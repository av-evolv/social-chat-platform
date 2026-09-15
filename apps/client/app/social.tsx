import { useEffect, useRef, useState } from 'react';
import { Link } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { accountRequest, hasSession, restoreSession, type Session } from '../src/auth/session';
import { addSource, operationKey, sourceFingerprint } from '../src/social/editor';
import type { Circle, Conversation, Preview, Role, Source, PendingConversation } from '../src/social/types';

const base = '/v1/social';
const key = () => operationKey(Date.now(), Crypto.getRandomBytes(16));
const label = (kind: string, value: { id: string; createdAt: string }) => `${kind} ${value.id.slice(-6)} · ${new Date(value.createdAt).toLocaleDateString()}`;
const person = (id: string, self?: string) => id === self ? 'You' : `Contact ${id.slice(-6)}`;

function Button({ title, onPress, disabled = false, primary = false }: { title: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return <Pressable role="button" disabled={disabled} onPress={onPress} style={[styles.button, primary && styles.primary, disabled && styles.disabled]}><Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text></Pressable>;
}

export default function SocialScreen() {
  const [session, setSession] = useState<Session>();
  const [circles, setCircles] = useState<Circle[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [circle, setCircle] = useState<Circle>();
  const [conversation, setConversation] = useState<Conversation>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
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
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Something went wrong. Please try again.'); }
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
      setNotice('Circle updated.');
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
      await load(); setNotice('Conversation updated.');
    } catch (failure) {
      setConversation(undefined); setEditing(false); setPreview(undefined); await load().catch(() => {}); throw failure;
    }
  }
  function confirm(id: string, title: string, action: () => Promise<void>) {
    return confirmation === id ? <View style={styles.actions}><Text style={styles.body}>{title}?</Text><Button title={`Confirm ${title.toLowerCase()}`} disabled={busy} onPress={() => void run(action)} /><Button title="Cancel" disabled={busy} onPress={() => setConfirmation(undefined)} /></View> : <Button title={title} disabled={busy} onPress={() => setConfirmation(id)} />;
  }
  function roles(current: Role, target: string, change: (role: Role) => Promise<void>) {
    return <View style={styles.row}>{(['MEMBER', 'ADMIN', 'OWNER'] as const).filter(role => role !== current).map(role => <Button key={role} title={`Make ${person(target, session?.participantId)} ${role.toLowerCase()}`} disabled={busy} onPress={() => void run(() => change(role))} />)}</View>;
  }
  const approvedPreview = preview?.fingerprint === sourceFingerprint(sources) ? preview.value : undefined;

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.page}>
    <Link href="/account" style={styles.link}>← Your account</Link>
    <Text role="heading" aria-level={1} style={styles.title}>Your people</Text>
    <Text style={styles.description}>Organize circles and choose who belongs in each conversation.</Text>
    {busy && <View role="status" style={styles.row}><ActivityIndicator color="#20372F" /><Text style={styles.body}>Please wait…</Text></View>}
    {!!error && <Text role="alert" style={styles.error}>{error}</Text>}
    {!!notice && <Text role="status" style={styles.body}>{notice}</Text>}
    {!session && !busy && <View style={styles.card}><Text style={styles.body}>Sign in to manage your circles and conversations.</Text><Link href="/account" style={styles.link}>Go to your account →</Link></View>}
    {session && <>
      <View style={styles.card}><Text role="heading" aria-level={2} style={styles.heading}>Your contact code</Text><Text style={styles.body}>Share this code with someone you know so they can invite you to a circle.</Text><Text selectable style={styles.code} testID="contact-code">{session.participantId}</Text><Button title="Refresh circles and conversations" disabled={busy} onPress={() => void run(async () => { setCircle(undefined); setConversation(undefined); setEditing(false); setPreview(undefined); await load(); })} /></View>
      <View style={styles.section}><Text role="heading" aria-level={2} style={styles.heading}>Circles</Text><Button title="Create circle" disabled={busy} primary onPress={() => void run(async () => {
        circleKey.current ??= key();
        const created = await accountRequest<Circle>(`${base}/circles`, 'POST', { operation_key: circleKey.current });
        circleKey.current = undefined; setCircle(created); setConversation(undefined); setEditing(false); setConfirmation(undefined); await load(); setNotice('Circle created. Invite someone using their contact code.');
      })} /></View>
      {!circles.length && <Text style={styles.small}>Your circles and invitations will appear here.</Text>}
      {circles.map(value => <View key={value.id} style={styles.listItem}><Button title={label('Circle', value)} disabled={busy} onPress={() => void run(async () => { setCircle(undefined); setConversation(undefined); setEditing(false); setConfirmation(undefined); setCircle(await accountRequest<Circle>(`${base}/circles/${value.id}`)); })} /><Text style={styles.small}>{value.state === 'INVITED' ? 'Invitation awaiting your acceptance' : `${value.state.toLowerCase()} · ${value.role.toLowerCase()}`}</Text></View>)}
      {circle && <View style={styles.card}>
        <Text role="heading" aria-level={3} style={styles.heading}>{label('Circle', circle)}</Text><Text selectable style={styles.code}>{circle.id}</Text>
        {circle.state === 'INVITED' && <><Text style={styles.body}>Accept this invitation to join the circle. Joining can make you eligible for conversations that include it; messaging still requires encryption setup.</Text><Button title="Accept invitation" disabled={busy} primary onPress={() => void run(() => mutateCircle('accept'))} /></>}
        {circle.state === 'ACTIVE' && <>
          {circle.members?.map(member => <View key={member.participantId} style={styles.member}><Text style={styles.body}>{person(member.participantId, session.participantId)} · {member.role.toLowerCase()} · {member.state.toLowerCase()}</Text><Text selectable style={styles.code}>{member.participantId}</Text>
            {circle.role === 'OWNER' && member.state === 'ACTIVE' && roles(member.role, member.participantId, role => mutateCircle('role', { participant_id: member.participantId, role }))}
            {['OWNER', 'ADMIN'].includes(circle.role) && member.participantId !== session.participantId && (member.role !== 'OWNER' || circle.role === 'OWNER') && ['ACTIVE', 'INVITED'].includes(member.state) && confirm(`remove:${member.participantId}`, `Remove ${person(member.participantId)}`, () => mutateCircle('remove', { participant_id: member.participantId }))}
          </View>)}
          {circle.members && ['OWNER', 'ADMIN'].includes(circle.role) && <><Text style={styles.body}>Invite a registered contact</Text><TextInput accessibilityLabel="Contact code to invite" value={invite} onChangeText={setInvite} editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder="Paste their contact code" style={styles.input} /><Button title="Send circle invitation" disabled={busy || !invite.trim()} primary onPress={() => void run(() => mutateCircle('invite', { participant_id: invite.trim().toLowerCase() }))} /></>}
        </>}
        {['INVITED', 'ACTIVE'].includes(circle.state) && confirm(`leave-circle:${circle.id}`, circle.state === 'INVITED' ? 'Decline invitation' : 'Leave circle', () => mutateCircle('leave'))}
        {circle.role === 'OWNER' && circle.state === 'ACTIVE' && confirm(`delete-circle:${circle.id}`, 'Delete circle', () => mutateCircle('delete'))}
      </View>}
      <View style={styles.section}><Text role="heading" aria-level={2} style={styles.heading}>Conversations</Text><Button title="New conversation" disabled={busy} primary onPress={() => editAudience()} /></View>
      <Text style={styles.small}>Audience setup is available. Messages stay unavailable until encryption is ready.</Text>
      {!conversations.length && <Text style={styles.small}>No conversations yet.</Text>}
      {conversations.map(value => <View key={value.id} style={styles.listItem}><Button title={label('Conversation', value)} disabled={busy} onPress={() => void run(async () => { setConversation(undefined); setCircle(undefined); setEditing(false); setConfirmation(undefined); setConversation(await accountRequest<Conversation>(`${base}/conversations/${value.id}`)); })} /><Text style={styles.small}>{value.memberState === 'LEFT' ? 'You left this conversation' : `Pending encryption · ${value.role.toLowerCase()}`}</Text></View>)}
      {conversation && !editing && <View style={styles.card}>
        <Text role="heading" aria-level={3} style={styles.heading}>{label('Conversation', conversation)}</Text><Text style={styles.body}>{conversation.memberState === 'LEFT' ? 'You left this conversation. Rejoin to check your current eligibility.' : 'Pending encryption. Messages cannot be sent or read yet.'}</Text>
        {conversation.memberState === 'PENDING' && conversation.orphaned && <Text style={styles.small}>No eligible owner remains. Audience administration is paused.</Text>}
        {conversation.memberState === 'PENDING' && conversation.members?.map(member => <View key={member.participantId} style={styles.member}><Text style={styles.body}>{person(member.participantId, session.participantId)} · {member.role.toLowerCase()}</Text><Text selectable style={styles.code}>{member.participantId}</Text><Text style={styles.small}>Pending encryption · Included by {member.provenance.length} audience source(s)</Text>{conversation.role === 'OWNER' && !conversation.orphaned && roles(member.role, member.participantId, role => mutateConversation('role', { participant_id: member.participantId, role }))}</View>)}
        {conversation.memberState === 'PENDING' && conversation.sources && !conversation.orphaned && ['OWNER', 'ADMIN'].includes(conversation.role) && <Button title="Edit audience" disabled={busy} onPress={() => editAudience(conversation)} />}
        {conversation.memberState === 'LEFT' ? <Button title="Rejoin conversation" disabled={busy} onPress={() => void run(() => mutateConversation('rejoin'))} /> : confirm(`leave-conversation:${conversation.id}`, 'Leave conversation', () => mutateConversation('leave'))}
        {conversation.memberState === 'PENDING' && conversation.sources && conversation.role === 'OWNER' && !conversation.orphaned && confirm(`delete-conversation:${conversation.id}`, 'Delete conversation', () => mutateConversation('delete'))}
      </View>}
      {editing && <View style={styles.card}>
        <Text role="heading" aria-level={3} style={styles.heading}>{conversation ? 'Edit audience' : 'Choose an audience'}</Text>
        <Text style={styles.body}>Include people or accepted members of a circle. Exclusions always win, even when someone is included in another way. Preview the audience before saving.</Text>
        <View style={styles.row}><Button title={sourceType === 'USER' ? '✓ Person' : 'Person'} disabled={busy} onPress={() => setSourceType('USER')} /><Button title={sourceType === 'CIRCLE' ? '✓ Circle' : 'Circle'} disabled={busy} onPress={() => setSourceType('CIRCLE')} /><Button title={operation === 'INCLUDE' ? '✓ Include' : 'Include'} disabled={busy} onPress={() => setOperation('INCLUDE')} /><Button title={operation === 'EXCLUDE' ? '✓ Exclude' : 'Exclude'} disabled={busy} onPress={() => setOperation('EXCLUDE')} /></View>
        <TextInput accessibilityLabel="Audience source code" value={sourceId} onChangeText={setSourceId} editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder={sourceType === 'USER' ? 'Your code or a contact in a shared circle' : 'Paste a circle code'} style={styles.input} />
        {sourceType === 'CIRCLE' && circles.filter(value => value.state === 'ACTIVE').map(value => <Button key={value.id} title={`Use ${label('circle', value)}`} disabled={busy} onPress={() => setSourceId(value.id)} />)}
        <Button title="Add audience source" disabled={busy || !sourceId.trim()} onPress={() => { try { changeSources(addSource(sources, sourceType, sourceId, operation)); setSourceId(''); setError(''); } catch (failure) { setError((failure as Error).message); } }} />
        {sources.map((source, index) => <View key={`${source.type}:${source.id}:${source.operation}`} style={styles.member}><Text style={styles.body}>{source.operation === 'INCLUDE' ? 'Include' : 'Exclude'} {source.type === 'USER' ? person(source.id, session.participantId) : `${source.type.toLowerCase()} ${source.id.slice(-6)}`}</Text><Text selectable style={styles.code}>{source.id}</Text>{!conversation && source.type === 'USER' && source.id === session.participantId && source.operation === 'INCLUDE' ? <Text style={styles.small}>You are included as the conversation’s first owner.</Text> : <Button title={`Remove source ${index + 1}`} disabled={busy} onPress={() => changeSources(sources.filter((_, at) => at !== index))} />}</View>)}
        <Button title="Preview audience" disabled={busy || !sources.length} primary onPress={() => void run(async () => {
          setPreview(undefined);
          const value = await accountRequest<Preview>(`${base}/preview`, 'POST', { sources, ...(conversation ? { conversation_id: conversation.id } : {}) });
          setPreview({ value, fingerprint: sourceFingerprint(sources) });
        })} />
        {approvedPreview && <View style={styles.preview}><Text role="heading" aria-level={4} style={styles.subheading}>Audience preview</Text><Text style={styles.body}>{approvedPreview.eligible.length} eligible · {approvedPreview.excluded.length} excluded</Text>{approvedPreview.eligible.map(member => <View key={member.participantId}><Text style={styles.body}>{person(member.participantId, session.participantId)}</Text><Text selectable style={styles.code}>{member.participantId}</Text><Text style={styles.small}>{member.provenance.length} inclusion source(s)</Text></View>)}<Text style={styles.small}>{!conversation && !approvedPreview.eligible.some(member => member.participantId === session.participantId) ? 'The first owner must be included. Remove any exclusion that applies to you before creating this conversation.' : 'Membership is checked again when you save. Everyone starts pending encryption.'}</Text></View>}
        <Button title={conversation ? 'Save audience' : 'Create conversation'} disabled={busy || !approvedPreview || (!conversation && !approvedPreview.eligible.some(member => member.participantId === session.participantId))} primary onPress={() => void run(async () => {
          if (!approvedPreview) return;
          if (conversation) await mutateConversation('audience', { sources });
          else {
            conversationKey.current ??= key();
            const created = await accountRequest<Conversation>(`${base}/conversations`, 'POST', { operation_key: conversationKey.current, sources });
            conversationKey.current = undefined; setConversation(created); setEditing(false); setPreview(undefined); await load(); setNotice('Conversation created. Messaging is pending encryption.');
          }
        })} />
        <Button title="Cancel audience changes" disabled={busy} onPress={() => { setEditing(false); setPreview(undefined); }} />
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
