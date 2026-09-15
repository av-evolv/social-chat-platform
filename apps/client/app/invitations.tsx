import Head from 'expo-router/head';
import { formatDate } from '@larynx/i18n';
import { useI18n } from '../src/i18n';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { localizeError, AccountRequestError, accountRequest, hasSession, restoreSession, type Session } from '../src/auth/session';
import { operationKey } from '../src/social/editor';
import type { Circle, Conversation } from '../src/social/types';
import { invitationTargets, type Invitation, type InvitationTarget } from '../src/invitations/editor';

const base = '/v1/invitations';
function Button({ title, onPress, disabled = false, primary = false }: { title: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return <Pressable role="button" disabled={disabled} onPress={onPress} style={[styles.button, primary && styles.primary, disabled && styles.disabled]}><Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text></Pressable>;
}

export default function InvitationsScreen() {
  const { t, locale } = useI18n();
  const targetLabel = (target: InvitationTarget) => t(target.type === 'CIRCLE' ? 'client.social.circleTarget' : 'client.social.conversationTarget', { id: target.id.slice(-6) });
  const [session, setSession] = useState<Session>();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [targets, setTargets] = useState<ReturnType<typeof invitationTargets>>([]);
  const [target, setTarget] = useState<string>();
  const [recipient, setRecipient] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [proofRequested, setProofRequested] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [revokeId, setRevokeId] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [acceptedTarget, setAcceptedTarget] = useState<InvitationTarget>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const creation = useRef<{ target: InvitationTarget; email: string; operation_key: string; expected_revision: string } | undefined>(undefined);
  const selected = targets.find(value => `${value.type}:${value.id}` === target);

  function clearProof() { setCode(''); setProofRequested(false); setConfirmed(false); }
  function clearPrivateState() {
    setSession(undefined); setInvitations([]); setTargets([]); setRecipient(''); setEmail(''); setToken(''); clearProof(); creation.current = undefined;
  }
  async function load() {
    await restoreSession();
    if (!hasSession()) { clearPrivateState(); return; }
    const current = await accountRequest<Session>('/v1/session');
    setSession(current);
    const [sent, circles, conversations] = await Promise.all([
      accountRequest<Invitation[]>(base), accountRequest<Circle[]>('/v1/social/circles'), accountRequest<Conversation[]>('/v1/social/conversations'),
    ]);
    setInvitations(sent); setTargets(invitationTargets(circles, conversations));
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(undefined); setNotice(''); setAcceptedTarget(undefined); setRefreshFailed(false);
    try { await action(); }
    catch (failure) {
      setError(failure);
      // Refresh revisions after a conflict; never silently retry a mutation.
      if (hasSession()) await load().catch(() => {});
    } finally { if (!hasSession()) clearPrivateState(); setBusy(false); }
  }
  useEffect(() => { void run(load); }, []);

  async function changeInvitation(invitation: Invitation, action: 'resend' | 'revoke') {
    await accountRequest<Invitation>(`${base}/${invitation.id}/${action}`, 'POST', { expected_revision: invitation.revision });
    setRevokeId(undefined);
    setNotice(action === 'revoke' ? 'client.invitations.revoked' : 'client.invitations.updated');
    await refreshAfterSuccess();
  }

  async function refreshAfterSuccess() {
    try { await load(); } catch { setRefreshFailed(true); }
  }

  return <SafeAreaView style={styles.safe}>
      {Platform.OS === 'web' && <Head><title>{t('client.common.pageTitle', { page: t('client.invitations.title') })}</title></Head>}<ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Link href="/account" style={styles.link}>{t('client.common.backAccount')}</Link>
    <Text role="heading" aria-level={1} style={styles.title}>{t('client.invitations.title')}</Text>
    <Text style={styles.description}>{t('client.invitations.description')}</Text>
    {busy && <View role="status" style={styles.row}><ActivityIndicator color="#20372F" /><Text style={styles.body}>{t('client.common.wait')}</Text></View>}
    {!!error && <Text role="alert" style={styles.error}>{localizeError(error, locale)}</Text>}
    {!!notice && <Text role="status" style={styles.body}>{t(notice, { id: acceptedTarget?.id.slice(-6) })}</Text>}
    {refreshFailed && <Text role="status" style={styles.body}>{t('client.invitations.refreshFailed')}</Text>}
    {!session && !busy && <View style={styles.card}>
      <Text role="heading" aria-level={2} style={styles.heading}>{t('client.invitations.signIn')}</Text>
      <Text style={styles.body}>{t('client.invitations.signInDescription')}</Text>
      <Link href="/account" style={styles.link}>{t('client.invitations.accountLink')}</Link>
    </View>}
    {session && <>
      <Link href="/social" style={styles.link}>{t('client.common.socialLink')}</Link>
      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.heading}>{t('client.invitations.acceptHeading')}</Text>
        <Text style={styles.body}>{t('client.invitations.acceptDescription')}</Text>
        <TextInput accessibilityLabel={t('client.invitations.emailLabel')} placeholder={t('client.invitations.emailPlaceholder')} value={email} onChangeText={value => { setEmail(value); clearProof(); }} editable={!busy} maxLength={254} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
        <TextInput accessibilityLabel={t('client.invitations.code')} placeholder={t('client.invitations.code')} value={token} onChangeText={value => { setToken(value); clearProof(); }} editable={!busy} maxLength={128} autoCapitalize="none" autoCorrect={false} autoComplete="off" secureTextEntry style={styles.input} />
        <Button title={proofRequested ? t('client.invitations.newVerification') : t('client.invitations.requestVerification')} disabled={busy || !email.trim() || !token.trim()} onPress={() => void run(async () => {
          clearProof();
          await accountRequest(`${base}/proof`, 'POST', { email: email.trim(), token: token.trim() });
          setProofRequested(true); setNotice('client.invitations.verificationSent');
        })} />
        {proofRequested && <>
          <TextInput accessibilityLabel={t('client.invitations.verificationLabel')} placeholder={t('client.invitations.verificationPlaceholder')} value={code} onChangeText={setCode} editable={!busy} maxLength={128} autoCapitalize="none" autoCorrect={false} autoComplete="off" secureTextEntry style={styles.input} />
          <Pressable role="checkbox" accessibilityLabel={t('client.invitations.confirmLabel')} accessibilityState={{ checked: confirmed, disabled: busy }} disabled={busy} onPress={() => setConfirmed(value => !value)} style={styles.confirmation}>
            <Text style={styles.body}>{t('client.invitations.confirmDescription', { check: confirmed ? '☑' : '☐' })}</Text>
          </Pressable>
          <Text style={styles.small}>{t('client.invitations.joinDescription')}</Text>
          <Button title={t('client.common.acceptInvitation')} primary disabled={busy || !code.trim() || !confirmed} onPress={() => void run(async () => {
            if (!confirmed) return;
            const accepted = await accountRequest<{ target: InvitationTarget }>(`${base}/accept`, 'POST', { email: email.trim(), token: token.trim(), code: code.trim(), confirm_accept: true });
            setEmail(''); setToken(''); clearProof();
            setAcceptedTarget(accepted.target); setNotice(accepted.target.type === 'CIRCLE' ? 'client.invitations.acceptedCircle' : 'client.invitations.acceptedConversation');
            await refreshAfterSuccess();
          })} />
        </>}
      </View>
      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.heading}>{t('client.invitations.sendHeading')}</Text>
        <Text style={styles.body}>{t('client.invitations.sendDescription')}</Text>
        {!targets.length && <Text style={styles.small}>{t('client.invitations.noTargets')}</Text>}
        {targets.map(value => <Button key={`${value.type}:${value.id}`} title={selected?.id === value.id && selected.type === value.type ? t('client.social.selected', { label: targetLabel(value) }) : targetLabel(value)} disabled={busy} onPress={() => { setTarget(`${value.type}:${value.id}`); creation.current = undefined; }} />)}
        <TextInput accessibilityLabel={t('client.invitations.recipient')} placeholder={t('client.invitations.recipient')} value={recipient} onChangeText={value => { setRecipient(value); creation.current = undefined; }} editable={!busy} maxLength={254} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
        <Button title={t('client.invitations.send')} primary disabled={busy || !selected || !recipient.trim()} onPress={() => void run(async () => {
          if (!selected) return;
          creation.current ??= { target: { type: selected.type, id: selected.id }, email: recipient.trim(), operation_key: operationKey(Date.now(), Crypto.getRandomBytes(16)), expected_revision: selected.revision };
          let sent: Invitation;
          try { sent = await accountRequest<Invitation>(base, 'POST', creation.current); }
          catch (failure) {
            if (failure instanceof AccountRequestError && failure.code === 'revision_conflict') creation.current = undefined;
            throw failure;
          }
          creation.current = undefined; setRecipient('');
          setNotice(sent.delivery === 'SENT' ? 'client.invitations.sent' : 'client.invitations.deliveryUnconfirmed');
          await refreshAfterSuccess();
        })} />
        <Text style={styles.small}>{t('client.invitations.expiryDescription')}</Text>
      </View>
      <View style={styles.row}><Text role="heading" aria-level={2} style={styles.heading}>{t('client.invitations.sentHeading')}</Text><Button title={t('client.invitations.refresh')} disabled={busy} onPress={() => void run(load)} /></View>
      {!invitations.length && <Text style={styles.small}>{t('client.invitations.empty')}</Text>}
      {invitations.map(invitation => <View key={invitation.id} style={styles.card}>
        <Text role="heading" aria-level={3} style={styles.subheading}>{targetLabel(invitation.target)}</Text>
        <Text selectable style={styles.body}>{invitation.recipientEmail}</Text>
        <Text style={styles.small}>{t('client.invitations.status', { state: t(`client.invitations.state.${invitation.state}`), delivery: t(`client.invitations.delivery.${invitation.delivery}`) })}</Text>
        <Text style={styles.small}>{t('client.invitations.expires', { date: formatDate(locale, invitation.expiresAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</Text>
        {['PENDING', 'EXPIRED'].includes(invitation.state) && <>
          {invitation.delivery !== 'SENT' && <Text style={styles.small}>{t('client.invitations.resendDescription')}</Text>}
          <Button title={t('client.invitations.resend', { email: invitation.recipientEmail })} disabled={busy} onPress={() => void run(() => changeInvitation(invitation, 'resend'))} />
          {revokeId === invitation.id ? <><Text style={styles.body}>{t('client.invitations.revokeQuestion')}</Text><Button title={t('client.invitations.confirmRevoke')} disabled={busy} onPress={() => void run(() => changeInvitation(invitation, 'revoke'))} /><Button title={t('client.invitations.cancelRevoke')} disabled={busy} onPress={() => setRevokeId(undefined)} /></> : <Button title={t('client.invitations.revoke', { email: invitation.recipientEmail })} disabled={busy} onPress={() => setRevokeId(invitation.id)} />}
        </>}
      </View>)}
    </>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F4EE' },
  page: { width: '100%', maxWidth: 800, alignSelf: 'center', padding: 24, paddingBottom: 60, gap: 20 },
  title: { color: '#20372F', fontSize: 38, fontWeight: '600', letterSpacing: -1 },
  heading: { color: '#20372F', fontSize: 24, fontWeight: '600' },
  subheading: { color: '#20372F', fontSize: 19, fontWeight: '600' },
  description: { color: '#58675D', fontSize: 18, lineHeight: 27 },
  body: { color: '#20372F', fontSize: 16, lineHeight: 24 },
  small: { color: '#58675D', fontSize: 14, lineHeight: 22 },
  link: { color: '#20372F', fontSize: 16, fontWeight: '600', paddingVertical: 10 },
  card: { backgroundColor: '#FFFFFF', borderColor: '#D9DFD5', borderWidth: 1, borderRadius: 20, padding: 22, gap: 16 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' },
  input: { borderColor: '#A8B4A7', borderWidth: 1, borderRadius: 10, padding: 14, color: '#20372F', fontSize: 16, minWidth: 0 },
  button: { borderColor: '#D9DFD5', borderWidth: 1, borderRadius: 12, padding: 14, alignItems: 'center' },
  primary: { backgroundColor: '#20372F', borderColor: '#20372F' },
  buttonText: { color: '#20372F', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  primaryText: { color: '#F5F4EE' },
  disabled: { opacity: 0.45 },
  error: { color: '#922E24', backgroundColor: '#FFF0E9', padding: 16, borderRadius: 12, fontSize: 16, lineHeight: 24 },
  confirmation: { backgroundColor: '#EDF3E8', padding: 16, borderRadius: 12 },
});
