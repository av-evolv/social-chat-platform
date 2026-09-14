import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { readOAuthConfig, type ApprovedClient } from '../src/oauth/config.js';

const run = promisify(execFile);
const key = {
  ...generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }),
  alg: 'RS256', use: 'sig', kid: 'config-test-key',
};
const cookieKey = 'test_cookie_key_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const client: ApprovedClient = {
  client_id: 'test-web', redirect_uris: ['https://client.example/oauth/callback'],
  token_endpoint_auth_method: 'none', response_types: ['code'],
  grant_types: ['authorization_code', 'refresh_token'],
  allowedScopes: ['profile:read'], origins: ['https://client.example'],
};
const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OAUTH_MODE: 'local', OAUTH_ISSUER: 'http://127.0.0.1:3000/oidc',
  OAUTH_RESOURCE: 'http://127.0.0.1:3000/api',
  OAUTH_JWKS: JSON.stringify({ keys: [key] }),
  OAUTH_COOKIE_KEYS: JSON.stringify([cookieKey]),
  OAUTH_CLIENTS: JSON.stringify([client]), ...overrides,
});
const clientEnv = (overrides: Record<string, unknown>) => env({ OAUTH_CLIENTS: JSON.stringify([{ ...client, ...overrides }]) });
function invalid(input: NodeJS.ProcessEnv) {
  assert.throws(() => readOAuthConfig(input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Invalid OAuth configuration: [a-zA-Z_ /]+$/);
    assert.doesNotMatch(error.message, /DO_NOT_LEAK|super-secret|client\.example|127\.0\.0\.1/);
    return true;
  });
}

test('OAuth configuration accepts persistent local and HTTPS production credentials', () => {
  const local = readOAuthConfig(env());
  assert.equal(local.issuer, 'http://127.0.0.1:3000/oidc');
  assert.equal(local.resource, 'http://127.0.0.1:3000/api');
  assert.equal(local.mode, 'local');
  assert.equal(local.trustProxy, false);
  assert.deepEqual(local.jwks, { keys: [key] });
  assert.deepEqual(local.cookieKeys, [cookieKey]);
  assert.deepEqual(local.clients, [client]);
  const production = readOAuthConfig(env({
    OAUTH_MODE: 'production', OAUTH_ISSUER: 'https://chat.example/oidc',
    OAUTH_RESOURCE: 'https://chat.example/api', OAUTH_TRUST_PROXY: 'true',
  }));
  assert.equal(production.mode, 'production');
  assert.equal(production.trustProxy, true);
  const confidential = readOAuthConfig(clientEnv({
    token_endpoint_auth_method: 'client_secret_basic', client_secret: 'a'.repeat(32),
  }));
  assert.equal(confidential.clients[0]?.token_endpoint_auth_method, 'client_secret_basic');
  const native = readOAuthConfig(clientEnv({ application_type: 'native',
    redirect_uris: ['larynx://oauth/callback', 'com.example.larynx:/oauth/callback'], origins: [],
  }));
  assert.equal(native.clients[0]?.redirect_uris?.length, 2);
  assert.deepEqual(readOAuthConfig(env({ OAUTH_CLIENTS: '[]' })).clients, []);
});

test('OAuth issuer, resource and trusted-proxy configuration fail closed', () => {
  for (const overrides of [
    { OAUTH_MODE: 'test' },
    { OAUTH_MODE: 'production' },
    { OAUTH_ISSUER: 'http://operator:super-secret@127.0.0.1:3000/oidc' },
    { OAUTH_ISSUER: 'http://127.0.0.1:3000/oidc?token=DO_NOT_LEAK' },
    { OAUTH_ISSUER: 'http://127.0.0.1:3000/oidc#DO_NOT_LEAK' },
    { OAUTH_ISSUER: 'http://127.0.0.1:3000/other' },
    { OAUTH_ISSUER: 'DO_NOT_LEAK' },
    { OAUTH_RESOURCE: 'http://other.example/api' },
    { OAUTH_RESOURCE: 'http://127.0.0.1:3000/api?token=DO_NOT_LEAK' },
    { OAUTH_RESOURCE: 'http://127.0.0.1:3000/other' },
    { OAUTH_TRUST_PROXY: 'true' },
    { OAUTH_TRUST_PROXY: 'sometimes' },
    { OAUTH_ISSUER: 'http://external.example/oidc', OAUTH_RESOURCE: 'http://external.example/api' },
    { OAUTH_MODE: 'production', OAUTH_ISSUER: 'https://localhost/oidc', OAUTH_RESOURCE: 'https://localhost/api' },
  ]) invalid(env(overrides));
});

test('OAuth signing keys reject public, weak, duplicate and malformed material without leakage', () => {
  const publicKey = { ...key };
  delete publicKey.d;
  const smallKey = {
    ...generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'jwk' }),
    alg: 'RS256', use: 'sig', kid: 'small-key',
  };
  for (const keys of [[], [null], ['DO_NOT_LEAK'], [43], [publicKey], [smallKey],
    [key, key], [{ ...key, alg: 'HS256' }], [{ ...key, use: 'enc' }],
    [{ ...key, kid: '' }], [{ ...key, d: 'DO_NOT_LEAK', p: 'invalid', q: 'invalid' }],
  ]) invalid(env({ OAUTH_JWKS: JSON.stringify({ keys }) }));
  for (const value of ['{DO_NOT_LEAK', 'null', '[]', '{}']) invalid(env({ OAUTH_JWKS: value }));
  const rotated = readOAuthConfig(env({ OAUTH_JWKS: JSON.stringify({ keys: [key, { ...key, kid: 'second-key' }] }) }));
  assert.equal(rotated.jwks.keys.length, 2);
});

test('OAuth cookie keys require distinct URL-safe key material and sanitized JSON failures', () => {
  for (const keys of [[], [null], [42], ['short'], ['a'.repeat(42)], ['a'.repeat(43) + '\n'],
    ['a'.repeat(42) + '='], [cookieKey, cookieKey]]) {
    invalid(env({ OAUTH_COOKIE_KEYS: JSON.stringify(keys) }));
  }
  for (const value of ['DO_NOT_LEAK', 'null', '{}']) invalid(env({ OAUTH_COOKIE_KEYS: value }));
});

test('OAuth clients reject unsupported grants, unsafe redirects, secrets and scopes', () => {
  for (const overrides of [
    { client_id: '' }, { token_endpoint_auth_method: 'client_secret_post' },
    { token_endpoint_auth_method: 'client_secret_basic', client_secret: 'super-secret' },
    { client_secret: 'DO_NOT_LEAK' }, { response_types: ['token'] },
    { grant_types: ['client_credentials'] }, { grant_types: ['authorization_code', 'password'] },
    { grant_types: 'authorization_code' }, { allowedScopes: ['administrator:*'] },
    { allowedScopes: null }, { redirect_uris: [] },
    { redirect_uris: ['https://client.example/*'] },
    { redirect_uris: ['https://operator:super-secret@client.example/callback'] },
    { redirect_uris: ['https://client.example/callback#DO_NOT_LEAK'] },
    { redirect_uris: ['http://client.example/callback'] },
    { redirect_uris: ['larynx://oauth/callback'] },
    { application_type: 'native', redirect_uris: ['javascript:DO_NOT_LEAK'] },
    { application_type: 'native', redirect_uris: ['unclaimed:/oauth/callback'] },
    { origins: ['https://client.example/'] }, { origins: ['*'] },
    { origins: ['http://client.example'] }, { origins: null },
  ]) invalid(clientEnv(overrides));
  invalid(env({ OAUTH_MODE: 'production', OAUTH_ISSUER: 'https://chat.example/oidc',
    OAUTH_RESOURCE: 'https://chat.example/api',
    OAUTH_CLIENTS: JSON.stringify([{ ...client, redirect_uris: ['http://127.0.0.1:8088/callback'] }]),
  }));
  invalid(env({ OAUTH_CLIENTS: JSON.stringify([client, client]) }));
  invalid(env({ OAUTH_CLIENTS: JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ ...client, client_id: `app-${index}` }))) }));
  for (const value of ['DO_NOT_LEAK', 'null', '{}', '[null]']) invalid(env({ OAUTH_CLIENTS: value }));
});

test('Local OAuth bootstrap preserves private signing credentials across repeated runs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'larynx-oauth-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../../../scripts/setup-local-oauth.mjs', import.meta.url));
  const options = { cwd: directory, env: { ...process.env, API_PORT: '4321', WEB_PORT: '8765' } };
  const first = await run(process.execPath, [script], options);
  const file = join(directory, '.env.oauth');
  const original = await readFile(file, 'utf8');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const generated: NodeJS.ProcessEnv = {};
  for (const line of original.trimEnd().split('\n')) {
    const match = /^([A-Z_]+)='(.*)'$/.exec(line);
    assert.ok(match, 'Bootstrap writes quoted dotenv values');
    generated[match[1]!] = match[2]!;
  }
  const configured = readOAuthConfig(generated);
  assert.equal(configured.mode, 'local');
  assert.equal(configured.issuer, 'http://127.0.0.1:4321/oidc');
  assert.ok(configured.clients.every(client => client.token_endpoint_auth_method === 'none' && client.client_secret === undefined));
  assert.ok(configured.clients.every(client => client.allowedScopes.join(' ') === 'profile:read'));
  assert.ok(configured.clients.find(client => client.client_id === 'larynx-web')?.origins.includes('http://127.0.0.1:8765'));
  assert.deepEqual(Object.keys(generated).sort(), ['OAUTH_CLIENTS', 'OAUTH_COOKIE_KEYS', 'OAUTH_ISSUER', 'OAUTH_JWKS', 'OAUTH_MODE', 'OAUTH_RESOURCE']);
  const second = await run(process.execPath, [script], options);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const generatedKey = configured.jwks.keys[0]!;
  assert.ok('d' in generatedKey && typeof generatedKey.d === 'string');
  for (const output of [first.stdout, first.stderr, second.stdout, second.stderr]) {
    assert.ok(!output.includes(generated.OAUTH_JWKS!));
    assert.ok(!output.includes(configured.cookieKeys[0]!));
    assert.ok(!output.includes(generatedKey.d));
  }
});
