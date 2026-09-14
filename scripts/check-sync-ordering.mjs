// A database design experiment for docs/domain-contracts.md, not a sync service.
// Run with a disposable/local PostgreSQL DATABASE_URL and schema creation rights.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const schema = `larynx_sync_probe_${randomBytes(8).toString('hex')}`;
const clients = Array.from({ length: 3 }, () => new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
}));
const [a, b, observer] = clients;
const connected = new Set();
let created = false;
let pending;
try {
  const connections = await Promise.allSettled(clients.map(async client => {
    await client.connect();
    connected.add(client);
  }));
  const failure = connections.find(connection => connection.status === 'rejected');
  if (failure) throw failure.reason;
  await observer.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await observer.query(`CREATE SEQUENCE ${schema}.unsafe_position`);
  await observer.query(`CREATE TABLE ${schema}.unsafe_log (position bigint PRIMARY KEY)`);
  await observer.query(`CREATE TABLE ${schema}.counter (id integer PRIMARY KEY, position bigint NOT NULL)`);
  await observer.query(`INSERT INTO ${schema}.counter VALUES (1, 0)`);
  await observer.query(`CREATE TABLE ${schema}.safe_log (position bigint PRIMARY KEY)`);

  // An allocated sequence value is not a commit-order checkpoint.
  await a.query('BEGIN');
  await a.query(`INSERT INTO ${schema}.unsafe_log VALUES (nextval('${schema}.unsafe_position'))`);
  await b.query('BEGIN');
  await b.query(`INSERT INTO ${schema}.unsafe_log VALUES (nextval('${schema}.unsafe_position'))`);
  await b.query('COMMIT');
  assert.deepEqual((await observer.query(`SELECT position FROM ${schema}.unsafe_log ORDER BY position`)).rows,
    [{ position: '2' }]);
  await a.query('COMMIT');
  assert.deepEqual((await observer.query(`SELECT position FROM ${schema}.unsafe_log WHERE position > 2`)).rows, []);
  assert.deepEqual((await observer.query(`SELECT position FROM ${schema}.unsafe_log ORDER BY position`)).rows,
    [{ position: '1' }, { position: '2' }]);
  console.log('Reproduced: committing position 2 first makes a cursor >2 miss late position 1.');

  // A transactional counter serializes publication for one recipient.
  const append = `WITH next AS (UPDATE ${schema}.counter SET position = position + 1 WHERE id = 1 RETURNING position)
    INSERT INTO ${schema}.safe_log SELECT position FROM next RETURNING position`;
  await a.query('BEGIN');
  assert.equal((await a.query(append)).rows[0].position, '1');
  await b.query('BEGIN');
  const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  // Observe errors immediately while the coordinator verifies database blocking.
  pending = b.query(append).then(result => ({ result }), error => ({ error }));
  const deadline = Date.now() + 3000;
  let blocked = false;
  while (Date.now() < deadline) {
    blocked = (await observer.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked;
    if (blocked) break;
    await delay(20);
  }
  assert.equal(blocked, true, 'second writer must wait for the first recipient counter transaction');
  assert.deepEqual((await observer.query(`SELECT position FROM ${schema}.safe_log`)).rows, []);
  await a.query('COMMIT');
  const second = await pending;
  if (second.error) throw second.error;
  assert.equal(second.result.rows[0].position, '2');
  assert.deepEqual((await observer.query(`SELECT position FROM ${schema}.safe_log ORDER BY position`)).rows,
    [{ position: '1' }]);
  await b.query('COMMIT');
  assert.deepEqual((await observer.query(`SELECT position FROM ${schema}.safe_log ORDER BY position`)).rows,
    [{ position: '1' }, { position: '2' }]);
  console.log('Verified: position 2 waits, then becomes visible only after position 1 commits.');

  await a.query('BEGIN');
  assert.equal((await a.query(append)).rows[0].position, '3');
  await a.query('ROLLBACK');
  assert.equal((await b.query(append)).rows[0].position, '3');
  assert.deepEqual((await observer.query(`SELECT position FROM ${schema}.safe_log ORDER BY position`)).rows,
    [{ position: '1' }, { position: '2' }, { position: '3' }]);
  console.log('Verified: rollback leaves neither a published change nor an advanced counter.');
} finally {
  // Release A first so an outstanding B query can settle before rollback/cleanup.
  if (connected.has(a)) await a.query('ROLLBACK').catch(() => {});
  if (pending) await pending;
  if (connected.has(b)) await b.query('ROLLBACK').catch(() => {});
  try {
    if (created) await observer.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
  }
}
