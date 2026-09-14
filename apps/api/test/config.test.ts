import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';

const databaseUrl = 'postgresql://larynx:local@localhost:5432/larynx';

test('config uses documented defaults and accepts explicit addresses', () => {
  assert.deepEqual(readConfig({ DATABASE_URL: databaseUrl }), {
    databaseUrl, host: '0.0.0.0', port: 3000,
  });
  assert.deepEqual(readConfig({ DATABASE_URL: databaseUrl, HOST: '::1', PORT: '8080' }), {
    databaseUrl, host: '::1', port: 8080,
  });
});

test('config requires a PostgreSQL URL without exposing invalid values', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL is required/);
  for (const value of ['invalid-secret', 'https://admin:secret@example.com/db', 'postgres:///db']) {
    assert.throws(() => readConfig({ DATABASE_URL: value }), {
      message: 'DATABASE_URL must be a PostgreSQL connection URL',
    });
  }
});

test('config rejects invalid ports and host values', () => {
  for (const port of ['', '0', '65536', '-1', '1.5', '3000oops', ' 3000', '1e3']) {
    assert.throws(() => readConfig({ DATABASE_URL: databaseUrl, PORT: port }), /PORT must be/);
  }
  for (const host of ['', ' ', 'http://localhost', 'local host']) {
    assert.throws(() => readConfig({ DATABASE_URL: databaseUrl, HOST: host }), /HOST must be/);
  }
});
