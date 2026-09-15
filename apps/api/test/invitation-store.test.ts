import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { digest, keyed, protectEmail, type IdentityConfig } from '../src/identity/config.js';
import { IdentityStore, type Registration } from '../src/identity/store.js';
import { InvitationStore } from '../src/invitations/store.js';
import { InvitationError, type Target, type Delivery } from '../src/invitations/types.js';
import { SocialStore } from '../src/social/store.js';
import { SocialError, type SocialActor, type Source } from '../src/social/types.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for isolated PostgreSQL integration tests' };
const denied = (error: unknown) => (error instanceof InvitationError || error instanceof SocialError) && [401,403,404,409].includes(error.status);
const source = (id: string, operation: Source['operation'] = 'INCLUDE'): Source => ({ type: 'USER', id, operation });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const suffix = randomBytes(8).toString('hex');
  const schema = `invitation_test_${suffix}`;
  const socialSchema = `invite_social_${suffix}`;
  const identitySchema = `invite_identity_${suffix}`;
  const applicationName = `invite_test_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 12, application_name: applicationName });
  t.after(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${socialSchema} CASCADE; DROP SCHEMA IF EXISTS ${identitySchema} CASCADE`); }
    finally { await pool.end(); }
  });
  const config: IdentityConfig = { origin: 'http://localhost:3000', rpId: 'localhost', mode: 'local', encryptionKey: randomBytes(32), lookupKey: randomBytes(32), smtp: { host: 'localhost', port: 1025, secure: false, from: 'no-reply@example.test' } };
  let social: SocialStore;
  const identity = new IdentityStore(pool, { schema: identitySchema, onPrincipalChange: async (db, participantId) => { await social.invalidateParticipant(db, participantId); } });
  await identity.migrate();
  const revokedClients = new Set<string>();
  const assertOAuth = async (db: PoolClient, actor: SocialActor) => {
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`${schema}:oauth:${actor.clientId}`]);
    if (revokedClients.has(actor.clientId)) throw new SocialError(401, 'invalid_token');
  };
  social = new SocialStore(pool, { schema: socialSchema, identitySchema, assertOAuth });
  await social.migrate();
  const store = new InvitationStore(pool, social, config, { schema, identitySchema });
  await store.migrate();
  const registrations = new Map<string, Registration>();
  async function registration(label: string, email = `${label}@example.test`): Promise<Registration> {
    return { accountId: await identity.newId(), participantId: await identity.newId(), emailHash: keyed(config, 'email', email), emailCiphertext: protectEmail(config, email), credential: { id: `credential:${label}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] }, deviceName: label, deviceHash: digest(`device:${label}`), sessionHash: digest(`session:${label}`) };
  }
  async function actor(label: string, email?: string): Promise<SocialActor> {
    const input = await registration(label, email);
    const session = await identity.register(input);
    registrations.set(session.accountId, input);
    return { ...session, participantId: input.participantId, clientId: 'first-party-test', scopes: ['profile:write', 'circles:read', 'circles:write', 'conversations:read', 'conversations:write'] };
  }
  async function circle(owner: SocialActor, ...members: SocialActor[]) {
    let view = await social.createCircle(owner, await identity.newId());
    for (const member of members) {
      view = await social.inviteCircle(owner, view.id, member.participantId, view.revision);
      await social.acceptCircle(member, view.id, view.revision);
      view = await social.circle(owner, view.id);
    }
    return view;
  }
  async function blocked() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`, [applicationName]);
      if (result.rowCount) return;
      await delay(10);
    }
    assert.fail('competing transaction did not reach its PostgreSQL lock');
  }
  async function invite(sender: SocialActor, target: Target, email: string) {
    const resource = target.type === 'CIRCLE' ? await social.circle(sender, target.id) : await social.conversation(sender, target.id);
    const result = await store.create(sender, { target, email, operationKey: await identity.newId(), expectedRevision: resource.revision });
    assert.ok(result.delivery);
    return { ...result, delivery: result.delivery };
  }
  async function proof(recipient: SocialActor, delivery: Delivery) {
    const result = await store.requestProof(recipient, { token: delivery.token, email: delivery.email });
    assert.ok(result.delivery, 'a valid invitation must issue fresh proof');
    return result.delivery.token;
  }
  async function accept(recipient: SocialActor, delivery: Delivery, code?: string) {
    return store.accept(recipient, { token: delivery.token, email: delivery.email, code: code ?? await proof(recipient, delivery), confirmAccept: true });
  }
  return { store, identity, social, pool, schema, socialSchema, identitySchema, config, actor, registration, registrations, circle, blocked, revokedClients, invite, proof, accept, id: () => identity.newId() };
}

test('Invitation migration is concurrent and unsafe schema identifiers are rejected', integration, async (t) => {
  const { store, pool, social, config, identitySchema } = await fixture(t);
  await Promise.all([store.migrate(), store.migrate()]);
  for (const schema of ['bad.schema', 'x;DROP SCHEMA public', '', 'Upper']) {
    assert.throws(() => new InvitationStore(pool, social, config, { schema, identitySchema }), /SQL identifier/);
  }
});

test('An invitation grants nothing before explicit proof and accepts only its selected circle', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const first = await f.circle(alice); const other = await f.circle(alice);
  const email = 'bob@example.test';
  const selected = await f.invite(alice, { type: 'CIRCLE', id: first.id }, email);
  const untouched = await f.invite(alice, { type: 'CIRCLE', id: other.id }, email);
  assert.equal((await f.social.circle(alice, first.id)).members?.length, 1);
  assert.deepEqual(await f.social.listCircles(bob), []);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.identitySchema}.participant_aliases`)).rows[0].n, 0);
  const code = await f.proof(bob, selected.delivery);
  await assert.rejects(f.store.accept(bob, { token: selected.delivery.token, email, code, confirmAccept: false }), (error: unknown) => error instanceof InvitationError && error.status === 400 && error.code === 'confirmation_required');
  assert.equal((await f.identity.findIdentity(keyed(f.config, 'email', email)))?.accountId, bob.accountId);
  assert.deepEqual(await f.accept(bob, selected.delivery, code), { target: { type: 'CIRCLE', id: first.id } });
  assert.equal((await f.social.circle(bob, first.id)).state, 'ACTIVE');
  assert.equal((await f.social.circle(bob, first.id)).role, 'MEMBER');
  await assert.rejects(f.social.circle(bob, other.id), denied);
  const aliases = (await f.pool.query(`SELECT * FROM ${f.identitySchema}.participant_aliases`)).rows;
  assert.equal(aliases.length, 1); assert.equal(aliases[0].canonical_participant_id, bob.participantId);
  const invited = (await f.pool.query(`SELECT pending_participant_id FROM ${f.schema}.invitations WHERE id=$1`, [selected.invitation.id])).rows[0];
  assert.equal(aliases[0].alias_id, invited.pending_participant_id);
  assert.ok((await f.pool.query(`SELECT 1 FROM ${f.identitySchema}.participants WHERE id=$1`, [invited.pending_participant_id])).rowCount);
  assert.equal((await f.identity.findIdentity(keyed(f.config, 'email', email)))?.accountId, bob.accountId);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.identitySchema}.identities WHERE account_id=$1`, [bob.accountId])).rows[0].n, 1);
  const claims = (await f.pool.query(`SELECT * FROM ${f.schema}.claims`)).rows;
  assert.equal(claims.length, 1); assert.equal(claims[0].original_participant_id, invited.pending_participant_id);
  assert.equal(claims[0].canonical_participant_id, bob.participantId);
  assert.equal((await f.store.list(alice)).find(view => view.id === untouched.invitation.id)?.state, 'PENDING');
  await assert.rejects(f.accept(bob, selected.delivery, code), denied);
});

test('Invitation acceptance retains conversation exclusions, durable self-leave and existing roles', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  await f.circle(alice, bob);
  const excluded = await f.social.createConversation(alice, await f.id(), [source(bob.participantId, 'EXCLUDE')]);
  const excludedInvite = await f.invite(alice, { type: 'CONVERSATION', id: excluded.id }, 'bob@example.test');
  await f.accept(bob, excludedInvite.delivery);
  assert.ok(!(await f.social.conversation(alice, excluded.id)).members?.some(member => member.participantId === bob.participantId));
  await assert.rejects(f.social.conversation(bob, excluded.id), denied);
  const left = await f.social.createConversation(alice, await f.id(), [source(bob.participantId)]);
  await f.social.leaveConversation(bob, left.id, left.revision);
  const leftInvite = await f.invite(alice, { type: 'CONVERSATION', id: left.id }, 'bob@example.test');
  await f.accept(bob, leftInvite.delivery);
  assert.ok(!(await f.social.conversation(alice, left.id)).members?.some(member => member.participantId === bob.participantId));
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.socialSchema}.self_exclusions WHERE conversation_id=$1 AND participant_id=$2`, [left.id, bob.participantId])).rows[0].n, 1);
  let promoted = await f.social.createConversation(alice, await f.id(), [source(bob.participantId)]);
  promoted = await f.social.conversationRole(alice, promoted.id, bob.participantId, 'ADMIN', promoted.revision);
  const roleInvite = await f.invite(alice, { type: 'CONVERSATION', id: promoted.id }, 'bob@example.test');
  await f.accept(bob, roleInvite.delivery);
  const view = await f.social.conversation(bob, promoted.id);
  assert.equal(view.role, 'ADMIN'); assert.equal(view.sendGate, 'CLOSED'); assert.equal(view.memberState, 'PENDING');
  const aliasId = (await f.pool.query(`SELECT pending_participant_id FROM ${f.schema}.invitations WHERE id=$1`, [roleInvite.invitation.id])).rows[0].pending_participant_id;
  assert.ok((await f.pool.query(`SELECT 1 FROM ${f.socialSchema}.audience_sources WHERE conversation_id=$1 AND source_id=$2`, [promoted.id, aliasId])).rowCount, 'historical invitation participant stays the source ID');

});

test('Accepting an invitation to an existing circle preserves its owner role', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.circle(alice, bob);
  await f.social.circleRole(alice, circle.id, bob.participantId, 'OWNER', circle.revision);
  const circleInvite = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  await f.accept(bob, circleInvite.delivery);
  assert.equal((await f.social.circle(bob, circle.id)).role, 'OWNER');
});

test('Fresh proof is bound to actor, application, device, session, email, purpose and exact invitation', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob'); const carol = await f.actor('carol');
  const first = await f.circle(alice); const second = await f.circle(alice);
  const invitation = await f.invite(alice, { type: 'CIRCLE', id: first.id }, 'bob@example.test');
  const other = await f.invite(alice, { type: 'CIRCLE', id: second.id }, 'bob@example.test');
  const code = await f.proof(bob, invitation.delivery);
  await assert.rejects(f.accept(carol, invitation.delivery, code), denied);
  await assert.rejects(f.accept({ ...bob, clientId: 'other-client' }, invitation.delivery, code), denied);
  await assert.rejects(f.accept({ ...bob, deviceId: carol.deviceId }, invitation.delivery, code), denied);
  await assert.rejects(f.accept({ ...bob, sessionId: carol.sessionId }, invitation.delivery, code), denied);
  await assert.rejects(f.accept(bob, { ...invitation.delivery, email: 'different@example.test' }, code), denied);
  await assert.rejects(f.accept(bob, other.delivery, code), denied);
  const registrationCode = randomBytes(32).toString('base64url');
  await f.identity.putChallenge(digest(registrationCode), 'email', digest('browser'), { purpose: 'register' }, 60);
  await assert.rejects(f.accept(bob, invitation.delivery, registrationCode), denied);
  await f.pool.query(`UPDATE ${f.schema}.proofs SET target_id=$2 WHERE id=$1`, [digest(code), second.id]);
  await assert.rejects(f.accept(bob, invitation.delivery, code), denied);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.claims`)).rows[0].n, 0);
  await f.pool.query(`UPDATE ${f.schema}.proofs SET target_id=$2 WHERE id=$1`, [digest(code), first.id]);
  await f.accept(bob, invitation.delivery, code);
});

test('Malformed, unknown and mismatched proof requests return the same empty result and cannot mutate membership', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.circle(alice); const invitation = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  for (const input of [{ token: randomBytes(32).toString('base64url'), email: 'bob@example.test' }, { token: invitation.delivery.token, email: 'wrong@example.test' }]) {
    assert.deepEqual(await f.store.requestProof(bob, input), {});
  }
  assert.equal((await f.social.circle(alice, circle.id)).members?.length, 1);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.proofs`)).rows[0].n, 0);
});

test('Resend rotates credentials and proof; expiry, revocation and consumption cannot be replayed', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.circle(alice); const invitation = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  const oldProof = await f.proof(bob, invitation.delivery);
  const resend = await f.store.resend(alice, invitation.invitation.id, invitation.invitation.revision);
  assert.ok(resend.delivery); assert.notEqual(resend.delivery.token, invitation.delivery.token);
  await assert.rejects(f.accept(bob, invitation.delivery, oldProof), denied);
  await assert.rejects(f.accept(bob, resend.delivery, oldProof), denied);
  assert.deepEqual(await f.store.requestProof(bob, { token: invitation.delivery.token, email: invitation.delivery.email }), {});
  const proof = await f.proof(bob, resend.delivery);
  await f.pool.query(`UPDATE ${f.schema}.proofs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [digest(proof)]);
  await assert.rejects(f.accept(bob, resend.delivery, proof), denied);
  const fresh = await f.proof(bob, resend.delivery);
  await f.store.revoke(alice, resend.invitation.id, resend.invitation.revision);
  await assert.rejects(f.accept(bob, resend.delivery, fresh), denied);
  const expiringActor = await f.actor('expiring');
  const expiring = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'expiring@example.test');
  const expiryProof = await f.proof(expiringActor, expiring.delivery);
  await f.pool.query(`UPDATE ${f.schema}.invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [expiring.invitation.id]);
  await assert.rejects(f.accept(expiringActor, expiring.delivery, expiryProof), denied);
  assert.equal((await f.social.circle(alice, circle.id)).members?.length, 1);
});

test('Create operation replay rechecks authority, payload and resource; concurrent create stores one invitation', integration, async (t) => {
  const f = await fixture(t); const owner = await f.actor('owner'); const admin = await f.actor('admin');
  let circle = await f.circle(owner, admin);
  circle = await f.social.circleRole(owner, circle.id, admin.participantId, 'ADMIN', circle.revision);
  const input = { target: { type: 'CIRCLE', id: circle.id } as Target, email: 'recipient@example.test', operationKey: await f.id(), expectedRevision: circle.revision };
  const results = await Promise.all(Array.from({ length: 4 }, () => f.store.create(admin, input)));
  assert.equal(new Set(results.map(r => r.invitation.id)).size, 1);
  assert.equal(results.filter(r => r.delivery).length, 1);
  await assert.rejects(f.store.create(admin, { ...input, email: 'changed@example.test' }), denied);
  await f.social.circleRole(owner, circle.id, admin.participantId, 'MEMBER', circle.revision);
  await assert.rejects(f.store.create(admin, input), denied);
  await assert.rejects(f.store.resend(admin, results[0]!.invitation.id, results[0]!.invitation.revision), denied);
});

test('Delivery acknowledgement cannot publish a stale send; failed intent stays retryable without persisting secrets', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.circle(alice); const invitation = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  const committed = await f.pool.query(`SELECT delivery FROM ${f.schema}.invitations WHERE id=$1`, [invitation.invitation.id]);
  assert.equal(committed.rows[0].delivery, 'PENDING');
  await f.store.recordDelivery(invitation.delivery, false);
  assert.equal((await f.store.list(alice))[0]?.delivery, 'FAILED');
  const resend = await f.store.resend(alice, invitation.invitation.id, invitation.invitation.revision);
  assert.ok(resend.delivery);
  await f.store.recordDelivery(invitation.delivery, true);
  assert.equal((await f.store.list(alice))[0]?.delivery, 'PENDING');
  await f.store.recordDelivery(resend.delivery, true);
  assert.equal((await f.store.list(alice))[0]?.delivery, 'SENT');
  const proof = await f.proof(bob, resend.delivery);
  for (const table of ['invitations', 'proofs', 'operations', 'claims']) {
    const serialized = JSON.stringify((await f.pool.query(`SELECT * FROM ${f.schema}.${table}`)).rows);
    for (const secret of [invitation.delivery.token, resend.delivery.token, proof, 'bob@example.test']) assert.ok(!serialized.includes(secret), `${table} must not persist raw secrets or email`);
  }
});

test('Owned email conflicts never merge accounts and concurrent acceptance has one consumer', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob'); const carol = await f.actor('carol');
  const circle = await f.circle(alice);
  const owned = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'carol@example.test');
  const ownedProof = await f.proof(bob, owned.delivery);
  await assert.rejects(f.accept(bob, owned.delivery, ownedProof), denied);
  assert.equal((await f.identity.findIdentity(keyed(f.config, 'email', 'carol@example.test')))?.accountId, carol.accountId);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.identitySchema}.participant_aliases`)).rows[0].n, 0);
  const invitation = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  const code = await f.proof(bob, invitation.delivery);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.accept(bob, invitation.delivery, code)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.claims`)).rows[0].n, 1);
});

test('A duplicate registration racing invitation acceptance cannot take the recipient identity', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.circle(alice); const email = 'bob@example.test';
  const invitation = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, email);
  const code = await f.proof(bob, invitation.delivery); const registration = await f.registration('registration', email);
  const results = await Promise.allSettled([f.accept(bob, invitation.delivery, code), f.identity.register(registration)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal((await f.identity.findIdentity(keyed(f.config, 'email', email)))?.accountId, bob.accountId);
  const accounts = (await f.pool.query(`SELECT count(*)::int AS n FROM ${f.identitySchema}.accounts`)).rows[0].n;
  const participants = (await f.pool.query(`SELECT count(*)::int AS n FROM ${f.identitySchema}.participants`)).rows[0].n;
  assert.equal(accounts, 2);
  assert.equal(participants, accounts + 1, 'only the durable invitation pending participant is unowned');
});

test('Proof delivery is bounded per recipient and inviter issuance cannot bypass its quota', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.circle(alice); const invitation = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  const results = await Promise.all(Array.from({ length: 8 }, () => f.store.requestProof(bob, { token: invitation.delivery.token, email: invitation.delivery.email })));
  assert.equal(results.filter(result => result.delivery).length, 3);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.proofs`)).rows[0].n, 3);
  const second = await f.store.resend(alice, invitation.invitation.id, invitation.invitation.revision);
  const third = await f.store.resend(alice, invitation.invitation.id, second.invitation.revision);
  await assert.rejects(f.store.resend(alice, invitation.invitation.id, third.invitation.revision), (error: unknown) => error instanceof InvitationError && error.status === 429);
  assert.equal((await f.store.list(alice))[0]?.revision, third.invitation.revision);
});

for (const change of ['demotion', 'deletion', 'revocation'] as const) {
  test(`A ${change} committed ahead of acceptance denies the claim under the same policy lock`, integration, async (t) => {
    const f = await fixture(t); const owner = await f.actor('owner'); const sender = await f.actor('sender'); const recipient = await f.actor('recipient');
    let circle = await f.circle(owner, sender);
    circle = await f.social.circleRole(owner, circle.id, sender.participantId, 'ADMIN', circle.revision);
    const invitation = await f.invite(sender, { type: 'CIRCLE', id: circle.id }, 'recipient@example.test');
    const code = await f.proof(recipient, invitation.delivery);
    const gate = await f.pool.connect();
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${f.socialSchema}:policy`]);
    try {
      const mutation = change === 'demotion' ? f.social.circleRole(owner, circle.id, sender.participantId, 'MEMBER', circle.revision)
        : change === 'deletion' ? f.social.deleteCircle(owner, circle.id, circle.revision)
        : f.store.revoke(sender, invitation.invitation.id, invitation.invitation.revision);
      await f.blocked();
      const acceptance = f.accept(recipient, invitation.delivery, code);
      const result = assert.rejects(acceptance, denied);
      await gate.query('COMMIT');
      await mutation; await result;
    } finally { await gate.query('ROLLBACK'); gate.release(); }
    assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.claims`)).rows[0].n, 0);
    assert.equal((await f.identity.findIdentity(keyed(f.config, 'email', 'recipient@example.test')))?.accountId, recipient.accountId);
    assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.identitySchema}.participant_aliases`)).rows[0].n, 0);
  });
}

test('Device and OAuth revocation block proof acceptance before any identity or audience change', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.circle(alice); const invitation = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  const code = await f.proof(bob, invitation.delivery);
  const input = f.registrations.get(bob.accountId)!;
  const replacement = await f.identity.authenticateCredential({ credentialId: input.credential.id, expectedCounter: 0, newCounter: 1, deviceHash: digest('replacement-device'), deviceName: 'replacement', sessionHash: digest('replacement-session') });
  await f.identity.revokeDevice(replacement, bob.deviceId);
  await assert.rejects(f.accept(bob, invitation.delivery, code), denied);
  const current = { ...bob, ...replacement };
  const currentCode = await f.proof(current, invitation.delivery);
  const gate = await f.pool.connect(); await gate.query('BEGIN');
  await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${f.schema}:oauth:${current.clientId}`]);
  try {
    const acceptance = f.accept(current, invitation.delivery, currentCode); const result = assert.rejects(acceptance, denied);
    await f.blocked(); f.revokedClients.add(current.clientId);
    await gate.query('COMMIT'); await result;
  } finally { await gate.query('ROLLBACK'); gate.release(); }
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.claims`)).rows[0].n, 0);
});

test('Acceptance already holding the policy lock commits before a later inviter demotion', integration, async (t) => {
  const f = await fixture(t); const owner = await f.actor('owner'); const sender = await f.actor('sender'); const bob = await f.actor('bob');
  let circle = await f.circle(owner, sender);
  circle = await f.social.circleRole(owner, circle.id, sender.participantId, 'ADMIN', circle.revision);
  const invitation = await f.invite(sender, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  const code = await f.proof(bob, invitation.delivery);
  const entered = deferred(); const release = deferred();
  const original = f.social.acceptInvitation.bind(f.social);
  f.social.acceptInvitation = async (db, participantId, target) => { entered.resolve(); await release.promise; await original(db, participantId, target); };
  const acceptance = f.accept(bob, invitation.delivery, code);
  await entered.promise;
  const demotion = f.social.circleRole(owner, circle.id, sender.participantId, 'MEMBER', circle.revision);
  const demotionResult = assert.rejects(demotion, (error: unknown) => error instanceof SocialError && error.code === 'revision_conflict');
  await f.blocked(); release.resolve();
  await acceptance; await demotionResult;
  const updated = await f.social.circle(owner, circle.id);
  await f.social.circleRole(owner, circle.id, sender.participantId, 'MEMBER', updated.revision);
  assert.equal((await f.social.circle(bob, circle.id)).state, 'ACTIVE');
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.claims`)).rows[0].n, 1);
});

test('Delegated OAuth plus attacker email proof cannot install a victim recovery email through invitation acceptance', integration, async (t) => {
  const f = await fixture(t); const attacker = await f.actor('attacker'); const victim = await f.actor('victim');
  const target = await f.circle(attacker);
  const invitation = await f.invite(attacker, { type: 'CIRCLE', id: target.id }, 'attacker-controlled@example.test');
  const delegatedVictim = { ...victim, clientId: 'delegated-third-party' };
  const code = await f.proof(delegatedVictim, invitation.delivery);
  await assert.rejects(f.accept(delegatedVictim, invitation.delivery, code), denied);
  assert.equal(await f.identity.findIdentity(keyed(f.config, 'email', invitation.delivery.email)), undefined);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.claims`)).rows[0].n, 0);
});

test('A conflicting historical participant alias cannot be reassigned by fresh email proof', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob'); const carol = await f.actor('carol');
  const circle = await f.circle(alice); const invitation = await f.invite(alice, { type: 'CIRCLE', id: circle.id }, 'bob@example.test');
  const code = await f.proof(bob, invitation.delivery);
  const originalId = (await f.pool.query(`SELECT pending_participant_id FROM ${f.schema}.invitations WHERE id=$1`, [invitation.invitation.id])).rows[0].pending_participant_id;
  await f.social.withPolicy(carol, async db => {
    await db.query(`INSERT INTO ${f.identitySchema}.participant_aliases(alias_id,canonical_participant_id) VALUES($1,$2)`, [originalId, carol.participantId]);
    await f.social.invalidateParticipant(db, carol.participantId);
  });
  await assert.rejects(f.accept(bob, invitation.delivery, code), denied);
  assert.equal((await f.pool.query(`SELECT canonical_participant_id FROM ${f.identitySchema}.participant_aliases WHERE alias_id=$1`, [originalId])).rows[0].canonical_participant_id, carol.participantId);
  assert.equal((await f.social.circle(alice, circle.id)).members?.length, 1);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.claims`)).rows[0].n, 0);
});

test('Invitation creation and acceptance require current resource scopes and profile consent', integration, async (t) => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.circle(alice);
  const target: Target = { type: 'CIRCLE', id: circle.id };
  await assert.rejects(f.store.create({ ...alice, scopes: ['circles:read'] }, { target, email: 'bob@example.test', operationKey: await f.id(), expectedRevision: circle.revision }), denied);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.invitations`)).rows[0].n, 0);
  const invitation = await f.invite(alice, target, 'bob@example.test');
  const code = await f.proof(bob, invitation.delivery);
  for (const removed of ['profile:write', 'circles:write']) {
    const narrowed = { ...bob, scopes: bob.scopes.filter(scope => scope !== removed) };
    await assert.rejects(f.store.requestProof(narrowed, { token: invitation.delivery.token, email: invitation.delivery.email }), denied);
    await assert.rejects(f.accept(narrowed, invitation.delivery, code), denied);
  }
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.claims`)).rows[0].n, 0);
  await f.accept(bob, invitation.delivery, code);
  assert.equal((await f.social.circle(bob, circle.id)).state, 'ACTIVE');
});
