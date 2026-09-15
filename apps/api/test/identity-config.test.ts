import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalEmail, digest, keyed, protectEmail, readIdentityConfig, revealEmail, secret,
} from '../src/identity/config.js';
import type { OAuthConfig } from '../src/oauth/config.js';

const encryptionKey = Buffer.alloc(32, 11).toString('base64url');
const lookupKey = Buffer.alloc(32, 29).toString('base64url');
const oauth = (overrides: Partial<OAuthConfig> = {}): OAuthConfig => ({
  issuer: 'http://localhost:3000/oidc', resource: 'http://localhost:3000/api',
  mode: 'local', jwks: { keys: [] }, cookieKeys: [], clients: [], ...overrides,
});
const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  IDENTITY_ENCRYPTION_KEY: encryptionKey, IDENTITY_LOOKUP_KEY: lookupKey,
  SMTP_HOST: 'mailpit', SMTP_PORT: '1025', SMTP_FROM: 'Larynx@EXAMPLE.COM', ...overrides,
});
const production = oauth({ mode: 'production', issuer: 'https://login.example.com/oidc', resource: 'https://login.example.com/api' });
const productionEnv = (overrides: NodeJS.ProcessEnv = {}) => env({
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'smtp-account',
  SMTP_PASSWORD: 'DO_NOT_LEAK_password', ...overrides,
});
function invalid(config: OAuthConfig, environment: NodeJS.ProcessEnv) {
  assert.throws(() => readIdentityConfig(config, environment), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Invalid account configuration');
    assert.doesNotMatch(error.message, /DO_NOT_LEAK|smtp-account|example\.com/);
    return true;
  });
}

test('email canonicalization preserves local-part identity and lowercases only the domain', () => {
  assert.equal(canonicalEmail('  Alice.Smith+work@EXAMPLE.COM  '), 'Alice.Smith+work@example.com');
  assert.notEqual(canonicalEmail('Alice@example.com'), canonicalEmail('alice@example.com'));
  assert.notEqual(canonicalEmail('a.b@example.com'), canonicalEmail('ab@example.com'));
  assert.notEqual(canonicalEmail('alice+work@example.com'), canonicalEmail('alice@example.com'));
  assert.equal(canonicalEmail("o'connor@sub.example.com"), "o'connor@sub.example.com");
  assert.equal(canonicalEmail(`${'a'.repeat(64)}@example.com`), `${'a'.repeat(64)}@example.com`);
});

test('email canonicalization rejects ambiguity, header injection and unsupported address forms', () => {
  for (const value of [undefined, null, 42, {}, [], '', 'a', 'a@@example.com', '@example.com',
    'a@localhost', 'a@[127.0.0.1]', 'a@-example.com', 'a@example-.com', 'a@exam_ple.com',
    'a@example..com', 'a@example.com.', '.a@example.com', 'a.@example.com', 'a..b@example.com',
    'a b@example.com', '"a"@example.com', 'Ålice@example.com', 'a@éxample.com',
    'Alice <alice@example.com>', 'alice@example.com,bob@example.com',
    'alice@example.com\r\nBcc: bob@example.com', 'alice\0@example.com',
    `${'a'.repeat(65)}@example.com`, `${'a'.repeat(250)}@example.com`,
  ]) assert.throws(() => canonicalEmail(value), { message: 'Invalid email' });
});

test('identity protection is randomized, authenticated and requires the encryption key', () => {
  const config = readIdentityConfig(oauth(), env());
  const email = 'Private.Person+tag@example.com';
  const first = protectEmail(config, email);
  const second = protectEmail(config, email);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /Private|Person|example/);
  assert.equal(revealEmail(config, first), email);
  assert.equal(revealEmail(config, second), email);
  const differentLookup = { ...config, lookupKey: randomBytes(32) };
  assert.equal(revealEmail(differentLookup, first), email);
  assert.throws(() => revealEmail({ ...config, encryptionKey: randomBytes(32) }, first));
  const parts = first.split('.');
  for (const index of [1, 2, 3]) {
    const tampered = [...parts];
    const bytes = Buffer.from(tampered[index]!, 'base64url');
    bytes[0] = bytes[0]! ^ 1;
    tampered[index] = bytes.toString('base64url');
    assert.throws(() => revealEmail(config, tampered.join('.')));
  }
  for (const malformed of ['', 'v1', 'v2.' + parts.slice(1).join('.'), 'v1...', first + '.extra']) {
    assert.throws(() => revealEmail(config, malformed));
  }
});

test('lookup hashes separate purposes, values and keys without using the encryption key', () => {
  const config = readIdentityConfig(oauth(), env());
  const email = 'private@example.com';
  const value = keyed(config, 'email', email);
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(value, keyed(config, 'email', email));
  assert.notEqual(value, keyed(config, 'verification', email));
  assert.notEqual(value, keyed(config, 'email', 'other@example.com'));
  assert.notEqual(value, keyed({ ...config, lookupKey: randomBytes(32) }, 'email', email));
  assert.equal(value, keyed({ ...config, encryptionKey: randomBytes(32) }, 'email', email));
  assert.notEqual(keyed(config, 'a', 'bc'), keyed(config, 'ab', 'c'));
  assert.notEqual(keyed(config, 'a:b', 'c'), keyed(config, 'a', 'b:c'));
});

test('bearer secrets are independent random values and digesting is stable', () => {
  const first = secret(); const second = secret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first, 'base64url').length, 32);
  assert.notEqual(first, second);
  assert.notEqual(digest(first), first);
  assert.equal(digest(first), digest(first));
  assert.notEqual(digest(first), digest(second));
  assert.equal(digest('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});

test('identity configuration derives the exact RP origin and local SMTP delivery', () => {
  const config = readIdentityConfig(oauth(), env());
  assert.equal(config.origin, 'http://localhost:3000');
  assert.equal(config.rpId, 'localhost');
  assert.equal(config.mode, 'local');
  assert.deepEqual(config.encryptionKey, Buffer.from(encryptionKey, 'base64url'));
  assert.deepEqual(config.lookupKey, Buffer.from(lookupKey, 'base64url'));
  assert.equal(config.smtp.host, 'mailpit');
  assert.equal(config.smtp.port, 1025);
  assert.equal(config.smtp.secure, false);
  assert.equal(config.smtp.from, 'Larynx@example.com');
  for (const host of ['localhost', '127.0.0.1']) {
    assert.equal(readIdentityConfig(oauth(), env({ SMTP_HOST: host })).smtp.host, host);
  }
  for (const issuer of ['http://127.0.0.1:3000/oidc', 'http://[::1]:3000/oidc', 'http://other.example/oidc']) {
    invalid(oauth({ issuer }), env());
  }
  for (const host of ['', 'smtp.example.com', 'mailpit.evil.example', 'mailpit\r\nDO_NOT_LEAK', 'http://mailpit']) {
    invalid(oauth(), env({ SMTP_HOST: host }));
  }
});

test('account secrets must be distinct canonical 32-byte keys and errors never disclose them', () => {
  for (const name of ['IDENTITY_ENCRYPTION_KEY', 'IDENTITY_LOOKUP_KEY']) {
    for (const value of [undefined, '', 'DO_NOT_LEAK', Buffer.alloc(31).toString('base64url'),
      Buffer.alloc(33).toString('base64url'), encryptionKey + '=', ' '.repeat(43), '*'.repeat(43),
    ]) invalid(oauth(), env({ [name]: value }));
  }
  invalid(oauth(), env({ IDENTITY_LOOKUP_KEY: encryptionKey }));
  // Base64url decoders accept non-zero unused bits; configuration must not accept aliases.
  invalid(oauth(), env({ IDENTITY_ENCRYPTION_KEY: 'A'.repeat(42) + 'B' }));
});

test('production mail configuration requires credentials and a TLS-capable port', () => {
  const tls = readIdentityConfig(production, productionEnv());
  assert.equal(tls.origin, 'https://login.example.com');
  assert.equal(tls.rpId, 'login.example.com');
  assert.equal(tls.smtp.secure, true);
  assert.equal(tls.smtp.port, 465);
  const startTls = readIdentityConfig(production, productionEnv({ SMTP_PORT: '587' }));
  assert.equal(startTls.smtp.secure, false);
  assert.equal(startTls.smtp.port, 587);
  for (const overrides of [{ SMTP_USER: undefined }, { SMTP_PASSWORD: undefined },
    { SMTP_USER: '' }, { SMTP_PASSWORD: '' }, { SMTP_PORT: '25' }, { SMTP_PORT: '1025' },
    { SMTP_HOST: '' }, { SMTP_HOST: 'smtp.example.com\r\nDO_NOT_LEAK' },
    { SMTP_FROM: 'DO_NOT_LEAK\r\nBcc: secret@example.com' },
  ]) invalid(production, productionEnv(overrides));
  for (const port of [undefined, '', '0', '-1', '65536', '1.5', 'NaN']) {
    invalid(oauth(), env({ SMTP_PORT: port }));
  }
  invalid(production, productionEnv({ SMTP_FROM: undefined }));
  invalid({ ...production, issuer: 'https://192.0.2.1/oidc' }, productionEnv());
});
