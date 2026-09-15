import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { IdentityStore, type Registration } from '../src/identity/store.js';
import { SocialStore } from '../src/social/store.js';
import { SocialError, type EventSourceAdapter, type SocialActor, type Source } from '../src/social/types.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for isolated PostgreSQL integration tests' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const source = (type: Source['type'], id: string, operation: Source['operation'] = 'INCLUDE'): Source => ({ type, id, operation });
const status = (expected: number) => (error: unknown) => error instanceof SocialError && error.status === expected;
const conflict = status(409);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, events = false) {
  const suffix = randomBytes(8).toString('hex');
  const schema = `social_test_${suffix}`;
  const identitySchema = `principal_test_${suffix}`;
  const applicationName = `social_test_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 12, application_name: applicationName });
  t.after(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${identitySchema} CASCADE`); }
    finally { await pool.end(); }
  });
  let store: SocialStore;
  const identity = new IdentityStore(pool, { schema: identitySchema,
    onPrincipalChange: async (db, participantId) => { await store.invalidateParticipant(db, participantId); },
  });
  await identity.migrate();
  const eventSources: EventSourceAdapter = { resolve: async (db, eventId) => {
    const event = await db.query<{ version: string; viewers: string[] }>(`SELECT version::text,viewers FROM ${schema}.fixture_events WHERE id=$1`, [eventId]);
    if (!event.rows[0]) return undefined;
    const roster = await db.query<{ participant_id: string }>(`SELECT participant_id FROM ${schema}.fixture_rsvps WHERE event_id=$1 AND state IN ('GOING','MAYBE') ORDER BY participant_id`, [eventId]);
    return { version: event.rows[0].version, rosterViewers: event.rows[0].viewers, participants: roster.rows.map((row) => row.participant_id) };
  } };
  store = new SocialStore(pool, { schema, identitySchema, assertOAuth: async () => {}, ...(events ? { eventSources } : {}) });
  await store.migrate();
  if (events) await pool.query(`
    CREATE TABLE ${schema}.fixture_events (id uuid PRIMARY KEY, version bigint NOT NULL, viewers uuid[] NOT NULL);
    CREATE TABLE ${schema}.fixture_rsvps (event_id uuid NOT NULL, participant_id uuid NOT NULL, state text NOT NULL, PRIMARY KEY(event_id,participant_id));
  `);
  const registrations = new Map<string, Registration>();
  async function actor(label: string): Promise<SocialActor> {
    const input: Registration = {
      accountId: await identity.newId(), participantId: await identity.newId(), emailHash: hash(`email:${label}`), emailCiphertext: `encrypted:${label}`,
      credential: { id: `credential:${label}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
      deviceName: label, deviceHash: hash(`device:${label}`), sessionHash: hash(`session:${label}`),
    };
    const session = await identity.register(input);
    registrations.set(session.accountId, input);
    return { ...session, participantId: input.participantId, clientId: 'first-party-test', scopes: ['circles:read', 'circles:write', 'conversations:read', 'conversations:write', 'events:read'] };
  }
  async function circle(owner: SocialActor, ...members: SocialActor[]) {
    let view = await store.createCircle(owner, await identity.newId());
    for (const member of members) {
      view = await store.inviteCircle(owner, view.id, member.participantId, view.revision);
      await store.acceptCircle(member, view.id, view.revision);
      view = await store.circle(owner, view.id);
    }
    return view;
  }
  async function waitForBlockedTransaction() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`, [applicationName]);
      if (result.rowCount) return;
      await delay(10);
    }
    assert.fail('competing transaction never reached the expected PostgreSQL lock');
  }
  return { store, identity, pool, schema, identitySchema, actor, circle, registrations, waitForBlockedTransaction, id: () => identity.newId() };
}

test('Social migration is concurrent and rejects unsafe SQL identifiers', integration, async (t) => {
  const { store, pool, identitySchema } = await fixture(t);
  await Promise.all([store.migrate(), store.migrate()]);
  for (const schema of ['unsafe.name', 'unsafe;DROP SCHEMA public', '', 'Upper']) {
    assert.throws(() => new SocialStore(pool, { schema, identitySchema, assertOAuth: async () => {} }), /SQL identifier/);
  }
});

test('Circle invitations need acceptance; roles protect the final owner and inaccessible circles are indistinguishable', integration, async (t) => {
  const { store, actor, id } = await fixture(t);
  const alice = await actor('alice'); const bob = await actor('bob'); const stranger = await actor('stranger');
  let circle = await store.createCircle(alice, await id());
  circle = await store.inviteCircle(alice, circle.id, bob.participantId, circle.revision);
  const invited = await store.circle(bob, circle.id);
  assert.equal(invited.state, 'INVITED');
  assert.equal(invited.members, undefined);
  await assert.rejects(store.preview(bob, [source('CIRCLE', circle.id)]), status(404));
  await assert.rejects(store.circle(stranger, circle.id), status(404));
  await assert.rejects(store.circle(stranger, await id()), status(404));
  await store.acceptCircle(bob, circle.id, circle.revision);
  circle = await store.circle(alice, circle.id);
  assert.equal((await store.circle(bob, circle.id)).state, 'ACTIVE');
  await assert.rejects(store.leaveCircle(alice, circle.id, circle.revision), conflict);
  await assert.rejects(store.circleRole(alice, circle.id, alice.participantId, 'MEMBER', circle.revision), conflict);
  await assert.rejects(store.circleRole(bob, circle.id, bob.participantId, 'OWNER', circle.revision), status(404));
  circle = await store.circleRole(alice, circle.id, bob.participantId, 'OWNER', circle.revision);
  await store.leaveCircle(alice, circle.id, circle.revision);
  assert.equal((await store.circle(bob, circle.id)).role, 'OWNER');
});

test('Circle administration confers no authority over an independent conversation; pending members receive no roster or content', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t);
  const admin = await actor('admin'); const alice = await actor('alice'); const bob = await actor('bob');
  await assert.rejects(store.preview(alice, [source('USER', bob.participantId)]), status(404));
  await circle(admin, alice, bob);
  const conversation = await store.createConversation(alice, await id(), [source('USER', bob.participantId)]);
  await assert.rejects(store.conversation(admin, conversation.id), status(404));
  await assert.rejects(store.setAudience(admin, conversation.id, [source('USER', admin.participantId)], conversation.revision), status(404));
  const member = await store.conversation(bob, conversation.id);
  assert.equal(member.memberState, 'PENDING'); assert.equal(member.sendGate, 'CLOSED');
  assert.equal(member.members, undefined); assert.equal(member.sources, undefined);
  let entered = false;
  await assert.rejects(store.withConversationAccess(bob, conversation.id, 'content', async () => { entered = true; }), (error: unknown) => error instanceof SocialError && error.code === 'crypto_not_ready');
  assert.equal(entered, false);
});

test('Audience union retains overlapping provenance, canonicalizes aliases, and applies exclusions after resolution', integration, async (t) => {
  const { store, actor, circle, pool, identitySchema, id } = await fixture(t);
  const alice = await actor('alice'); const bob = await actor('bob'); const carol = await actor('carol');
  const first = await circle(alice, bob); const second = await circle(alice, bob, carol);
  const sources = [source('CIRCLE', first.id), source('CIRCLE', second.id), source('USER', bob.participantId)];
  const preview = await store.preview(alice, sources);
  assert.equal(preview.eligible.filter((member) => member.participantId === bob.participantId).length, 1);
  assert.equal(preview.eligible.find((member) => member.participantId === bob.participantId)?.provenance.length, 3);
  const alias = await id();
  await pool.query(`INSERT INTO ${identitySchema}.participants (id) VALUES ($1)`, [alias]);
  await pool.query(`INSERT INTO ${identitySchema}.participant_aliases (alias_id,canonical_participant_id) VALUES ($1,$2)`, [alias, bob.participantId]);
  const excluded = await store.preview(alice, [...sources, source('USER', alias, 'EXCLUDE')]);
  assert.ok(excluded.excluded.includes(bob.participantId));
  assert.ok(!excluded.eligible.some((member) => member.participantId === bob.participantId || member.participantId === alias));
  const conversation = await store.createConversation(alice, await id(), sources);
  const oldInterval = conversation.members?.find((member) => member.participantId === bob.participantId)?.intervalId;
  await store.removeCircleMember(alice, first.id, bob.participantId, (await store.circle(alice, first.id)).revision);
  const after = await store.conversation(alice, conversation.id);
  assert.equal(after.members?.find((member) => member.participantId === bob.participantId)?.intervalId, oldInterval);
  assert.equal(after.members?.find((member) => member.participantId === bob.participantId)?.provenance.length, 2);
});

test('Self-leave survives audience replacement and explicit rejoin starts a fresh membership interval', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t);
  const alice = await actor('alice'); const bob = await actor('bob');
  const group = await circle(alice, bob);
  let conversation = await store.createConversation(alice, await id(), [source('CIRCLE', group.id)]);
  const initialInterval = conversation.members?.find((member) => member.participantId === bob.participantId)?.intervalId;
  await store.leaveConversation(bob, conversation.id, conversation.revision);
  const left = await store.conversation(bob, conversation.id);
  assert.equal(left.members, undefined); assert.equal(left.sources, undefined);
  await assert.rejects(store.withConversationAccess(bob, conversation.id, 'manage', async () => {}), status(404));
  conversation = await store.conversation(alice, conversation.id);
  conversation = await store.setAudience(alice, conversation.id, [source('CIRCLE', group.id), source('USER', alice.participantId), source('USER', bob.participantId)], conversation.revision);
  assert.ok(!conversation.members?.some((member) => member.participantId === bob.participantId));
  await store.rejoinConversation(bob, conversation.id, conversation.revision);
  const after = await store.conversation(alice, conversation.id);
  const rejoined = after.members?.find((member) => member.participantId === bob.participantId);
  assert.ok(initialInterval); assert.ok(rejoined); assert.notEqual(rejoined.intervalId, initialInterval);
  assert.equal(rejoined.state, 'PENDING'); assert.equal(after.sendGate, 'CLOSED');
});

test('Create retries retain identities, reject changed payloads, and cannot resurrect a deleted object; revisions prevent lost writes', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t);
  const alice = await actor('alice'); const bob = await actor('bob');
  await circle(alice, bob);
  const key = await id();
  const results = await Promise.all(Array.from({ length: 5 }, () => store.createConversation(alice, key, [source('USER', bob.participantId)])));
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  const conversation = results[0]!;
  await assert.rejects(store.createConversation(alice, key, []), conflict);
  const edits = await Promise.allSettled([
    store.setAudience(alice, conversation.id, [source('USER', alice.participantId)], conversation.revision),
    store.setAudience(alice, conversation.id, [source('USER', alice.participantId), source('USER', bob.participantId)], conversation.revision),
  ]);
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = edits.find((result) => result.status === 'rejected'); assert.ok(loser?.status === 'rejected' && conflict(loser.reason));
  await store.deleteConversation(alice, conversation.id, (await store.conversation(alice, conversation.id)).revision);
  await assert.rejects(store.createConversation(alice, key, [source('USER', bob.participantId)]), status(404));
  await assert.rejects(store.conversation(alice, conversation.id), status(404));
});

test('Upstream owner removal proceeds, ends eligibility and freezes orphaned conversation administration', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t);
  const circleOwner = await actor('circle-owner'); const owner = await actor('conversation-owner');
  const group = await circle(circleOwner, owner);
  let conversation = await store.createConversation(owner, await id(), [source('CIRCLE', group.id)]);
  conversation = await store.setAudience(owner, conversation.id, [source('CIRCLE', group.id)], conversation.revision);
  await assert.rejects(store.conversationRole(owner, conversation.id, owner.participantId, 'MEMBER', conversation.revision), conflict);
  await store.removeCircleMember(circleOwner, group.id, owner.participantId, (await store.circle(circleOwner, group.id)).revision);
  await assert.rejects(store.conversation(owner, conversation.id), status(404));
  const remaining = await store.conversation(circleOwner, conversation.id);
  assert.equal(remaining.orphaned, true); assert.equal(remaining.sendGate, 'CLOSED');
  await assert.rejects(store.conversationRole(circleOwner, conversation.id, circleOwner.participantId, 'OWNER', remaining.revision), (error: unknown) => error instanceof SocialError && [404, 409].includes(error.status));
});

// The production resolver is deliberately unavailable until #12; a SQL-backed server adapter
// proves eligibility/version integration without exposing any client-controlled roster endpoint.
test('Unavailable EVENT sources fail closed and SQL event changes remove only their own contribution', integration, async (t) => {
  const unavailable = await fixture(t);
  const user = await unavailable.actor('user');
  await assert.rejects(unavailable.store.preview(user, [source('EVENT', await unavailable.id())]), status(404));
  const { store, actor, circle, pool, schema, id } = await fixture(t, true);
  const alice = await actor('alice'); const bob = await actor('bob'); const carol = await actor('carol'); const stranger = await actor('stranger');
  await circle(alice, bob, carol);
  const event = await id();
  await pool.query(`INSERT INTO ${schema}.fixture_events VALUES ($1,1,$2)`, [event, [alice.participantId]]);
  for (const [member, state] of [[alice, 'GOING'], [bob, 'MAYBE'], [carol, 'DECLINED']] as const) {
    await pool.query(`INSERT INTO ${schema}.fixture_rsvps VALUES ($1,$2,$3)`, [event, member.participantId, state]);
  }
  await assert.rejects(store.preview(stranger, [source('EVENT', event)]), status(404));
  const preview = await store.preview(alice, [source('EVENT', event)]);
  assert.deepEqual(preview.eligible.map((member) => member.participantId).sort(), [alice.participantId, bob.participantId].sort());
  const sole = await store.createConversation(alice, await id(), [source('EVENT', event)]);
  const overlapping = await store.createConversation(alice, await id(), [source('EVENT', event), source('USER', bob.participantId)]);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${schema}:policy`]);
    await db.query(`UPDATE ${schema}.fixture_rsvps SET state='DECLINED' WHERE event_id=$1 AND participant_id=$2`, [event, bob.participantId]);
    await db.query(`UPDATE ${schema}.fixture_events SET version=version+1 WHERE id=$1`, [event]);
    await store.invalidateEvent(db, event);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  await assert.rejects(store.conversation(bob, sole.id), status(404));
  assert.equal((await store.conversation(bob, overlapping.id)).memberState, 'PENDING');
  const updated = await store.conversation(alice, overlapping.id);
  assert.deepEqual(updated.members?.find((member) => member.participantId === bob.participantId)?.provenance, [source('USER', bob.participantId)]);
  assert.notEqual(updated.generation, overlapping.generation);
});

test('A protected write and source removal serialize on PostgreSQL locks, then the removed owner cannot write', integration, async (t) => {
  const { store, actor, circle, pool, schema, id, waitForBlockedTransaction } = await fixture(t);
  const sourceOwner = await actor('source-owner'); const owner = await actor('conversation-owner');
  const group = await circle(sourceOwner, owner);
  let conversation = await store.createConversation(owner, await id(), [source('CIRCLE', group.id)]);
  conversation = await store.setAudience(owner, conversation.id, [source('CIRCLE', group.id)], conversation.revision);
  await pool.query(`CREATE TABLE ${schema}.fixture_writes (id int PRIMARY KEY)`);
  const entered = deferred(); const release = deferred();
  const write = store.withConversationAccess(owner, conversation.id, 'manage', async (db) => {
    await db.query(`INSERT INTO ${schema}.fixture_writes VALUES (1)`); entered.resolve(); await release.promise;
  });
  await entered.promise;
  const removal = store.removeCircleMember(sourceOwner, group.id, owner.participantId, group.revision);
  try { await waitForBlockedTransaction(); } finally { release.resolve(); }
  await Promise.all([write, removal]);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.fixture_writes`)).rows[0].count, 1);
  await assert.rejects(store.withConversationAccess(owner, conversation.id, 'manage', async (db) => { await db.query(`INSERT INTO ${schema}.fixture_writes VALUES (2)`); }), status(404));
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.fixture_writes`)).rows[0].count, 1);
});

test('Device revocation waits for the protected account transaction, then rejects the previously verified actor', integration, async (t) => {
  const { store, identity, actor, registrations, pool, schema, id, waitForBlockedTransaction } = await fixture(t);
  const owner = await actor('owner'); const input = registrations.get(owner.accountId)!;
  const secondSession = await identity.authenticateCredential({ credentialId: input.credential.id, expectedCounter: 0, newCounter: 1, deviceHash: hash('second-device'), deviceName: 'second', sessionHash: hash('second-session') });
  const conversation = await store.createConversation(owner, await id(), []);
  const entered = deferred(); const release = deferred();
  const write = store.withConversationAccess(owner, conversation.id, 'manage', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const revoke = identity.revokeDevice(secondSession, owner.deviceId);
  try { await waitForBlockedTransaction(); } finally { release.resolve(); }
  await Promise.all([write, revoke]);
  // Inspect immediately, before any social read can lazily reconcile: the identity
  // transaction must have advanced the policy generation before committing revoke.
  const committed = (await pool.query(`SELECT generation::text,send_gate FROM ${schema}.conversations WHERE id=$1`, [conversation.id])).rows[0];
  assert.notEqual(committed.generation, conversation.generation);
  assert.equal(committed.send_gate, 'CLOSED');
  assert.equal(await identity.isSessionActive(owner), false);
  await assert.rejects(store.withConversationAccess(owner, conversation.id, 'manage', async () => {}), status(401));
});

test('Stale ACTIVE materialization never authorizes a participant absent from current source policy', integration, async (t) => {
  const { store, actor, pool, schema, id } = await fixture(t);
  const owner = await actor('owner'); const stranger = await actor('stranger');
  const conversation = await store.createConversation(owner, await id(), []);
  await pool.query(`INSERT INTO ${schema}.membership_intervals (conversation_id,participant_id,state,generation,provenance) VALUES ($1,$2,'ACTIVE',1,'[]')`, [conversation.id, stranger.participantId]);
  let accessed = false;
  await assert.rejects(store.withConversationAccess(stranger, conversation.id, 'content', async () => { accessed = true; }), status(404));
  await assert.rejects(store.conversation(stranger, conversation.id), status(404));
  assert.equal(accessed, false);
  const current = await store.conversation(owner, conversation.id);
  assert.equal(current.sendGate, 'CLOSED');
  assert.ok(!current.members?.some((member) => member.participantId === stranger.participantId));
});

test('Existing conversation USER sources remain manageable after the common circle is deleted', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t);
  const alice = await actor('alice'); const bob = await actor('bob'); const stranger = await actor('stranger');
  const common = await circle(alice, bob);
  const sources = [source('USER', alice.participantId), source('USER', bob.participantId)];
  const conversation = await store.createConversation(alice, await id(), sources);
  await store.deleteCircle(alice, common.id, common.revision);
  const outcomes = await Promise.allSettled([
    store.setAudience(alice, conversation.id, sources, conversation.revision),
    store.preview(alice, sources, conversation.id),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
  await assert.rejects(store.preview(alice, [...sources, source('USER', stranger.participantId)], conversation.id), status(404));
});

test('Self-left conversation metadata omits live generation, orphan status and role in get and list', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t);
  const alice = await actor('alice'); const bob = await actor('bob');
  await circle(alice, bob);
  const conversation = await store.createConversation(alice, await id(), [source('USER', bob.participantId)]);
  await store.leaveConversation(bob, conversation.id, conversation.revision);
  for (const left of [await store.conversation(bob, conversation.id), ...(await store.listConversations(bob))]) {
    assert.equal(left.id, conversation.id);
    assert.deepEqual(Object.keys(left).sort(), ['id', 'revision', 'createdAt', 'memberState', 'sendGate'].sort());
  }
});

test('Audience source resolution requires source scopes in addition to conversation authority', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t, true);
  const alice = await actor('alice'); const group = await circle(alice);
  const restricted = { ...alice, scopes: ['conversations:read', 'conversations:write'] };
  const circleKey = await id(); const eventId = await id(); const eventKey = await id();
  const outcomes = await Promise.allSettled([
    store.preview(restricted, [source('CIRCLE', group.id)]),
    store.createConversation(restricted, circleKey, [source('CIRCLE', group.id)]),
    store.preview(restricted, [source('EVENT', eventId)]),
    store.createConversation(restricted, eventKey, [source('EVENT', eventId)]),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status === 'rejected' && outcome.reason instanceof SocialError ? outcome.reason.status : outcome.status), [403, 403, 403, 403]);
});

test('Canonical removal and role demotion update every alias-backed row rather than leaving hidden authority', integration, async (t) => {
  const { store, actor, circle, pool, schema, identitySchema, id } = await fixture(t);
  const alice = await actor('alice'); const bob = await actor('bob');
  const group = await circle(alice, bob);
  let conversation = await store.createConversation(alice, await id(), [source('CIRCLE', group.id), source('USER', bob.participantId)]);
  conversation = await store.conversationRole(alice, conversation.id, bob.participantId, 'OWNER', conversation.revision);
  const alias = await id();
  await pool.query(`INSERT INTO ${identitySchema}.participants (id) VALUES ($1)`, [alias]);
  await pool.query(`INSERT INTO ${identitySchema}.participant_aliases (alias_id,canonical_participant_id) VALUES ($1,$2)`, [alias, bob.participantId]);
  await pool.query(`INSERT INTO ${schema}.circle_memberships (circle_id,participant_id,role,state) VALUES ($1,$2,'MEMBER','ACTIVE')`, [group.id, alias]);
  await pool.query(`INSERT INTO ${schema}.conversation_roles (conversation_id,participant_id,role) VALUES ($1,$2,'OWNER')`, [conversation.id, alias]);
  await store.conversationRole(alice, conversation.id, bob.participantId, 'MEMBER', conversation.revision);
  assert.equal((await store.conversation(bob, conversation.id)).role, 'MEMBER');
  const roles = (await pool.query(`SELECT role FROM ${schema}.conversation_roles WHERE conversation_id=$1 AND participant_id=ANY($2::uuid[])`, [conversation.id, [bob.participantId, alias]])).rows;
  assert.deepEqual(roles.map((row) => row.role), ['MEMBER', 'MEMBER']);
  await store.removeCircleMember(alice, group.id, bob.participantId, group.revision);
  const memberships = (await pool.query(`SELECT state FROM ${schema}.circle_memberships WHERE circle_id=$1 AND participant_id=ANY($2::uuid[])`, [group.id, [bob.participantId, alias]])).rows;
  assert.deepEqual(memberships.map((row) => row.state), ['REMOVED', 'REMOVED']);
  await assert.rejects(store.circle(bob, group.id), status(404));
});

test('A conversation administrator cannot exclude an owner even when a second owner remains eligible', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t);
  const alice = await actor('alice'); const bob = await actor('bob'); const admin = await actor('admin');
  await circle(alice, bob, admin);
  const sources = [source('USER', alice.participantId), source('USER', bob.participantId), source('USER', admin.participantId)];
  let conversation = await store.createConversation(alice, await id(), sources);
  conversation = await store.conversationRole(alice, conversation.id, bob.participantId, 'OWNER', conversation.revision);
  conversation = await store.conversationRole(alice, conversation.id, admin.participantId, 'ADMIN', conversation.revision);
  await assert.rejects(store.setAudience(admin, conversation.id, [...sources, source('USER', alice.participantId, 'EXCLUDE')], conversation.revision), status(404));
  assert.equal((await store.conversation(alice, conversation.id)).role, 'OWNER');
  assert.equal((await store.conversation(bob, conversation.id)).role, 'OWNER');
});

test('An unavailable exclusion source closes the whole audience until the event authority returns', integration, async (t) => {
  const { store, actor, circle, pool, schema, id } = await fixture(t, true);
  const alice = await actor('alice'); const bob = await actor('bob');
  await circle(alice, bob);
  const event = await id();
  await pool.query(`INSERT INTO ${schema}.fixture_events VALUES ($1,1,$2)`, [event, [alice.participantId]]);
  await pool.query(`INSERT INTO ${schema}.fixture_rsvps VALUES ($1,$2,'GOING')`, [event, bob.participantId]);
  const conversation = await store.createConversation(alice, await id(), [source('USER', bob.participantId), source('EVENT', event, 'EXCLUDE')]);
  await assert.rejects(store.conversation(bob, conversation.id), status(404));
  async function updateEvent(query: string, params: unknown[]) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${schema}:policy`]);
      await db.query(query, params); await store.invalidateEvent(db, event); await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  await updateEvent(`DELETE FROM ${schema}.fixture_events WHERE id=$1`, [event]);
  const unavailable = await Promise.allSettled([store.conversation(alice, conversation.id), store.conversation(bob, conversation.id)]);
  assert.deepEqual(unavailable.map((outcome) => outcome.status === 'rejected' && outcome.reason instanceof SocialError ? outcome.reason.status : outcome.status), [404, 404]);
  await updateEvent(`INSERT INTO ${schema}.fixture_events VALUES ($1,2,$2)`, [event, [alice.participantId]]);
  assert.equal((await store.conversation(alice, conversation.id)).memberState, 'PENDING');
  await assert.rejects(store.conversation(bob, conversation.id), status(404));
  await updateEvent(`WITH changed AS (UPDATE ${schema}.fixture_rsvps SET state='DECLINED' WHERE event_id=$1 RETURNING event_id) UPDATE ${schema}.fixture_events SET version=version+1 WHERE id=$1`, [event]);
  assert.equal((await store.conversation(bob, conversation.id)).memberState, 'PENDING');
});

test('Conversation context does not grant access to a circle roster after source membership is removed', integration, async (t) => {
  const { store, actor, circle, id } = await fixture(t);
  const alice = await actor('alice'); const sourceOwner = await actor('source-owner');
  const group = await circle(sourceOwner, alice);
  const sources = [source('USER', alice.participantId), source('CIRCLE', group.id)];
  const conversation = await store.createConversation(alice, await id(), sources);
  await store.removeCircleMember(sourceOwner, group.id, alice.participantId, group.revision);
  assert.equal((await store.conversation(alice, conversation.id)).role, 'OWNER');
  await assert.rejects(store.preview(alice, sources, conversation.id), status(404));
  await assert.rejects(store.setAudience(alice, conversation.id, sources, conversation.revision), status(404));
  const withoutSource = await store.setAudience(alice, conversation.id, [source('USER', alice.participantId)], conversation.revision);
  assert.deepEqual(withoutSource.members?.map((member) => member.participantId), [alice.participantId]);
});
