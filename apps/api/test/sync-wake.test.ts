import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { SyncError } from '../src/sync/types.js';
import { SyncWakeHub } from '../src/sync/wake.js';

const alice = '01994000-0000-7000-8000-000000000001';
const bob = '01994000-0000-7000-8000-000000000002';
const carol = '01994000-0000-7000-8000-000000000003';
const channel = 'larynx_sync_test';
const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for isolated PostgreSQL integration tests' };
const code = (expected: string) => (error: unknown) => error instanceof SyncError && error.code === expected;

class FakeClient extends EventEmitter {
  queries: string[] = [];
  releases: (boolean | undefined)[] = [];
  async query(sql: string) { this.queries.push(sql); }
  release(destroy?: boolean) { this.releases.push(destroy); }
  hint(participantId: string, target = channel) { this.emit('notification', { channel: target, payload: participantId }); }
}

class FakePool {
  clients: FakeClient[] = [];
  failures = 0;
  attempts = 0;
  async connect(): Promise<PoolClient> {
    this.attempts++;
    if (this.failures > 0) { this.failures--; throw new Error('test connection loss'); }
    const client = new FakeClient();
    this.clients.push(client);
    return client as unknown as PoolClient;
  }
  get latest() { return this.clients.at(-1)!; }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Expected wake listener state was not reached');
}

async function fake(t: TestContext, options: { maxWaiters?: number; maxPerPrincipal?: number } = {}) {
  const pool = new FakePool();
  const hub = new SyncWakeHub(pool as unknown as Pool, channel, { ...options, reconnectDelayMs: 5 });
  t.after(() => hub.close());
  await hub.start();
  return { pool, hub };
}

test('Wake hints latch between registration and wait and filter other principals/channels', async (t) => {
  const { hub, pool } = await fake(t);
  const first = hub.watch(alice);
  pool.latest.hint(alice);
  await first.wait(25_000);
  let done = false;
  const second = hub.watch(bob);
  const waiting = second.wait(25_000).then(() => { done = true; });
  pool.latest.hint(alice);
  pool.latest.hint(bob, 'wrong_channel');
  await delay(5);
  assert.equal(done, false);
  pool.latest.hint(bob);
  await waiting;
  assert.deepEqual(pool.latest.queries, [`LISTEN ${channel}`]);
  assert.equal(pool.clients.length, 1);
});

test('Waiter caps include the initial read and cleanup permits another registration', async (t) => {
  const { hub, pool } = await fake(t, { maxWaiters: 3 });
  const a = hub.watch(alice);
  const b = hub.watch(alice);
  assert.throws(() => hub.watch(alice), code('sync_wait_limit'));
  const c = hub.watch(bob);
  assert.throws(() => hub.watch(carol), code('sync_wait_limit'));
  a.close(); a.close();
  const d = hub.watch(carol);
  const waits = [b, c, d].map((watch) => watch.wait(25_000));
  pool.latest.hint('*');
  await Promise.all(waits);
  hub.watch(alice).close();
  hub.watch(alice).close();
});

test('Timeout, abort, pre-abort and explicit close resolve and remove signal listeners', async (t) => {
  const { hub } = await fake(t, { maxWaiters: 1 });
  const timeoutSignal = new AbortController();
  const started = Date.now();
  await hub.watch(alice).wait(25, timeoutSignal.signal);
  assert.ok(Date.now() - started >= 20);
  assert.equal(getEventListeners(timeoutSignal.signal, 'abort').length, 0);
  const controller = new AbortController();
  const watch = hub.watch(alice);
  const waiting = watch.wait(25_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await waiting;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await hub.watch(alice).wait(25_000, controller.signal);
  const closed = hub.watch(alice);
  closed.close();
  await closed.wait(25_000);
  const manual = hub.watch(alice);
  const manualWait = manual.wait(25_000);
  manual.close();
  await manualWait;
  hub.watch(alice).close();
});

test('Invalid wait/channel/principal/options are rejected without leaking capacity', async (t) => {
  const { hub, pool } = await fake(t, { maxWaiters: 1 });
  for (const milliseconds of [-1, 25_001, NaN, Infinity, 0.5]) {
    await assert.rejects(hub.watch(alice).wait(milliseconds), code('invalid_sync_wait'));
  }
  for (const principal of ['', '*', 'not-a-uuid']) assert.throws(() => hub.watch(principal), code('invalid_sync_request'));
  for (const name of ['', 'unsafe;LISTEN other', 'Upper', 'x'.repeat(64)]) {
    assert.throws(() => new SyncWakeHub(pool as unknown as Pool, name), /SQL identifier/);
  }
  for (const options of [{ maxWaiters: 201 }, { maxPerPrincipal: 3 }, { reconnectDelayMs: 0 }]) {
    assert.throws(() => new SyncWakeHub(pool as unknown as Pool, channel, options), /limit/);
  }
  hub.watch(alice).close();
});

test('Connection loss wakes waiters, reconnect backs off through failure and wakes registrations made while offline', async (t) => {
  const { hub, pool } = await fake(t);
  const firstClient = pool.latest;
  const waiting = hub.watch(alice).wait(25_000);
  pool.failures = 1;
  firstClient.emit('error', new Error('test connection loss'));
  await waiting;
  assert.deepEqual(firstClient.releases, [true]);
  assert.equal(firstClient.listenerCount('notification'), 0);
  const offline = hub.watch(bob).wait(25_000);
  await offline;
  await until(() => pool.clients.length === 2);
  assert.ok(pool.attempts >= 3);
  const next = hub.watch(alice).wait(25_000);
  pool.latest.hint(alice);
  await next;
  assert.deepEqual(pool.latest.queries, [`LISTEN ${channel}`]);
});

test('Shutdown removes listener, resolves all waits and cancels reconnect', async (t) => {
  const { hub, pool } = await fake(t);
  const controller = new AbortController();
  const waiting = hub.watch(alice).wait(25_000, controller.signal);
  const notWaiting = hub.watch(bob);
  await hub.close();
  await waiting;
  await notWaiting.wait(25_000);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(pool.latest.releases, [true]);
  assert.equal(pool.latest.listenerCount('error'), 0);
  assert.equal(pool.latest.listenerCount('end'), 0);
  assert.equal(pool.latest.listenerCount('notification'), 0);
  assert.throws(() => hub.watch(alice), code('sync_unavailable'));
  await assert.rejects(hub.start(), code('sync_unavailable'));
  await delay(20);
  assert.equal(pool.clients.length, 1);
});

test('Shutdown while pool checkout is pending releases the eventual connection', async () => {
  let resolve!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((done) => { resolve = done; });
  const pool = { connect: () => checkout } as unknown as Pool;
  const hub = new SyncWakeHub(pool, channel);
  const starting = hub.start();
  const closing = hub.close();
  const client = new FakeClient();
  resolve(client as unknown as PoolClient);
  await Promise.all([starting, closing]);
  assert.deepEqual(client.releases, [true]);
  assert.deepEqual(client.queries, []);
});

test('Repeated start waits for LISTEN to finish and shutdown cancels a scheduled reconnect', async () => {
  const client = new FakeClient();
  let finish!: () => void;
  const listening = new Promise<void>((resolve) => { finish = resolve; });
  client.query = async (sql) => { client.queries.push(sql); await listening; };
  let connections = 0;
  const pool = { connect: async () => { connections++; return client; } } as unknown as Pool;
  const hub = new SyncWakeHub(pool, channel, { reconnectDelayMs: 5 });
  const first = hub.start();
  await delay(0);
  let secondDone = false;
  const second = hub.start().then(() => { secondDone = true; });
  await delay(5);
  assert.equal(secondDone, false);
  finish();
  await Promise.all([first, second]);
  assert.equal(connections, 1);
  client.emit('end');
  await hub.close();
  await delay(20);
  assert.equal(connections, 1);
  assert.deepEqual(client.releases, [true]);
});

test('PostgreSQL notifies only committed writes, rolls back silently and holds one idle listener for all waits', integration, async (t) => {
  const applicationName = `wake_test_${randomBytes(8).toString('hex')}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 3, application_name: applicationName });
  const hub = new SyncWakeHub(pool, applicationName);
  let writer: PoolClient | undefined;
  t.after(async () => { writer?.release(true); await hub.close(); await pool.end(); });
  await hub.start();
  writer = await pool.connect();
  let received = false;
  const waiting = hub.watch(alice).wait(2_000).then(() => { received = true; });
  await writer.query('BEGIN');
  await writer.query('SELECT pg_notify($1,$2)', [applicationName, alice]);
  await delay(30);
  assert.equal(received, false);
  const committed = Date.now();
  await writer.query('COMMIT');
  await waiting;
  assert.ok(Date.now() - committed < 1_000, 'Commit must wake before the long-poll timeout');
  const begin = Date.now();
  let rolledBackWake = false;
  const rollback = hub.watch(alice).wait(100).then(() => { rolledBackWake = true; });
  await writer.query('BEGIN');
  await writer.query('SELECT pg_notify($1,$2)', [applicationName, alice]);
  await writer.query('ROLLBACK');
  await delay(30);
  assert.equal(rolledBackWake, false);
  const bobWait = hub.watch(bob).wait(25_000);
  const stats = await writer.query<{ state: string; xact_start: Date | null; query: string }>(
    'SELECT state,xact_start,query FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()', [applicationName]);
  assert.equal(stats.rowCount, 1);
  assert.equal(stats.rows[0]!.state, 'idle');
  assert.equal(stats.rows[0]!.xact_start, null);
  assert.equal(stats.rows[0]!.query, `LISTEN ${applicationName}`);
  await rollback;
  assert.ok(Date.now() - begin >= 80);
  await writer.query('SELECT pg_notify($1,$2)', [applicationName, '*']);
  await bobWait;
});

test('A terminated PostgreSQL listener wakes requests and reconnects to receive later commits', integration, async (t) => {
  const applicationName = `wake_test_${randomBytes(8).toString('hex')}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 3, application_name: applicationName });
  const hub = new SyncWakeHub(pool, applicationName, { reconnectDelayMs: 5 });
  t.after(async () => { await hub.close(); await pool.end(); });
  await hub.start();
  const listeners = await pool.query<{ pid: number }>(
    'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query=$2 AND state=$3',
    [applicationName, `LISTEN ${applicationName}`, 'idle']);
  assert.equal(listeners.rowCount, 1);
  const originalPid = listeners.rows[0]!.pid;
  const waiting = hub.watch(alice).wait(2_000);
  const terminated = Date.now();
  await pool.query('SELECT pg_terminate_backend($1)', [originalPid]);
  await waiting;
  assert.ok(Date.now() - terminated < 1_000, 'Connection loss must wake before the long-poll timeout');
  let reconnected = false;
  for (let i = 0; i < 100; i++) {
    const current = await pool.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query=$2 AND state=$3',
      [applicationName, `LISTEN ${applicationName}`, 'idle']);
    if (current.rowCount === 1 && current.rows[0]!.pid !== originalPid) { reconnected = true; break; }
    await delay(10);
  }
  assert.equal(reconnected, true);
  let received = false;
  const next = hub.watch(bob).wait(2_000).then(() => { received = true; });
  await delay(10);
  assert.equal(received, false);
  const committed = Date.now();
  await pool.query('SELECT pg_notify($1,$2)', [applicationName, bob]);
  await next;
  assert.ok(Date.now() - committed < 1_000, 'Reconnected listener must wake before the long-poll timeout');
});
