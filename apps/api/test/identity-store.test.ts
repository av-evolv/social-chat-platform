import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { IdentityStore, IdentityStoreError, type Registration } from '../src/identity/store.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for isolated PostgreSQL integration tests' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const schema = `identity_test_${randomBytes(10).toString('hex')}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  t.after(async () => { try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); } });
  const store = new IdentityStore(pool, { schema });
  await store.migrate();
  async function registration(label: string): Promise<Registration> {
    return {
      accountId: await store.newId(), participantId: await store.newId(),
      emailHash: hash(`email:${label}`), emailCiphertext: `encrypted:${label}`,
      credential: { id: `credential:${label}`, publicKey: new Uint8Array([1,2,3]), counter: 0, transports: ['internal'] },
      deviceName: label, sessionHash: hash(`session:${label}`), deviceHash: hash(`device:${label}`),
    };
  }
  return { store,pool,schema,registration };
}

test('Identity schema validation rejects unsafe names before database access', async () => {
  const pool = new Pool();
  try { for (const schema of ['a.b', 'a;DROP SCHEMA public', '', '_private', 'Upper', 'a'.repeat(64)]) assert.throws(() => new IdentityStore(pool, { schema }), /SQL identifier/); }
  finally { await pool.end(); }
});

test('Identity migration is concurrent, idempotent and generates UUIDv7', integration, async (t) => {
  const { store,pool,schema } = await fixture(t);
  await Promise.all([store.migrate(),store.migrate()]);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.migrations`)).rows[0].count,2);
  await pool.query(`INSERT INTO ${schema}.migrations (version) VALUES (99)`);
  await assert.rejects(store.migrate(), /newer than this application/);
  assert.match(await store.newId(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('Challenges are bound to browser and purpose, expire, and have one concurrent consumer', integration, async (t) => {
  const { store,pool,schema } = await fixture(t);
  await store.putChallenge('challenge','register',hash('browser'), { challenge: 'public challenge' },60);
  assert.equal(await store.takeChallenge('challenge','login',hash('browser')),undefined);
  assert.equal(await store.takeChallenge('challenge','register',hash('other')),undefined);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.takeChallenge('challenge','register',hash('browser'))));
  assert.equal(results.filter(Boolean).length,1);
  await assert.rejects(store.putChallenge('challenge','register',hash('browser'), {},60));
  assert.equal(await store.takeChallenge('challenge','register',hash('browser')),undefined);
  await store.putChallenge('expired','register',hash('browser'), {},60);
  await pool.query(`UPDATE ${schema}.challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id='expired'`);
  assert.equal(await store.takeChallenge('expired','register',hash('browser')),undefined);
  await assert.rejects(store.putChallenge('invalid','register',hash('browser'), {},0));
});

test('Primary-backed rate limits bound concurrent attempts and reset only after expiry', integration, async (t) => {
  const { store,pool,schema } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => store.rateLimit(hash('key'),5,60)));
  assert.equal(results.filter(Boolean).length,5);
  assert.equal(await store.rateLimit(hash('key'),5,60),false);
  assert.equal(await store.rateLimit(hash('other'),5,60),true);
  await pool.query(`UPDATE ${schema}.rate_limits SET expires_at=clock_timestamp()-interval '1 second'`);
  assert.equal(await store.rateLimit(hash('key'),5,60),true);
  await assert.rejects(store.rateLimit('invalid',0,60));
});

test('Registration binds protected identity, stable participant and pending device atomically', integration, async (t) => {
  const { store,pool,schema,registration } = await fixture(t);
  const input = await registration('alice');
  const actor = await store.register(input);
  assert.equal(actor.accountId,input.accountId);
  assert.equal(await store.isSessionActive(actor),true);
  assert.deepEqual(await store.session(input.sessionHash), { accountId: actor.accountId, deviceId: actor.deviceId, sessionId: actor.sessionId });
  assert.deepEqual(await store.findAccount(actor.accountId), { id: actor.accountId, participantId: input.participantId });
  assert.deepEqual(await store.findIdentity(input.emailHash), { accountId: actor.accountId, participantId: input.participantId, recoveryGeneration: 0, status: 'active', emailCiphertext: input.emailCiphertext });
  const credential = await store.credential(input.credential.id);
  assert.deepEqual(credential?.publicKey,input.credential.publicKey);
  assert.equal(credential?.revokedAt,null);
  assert.equal(credential?.deviceType,'singleDevice');
  assert.equal(credential?.backedUp,false);
  const view = await store.accountView(actor);
  assert.equal(view?.devices.length,1);
  assert.equal(view?.devices[0]?.cryptoState,'pending');
  assert.equal(view?.devices[0]?.name,'alice');
  assert.equal((await pool.query(`SELECT (expires_at-created_at) > interval '29 days' AND (expires_at-created_at) < interval '31 days' AS valid FROM ${schema}.sessions`)).rows[0].valid,true);
});

test('Concurrent identity registration has one winner and leaves no orphan principal', integration, async (t) => {
  const { store,pool,schema,registration } = await fixture(t);
  const a = await registration('one'); const b = await registration('two'); b.emailHash=a.emailHash;
  const outcomes = await Promise.allSettled([store.register(a),store.register(b)]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length,1);
  const rejected = outcomes.find((r) => r.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof IdentityStoreError && rejected.reason.code === 'identity_conflict');
  for (const table of ['accounts','participants','identities','credentials','devices','sessions']) assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.${table}`)).rows[0].count,1);
  const reused = await registration('reuse'); reused.credential.id = outcomes[0]?.status === 'fulfilled' ? a.credential.id : b.credential.id;
  await assert.rejects(store.register(reused),IdentityStoreError);
});

test('Credential counters reject concurrent stale assertions and same-device login rotates sessions', integration, async (t) => {
  const { store,registration } = await fixture(t);
  const input = await registration('alice'); const original = await store.register(input);
  const login = { credentialId: input.credential.id,expectedCounter: 0,newCounter: 1,deviceHash: input.deviceHash,deviceName: 'renamed',sessionHash: hash('rotated') };
  const outcomes = await Promise.allSettled([store.authenticateCredential(login),store.authenticateCredential({ ...login,sessionHash: hash('concurrent') })]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length,1);
  const success = outcomes.find((r) => r.status === 'fulfilled'); assert.ok(success?.status === 'fulfilled');
  assert.equal(success.value.deviceId,original.deviceId);
  assert.deepEqual(success.value.revokedSessionIds,[original.sessionId]);
  assert.equal(await store.isSessionActive(original),false);
  assert.equal(await store.isSessionActive(success.value),true);
  assert.equal((await store.credential(input.credential.id))?.counter,1);
  await assert.rejects(store.authenticateCredential({ ...login,expectedCounter: 1,newCounter: 1,sessionHash: hash('replay') }),IdentityStoreError);
  await assert.rejects(store.authenticateCredential({ ...login,expectedCounter: 1,newCounter: 0,sessionHash: hash('rollback') }),IdentityStoreError);
});

test('Device revocation is owned, immediate and cannot silently reactivate a device hash', integration, async (t) => {
  const { store,registration } = await fixture(t);
  const input = await registration('alice'); const alice = await store.register(input);
  const bob = await store.register(await registration('bob'));
  const second = await store.authenticateCredential({ credentialId: input.credential.id,expectedCounter: 0,newCounter: 1,deviceHash: hash('second'),deviceName: 'second',sessionHash: hash('second-session') });
  await assert.rejects(store.revokeDevice(bob,alice.deviceId), (error: unknown) => error instanceof IdentityStoreError && error.code === 'identity_not_found');
  await assert.rejects(store.revokeDevice(bob,await store.newId()), (error: unknown) => error instanceof IdentityStoreError && error.code === 'identity_not_found');
  assert.equal(await store.isSessionActive(alice),true);
  assert.deepEqual(await store.revokeDevice(second,alice.deviceId),[alice.sessionId]);
  assert.equal(await store.isSessionActive(alice),false);
  assert.equal(await store.session(input.sessionHash),undefined);
  assert.equal(await store.accountView(alice),undefined);
  assert.equal(await store.accountView({ ...second,accountId: bob.accountId }),undefined);
  assert.equal(await store.isSessionActive(second),true);
  await assert.rejects(store.logout(alice),IdentityStoreError);
  await assert.rejects(store.revokeDevice(alice,second.deviceId),IdentityStoreError);
  await assert.rejects(store.authenticateCredential({ credentialId: input.credential.id,expectedCounter: 1,newCounter: 2,deviceHash: input.deviceHash,deviceName: 'revoked',sessionHash: hash('revoked-login') }),IdentityStoreError);
  assert.equal((await store.credential(input.credential.id))?.counter,1);
  await store.logout(second);
  assert.equal(await store.isSessionActive(second),false);
  assert.equal(await store.isSessionActive(bob),true);
});

test('Recovery preserves identity and participant, resets all sessions and has one generation winner', integration, async (t) => {
  const { store,pool,schema,registration } = await fixture(t);
  const input = await registration('alice'); const old = await store.register(input);
  const replacement = { ...input,credential: { ...input.credential,id: 'recovered-credential' },deviceHash: hash('recovery-device'),sessionHash: hash('recovered-session'),expectedRecoveryGeneration: 0 };
  const outcomes = await Promise.allSettled([store.recover(replacement),store.recover({ ...replacement,credential: { ...replacement.credential,id: 'competing-credential' },deviceHash: hash('competing-device'),sessionHash: hash('competing-session') })]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length,1);
  const success = outcomes.find((r) => r.status === 'fulfilled'); assert.ok(success?.status === 'fulfilled');
  assert.equal(success.value.accountId,old.accountId);
  assert.ok(success.value.revokedSessionIds.includes(old.sessionId));
  assert.equal(await store.isSessionActive(old),false);
  assert.equal(await store.isSessionActive(success.value),true);
  assert.ok((await store.credential(input.credential.id))?.revokedAt);
  assert.equal((await store.findIdentity(input.emailHash))?.recoveryGeneration,1);
  assert.equal((await store.findAccount(old.accountId))?.participantId,input.participantId);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.participants`)).rows[0].count,1);
  assert.ok((await store.accountView(success.value))?.devices.every((d) => d.cryptoState === 'pending'));
  await assert.rejects(store.authenticateCredential({ credentialId: input.credential.id,expectedCounter: 0,newCounter: 1,deviceHash: hash('fresh'),deviceName: 'fresh',sessionHash: hash('fresh-session') }),IdentityStoreError);
});

test('Recovery rejects foreign identities and revoked-device reuse without partial reset', integration, async (t) => {
  const { store,registration } = await fixture(t);
  const input = await registration('alice'); const alice = await store.register(input);
  const other = await registration('bob'); await store.register(other);
  const recovery = { ...input,credential: { ...input.credential,id: 'replacement' },deviceHash: hash('fresh-device'),sessionHash: hash('fresh-session'),expectedRecoveryGeneration: 0 };
  await assert.rejects(store.recover({ ...recovery,emailHash: other.emailHash }),IdentityStoreError);
  await assert.rejects(store.recover({ ...recovery,participantId: other.participantId }),IdentityStoreError);
  await assert.rejects(store.recover({ ...recovery,deviceHash: input.deviceHash }),IdentityStoreError);
  assert.equal(await store.isSessionActive(alice),true);
  assert.equal((await store.findIdentity(input.emailHash))?.recoveryGeneration,0);
  assert.equal((await store.credential(input.credential.id))?.revokedAt,null);
});

test('Account suspension and expiry invalidate all session lookups and mutations', integration, async (t) => {
  const { store,pool,schema,registration } = await fixture(t);
  const input = await registration('alice'); const alice = await store.register(input);
  await pool.query(`UPDATE ${schema}.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [alice.sessionId]);
  assert.equal(await store.isSessionActive(alice),false);
  assert.equal(await store.session(input.sessionHash),undefined);
  await assert.rejects(store.revokeDevice(alice,alice.deviceId),IdentityStoreError);
  await pool.query(`UPDATE ${schema}.sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1`, [alice.sessionId]);
  await pool.query(`UPDATE ${schema}.accounts SET status='suspended' WHERE id=$1`, [alice.accountId]);
  assert.equal(await store.isSessionActive(alice),false);
  assert.equal(await store.session(input.sessionHash),undefined);
  assert.equal(await store.findAccount(alice.accountId),undefined);
  assert.equal(await store.accountView(alice),undefined);
  await assert.rejects(store.logout(alice),IdentityStoreError);
  await assert.rejects(store.authenticateCredential({ credentialId: input.credential.id,expectedCounter: 0,newCounter: 1,deviceHash: hash('fresh'),deviceName: 'fresh',sessionHash: hash('fresh-session') }),IdentityStoreError);
});

test('Revocation racing login never leaves an active session on a revoked device', integration, async (t) => {
  const { store,registration } = await fixture(t);
  const input = await registration('alice'); const first = await store.register(input);
  const second = await store.authenticateCredential({ credentialId: input.credential.id,expectedCounter: 0,newCounter: 1,deviceHash: hash('second'),deviceName: 'second',sessionHash: hash('second-session') });
  const outcomes = await Promise.allSettled([
    store.authenticateCredential({ credentialId: input.credential.id,expectedCounter: 1,newCounter: 2,deviceHash: input.deviceHash,deviceName: 'first',sessionHash: hash('racing-session') }),
    store.revokeDevice(second,first.deviceId),
  ]);
  assert.equal(outcomes[1]?.status,'fulfilled');
  assert.equal(await store.session(hash('racing-session')),undefined);
  assert.equal(await store.isSessionActive(first),false);
  assert.equal(await store.isSessionActive(second),true);
});


test('Recovery racing a credential login leaves only the new recovery generation active', integration, async (t) => {
  const { store,pool,schema,registration } = await fixture(t);
  const input = await registration('alice'); const original = await store.register(input);
  const replacement = { ...input,credential: { ...input.credential,id: 'recovered',deviceType: 'multiDevice' as const,backedUp: true },deviceHash: hash('recovery'),sessionHash: hash('recovery-session'),expectedRecoveryGeneration: 0 };
  const outcomes = await Promise.allSettled([
    store.authenticateCredential({ credentialId: input.credential.id,expectedCounter: 0,newCounter: 1,deviceHash: hash('new-device'),deviceName: 'racing',sessionHash: hash('racing-login') }),
    store.recover(replacement),
  ]);
  const recovered = outcomes[1]; assert.ok(recovered?.status === 'fulfilled');
  assert.equal(await store.isSessionActive(original),false);
  assert.equal(await store.session(hash('racing-login')),undefined);
  assert.equal(await store.isSessionActive(recovered.value),true);
  assert.equal((await store.credential('recovered'))?.deviceType,'multiDevice');
  assert.equal((await store.credential('recovered'))?.backedUp,true);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.sessions WHERE revoked_at IS NULL`)).rows[0].count,1);
  await assert.rejects(store.revokeDevice(original,recovered.value.deviceId),IdentityStoreError);
});


test('Revoked sessions durably queue OAuth cleanup and completion is bounded and idempotent', integration, async (t) => {
  const { store,pool,schema,registration } = await fixture(t);
  const input = await registration('alice'); const original = await store.register(input);
  assert.deepEqual(await store.pendingRevocations(),[]);
  await store.completeRevocations([original.sessionId]);
  await store.logout(original);
  assert.deepEqual(await store.pendingRevocations(),[original.sessionId]);
  const second = await store.authenticateCredential({ credentialId: input.credential.id,expectedCounter: 0,newCounter: 1,deviceHash: input.deviceHash,deviceName: 'first',sessionHash: hash('next-session') });
  await store.revokeDevice(second,second.deviceId);
  assert.deepEqual(await store.pendingRevocations(1),[original.sessionId]);
  assert.deepEqual(await store.pendingRevocations(),[original.sessionId,second.sessionId]);
  // Failure/restart before acknowledgment leaves the work discoverable.
  const restarted = new IdentityStore(pool, { schema });
  assert.deepEqual(await restarted.pendingRevocations(),[original.sessionId,second.sessionId]);
  await restarted.completeRevocations([original.sessionId]);
  await restarted.completeRevocations([original.sessionId]);
  assert.deepEqual(await restarted.pendingRevocations(),[second.sessionId]);
  await restarted.completeRevocations([second.sessionId]);
  assert.deepEqual(await restarted.pendingRevocations(),[]);
  assert.equal(await restarted.isSessionActive(second),false);
  await assert.rejects(restarted.pendingRevocations(0));
  await assert.rejects(restarted.pendingRevocations(1001));
});


test('Identity version 1 upgrades aliases without changing existing principals or sessions', integration, async t => {
  const { store,pool,schema,registration } = await fixture(t);
  const input = await registration('upgrade');
  const actor = await store.register(input);
  await pool.query(`DROP TABLE ${schema}.participant_aliases; DELETE FROM ${schema}.migrations WHERE version=2`);
  await Promise.all([store.migrate(),store.migrate()]);
  assert.deepEqual((await pool.query(`SELECT version FROM ${schema}.migrations ORDER BY version`)).rows, [{ version:1 },{ version:2 }]);
  assert.equal(await store.isSessionActive(actor), true);
  assert.equal((await store.findAccount(actor.accountId))?.participantId, input.participantId);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.participant_aliases`)).rows[0].count, 0);
});
