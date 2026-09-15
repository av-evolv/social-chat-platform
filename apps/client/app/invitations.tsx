import { useEffect, useRef, useState } from 'react';
import { Link } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AccountRequestError, accountRequest, hasSession, restoreSession, type Session } from '../src/auth/session';
import { operationKey } from '../src/social/editor';
import type { Circle, Conversation } from '../src/social/types';
import { invitationTargets, type Invitation, type InvitationTarget } from '../src/invitations/editor';

const base = '/v1/invitations';
function Button({ title, onPress, disabled = false, primary = false }: { title: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return <Pressable role="button" disabled={disabled} onPress={onPress} style={[styles.button, primary && styles.primary, disabled && styles.disabled]}><Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text></Pressable>;
}
const targetLabel = (target: InvitationTarget) => `${target.type === 'CIRCLE' ? 'Circle' : 'Conversation'} ${target.id.slice(-6)}`;

export default function InvitationsScreen() {
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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Something went wrong. Please try again.');
      // Refresh revisions after a conflict; never silently retry a mutation.
      if (hasSession()) await load().catch(() => {});
    } finally { if (!hasSession()) clearPrivateState(); setBusy(false); }
  }
  useEffect(() => { void run(load); }, []);

  async function changeInvitation(invitation: Invitation, action: 'resend' | 'revoke') {
    await accountRequest<Invitation>(`${base}/${invitation.id}/${action}`, 'POST', { expected_revision: invitation.revision });
    setRevokeId(undefined);
    setNotice(action === 'revoke' ? 'Invitation revoked. It can no longer be accepted.' : 'Invitation updated. Check its delivery status below; earlier invitation and verification codes no longer work.');
    await refreshAfterSuccess();
  }

  async function refreshAfterSuccess() {
    try { await load(); } catch { setNotice(value => `${value} The latest details could not be loaded. Refresh to check them.`); }
  }

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Link href="/account" style={styles.link}>← Your account</Link>
    <Text role="heading" aria-level={1} style={styles.title}>Invitations</Text>
    <Text style={styles.description}>Invite someone by email or accept an invitation sent to you.</Text>
    {busy && <View role="status" style={styles.row}><ActivityIndicator color="#20372F" /><Text style={styles.body}>Please wait…</Text></View>}
    {!!error && <Text role="alert" style={styles.error}>{error}</Text>}
    {!!notice && <Text role="status" style={styles.body}>{notice}</Text>}
    {!session && !busy && <View style={styles.card}>
      <Text role="heading" aria-level={2} style={styles.heading}>Sign in to continue</Text>
      <Text style={styles.body}>Sign in to the account registered with the invited email address. If you are new, create an account with that email first, then return here and enter the invitation code.</Text>
      <Link href="/account" style={styles.link}>Sign in or create account →</Link>
    </View>}
    {session && <>
      <Link href="/social" style={styles.link}>Your circles and conversations →</Link>
      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.heading}>Accept an invitation</Text>
        <Text style={styles.body}>Use the account registered with the invited email address, then enter that email and the invitation code. If you are signed in to a different account, sign out on Your account and sign in with the invited email. We will send a separate verification code if the invitation can be used.</Text>
        <TextInput accessibilityLabel="Invited email address" placeholder="Email address from the invitation" value={email} onChangeText={value => { setEmail(value); clearProof(); }} editable={!busy} maxLength={254} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
        <TextInput accessibilityLabel="Invitation code" placeholder="Invitation code" value={token} onChangeText={value => { setToken(value); clearProof(); }} editable={!busy} maxLength={128} autoCapitalize="none" autoCorrect={false} autoComplete="off" secureTextEntry style={styles.input} />
        <Button title={proofRequested ? 'Send a new verification code' : 'Request verification code'} disabled={busy || !email.trim() || !token.trim()} onPress={() => void run(async () => {
          clearProof();
          await accountRequest(`${base}/proof`, 'POST', { email: email.trim(), token: token.trim() });
          setProofRequested(true); setNotice('If this invitation can be used, a verification code has been sent to that email address. Check your inbox.');
        })} />
        {proofRequested && <>
          <TextInput accessibilityLabel="Invitation verification code" placeholder="Fresh verification code" value={code} onChangeText={setCode} editable={!busy} maxLength={128} autoCapitalize="none" autoCorrect={false} autoComplete="off" secureTextEntry style={styles.input} />
          <Pressable role="checkbox" accessibilityLabel="Accept this invitation for my signed-in account" accessibilityState={{ checked: confirmed, disabled: busy }} disabled={busy} onPress={() => setConfirmed(value => !value)} style={styles.confirmation}>
            <Text style={styles.body}>{confirmed ? '☑' : '☐'} I accept this invitation for my signed-in account. Only this invitation will be accepted; other invitations stay pending.</Text>
          </Pressable>
          <Text style={styles.small}>Joining a circle can also make you eligible for conversations that include it. Messaging remains unavailable until encryption is ready.</Text>
          <Button title="Accept invitation" primary disabled={busy || !code.trim() || !confirmed} onPress={() => void run(async () => {
            if (!confirmed) return;
            const accepted = await accountRequest<{ target: InvitationTarget }>(`${base}/accept`, 'POST', { email: email.trim(), token: token.trim(), code: code.trim(), confirm_accept: true });
            setEmail(''); setToken(''); clearProof();
            setNotice(`Invitation accepted for ${targetLabel(accepted.target)}. Find your membership in Your circles and conversations.`);
            await refreshAfterSuccess();
          })} />
        </>}
      </View>
      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.heading}>Send an invitation</Text>
        <Text style={styles.body}>Choose a circle or conversation you manage. The recipient joins as a member after verifying their email and accepting.</Text>
        {!targets.length && <Text style={styles.small}>Create a circle or conversation first, or ask its owner for administrator access.</Text>}
        {targets.map(value => <Button key={`${value.type}:${value.id}`} title={`${selected?.id === value.id && selected.type === value.type ? '✓ ' : ''}${targetLabel(value)}`} disabled={busy} onPress={() => { setTarget(`${value.type}:${value.id}`); creation.current = undefined; }} />)}
        <TextInput accessibilityLabel="Recipient email address" placeholder="Recipient email address" value={recipient} onChangeText={value => { setRecipient(value); creation.current = undefined; }} editable={!busy} maxLength={254} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.input} />
        <Button title="Send email invitation" primary disabled={busy || !selected || !recipient.trim()} onPress={() => void run(async () => {
          if (!selected) return;
          creation.current ??= { target: { type: selected.type, id: selected.id }, email: recipient.trim(), operation_key: operationKey(Date.now(), Crypto.getRandomBytes(16)), expected_revision: selected.revision };
          let sent: Invitation;
          try { sent = await accountRequest<Invitation>(base, 'POST', creation.current); }
          catch (failure) {
            if (failure instanceof AccountRequestError && failure.code === 'revision_conflict') creation.current = undefined;
            throw failure;
          }
          creation.current = undefined; setRecipient('');
          setNotice(sent.delivery === 'SENT' ? 'Invitation sent. It grants membership only after the recipient accepts.' : 'Invitation created, but delivery is not confirmed. Check its status below and resend if needed.');
          await refreshAfterSuccess();
        })} />
        <Text style={styles.small}>Invitations expire after seven days. Emails contain no private titles, messages or member lists.</Text>
      </View>
      <View style={styles.row}><Text role="heading" aria-level={2} style={styles.heading}>Invitations you sent</Text><Button title="Refresh invitations" disabled={busy} onPress={() => void run(load)} /></View>
      {!invitations.length && <Text style={styles.small}>Your sent invitations will appear here while you can manage their destinations.</Text>}
      {invitations.map(invitation => <View key={invitation.id} style={styles.card}>
        <Text role="heading" aria-level={3} style={styles.subheading}>{targetLabel(invitation.target)}</Text>
        <Text selectable style={styles.body}>{invitation.recipientEmail}</Text>
        <Text style={styles.small}>{invitation.state.toLowerCase()} · Delivery {invitation.delivery.toLowerCase()}</Text>
        <Text style={styles.small}>Expires {new Date(invitation.expiresAt).toLocaleString()}</Text>
        {['PENDING', 'EXPIRED'].includes(invitation.state) && <>
          {invitation.delivery !== 'SENT' && <Text style={styles.small}>Delivery is not confirmed. Resend to issue a new code and try delivery again.</Text>}
          <Button title={`Resend invitation to ${invitation.recipientEmail}`} disabled={busy} onPress={() => void run(() => changeInvitation(invitation, 'resend'))} />
          {revokeId === invitation.id ? <><Text style={styles.body}>Revoke this invitation? The recipient will no longer be able to accept it.</Text><Button title="Confirm invitation revocation" disabled={busy} onPress={() => void run(() => changeInvitation(invitation, 'revoke'))} /><Button title="Cancel revocation" disabled={busy} onPress={() => setRevokeId(undefined)} /></> : <Button title={`Revoke invitation to ${invitation.recipientEmail}`} disabled={busy} onPress={() => setRevokeId(invitation.id)} />}
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
