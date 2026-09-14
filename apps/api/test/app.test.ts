import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp, type Database } from '../src/app.js';

test('liveness does not depend on database availability', async (t) => {
  const app = buildApp({
    query: async () => { throw new Error('Database unavailable'); },
    end: async () => {},
  });
  t.after(() => app.close());

  const response = await app.inject('/health/live');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('readiness checks the database and closing the app releases it', async () => {
  const queries: string[] = [];
  let closed = false;
  const database: Database = {
    query: async (sql) => { queries.push(sql); },
    end: async () => { closed = true; },
  };
  const app = buildApp(database);
  try {
    const response = await app.inject('/health/ready');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assert.deepEqual(queries, ['SELECT 1']);
  } finally {
    await app.close();
  }
  assert.equal(closed, true);
});

test('readiness returns 503 without leaking database errors', async (t) => {
  const app = buildApp({
    query: async () => { throw new Error('postgres://admin:secret@private.example/db'); },
    end: async () => {},
  });
  t.after(() => app.close());

  const response = await app.inject('/health/ready');
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'unavailable' });
  assert.doesNotMatch(response.body, /secret|private\.example/);
});
