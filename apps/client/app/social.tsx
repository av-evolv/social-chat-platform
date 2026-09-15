import Head from 'expo-router/head';
import { formatDate, formatNumber } from '@larynx/i18n';
import { useI18n } from '../src/i18n';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { localizeError, accountRequest, hasSession, restoreSession, type Session } from '../src/auth/session';
import { InvalidSourceError, addSource, operationKey, sourceFingerprint } from '../src/social/editor';
import type { Circle, Conversation, Preview, Role, Source, PendingConversation } from '../src/social/types';

const base = '/v1/social';
const key = () => operationKey(Date.now(), Crypto.getRandomBytes(16));

function Button({ title, onPress, disabled = false, primary = false }: { title: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return <Pressable role="button" disabled={disabled} onPress={onPress} style={[styles.button, primary && styles.primary, disabled && styles.disabled]}><Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text></Pressable>;
}

export default function SocialScreen() {
  const { t, locale } = useI18n();
  const label = (kind: 'circle' | 'conversation', value: { id: string; createdAt: string }) => t(`client.social.${kind}Label`, { id: value.id.slice(-6), date: formatDate(locale, value.createdAt) });
  const person = (id: string, self?: string) => id === self ? t('client.social.you') : t('client.social.contact', { id: id.slice(-6) });
  const roleLabel = (role: Role) => t(`client.social.role.${role}`);
  const stateLabel = (state: string) => t(`client.social.state.${state}`);
  const [session, setSession] = useState<Session>();
  const [circles, setCircles] = useState<Circle[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [circle, setCircle] = useState<Circle>();
  const [conversation, setConversation] = useState<Conversation>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [invite, setInvite] = useState('');
  const [editing, setEditing] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceType, setSourceType] = useState<'USER' | 'CIRCLE'>('USER');
  const [sourceId, setSourceId] = useState('');
  const [operation, setOperation] = useState<Source['operation']>('INCLUDE');
  const [preview, setPreview] = useState<{ value: Preview; fingerprint: string }>();
  const [confirmation, setConfirmation] = useState<string>();
  const circleKey = useRef<string | undefined>(undefined);
  const conversationKey = useRef<string | undefined>(undefined);

  async function load() {
    await restoreSession();
    if (!hasSession()) { setSession(undefined); return; }
    const nextSession = await accountRequest<Session>('/v1/session');
    setSession(nextSession);
    const [nextCircles, nextConversations] = await Promise.all([accountRequest<Circle[]>(`${base}/circles`), accountRequest<Conversation[]>(`${base}/conversations`)]);
    setCircles(nextCircles); setConversations(nextConversations);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(undefined); setNotice('');
    try { await action(); }
    catch (failure) { setError(failure); }
    finally {
      if (!hasSession()) { setSession(undefined); setCircles([]); setConversations([]); setCircle(undefined); setConversation(undefined); }
      setBusy(false);
    }
  }
  useEffect(() => { void run(load); }, []);

  function changeSources(next: Source[]) { setSources(next); setPreview(undefined); conversationKey.current = undefined; }
  function editAudience(current?: PendingConversation) {
    setConversation(current); setCircle(undefined); setEditing(true); setPreview(undefined); setSourceId(''); setConfirmation(undefined);
    changeSources(current?.sources ?? (session ? [{ type: 'USER', id: session.participantId, operation: 'INCLUDE' }] : []));
  }
  async function mutateCircle(action: string, body: Record<string, unknown> = {}) {
    if (!circle) return;
    const id = circle.id;
    try {
      await accountRequest(`${base}/circles/${id}/${action}`, 'POST', { ...body, expected_revision: circle.revision });
      setInvite(''); setConfirmation(undefined);
      if (['leave', 'delete'].includes(action)) setCircle(undefined);
      else setCircle(await accountRequest<Circle>(`${base}/circles/${id}`));
      await load();
      setNotice('client.social.circleUpdated');
    } catch (failure) {
      // A conflicting revision must never be retried with stale membership controls.
      setCircle(undefined); await load().catch(() => {}); throw failure;
    }
  }
  async function mutateConversation(action: string, body: Record<string, unknown> = {}) {
    if (!conversation) return;
    const id = conversation.id;
    try {
      await accountRequest(`${base}/conversations/${id}/${action}`, 'POST', { ...body, expected_revision: conversation.revision });
      setConfirmation(undefined); setEditing(false); setPreview(undefined);
      if (['leave', 'delete'].includes(action)) setConversation(undefined);
      else setConversation(await accountRequest<Conversation>(`${base}/conversations/${id}`));
      await load(); setNotice('client.social.conversationUpdated');
    } catch (failure) {
      setConversation(undefined); setEditing(false); setPreview(undefined); await load().catch(() => {}); throw failure;
    }
  }
  function confirm(id: string, message: string, action: () => Promise<void>, values: Record<string, string> = {}) {
    return confirmation === id ? <View style={styles.actions}><Text style={styles.body}>{t(`${message}Question`, values)}</Text><Button title={t(`${message}Confirm`, values)} disabled={busy} onPress={() => void run(action)} /><Button title={t('client.common.cancel')} disabled={busy} onPress={() => setConfirmation(undefined)} /></View> : <Button title={t(message, values)} disabled={busy} onPress={() => setConfirmation(id)} />;
  }
  function roles(current: Role, target: string, change: (role: Role) => Promise<void>) {
    return <View style={styles.row}>{(['MEMBER', 'ADMIN', 'OWNER'] as const).filter(role => role !== current).map(role => <Button key={role} title={t(`client.social.make.${role}`, { person: person(target, session?.participantId) })} disabled={busy} onPress={() => void run(() => change(role))} />)}</View>;
  }
  const approvedPreview = preview?.fingerprint === sourceFingerprint(sources) ? preview.value : undefined;

  return <SafeAreaView style={styles.safe}>
      {Platform.OS === 'web' && <Head><title>{t('client.common.pageTitle', { page: t('client.social.title') })}</title></Head>}<ScrollView contentContainerStyle={styles.page}>
    <Link href="/account" style={styles.link}>{t('client.common.backAccount')}</Link>
    <Text role="heading" aria-level={1} style={styles.title}>{t('client.social.title')}</Text>
    <Text style={styles.description}>{t('client.social.description')}</Text>
    <Link href="/invitations" style={styles.link}>{t('client.common.invitationsLink')}</Link>
    {busy && <View role="status" style={styles.row}><ActivityIndicator color="#20372F" /><Text style={styles.body}>{t('client.common.wait')}</Text></View>}
    {!!error && <Text role="alert" style={styles.error}>{error instanceof InvalidSourceError ? t('client.error.invalidSource') : localizeError(error, locale)}</Text>}
    {!!notice && <Text role="status" style={styles.body}>{t(notice)}</Text>}
    {!session && !busy && <View style={styles.card}><Text style={styles.body}>{t('client.social.signIn')}</Text><Link href="/account" style={styles.link}>{t('client.social.accountLink')}</Link></View>}
    {session && <>
      <View style={styles.card}><Text role="heading" aria-level={2} style={styles.heading}>{t('client.social.contactCode')}</Text><Text style={styles.body}>{t('client.social.shareCode')}</Text><Text selectable style={styles.code} testID="contact-code">{session.participantId}</Text><Button title={t('client.social.refresh')} disabled={busy} onPress={() => void run(async () => { setCircle(undefined); setConversation(undefined); setEditing(false); setPreview(undefined); await load(); })} /></View>
      <View style={styles.section}><Text role="heading" aria-level={2} style={styles.heading}>{t('client.social.circles')}</Text><Button title={t('client.social.createCircle')} disabled={busy} primary onPress={() => void run(async () => {
        circleKey.current ??= key();
        const created = await accountRequest<Circle>(`${base}/circles`, 'POST', { operation_key: circleKey.current });
        circleKey.current = undefined; setCircle(created); setConversation(undefined); setEditing(false); setConfirmation(undefined); await load(); setNotice('client.social.circleCreated');
      })} /></View>
      {!circles.length && <Text style={styles.small}>{t('client.social.emptyCircles')}</Text>}
      {circles.map(value => <View key={value.id} style={styles.listItem}><Button title={label('circle', value)} disabled={busy} onPress={() => void run(async () => { setCircle(undefined); setConversation(undefined); setEditing(false); setConfirmation(undefined); setCircle(await accountRequest<Circle>(`${base}/circles/${value.id}`)); })} /><Text style={styles.small}>{value.state === 'INVITED' ? t('client.social.invitationPending') : t('client.social.circleStatus', { state: stateLabel(value.state), role: roleLabel(value.role) })}</Text></View>)}
      {circle && <View style={styles.card}>
        <Text role="heading" aria-level={3} style={styles.heading}>{label('circle', circle)}</Text><Text selectable style={styles.code}>{circle.id}</Text>
        {circle.state === 'INVITED' && <><Text style={styles.body}>{t('client.social.circleAcceptDescription')}</Text><Button title={t('client.common.acceptInvitation')} disabled={busy} primary onPress={() => void run(() => mutateCircle('accept'))} /></>}
        {circle.state === 'ACTIVE' && <>
          {circle.members?.map(member => <View key={member.participantId} style={styles.member}><Text style={styles.body}>{t('client.social.memberStatus', { person: person(member.participantId, session.participantId), role: roleLabel(member.role), state: stateLabel(member.state) })}</Text><Text selectable style={styles.code}>{member.participantId}</Text>
            {circle.role === 'OWNER' && member.state === 'ACTIVE' && roles(member.role, member.participantId, role => mutateCircle('role', { participant_id: member.participantId, role }))}
            {['OWNER', 'ADMIN'].includes(circle.role) && member.participantId !== session.participantId && (member.role !== 'OWNER' || circle.role === 'OWNER') && ['ACTIVE', 'INVITED'].includes(member.state) && confirm(`remove:${member.participantId}`, 'client.social.remove', () => mutateCircle('remove', { participant_id: member.participantId }), { person: person(member.participantId) })}
          </View>)}
          {circle.members && ['OWNER', 'ADMIN'].includes(circle.role) && <><Text style={styles.body}>{t('client.social.inviteContact')}</Text><TextInput accessibilityLabel={t('client.social.inviteCodeLabel')} value={invite} onChangeText={setInvite} editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder={t('client.social.inviteCodePlaceholder')} style={styles.input} /><Button title={t('client.social.sendCircleInvitation')} disabled={busy || !invite.trim()} primary onPress={() => void run(() => mutateCircle('invite', { participant_id: invite.trim().toLowerCase() }))} /></>}
        </>}
        {['INVITED', 'ACTIVE'].includes(circle.state) && confirm(`leave-circle:${circle.id}`, circle.state === 'INVITED' ? 'client.social.declineInvitation' : 'client.social.leaveCircle', () => mutateCircle('leave'))}
        {circle.role === 'OWNER' && circle.state === 'ACTIVE' && confirm(`delete-circle:${circle.id}`, 'client.social.deleteCircle', () => mutateCircle('delete'))}
      </View>}
      <View style={styles.section}><Text role="heading" aria-level={2} style={styles.heading}>{t('client.home.conversations')}</Text><Button title={t('client.social.newConversation')} disabled={busy} primary onPress={() => editAudience()} /></View>
      <Text style={styles.small}>{t('client.social.pendingDescription')}</Text>
      {!conversations.length && <Text style={styles.small}>{t('client.social.emptyConversations')}</Text>}
      {conversations.map(value => <View key={value.id} style={styles.listItem}><Button title={label('conversation', value)} disabled={busy} onPress={() => void run(async () => { setConversation(undefined); setCircle(undefined); setEditing(false); setConfirmation(undefined); setConversation(await accountRequest<Conversation>(`${base}/conversations/${value.id}`)); })} /><Text style={styles.small}>{value.memberState === 'LEFT' ? t('client.social.leftConversation') : t('client.social.pendingRole', { role: roleLabel(value.role) })}</Text></View>)}
      {conversation && !editing && <View style={styles.card}>
        <Text role="heading" aria-level={3} style={styles.heading}>{label('conversation', conversation)}</Text><Text style={styles.body}>{conversation.memberState === 'LEFT' ? t('client.social.rejoinDescription') : t('client.social.encryptionDescription')}</Text>
        {conversation.memberState === 'PENDING' && conversation.orphaned && <Text style={styles.small}>{t('client.social.orphaned')}</Text>}
        {conversation.memberState === 'PENDING' && conversation.members?.map(member => <View key={member.participantId} style={styles.member}><Text style={styles.body}>{t('client.social.memberRole', { person: person(member.participantId, session.participantId), role: roleLabel(member.role) })}</Text><Text selectable style={styles.code}>{member.participantId}</Text><Text style={styles.small}>{t('client.social.pendingSources', { count: member.provenance.length, number: formatNumber(locale, member.provenance.length) })}</Text>{conversation.role === 'OWNER' && !conversation.orphaned && roles(member.role, member.participantId, role => mutateConversation('role', { participant_id: member.participantId, role }))}</View>)}
        {conversation.memberState === 'PENDING' && conversation.sources && !conversation.orphaned && ['OWNER', 'ADMIN'].includes(conversation.role) && <Button title={t('client.social.editAudience')} disabled={busy} onPress={() => editAudience(conversation)} />}
        {conversation.memberState === 'LEFT' ? <Button title={t('client.social.rejoin')} disabled={busy} onPress={() => void run(() => mutateConversation('rejoin'))} /> : confirm(`leave-conversation:${conversation.id}`, 'client.social.leaveConversation', () => mutateConversation('leave'))}
        {conversation.memberState === 'PENDING' && conversation.sources && conversation.role === 'OWNER' && !conversation.orphaned && confirm(`delete-conversation:${conversation.id}`, 'client.social.deleteConversation', () => mutateConversation('delete'))}
      </View>}
      {editing && <View style={styles.card}>
        <Text role="heading" aria-level={3} style={styles.heading}>{conversation ? t('client.social.editAudience') : t('client.social.chooseAudience')}</Text>
        <Text style={styles.body}>{t('client.social.audienceDescription')}</Text>
        <View style={styles.row}><Button title={sourceType === 'USER' ? t('client.social.selected', { label: t('client.social.person') }) : t('client.social.person')} disabled={busy} onPress={() => setSourceType('USER')} /><Button title={sourceType === 'CIRCLE' ? t('client.social.selected', { label: t('client.social.circle') }) : t('client.social.circle')} disabled={busy} onPress={() => setSourceType('CIRCLE')} /><Button title={operation === 'INCLUDE' ? t('client.social.selected', { label: t('client.social.include') }) : t('client.social.include')} disabled={busy} onPress={() => setOperation('INCLUDE')} /><Button title={operation === 'EXCLUDE' ? t('client.social.selected', { label: t('client.social.exclude') }) : t('client.social.exclude')} disabled={busy} onPress={() => setOperation('EXCLUDE')} /></View>
        <TextInput accessibilityLabel={t('client.social.sourceCodeLabel')} value={sourceId} onChangeText={setSourceId} editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder={sourceType === 'USER' ? t('client.social.personPlaceholder') : t('client.social.circlePlaceholder')} style={styles.input} />
        {sourceType === 'CIRCLE' && circles.filter(value => value.state === 'ACTIVE').map(value => <Button key={value.id} title={t('client.social.useCircle', { id: value.id.slice(-6), date: formatDate(locale, value.createdAt) })} disabled={busy} onPress={() => setSourceId(value.id)} />)}
        <Button title={t('client.social.addSource')} disabled={busy || !sourceId.trim()} onPress={() => { try { changeSources(addSource(sources, sourceType, sourceId, operation)); setSourceId(''); setError(undefined); } catch (failure) { setError(failure); } }} />
        {sources.map((source, index) => <View key={`${source.type}:${source.id}:${source.operation}`} style={styles.member}><Text style={styles.body}>{t(source.operation === 'INCLUDE' ? 'client.social.includeSource' : 'client.social.excludeSource', { source: source.type === 'USER' ? person(source.id, session.participantId) : t('client.social.circleTarget', { id: source.id.slice(-6) }) })}</Text><Text selectable style={styles.code}>{source.id}</Text>{!conversation && source.type === 'USER' && source.id === session.participantId && source.operation === 'INCLUDE' ? <Text style={styles.small}>{t('client.social.firstOwner')}</Text> : <Button title={t('client.social.removeSource', { number: formatNumber(locale, index + 1) })} disabled={busy} onPress={() => changeSources(sources.filter((_, at) => at !== index))} />}</View>)}
        <Button title={t('client.social.preview')} disabled={busy || !sources.length} primary onPress={() => void run(async () => {
          setPreview(undefined);
          const value = await accountRequest<Preview>(`${base}/preview`, 'POST', { sources, ...(conversation ? { conversation_id: conversation.id } : {}) });
          setPreview({ value, fingerprint: sourceFingerprint(sources) });
        })} />
        {approvedPreview && <View style={styles.preview}><Text role="heading" aria-level={4} style={styles.subheading}>{t('client.social.previewHeading')}</Text><Text style={styles.body}>{t('client.social.previewCounts', { eligible: t('client.social.eligibleCount', { count: approvedPreview.eligible.length, number: formatNumber(locale, approvedPreview.eligible.length) }), excluded: t('client.social.excludedCount', { count: approvedPreview.excluded.length, number: formatNumber(locale, approvedPreview.excluded.length) }) })}</Text>{approvedPreview.eligible.map(member => <View key={member.participantId}><Text style={styles.body}>{person(member.participantId, session.participantId)}</Text><Text selectable style={styles.code}>{member.participantId}</Text><Text style={styles.small}>{t('client.social.inclusionSources', { count: member.provenance.length, number: formatNumber(locale, member.provenance.length) })}</Text></View>)}<Text style={styles.small}>{!conversation && !approvedPreview.eligible.some(member => member.participantId === session.participantId) ? t('client.social.ownerExcluded') : t('client.social.saveDescription')}</Text></View>}
        <Button title={conversation ? t('client.social.saveAudience') : t('client.social.createConversation')} disabled={busy || !approvedPreview || (!conversation && !approvedPreview.eligible.some(member => member.participantId === session.participantId))} primary onPress={() => void run(async () => {
          if (!approvedPreview) return;
          if (conversation) await mutateConversation('audience', { sources });
          else {
            conversationKey.current ??= key();
            const created = await accountRequest<Conversation>(`${base}/conversations`, 'POST', { operation_key: conversationKey.current, sources });
            conversationKey.current = undefined; setConversation(created); setEditing(false); setPreview(undefined); await load(); setNotice('client.social.conversationCreated');
          }
        })} />
        <Button title={t('client.social.cancelAudience')} disabled={busy} onPress={() => { setEditing(false); setPreview(undefined); }} />
      </View>}
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
  section: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  listItem: { gap: 8 },
  member: { borderTopColor: '#D9DFD5', borderTopWidth: 1, paddingTop: 16, gap: 10 },
  code: { color: '#58675D', fontSize: 13, lineHeight: 22, flexShrink: 1 },
  input: { borderColor: '#A8B4A7', borderWidth: 1, borderRadius: 10, padding: 14, color: '#20372F', fontSize: 16, minWidth: 0 },
  button: { borderColor: '#D9DFD5', borderWidth: 1, borderRadius: 12, padding: 14, alignItems: 'center' },
  primary: { backgroundColor: '#20372F', borderColor: '#20372F' },
  buttonText: { color: '#20372F', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  primaryText: { color: '#F5F4EE' },
  disabled: { opacity: 0.45 },
  error: { color: '#922E24', backgroundColor: '#FFF0E9', padding: 16, borderRadius: 12, fontSize: 16, lineHeight: 24 },
  actions: { gap: 12 },
  preview: { backgroundColor: '#EDF3E8', padding: 18, borderRadius: 12, gap: 12 },
});
