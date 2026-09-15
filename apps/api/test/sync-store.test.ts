import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { CursorCodec, type CursorState } from '../src/sync/cursor.js';
import { SyncStore, SYNC_LIMITS } from '../src/sync/store.js';
import { SyncError, type SyncResource, type ChangeRef } from '../src/sync/types.js';
import type { SocialActor } from '../src/social/types.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for PostgreSQL integration tests' };
const actor = (): SocialActor => ({ accountId: randomUUID(), participantId: randomUUID(), clientId: 'test-client', deviceId: randomUUID(), sessionId: randomUUID(), scopes: ['messages:read', 'sync:read'] });
const errorCode = (code: string) => (error: unknown) => error instanceof SyncError && error.code === code;
const ref = (id: string = randomUUID(), revision = '1'): ChangeRef => ({ type: 'message', id, revision, kind: 'upsert' });
const resource = (id: string = randomUUID(), revision = '1', data: unknown = { ciphertext: 'aGVsbG8=' }): SyncResource => ({ type: 'message', id, revision, data });
async function fixture(t: TestContext) {
  const schema = `sync_test_${randomBytes(8).toString('hex')}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 10, application_name: schema });
  let allowed = true; let grant = 'grant-1';
  const owner = actor();
  async function tx<T>(work: (db: PoolClient) => Promise<T>, policy = true): Promise<T> {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      if (policy) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${schema}:policy`]);
      const result = await work(db); await db.query('COMMIT'); return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  const resources = {
    snapshot: async (db: PoolClient, _actor: SocialActor, maximum: number) => (await db.query<{ resource: SyncResource }>(`SELECT resource FROM ${schema}.fixture_current ORDER BY id LIMIT $1`, [maximum])).rows.map((row) => row.resource),
    read: async (db: PoolClient, _actor: SocialActor, change: ChangeRef) => (await db.query<{ resource: SyncResource }>(`SELECT v.resource FROM ${schema}.fixture_versions v JOIN ${schema}.fixture_current c USING(id)
      WHERE v.id=$1 AND v.revision=$2 AND c.visible`, [change.id, change.revision])).rows[0]?.resource,
    visible: async (db: PoolClient, _actor: SocialActor, value: SyncResource) => Boolean((await db.query(`SELECT 1 FROM ${schema}.fixture_current WHERE id=$1 AND visible`, [value.id])).rowCount),
  };
  const store = new SyncStore(pool, { withPolicy: async (_actor, work) => tx(async (db) => { if (!allowed) throw new SyncError(401, 'invalid_token'); return work(db); }) },
    { schema, cursorKeys: ['shared-secret'], binding: () => grant, resources });
  await store.migrate();
  await pool.query(`CREATE TABLE ${schema}.fixture_current(id uuid PRIMARY KEY,resource jsonb NOT NULL,visible boolean NOT NULL DEFAULT true);
    CREATE TABLE ${schema}.fixture_versions(id uuid NOT NULL,revision text NOT NULL,resource jsonb NOT NULL,PRIMARY KEY(id,revision));`);
  t.after(async () => { try { await pool.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await pool.end(); } });
  async function save(db: PoolClient, value: SyncResource, recipients = [owner.participantId]) {
    await db.query(`INSERT INTO ${schema}.fixture_current(id,resource) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET resource=excluded.resource`, [value.id, value]);
    await db.query(`INSERT INTO ${schema}.fixture_versions(id,revision,resource) VALUES($1,$2,$3)`, [value.id, value.revision, value]);
    await store.append(db, recipients, [ref(value.id, value.revision)]);
  }
  async function blocked() {
    for (let i = 0; i < 200; i++) {
      if ((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`, [schema])).rowCount) return;
      await delay(10);
    }
    assert.fail('competing writer did not block');
  }
  return { schema, pool, store, owner, tx, save, blocked, deny: () => { allowed = false; }, grant: (value: string) => { grant = value; } };
}

test('Opaque cursor authenticates all bindings, rejects tampering/expiry and supports shared rotating keys', () => {
  const principal = actor(); const codec = new CursorCodec(['old']);
  const binding = codec.binding(principal, 'grant');
  const value: CursorState = { version: 1, binding, auth: '0', global: '0', retention: '0', position: '0', high: '12', expires: Date.now() + 60000 };
  const token = codec.encode(value);
  assert.equal(token.includes(principal.participantId), false);
  assert.deepEqual(new CursorCodec(['new', 'old']).decode(token, binding), value);
  assert.throws(() => codec.decode(token.slice(0, -4) + 'AAAA', binding), errorCode('invalid_cursor'));
  assert.throws(() => codec.decode(token, codec.binding(principal, 'different-grant')), errorCode('invalid_cursor'));
  assert.throws(() => codec.decode(codec.encode({ ...value, expires: 1 }), binding), errorCode('cursor_expired'));
  assert.throws(() => codec.decode(codec.encode({ ...value, position: '13' }), binding), errorCode('invalid_cursor'));
});

test('Sync migrations are repeatable/concurrent and schema identifiers are bounded', integration, async (t) => {
  const { store, pool } = await fixture(t);
  await Promise.all([store.migrate(), store.migrate()]);
  assert.throws(() => new SyncStore(pool, {} as never, { schema: 'bad.schema', cursorKeys: ['key'], binding: () => '', resources: {} as never }), /SQL identifier/);
});

test('First sync freezes snapshot versions and H; retried pages remain stable and later changes use the next window', integration, async (t) => {
  const { store, owner, tx, save } = await fixture(t);
  const first = resource('00000000-0000-7000-8000-000000000001');
  const second = resource('00000000-0000-7000-8000-000000000002');
  await tx(async (db) => { await save(db, first); await save(db, second); });
  const initial = await store.page(owner, { limit: 1 });
  assert.equal(initial.mode, 'snapshot'); assert.equal(initial.hasMore, true); assert.deepEqual(initial.resources, [first]);
  await tx((db) => save(db, { ...second, revision: '2', data: { ciphertext: 'bmV3' } }));
  const last = await store.page(owner, { after: initial.cursor, limit: 1 });
  assert.equal(last.hasMore, false); assert.deepEqual(last.resources, [second]);
  assert.deepEqual((await store.page(owner, { after: initial.cursor, limit: 1 })).resources, [second]);
  const delta = await store.page(owner, { after: last.cursor });
  assert.equal(delta.mode, 'delta'); assert.equal(delta.resources[0]?.revision, '2'); assert.equal(delta.hasMore, false);
});

test('Fixed delta H never substitutes a later revision and filtered pages advance their scanned position', integration, async (t) => {
  const { store, owner, tx, save, pool, schema } = await fixture(t);
  const initial = await store.page(owner);
  const hidden = resource(); const visible = resource(); const later = resource();
  await tx(async (db) => { await save(db, hidden); await save(db, visible); await save(db, later); await db.query(`UPDATE ${schema}.fixture_current SET visible=false WHERE id=$1`, [hidden.id]); });
  const filtered = await store.page(owner, { after: initial.cursor, limit: 1 });
  assert.deepEqual(filtered.resources, []); assert.equal(filtered.hasMore, true);
  await tx((db) => save(db, { ...visible, revision: '2', data: { ciphertext: 'bGF0ZXI=' } }));
  const next = await store.page(owner, { after: filtered.cursor, limit: 1 });
  assert.deepEqual(next.resources, [visible]); assert.equal(next.hasMore, true);
  const end = await store.page(owner, { after: next.cursor });
  assert.deepEqual(end.resources, [later]); assert.equal(end.hasMore, false);
  const postH = await store.page(owner, { after: end.cursor });
  assert.equal(postH.resources[0]?.revision, '2');
  assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.changes`)).rows[0].count, '4');
});

test('Every account, principal, client, device, session, scope and grant binding rejects foreign cursors; revocation precedes decoding', integration, async (t) => {
  const f = await fixture(t); const page = await f.store.page(f.owner);
  for (const key of ['accountId', 'participantId', 'clientId', 'deviceId', 'sessionId'] as const) {
    await assert.rejects(f.store.page({ ...f.owner, [key]: randomUUID() }, { after: page.cursor }), errorCode('invalid_cursor'));
  }
  await assert.rejects(f.store.page({ ...f.owner, scopes: ['sync:read'] }, { after: page.cursor }), errorCode('invalid_cursor'));
  assert.equal((await f.store.page({ ...f.owner, scopes: [...f.owner.scopes].reverse() }, { after: page.cursor })).hasMore, false);
  f.grant('new'); await assert.rejects(f.store.page(f.owner, { after: page.cursor }), errorCode('invalid_cursor'));
  f.deny(); await assert.rejects(f.store.page(f.owner, { after: 'malformed' }), errorCode('invalid_token'));
});

test('Invalidation resets before payload retrieval and purges materialized snapshots; rollback does neither', integration, async (t) => {
  const { store, owner, tx, save, pool, schema } = await fixture(t);
  await tx(async (db) => { await save(db, resource()); await save(db, resource()); });
  const snapshot = await store.page(owner, { limit: 1 });
  await assert.rejects(tx(async (db) => { await store.invalidate(db, [owner.participantId]); throw new Error('rollback'); }), /rollback/);
  assert.equal((await store.page(owner, { after: snapshot.cursor })).resources.length, 1);
  await tx(async (db) => { await db.query(`DELETE FROM ${schema}.fixture_current`); await db.query(`DELETE FROM ${schema}.fixture_versions`); await store.invalidate(db, [owner.participantId]); });
  await assert.rejects(store.page(owner, { after: snapshot.cursor }), errorCode('sync_reset_required'));
  assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.snapshots`)).rows[0].count, '0');
  assert.deepEqual((await store.page(owner)).resources, []);
});

test('Security invalidation above fanout bound succeeds through global reset; appends reject before mutation', integration, async (t) => {
  const { store, owner, tx, pool, schema } = await fixture(t);
  const initial = await store.page(owner); const many = Array.from({ length: SYNC_LIMITS.recipients + 1 }, () => randomUUID());
  await assert.rejects(tx((db) => store.append(db, many, [ref()])), errorCode('sync_fanout_exceeded'));
  assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.changes`)).rows[0].count, '0');
  await tx((db) => store.invalidate(db, many));
  await assert.rejects(store.page(owner, { after: initial.cursor }), errorCode('sync_reset_required'));
});

test('Snapshot expiry and seven-day compaction require explicit rebuild, never skipping retained positions', integration, async (t) => {
  const { store, owner, tx, save, pool, schema } = await fixture(t);
  await tx(async (db) => { await save(db, resource()); await save(db, resource()); });
  const partial = await store.page(owner, { limit: 1 });
  await pool.query(`UPDATE ${schema}.snapshots SET expires_at=clock_timestamp()-interval '1 second'`);
  await assert.rejects(store.page(owner, { after: partial.cursor }), errorCode('cursor_expired'));
  const initial = await store.page(owner);
  await pool.query(`UPDATE ${schema}.changes SET created_at=clock_timestamp()-interval '8 days' WHERE position=1`);
  await store.compact();
  await assert.rejects(store.page(owner, { after: initial.cursor }), errorCode('cursor_expired'));
  assert.equal((await pool.query(`SELECT position::text FROM ${schema}.changes`)).rows[0].position, '2');
  assert.equal((await store.page(owner)).resources.length, 2);
});

test('Snapshot capacity overflow fails transactionally; page byte limits make progress within scanned bounds', integration, async (t) => {
  const { store, owner, tx, save, pool, schema } = await fixture(t);
  const payload = { ciphertext: 'a'.repeat(180000) };
  await tx(async (db) => { for (let i = 0; i < 4; i++) await save(db, resource(randomUUID(), '1', payload)); });
  const first = await store.page(owner);
  assert.equal(first.resources.length, 2); assert.equal(first.hasMore, true);
  const last = await store.page(owner, { after: first.cursor });
  assert.equal(last.resources.length, 2); assert.equal(last.hasMore, false);
  await pool.query(`UPDATE ${schema}.fixture_current SET resource=jsonb_set(resource,'{data}',to_jsonb(repeat('a',600000)))`);
  const before = (await pool.query(`SELECT count(*) FROM ${schema}.snapshots`)).rows[0].count;
  await assert.rejects(store.page(owner), errorCode('sync_snapshot_too_large'));
  assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.snapshots`)).rows[0].count, before);
});

test('Transactional counters block later publication behind a stalled reservation and rollback reuses the position', integration, async (t) => {
  const { store, owner, pool, schema, blocked } = await fixture(t);
  await store.page(owner);
  const a = await pool.connect(); const b = await pool.connect();
  try {
    await a.query('BEGIN'); await b.query('BEGIN');
    await store.append(a, [owner.participantId], [ref()]);
    const pending = store.append(b, [owner.participantId], [ref()]);
    await blocked();
    assert.equal((await pool.query(`SELECT position::text FROM ${schema}.streams WHERE participant_id=$1`, [owner.participantId])).rows[0].position, '0');
    assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.changes`)).rows[0].count, '0');
    await a.query('COMMIT'); await pending; await b.query('COMMIT');
    assert.deepEqual((await pool.query(`SELECT position::text FROM ${schema}.changes ORDER BY position`)).rows.map((row) => row.position), ['1', '2']);
    await a.query('BEGIN'); await b.query('BEGIN');
    await store.append(a, [owner.participantId], [ref()]);
    const rollbackPending = store.append(b, [owner.participantId], [ref()]);
    await blocked(); await a.query('ROLLBACK'); await rollbackPending; await b.query('COMMIT');
    assert.deepEqual((await pool.query(`SELECT position::text FROM ${schema}.changes ORDER BY position`)).rows.map((row) => row.position), ['1', '2', '3']);
  } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
});

test('Recipient locks use canonical order even when competing callers pass opposite order', integration, async (t) => {
  const { store, owner, pool, blocked } = await fixture(t);
  const other = randomUUID(); const a = await pool.connect(); const b = await pool.connect();
  try {
    await a.query('BEGIN'); await b.query('BEGIN');
    await store.append(a, [owner.participantId, other], [ref()]);
    const pending = store.append(b, [other, owner.participantId], [ref()]);
    await blocked(); await a.query('COMMIT'); await pending; await b.query('COMMIT');
  } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
});

test('Wake hints publish only after commit, never for rolled-back changes or invalidations', integration, async (t) => {
  const { store, owner, pool, schema } = await fixture(t);
  const listener = await pool.connect(); const writer = await pool.connect();
  const payloads: string[] = [];
  listener.on('notification', (notification) => { if (notification.channel === store.channel) payloads.push(notification.payload!); });
  try {
    await listener.query(`LISTEN ${store.channel}`);
    await writer.query('BEGIN'); await store.append(writer, [owner.participantId], [ref()]);
    await listener.query('SELECT 1'); assert.deepEqual(payloads, []);
    await writer.query('COMMIT');
    for (let i = 0; i < 100 && !payloads.length; i++) await delay(5);
    assert.deepEqual(payloads, [owner.participantId]);
    await writer.query('BEGIN'); await store.append(writer, [owner.participantId], [ref()]); await store.invalidate(writer, [owner.participantId]); await writer.query('ROLLBACK');
    // A committed marker on the same connection gives an ordering barrier for delivery.
    await writer.query('SELECT pg_notify($1,$2)', [store.channel, 'barrier']);
    for (let i = 0; i < 100 && payloads.at(-1) !== 'barrier'; i++) await delay(5);
    assert.deepEqual(payloads, [owner.participantId, 'barrier']);
    assert.equal((await pool.query(`SELECT position::text,auth_generation::text FROM ${schema}.streams WHERE participant_id=$1`, [owner.participantId])).rows[0].position, '1');
  } finally { await writer.query('ROLLBACK'); await listener.query('UNLISTEN *'); writer.release(); listener.release(); }
});

test('Snapshot resource count is a hard complete-snapshot limit and sync scope is required', integration, async (t) => {
  const { store, owner, pool, schema } = await fixture(t);
  await pool.query(`INSERT INTO ${schema}.fixture_current(id,resource)
    SELECT id,jsonb_build_object('type','message','id',id,'revision','1','data',jsonb_build_object('ciphertext','AA=='))
    FROM (SELECT uuidv7() id FROM generate_series(1,2001)) fixture`);
  await assert.rejects(store.page(owner), errorCode('sync_snapshot_too_large'));
  assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.snapshots`)).rows[0].count, '0');
  await assert.rejects(store.page({ ...owner, scopes: ['messages:read'] }), errorCode('insufficient_scope'));
});

test('Compaction releases one recipient before waiting on another domain hook lock', integration, async (t) => {
  const { store, pool, schema, tx, blocked } = await fixture(t);
  const a = '00000000-0000-7000-8000-000000000001';
  const b = '00000000-0000-7000-8000-000000000002';
  await tx((db) => store.append(db, [a, b], [ref()]));
  await pool.query(`UPDATE ${schema}.changes SET created_at=clock_timestamp()-interval '8 days'`);
  const domain = await pool.connect(); let cleanup: Promise<void> | undefined;
  try {
    await domain.query('BEGIN');
    await domain.query("SET LOCAL lock_timeout='500ms'");
    // A domain policy transaction may run hooks B then A across separate resources.
    await store.invalidate(domain, [b]);
    cleanup = store.compact();
    // Compaction has processed A and now waits for the held B row.
    await blocked();
    await store.invalidate(domain, [a]);
    await domain.query('COMMIT');
    await cleanup;
    assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.changes`)).rows[0].count, '0');
  } finally {
    await domain.query('ROLLBACK'); domain.release();
    await cleanup?.catch(() => {});
  }
});

test('Compaction deletes at most 1000 expired references per recipient and repeated batches reset safely', integration, async (t) => {
  const { store, owner, pool, schema } = await fixture(t);
  const initial = await store.page(owner);
  await pool.query(`INSERT INTO ${schema}.changes(participant_id,position,reference,created_at)
    SELECT $1,n,$2::jsonb,clock_timestamp()-interval '8 days' FROM generate_series(1,1001) n`, [owner.participantId, JSON.stringify(ref())]);
  await pool.query(`UPDATE ${schema}.streams SET position=1001 WHERE participant_id=$1`, [owner.participantId]);
  await store.compact();
  assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.changes`)).rows[0].count, '1');
  await assert.rejects(store.page(owner, { after: initial.cursor }), errorCode('cursor_expired'));
  const rebuilt = await store.page(owner);
  await store.compact();
  assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.changes`)).rows[0].count, '0');
  await assert.rejects(store.page(owner, { after: rebuilt.cursor }), errorCode('cursor_expired'));
  await store.compact();
  assert.equal((await pool.query(`SELECT retention_generation::text FROM ${schema}.streams WHERE participant_id=$1`, [owner.participantId])).rows[0].retention_generation, '2');
});
