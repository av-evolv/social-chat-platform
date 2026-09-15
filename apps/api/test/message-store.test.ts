import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { IdentityStore } from '../src/identity/store.js';
import { MESSAGE_SNAPSHOT_SCAN_LIMIT, MessageStore } from '../src/messages/store.js';
import { MessageError, type MessageAdmission, type MessageView } from '../src/messages/types.js';
import { SocialStore } from '../src/social/store.js';
import { SocialError, type SocialActor } from '../src/social/types.js';
import type { ChangeWriter } from '../src/sync/types.js';
import { SyncStore } from '../src/sync/store.js';
import { SyncError } from '../src/sync/types.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for isolated PostgreSQL integration tests' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const envelope = (value = 'encrypted fixture bytes') => ({ generation: '1', cryptoEpoch: '0', envelopeVersion: 1 as const, ciphertext: Buffer.from(value).toString('base64') });
const errorCode = (code: string) => (error: unknown) => (error instanceof MessageError || error instanceof SocialError) && error.code === code;

async function fixture(t: TestContext) {
  const suffix = randomBytes(8).toString('hex');
  const schema = `message_test_${suffix}`; const socialSchema = `message_social_${suffix}`; const identitySchema = `message_identity_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 10, application_name: schema });
  t.after(async () => { try { await pool.query(`DROP SCHEMA ${schema} CASCADE; DROP SCHEMA ${socialSchema} CASCADE; DROP SCHEMA ${identitySchema} CASCADE`); } finally { await pool.end(); } });
  const identity = new IdentityStore(pool, { schema: identitySchema }); await identity.migrate();
  const social = new SocialStore(pool, { schema: socialSchema, identitySchema, assertOAuth: async () => {} }); await social.migrate();
  const writer: ChangeWriter = {
    append: async (db, recipients, changes) => { await db.query(`INSERT INTO ${schema}.fixture_effects(kind,recipients,changes) VALUES('append',$1,$2)`, [recipients, JSON.stringify(changes)]); },
    invalidate: async (db, recipients) => { await db.query(`INSERT INTO ${schema}.fixture_effects(kind,recipients) VALUES('invalidate',$1)`, [recipients]); },
  };
  // Explicit server-owned trusted fixture. This table is NOT MLS or a production
  // activation path. It only tests atomic storage against ordered policy state.
  const admission: MessageAdmission = async (db, actor, request) => {
    const row = (await db.query(`SELECT * FROM ${schema}.fixture_admission WHERE conversation_id=$1`, [request.conversationId])).rows[0];
    if (!row || !row.recipients.includes(actor.participantId)) throw new MessageError(404, 'not_found');
    if (row.closed) throw new SocialError(409, 'crypto_not_ready');
    if ((request.action === 'read' || request.action === 'create') && request.message && BigInt(request.message.cryptoEpoch) < BigInt(row.history_start)) throw new MessageError(404, 'not_found');
    return { generation: row.generation, cryptoEpoch: row.crypto_epoch, recipients: row.recipients };
  };
  const store = new MessageStore(pool, social, writer, { schema, admission }); await store.migrate();
  await pool.query(`CREATE TABLE ${schema}.fixture_admission (conversation_id uuid PRIMARY KEY,generation text NOT NULL DEFAULT '1',crypto_epoch text NOT NULL DEFAULT '0',history_start text NOT NULL DEFAULT '0',recipients uuid[] NOT NULL,closed boolean NOT NULL DEFAULT false);
    CREATE TABLE ${schema}.fixture_effects (kind text NOT NULL,recipients uuid[] NOT NULL,changes jsonb);`);
  async function actor(label: string): Promise<SocialActor> {
    const participantId = await identity.newId();
    const session = await identity.register({ accountId: await identity.newId(), participantId, emailHash: hash(label), emailCiphertext: `encrypted:${label}`,
      credential: { id: `credential:${label}`, publicKey: new Uint8Array([1, 2]), counter: 0, transports: ['internal'] },
      deviceName: label, deviceHash: hash(`device:${label}`), sessionHash: hash(`session:${label}`) });
    return { ...session, participantId, clientId: 'first-party-test', scopes: ['messages:read', 'messages:write', 'sync:read'] };
  }
  const alice = await actor('alice'); const bob = await actor('bob'); const conversationId = await identity.newId();
  await pool.query(`INSERT INTO ${schema}.fixture_admission(conversation_id,recipients) VALUES($1,$2)`, [conversationId, [alice.participantId, bob.participantId]]);
  async function input() { return { ...envelope(), id: await identity.newId() }; }
  async function effects() { return (await pool.query(`SELECT * FROM ${schema}.fixture_effects`)).rows; }
  async function waitBlocked() {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`, [schema])).rowCount) return;
      await delay(10);
    }
    assert.fail('Competing request did not wait for policy lock');
  }
  return { pool, schema, socialSchema, identitySchema, social, store, writer, admission, alice, bob, conversationId, input, effects, waitBlocked, id: () => identity.newId() };
}

test('Message migrations are concurrent; identifiers and envelope formats are bounded', integration, async t => {
  const f = await fixture(t); await Promise.all([f.store.migrate(), f.store.migrate()]);
  assert.throws(() => new MessageStore(f.pool, f.social, f.writer, { schema: 'bad;sql', admission: f.admission }), /SQL identifier/);
  const input = await f.input(); const key = await f.id();
  for (const ciphertext of ['', 'Zg', 'Zg==\n', 'Zh==', '-_==']) {
    await assert.rejects(f.store.create(f.alice, f.conversationId, key, { ...input, ciphertext }), errorCode('invalid_request'));
  }
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, { ...input, ciphertext: Buffer.alloc(65537).toString('base64') }), errorCode('message_too_large'));
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, { ...input, generation: '01' }), errorCode('invalid_request'));
  await assert.rejects(f.store.create(f.alice, f.conversationId, 'invalid', input), errorCode('invalid_request'));
  assert.equal((await f.effects()).length, 0);
  await f.store.create(f.alice, f.conversationId, key, { ...input, ciphertext: Buffer.alloc(65536).toString('base64') });
});

test('D15 concurrent duplicate create produces one envelope, effect and retained receipt; changed inputs conflict', integration, async t => {
  const f = await fixture(t); const input = await f.input(); const key = await f.id();
  const [a, b] = await Promise.all([f.store.create(f.alice, f.conversationId, key, input), f.store.create(f.alice, f.conversationId, key, input)]);
  assert.deepEqual(a, b); assert.equal(a.revision, '1'); assert.equal((await f.effects()).length, 1);
  const stored = await f.store.get(f.bob, input.id); assert.equal(stored.ciphertext, input.ciphertext);
  assert.equal(stored.authorId, f.alice.participantId); assert.equal(stored.authorDeviceId, f.alice.deviceId);
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, { ...input, ciphertext: envelope('different').ciphertext }), errorCode('idempotency_conflict'));
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, { ...input, id: await f.id() }), errorCode('idempotency_conflict'));
  await assert.rejects(f.store.create(f.alice, f.conversationId, await f.id(), input), errorCode('id_conflict'));
  await assert.rejects(f.store.create({ ...f.alice, clientId: 'other-app' }, f.conversationId, key, input), errorCode('id_conflict'));
});

test('Revision writes serialize, preserve original identity and replay stable metadata-only receipts', integration, async t => {
  const f = await fixture(t); const input = await f.input(); await f.store.create(f.alice, f.conversationId, await f.id(), input);
  const keys = [await f.id(), await f.id()]; const edit = { ...envelope('edited'), expectedRevision: '1' };
  const results = await Promise.allSettled(keys.map(key => f.store.update(f.alice, input.id, key, edit)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && errorCode('revision_conflict')(rejected.reason));
  const winningIndex = results.findIndex(result => result.status === 'fulfilled'); const key = keys[winningIndex]!;
  const replay = await f.store.update(f.alice, input.id, key, edit); assert.equal(replay.revision, '2');
  await assert.rejects(f.store.update(f.alice, input.id, key, { ...edit, expectedRevision: '2' }), errorCode('idempotency_conflict'));
  const stored = await f.store.get(f.alice, input.id); assert.equal(stored.authorDeviceId, f.alice.deviceId); assert.equal(stored.ciphertext, edit.ciphertext);
  await assert.rejects(f.store.update(f.bob, input.id, await f.id(), { ...edit, expectedRevision: '2' }), errorCode('not_found'));
  assert.equal((await f.effects()).length, 2);
});

test('D19 reads exact historical revisions; current history admission and scopes filter every read surface', integration, async t => {
  const f = await fixture(t); const input = await f.input(); await f.store.create(f.alice, f.conversationId, await f.id(), input);
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET crypto_epoch='1'`);
  await f.store.update(f.alice, input.id, await f.id(), { ...envelope('new epoch'), cryptoEpoch: '1', expectedRevision: '1' });
  await f.social.withPolicy(f.bob, async db => {
    const old = await f.store.read(db, f.bob, { type: 'message', id: input.id, revision: '1', kind: 'upsert' });
    assert.equal((old!.data as MessageView).ciphertext, input.ciphertext);
    assert.equal((await f.store.snapshot(db, f.bob, 100))[0]!.revision, '2');
    const narrowed = { ...f.bob, scopes: ['sync:read'] };
    assert.deepEqual(await f.store.snapshot(db, narrowed, 100), []); assert.equal(await f.store.visible(db, narrowed, old!), false);
  });
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET history_start='1'`);
  await f.social.withPolicy(f.bob, async db => {
    assert.equal(await f.store.read(db, f.bob, { type: 'message', id: input.id, revision: '1', kind: 'upsert' }), undefined);
    assert.ok(await f.store.read(db, f.bob, { type: 'message', id: input.id, revision: '2', kind: 'upsert' }));
  });
  await assert.rejects(f.store.get({ ...f.bob, scopes: [] }, input.id), errorCode('insufficient_scope'));
});

test('Deletion purges all ciphertext versions, invalidates old recipients, retains tombstone and replay identities', integration, async t => {
  const f = await fixture(t); const input = await f.input(); const createKey = await f.id();
  const original = await f.store.create(f.alice, f.conversationId, createKey, input);
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET recipients=$1`, [[f.alice.participantId]]);
  const deleteKey = await f.id(); const deletion = { generation: '1', cryptoEpoch: '0', expectedRevision: '1' };
  const deleted = await f.store.delete(f.alice, input.id, deleteKey, deletion); assert.equal(deleted.deleted, true);
  assert.deepEqual(await f.store.delete(f.alice, input.id, deleteKey, deletion), deleted);
  assert.deepEqual(await f.store.create(f.alice, f.conversationId, createKey, input), original);
  assert.equal((await f.pool.query(`SELECT * FROM ${f.schema}.versions`)).rowCount, 0);
  assert.equal((await f.pool.query(`SELECT * FROM ${f.schema}.operations`)).rowCount, 2);
  assert.ok((await f.effects()).find(effect => effect.kind === 'invalidate').recipients.includes(f.bob.participantId));
  await assert.rejects(f.store.get(f.alice, input.id), errorCode('not_found'));
  await f.social.withPolicy(f.alice, async db => {
    assert.equal(await f.store.read(db, f.alice, { type: 'message', id: input.id, revision: '1', kind: 'upsert' }), undefined);
    const tombstone = await f.store.read(db, f.alice, { type: 'message', id: input.id, revision: '2', kind: 'delete' });
    assert.equal((tombstone!.data as MessageView).ciphertext, undefined); assert.deepEqual(await f.store.snapshot(db, f.alice, 100), []);
  });
});

test('D12/D16 committed revocation wins against a waiting write and denies cached replay', integration, async t => {
  const f = await fixture(t); const input = await f.input(); const key = await f.id(); await f.store.create(f.alice, f.conversationId, key, input);
  const db = await f.pool.connect();
  try {
    await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${f.socialSchema}:policy`]);
    await db.query(`UPDATE ${f.schema}.fixture_admission SET recipients=$1,generation='2'`, [[f.bob.participantId]]);
    const pending = f.store.update(f.alice, input.id, await f.id(), { ...envelope('stale'), expectedRevision: '1' });
    const rejected = assert.rejects(pending, errorCode('not_found'));
    await f.waitBlocked(); await db.query('COMMIT'); await rejected;
  } finally { await db.query('ROLLBACK'); db.release(); }
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, input), errorCode('not_found'));
  assert.equal((await f.effects()).length, 1);
});

test('Failed append rolls back envelope and operation; retry succeeds without duplicate effects', integration, async t => {
  const f = await fixture(t); const input = await f.input(); const key = await f.id();
  const broken = new MessageStore(f.pool, f.social, { ...f.writer, append: async (db, recipients, changes) => { await f.writer.append(db, recipients, changes); throw new Error('fixture rollback'); } }, { schema: f.schema, admission: f.admission });
  await assert.rejects(broken.create(f.alice, f.conversationId, key, input), /fixture rollback/);
  for (const table of ['messages', 'versions', 'operations', 'fixture_effects']) assert.equal((await f.pool.query(`SELECT * FROM ${f.schema}.${table}`)).rowCount, 0);
  await f.store.create(f.alice, f.conversationId, key, input); assert.equal((await f.effects()).length, 1);
});

test('Admission gates, epoch mismatch and fanout reject before mutation; read does not expose closed ciphertext', integration, async t => {
  const f = await fixture(t); const input = await f.input(); const key = await f.id();
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, { ...input, cryptoEpoch: '1' }), errorCode('crypto_epoch_conflict'));
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET closed=true`);
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, input), errorCode('crypto_not_ready'));
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET closed=false,recipients=array_append(ARRAY(SELECT uuidv7() FROM generate_series(1,256)),$1::uuid)`, [f.alice.participantId]);
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, input), errorCode('message_fanout_exceeded'));
  assert.equal((await f.effects()).length, 0);
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET recipients=$1`, [[f.alice.participantId]]);
  await f.store.create(f.alice, f.conversationId, key, input);
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET closed=true`);
  await assert.rejects(f.store.get(f.alice, input.id), errorCode('not_found'));
});

test('Real message and sync stores atomically publish, roll back and purge fixed snapshot payloads', integration, async t => {
  const f = await fixture(t); const syncSchema = `${f.schema}_sync`;
  let messages: MessageStore;
  const sync = new SyncStore(f.pool, f.social, { schema: syncSchema, cursorKeys: ['test-issuer-secret'], binding: () => 'trusted-fixture-grant',
    resources: { snapshot: (db, actor, maximum) => messages.snapshot(db, actor, maximum),
      read: (db, actor, ref) => messages.read(db, actor, ref), visible: (db, actor, resource) => messages.visible(db, actor, resource) } });
  await sync.migrate(); messages = new MessageStore(f.pool, f.social, sync, { schema: f.schema, admission: f.admission });
  try {
    const initial = await sync.page(f.bob);
    const input = await f.input(); const key = await f.id();
    await Promise.all([messages.create(f.alice, f.conversationId, key, input), messages.create(f.alice, f.conversationId, key, input)]);
    const delta = await sync.page(f.bob, { after: initial.cursor });
    assert.equal(delta.mode, 'delta'); assert.equal(delta.resources.length, 1);
    assert.equal((delta.resources[0]!.data as MessageView).ciphertext, input.ciphertext);
    assert.deepEqual((await f.pool.query(`SELECT position::text FROM ${syncSchema}.streams ORDER BY participant_id`)).rows.map(row => row.position), ['1', '1']);
    const broken = new MessageStore(f.pool, f.social, { append: async (db, recipients, changes) => { await sync.append(db, recipients, changes); throw new Error('rollback after actual stream append'); }, invalidate: (db, recipients) => sync.invalidate(db, recipients) }, { schema: f.schema, admission: f.admission });
    await assert.rejects(broken.create(f.alice, f.conversationId, await f.id(), await f.input()), /rollback after actual stream append/);
    assert.equal((await f.pool.query(`SELECT * FROM ${syncSchema}.changes`)).rowCount, 2);
    assert.equal((await f.pool.query(`SELECT * FROM ${f.schema}.messages`)).rowCount, 1);
    await messages.create(f.alice, f.conversationId, await f.id(), await f.input());
    const snapshot = await sync.page(f.bob, { limit: 1 }); assert.equal(snapshot.hasMore, true);
    assert.ok((await f.pool.query(`SELECT 1 FROM ${syncSchema}.snapshots WHERE participant_id=$1`, [f.bob.participantId])).rowCount);
    await messages.delete(f.alice, input.id, await f.id(), { generation: '1', cryptoEpoch: '0', expectedRevision: '1' });
    assert.equal((await f.pool.query(`SELECT 1 FROM ${syncSchema}.snapshots WHERE participant_id=$1`, [f.bob.participantId])).rowCount, 0);
    await assert.rejects(sync.page(f.bob, { after: snapshot.cursor }), error => error instanceof SyncError && error.code === 'sync_reset_required');
    assert.equal((await sync.page(f.bob)).resources.length, 1);
  } finally { await f.pool.query(`DROP SCHEMA ${syncSchema} CASCADE`); }
});

test('Audience growth beyond append capacity cannot prevent ciphertext erasure', integration, async t => {
  const f = await fixture(t); const input = await f.input(); await f.store.create(f.alice, f.conversationId, await f.id(), input);
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET recipients=array_append(ARRAY(SELECT uuidv7() FROM generate_series(1,256)),$1::uuid)`, [f.alice.participantId]);
  const result = await f.store.delete(f.alice, input.id, await f.id(), { generation: '1', cryptoEpoch: '0', expectedRevision: '1' });
  assert.equal(result.deleted, true);
  assert.equal((await f.pool.query(`SELECT * FROM ${f.schema}.versions`)).rowCount, 0);
  const effects = await f.effects(); assert.equal(effects.filter(effect => effect.kind === 'append').length, 1);
  assert.ok(effects.find(effect => effect.kind === 'invalidate').recipients.length > 256);
});

test('D16/D20 replay rechecks message history and current identity device before returning a receipt', integration, async t => {
  const f = await fixture(t); const input = await f.input(); const key = await f.id();
  await f.store.create(f.alice, f.conversationId, key, input);
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET history_start='1'`);
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, input), errorCode('not_found'));
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET history_start='0'`);
  await f.pool.query(`UPDATE ${f.identitySchema}.devices SET revoked_at=clock_timestamp() WHERE id=$1`, [f.alice.deviceId]);
  await assert.rejects(f.store.create(f.alice, f.conversationId, key, input), errorCode('invalid_token'));
  await assert.rejects(f.store.get(f.alice, input.id), errorCode('invalid_token'));
  assert.equal((await f.effects()).length, 1);
});

test('Snapshot rejects an exhausted candidate scan budget rather than returning an incomplete empty cache', integration, async t => {
  const f = await fixture(t); const input = await f.input(); await f.store.create(f.alice, f.conversationId, await f.id(), input);
  const original = await f.store.get(f.alice, input.id);
  await f.pool.query(`INSERT INTO ${f.schema}.messages(id,conversation_id,author_id,revision,deleted,metadata)
    SELECT id,$1,$2,1,false,($3::jsonb-'ciphertext')||jsonb_build_object('id',id) FROM (SELECT uuidv7() AS id FROM generate_series(1,$4)) AS ids`,
  [f.conversationId, f.alice.participantId, original, MESSAGE_SNAPSHOT_SCAN_LIMIT]);
  await f.pool.query(`INSERT INTO ${f.schema}.versions(message_id,revision,envelope,recipients)
    SELECT id,1,metadata||jsonb_build_object('ciphertext',$1::text),$2::uuid[] FROM ${f.schema}.messages WHERE id<>$3`,
  [input.ciphertext, [f.alice.participantId], input.id]);
  await f.pool.query(`UPDATE ${f.schema}.fixture_admission SET closed=true`);
  await assert.rejects(f.social.withPolicy(f.alice, db => f.store.snapshot(db, f.alice, 2000)), error => error instanceof SyncError && error.code === 'sync_snapshot_too_large');
});

test('Snapshot enforces byte budget incrementally before materializing all large envelopes', integration, async t => {
  const f = await fixture(t); const input = { ...await f.input(), ciphertext: Buffer.alloc(65536).toString('base64') };
  await f.store.create(f.alice, f.conversationId, await f.id(), input); const original = await f.store.get(f.alice, input.id);
  await f.pool.query(`INSERT INTO ${f.schema}.messages(id,conversation_id,author_id,revision,deleted,metadata)
    SELECT id,$1,$2,1,false,($3::jsonb-'ciphertext')||jsonb_build_object('id',id) FROM (SELECT uuidv7() AS id FROM generate_series(1,30)) AS ids`,
  [f.conversationId, f.alice.participantId, original]);
  await f.pool.query(`INSERT INTO ${f.schema}.versions(message_id,revision,envelope,recipients)
    SELECT id,1,metadata||jsonb_build_object('ciphertext',$1::text),$2::uuid[] FROM ${f.schema}.messages WHERE id<>$3`,
  [input.ciphertext, [f.alice.participantId], input.id]);
  let inspected = 0;
  const store = new MessageStore(f.pool, f.social, f.writer, { schema: f.schema, admission: async (db, actor, request) => {
    if (request.action === 'read') inspected++;
    return f.admission(db, actor, request);
  } });
  await assert.rejects(f.social.withPolicy(f.alice, db => store.snapshot(db, f.alice, 2000)), error => error instanceof SyncError && error.code === 'sync_snapshot_too_large');
  assert.ok(inspected > 0 && inspected < 31);
  inspected = 0;
  await assert.rejects(f.social.withPolicy(f.alice, db => store.snapshot(db, f.alice, 2000, 1000)), error => error instanceof SyncError && error.code === 'sync_snapshot_too_large');
  assert.equal(inspected, 1);
});
