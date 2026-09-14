import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { errors } from 'oidc-provider';
import { Pool } from 'pg';
import { createAdapter, isGrantRevoked, migrateOAuth } from '../src/oauth/adapter.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for isolated PostgreSQL integration tests' };

async function storage(t: TestContext) {
  const schema = `oauth_test_${randomBytes(10).toString('hex')}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  t.after(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await pool.end(); }
  });
  await migrateOAuth(pool, { schema });
  return { schema, pool, Adapter: createAdapter(pool, { schema }) };
}

test('OAuth schema names reject SQL injection and invalid identifiers before database access', async () => {
  const pool = new Pool();
  try {
    for (const schema of ['public;DROP TABLE users', 'OAuth', 'x.y', '', '_private', 'a'.repeat(64)]) {
      assert.throws(() => createAdapter(pool, { schema }), /SQL identifier/);
      await assert.rejects(migrateOAuth(pool, { schema }), /SQL identifier/);
      await assert.rejects(isGrantRevoked(pool, 'grant', { schema }), /SQL identifier/);
    }
  } finally { await pool.end(); }
});

test('OAuth migrations are concurrent and idempotent; artifacts survive a pool restart', integration, async (t) => {
  const { pool, schema, Adapter } = await storage(t);
  await Promise.all([migrateOAuth(pool, { schema }), migrateOAuth(pool, { schema })]);
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${schema}.migrations`)).rows[0].count, 1);
  const session = new Adapter('Session');
  const payload = { uid: 'session-uid', accountId: 'account-1' };
  const initial = new Pool({ connectionString: databaseUrl });
  try {
    const InitialAdapter = createAdapter(initial, { schema });
    await new InitialAdapter('Session').upsert('session-1', payload);
  } finally { await initial.end(); }
  const restarted = new Pool({ connectionString: databaseUrl });
  try {
    const OtherAdapter = createAdapter(restarted, { schema });
    assert.deepEqual(await new OtherAdapter('Session').find('session-1'), payload);
    assert.deepEqual(await new OtherAdapter('Session').findByUid('session-uid'), payload);
    assert.equal(await new OtherAdapter('Grant').find('session-1'), undefined);
  } finally { await restarted.end(); }
  await session.destroy('session-1');
  assert.equal(await session.find('session-1'), undefined);
});

test('OAuth lookup paths reject expired artifacts and preserve consumption on stale upsert', integration, async (t) => {
  const { pool, schema, Adapter } = await storage(t);
  const adapter = new Adapter('DeviceCode');
  const payload = { uid: 'uid-1', userCode: 'user-code-1', grantId: 'grant-1' };
  await adapter.upsert('code-1', payload, 60);
  assert.deepEqual(await adapter.findByUserCode('user-code-1'), payload);
  await adapter.consume('code-1');
  const consumed = (await adapter.find('code-1'))?.consumed;
  assert.equal(typeof consumed, 'number');
  assert.ok(consumed > 0);
  await adapter.upsert('code-1', payload, 60);
  assert.equal((await adapter.find('code-1'))?.consumed, consumed);
  await pool.query(`UPDATE ${schema}.artifacts SET expires_at = clock_timestamp() - interval '1 second'`);
  assert.equal(await adapter.find('code-1'), undefined);
  assert.equal(await adapter.findByUid('uid-1'), undefined);
  assert.equal(await adapter.findByUserCode('user-code-1'), undefined);
  await assert.rejects(adapter.consume('code-1'), errors.InvalidGrant);
  await adapter.upsert('zero-ttl', { uid: 'zero' }, 0);
  assert.equal(await adapter.find('zero-ttl'), undefined);
  await assert.rejects(adapter.upsert('bad-ttl', {}, -1), /lifetime/);
});

test('Concurrent refresh consumption has one winner and permanently revokes the entire grant', integration, async (t) => {
  const { pool, schema, Adapter } = await storage(t);
  const refresh = new Adapter('RefreshToken');
  const access = new Adapter('AccessToken');
  const grant = new Adapter('Grant');
  await grant.upsert('grant-race', { accountId: 'account-1' }, 60);
  await refresh.upsert('refresh-1', { grantId: 'grant-race' }, 60);
  await access.upsert('access-1', { grantId: 'grant-race' }, 60);
  const outcomes = await Promise.allSettled([refresh.consume('refresh-1'), refresh.consume('refresh-1')]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = outcomes.find((result) => result.status === 'rejected');
  assert.ok(failure?.status === 'rejected' && failure.reason instanceof errors.InvalidGrant);
  assert.equal(await isGrantRevoked(pool, 'grant-race', { schema }), true);
  assert.equal(await grant.find('grant-race'), undefined);
  assert.equal(await refresh.find('refresh-1'), undefined);
  assert.equal(await access.find('access-1'), undefined);
  await assert.rejects(refresh.upsert('rotated-refresh', { grantId: 'grant-race' }, 60), errors.InvalidGrant);
  await assert.rejects(access.upsert('racing-access', { grantId: 'grant-race' }, 60), errors.InvalidGrant);
  await assert.rejects(grant.upsert('grant-race', { accountId: 'account-1' }, 60), errors.InvalidGrant);
});

test('Revocation and cross-model saves share a lock and cannot recreate removed grants', integration, async (t) => {
  const { pool, schema, Adapter } = await storage(t);
  const grants = new Adapter('Grant');
  const refresh = new Adapter('RefreshToken');
  const access = new Adapter('AccessToken');
  for (let i = 0; i < 8; i++) {
    const grantId = `grant-${i}`;
    await grants.upsert(grantId, {}, 60);
    const operations = [
      () => access.upsert(`access-${i}`, { grantId }, 60),
      () => refresh.upsert(`refresh-${i}`, { grantId }, 60),
      () => grants.revokeByGrantId(grantId),
      () => grants.upsert(grantId, {}, 60),
    ];
    if (i % 2) operations.reverse();
    const results = await Promise.allSettled(operations.map((operation) => operation()));
    for (const result of results) {
      if (result.status === 'rejected') assert.ok(result.reason instanceof errors.InvalidGrant);
    }
    assert.equal(await isGrantRevoked(pool, grantId, { schema }), true);
    assert.equal(await grants.find(grantId), undefined);
    assert.equal(await access.find(`access-${i}`), undefined);
    assert.equal(await refresh.find(`refresh-${i}`), undefined);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${schema}.artifacts WHERE grant_id = $1`, [grantId])).rows[0].count, 0);
  }
});

test('Grant destroy revokes artifacts, while artifact identifiers cannot change grant affiliation', integration, async (t) => {
  const { pool, schema, Adapter } = await storage(t);
  const grants = new Adapter('Grant');
  const access = new Adapter('AccessToken');
  await grants.upsert('grant-original', {}, 60);
  await access.upsert('token', { grantId: 'grant-original' }, 60);
  await assert.rejects(access.upsert('token', { grantId: 'different-grant' }, 60), errors.InvalidGrant);
  await grants.destroy('grant-original');
  assert.equal(await isGrantRevoked(pool, 'grant-original', { schema }), true);
  assert.equal(await access.find('token'), undefined);
});


test('Grant bindings are immutable under concurrent consent while identical renewals remain valid', integration, async (t) => {
  const { Adapter } = await storage(t);
  const bindings = new Adapter('LarynxGrantBinding');
  const payload = { grantId: 'bound-grant', accountId: 'first-account', uid: 'first-device' };
  await bindings.upsert('bound-grant', payload, 60);
  await bindings.upsert('bound-grant', payload, 120);
  await assert.rejects(bindings.upsert('bound-grant', { ...payload, accountId: 'other-account' }, 60), errors.InvalidGrant);
  assert.deepEqual(await bindings.find('bound-grant'), payload);
  const outcomes = await Promise.allSettled([
    bindings.upsert('new-grant', { grantId: 'new-grant', accountId: 'account-a' }, 60),
    bindings.upsert('new-grant', { grantId: 'new-grant', accountId: 'account-b' }, 60),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof errors.InvalidGrant);
});

test('Single-use interaction submissions cannot be consumed twice without unrelated grant revocation', integration, async (t) => {
  const { pool, schema, Adapter } = await storage(t);
  const submissions = new Adapter('LarynxInteractionSubmission');
  await submissions.upsert('submission', { uid: 'interaction-uid' }, 60);
  const outcomes = await Promise.allSettled([submissions.consume('submission'), submissions.consume('submission')]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${schema}.revoked_grants`)).rows[0].count, 0);
});
