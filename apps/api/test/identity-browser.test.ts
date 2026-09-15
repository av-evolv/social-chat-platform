import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { BrowserContext, Page } from '@playwright/test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { createIdentity } from '../src/identity/index.js';
import type { IdentityConfig } from '../src/identity/config.js';
import { createOAuth } from '../src/oauth/index.js';
import type { OAuthConfig } from '../src/oauth/config.js';

const enabled = Boolean(process.env.OAUTH_TEST_DATABASE_URL) && process.env.OAUTH_TEST_BROWSER === '1';
const uuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Mail = { email: string; code: string; purpose: string };
type Tokens = { access_token: string; refresh_token: string; id_token: string };
type Device = { id: string; revokedAt: string | null; cryptoState: string };
type Account = { accountId: string; participantId: string; recoveryGeneration: number; devices: Device[] };
async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function fixture(t: TestContext) {
  const suffix = randomBytes(8).toString('hex');
  const schema = `identity_browser_${suffix}`; const oauthSchema = `oauth_identity_${suffix}`;
  const pool = new Pool({ connectionString: process.env.OAUTH_TEST_DATABASE_URL! });
  const origin = `http://localhost:${await port()}`;
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const config: OAuthConfig = {
    issuer: origin + '/oidc', resource: origin + '/api', mode: 'local',
    jwks: { keys: [{ ...jwk, kid: 'identity-browser-test', alg: 'RS256', use: 'sig' }] },
    cookieKeys: [randomBytes(48).toString('base64url')], clients: [{ client_id: 'identity-browser',
      redirect_uris: [origin + '/test/callback'], token_endpoint_auth_method: 'none',
      response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
      allowedScopes: ['profile:read', 'profile:write'], origins: [origin] }],
  };
  const identityConfig: IdentityConfig = { origin, rpId: 'localhost', mode: 'local',
    encryptionKey: randomBytes(32), lookupKey: randomBytes(32), smtp: { host: 'localhost', port: 1025, secure: false, from: 'test@example.com' } };
  const mails: Mail[] = [];
  const identity = await createIdentity(pool, identityConfig, config, {
    schema, mailer: async (email, code, purpose) => { mails.push({ email, code, purpose }); },
  });
  const oauth = await createOAuth(pool, config, identity.directory, { schema: oauthSchema, loginPath: '/account/login' });
  const app = Fastify({ logger: false });
  await oauth.mount(app); await identity.mount(app, oauth);
  app.get('/test/callback', async (_request, reply) => reply.type('text/html').send('<title>Callback</title>Authorization complete'));
  await app.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) });
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close(); await app.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${oauthSchema} CASCADE`);
    await pool.end();
  });
  async function context(existing?: BrowserContext) {
    const ctx = existing ?? await browser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.name));
    page.on('response', response => {
      if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } });
    return { ctx, page, cdp, authenticatorId: authenticatorId as string, failures };
  }
  async function register(target: Awaited<ReturnType<typeof context>>, email: string, recover = false) {
    await target.page.goto(origin + '/account/login');
    await target.page.locator('#email-address').fill(email);
    if (recover) { await target.page.locator('#purpose').selectOption('recover'); await target.page.locator('#recovery-confirm').check(); }
    const previous = mails.length;
    await target.page.getByRole('button', { name: 'Send verification code', exact: true }).click();
    await expect(target.page.locator('#verify')).toBeVisible();
    assert.equal(mails.length, previous + 1, 'Verification must use the injected delivery channel');
    const mail = mails.at(-1)!; assert.equal(mail.email, email); assert.equal(mail.purpose, recover ? 'recover' : 'register');
    await target.page.locator('#verification-code').fill(mail.code);
    await target.page.locator('#device-name').fill(recover ? 'Recovered browser' : 'Test browser');
    await target.page.getByRole('button', { name: 'Verify email and create passkey', exact: true }).click();
    try { await target.page.waitForURL(origin + '/account/complete'); }
    catch { assert.fail(`Registration did not complete: ${target.failures.join(', ')}; ${await target.page.locator('#status').textContent()}`); }
  }
  async function authorize(page: Page): Promise<Tokens> {
    const nonce = randomBytes(24).toString('base64url'); const verifier = randomBytes(32).toString('base64url'); const state = randomBytes(24).toString('base64url');
    const url = new URL(origin + '/oidc/auth');
    url.search = new URLSearchParams({ client_id: 'identity-browser', redirect_uri: origin + '/test/callback',
      response_type: 'code', scope: 'openid offline_access profile:read profile:write', resource: config.resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      state, nonce, prompt: 'consent' }).toString();
    await page.goto(url.href);
    for (let i = 0; i < 3 && new URL(page.url()).pathname !== '/test/callback'; i++) {
      await page.locator('button[value="approve"]').click();
      await page.waitForLoadState('domcontentloaded');
    }
    await page.waitForURL(value => value.pathname === '/test/callback');
    const result = new URL(page.url()); assert.equal(result.searchParams.get('state'), state);
    const code = result.searchParams.get('code'); assert.ok(code, 'OAuth callback must contain an authorization code');
    const response = await fetch(origin + '/oidc/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: 'identity-browser', code, code_verifier: verifier, redirect_uri: origin + '/test/callback',
    }) });
    assert.equal(response.status, 200, 'Code exchange must succeed');
    const tokens = await response.json() as Tokens; assert.ok(tokens.access_token && tokens.refresh_token && tokens.id_token);
    const confirm = (idToken: string, suppliedNonce: string) => fetch(origin + '/v1/session/confirm', {
      method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ idToken, nonce: suppliedNonce }),
    });
    assert.equal((await confirm(tokens.id_token, nonce)).status, 200, 'ID-token verification must retain configured signing key IDs');
    assert.equal((await confirm(tokens.id_token, 'wrong-nonce')).status, 400);
    assert.equal((await confirm(tokens.id_token + 'tampered', nonce)).status, 400);
    return tokens;
  }
  const api = (path: string, token?: string, method = 'GET') => fetch(origin + path, {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  async function account(tokens: Tokens) {
    const response = await api('/v1/account', tokens.access_token); assert.equal(response.status, 200);
    return await response.json() as Account;
  }
  async function refresh(tokens: Tokens) {
    return fetch(origin + '/oidc/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: 'identity-browser', refresh_token: tokens.refresh_token,
    }) });
  }
  return { origin, pool, schema, browser, context, register, authorize, account, api, refresh, expect, mails };
}

test('account browser ceremonies use real WebAuthn and PostgreSQL', { skip: !enabled, timeout: 120_000 }, async t => {
  await t.test('verified email creates a passkey account, OAuth session, and a reusable pending device', async t => {
    const f = await fixture(t); const user = await f.context();
    await f.register(user, 'Alice.Test+browser@example.com');
    const tokens = await f.authorize(user.page); const before = await f.account(tokens);
    assert.match(before.accountId, uuid7); assert.match(before.participantId, uuid7);
    assert.notEqual(before.accountId, before.participantId);
    assert.equal(before.devices.length, 1); assert.equal(before.devices[0]!.cryptoState, 'pending');
    assert.equal((await f.api('/v1/account')).status, 401);
    const cookies = await user.ctx.cookies(f.origin);
    const sessionCookie = cookies.find(cookie => cookie.name === 'larynx_session');
    assert.ok(sessionCookie?.httpOnly); assert.equal(sessionCookie.sameSite, 'Lax');
    const cookieOnly = await user.ctx.request.get(f.origin + '/v1/account'); assert.equal(cookieOnly.status(), 401);
    assert.equal((await f.api('/v1/logout', tokens.access_token, 'POST')).status, 200);
    assert.equal((await f.api('/v1/account', tokens.access_token)).status, 401);
    assert.equal((await f.refresh(tokens)).status, 400);
    await user.page.goto(f.origin + '/account/login');
    await user.page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await user.page.waitForURL(f.origin + '/account/complete');
    const loggedIn = await f.account(await f.authorize(user.page));
    assert.equal(loggedIn.accountId, before.accountId); assert.equal(loggedIn.participantId, before.participantId);
    assert.equal(loggedIn.devices.length, 1); assert.equal(loggedIn.devices[0]!.id, before.devices[0]!.id);
  });

  await t.test('recovery keeps account identity and invalidates old passkeys, devices, access and refresh', async t => {
    const f = await fixture(t); const old = await f.context();
    await f.register(old, 'recover@example.com'); const tokens = await f.authorize(old.page); const before = await f.account(tokens);
    const recovered = await f.context(); await f.register(recovered, 'recover@example.com', true);
    assert.equal((await f.api('/v1/account', tokens.access_token)).status, 401);
    assert.equal((await f.refresh(tokens)).status, 400);
    const after = await f.account(await f.authorize(recovered.page));
    assert.equal(after.accountId, before.accountId); assert.equal(after.participantId, before.participantId);
    assert.equal(after.recoveryGeneration, before.recoveryGeneration + 1);
    assert.equal(after.devices.length, 2);
    assert.ok(after.devices.find(device => device.id === before.devices[0]!.id)?.revokedAt);
    assert.equal(after.devices.filter(device => device.revokedAt === null).length, 1);
    assert.ok(after.devices.every(device => device.cryptoState === 'pending'));
    await old.page.goto(f.origin + '/account/login');
    await old.page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await f.expect(old.page.locator('#status')).toContainText('Unable to continue');
    assert.equal(new URL(old.page.url()).pathname, '/account/login');
  });

  await t.test('email proof and bootstrap CSRF are bound to the initiating browser', async t => {
    const f = await fixture(t); const owner = await f.context(); const other = await f.context();
    await owner.page.goto(f.origin + '/account/login'); await other.page.goto(f.origin + '/account/login');
    const csrf = async (page: Page) => page.locator('meta[name="larynx-csrf"]').getAttribute('content');
    const ownerCsrf = (await csrf(owner.page))!; const otherCsrf = (await csrf(other.page))!;
    const requestBody = { email: 'bound@example.com', purpose: 'register', returnTo: '/account/complete' };
    for (const headers of [
      { origin: f.origin, 'x-larynx-csrf': 'wrong' },
      { origin: 'https://attacker.example', 'x-larynx-csrf': ownerCsrf },
      { origin: 'null', 'x-larynx-csrf': ownerCsrf },
    ]) {
      const response = await owner.ctx.request.post(f.origin + '/account/email', { headers, data: requestBody });
      assert.equal(response.status(), 403);
    }
    assert.equal(f.mails.length, 0);
    await owner.page.locator('#email-address').fill('bound@example.com');
    await owner.page.getByRole('button', { name: 'Send verification code', exact: true }).click();
    await f.expect(owner.page.locator('#verify')).toBeVisible();
    const code = f.mails.at(-1)!.code;
    const theft = await other.ctx.request.post(f.origin + '/account/register/options', {
      headers: { origin: f.origin, 'x-larynx-csrf': otherCsrf }, data: { code, deviceName: 'Foreign browser' },
    });
    assert.equal(theft.status(), 400, 'Email proof must not work in a different browser');
    await owner.page.locator('#verification-code').fill(code);
    await owner.page.getByRole('button', { name: 'Verify email and create passkey', exact: true }).click();
    await owner.page.waitForURL(f.origin + '/account/complete');
    await owner.page.goto(f.origin + '/account/login');
    const replay = await owner.ctx.request.post(f.origin + '/account/register/options', {
      headers: { origin: f.origin, 'x-larynx-csrf': (await csrf(owner.page))! }, data: { code, deviceName: 'Replay' },
    });
    assert.equal(replay.status(), 400, 'Consumed proof must not create another passkey');
    assert.equal((await f.pool.query(`SELECT count(*)::integer AS count FROM ${f.schema}.accounts`)).rows[0].count, 1);
  });

  await t.test('server rejects a real authenticator response whose origin was substituted', async t => {
    const f = await fixture(t); const user = await f.context();
    await user.page.route('**/account/register/finish', async route => {
      const body = route.request().postDataJSON();
      const data = JSON.parse(Buffer.from(body.response.response.clientDataJSON, 'base64url').toString('utf8'));
      data.origin = 'https://attacker.example';
      body.response.response.clientDataJSON = Buffer.from(JSON.stringify(data)).toString('base64url');
      await route.continue({ postData: JSON.stringify(body) });
    });
    await user.page.goto(f.origin + '/account/login');
    await user.page.locator('#email-address').fill('tamper@example.com');
    await user.page.getByRole('button', { name: 'Send verification code', exact: true }).click();
    await f.expect(user.page.locator('#verify')).toBeVisible();
    await user.page.locator('#verification-code').fill(f.mails.at(-1)!.code);
    await user.page.getByRole('button', { name: 'Verify email and create passkey', exact: true }).click();
    await f.expect(user.page.locator('#status')).toContainText('Unable to continue');
    assert.equal((await f.pool.query(`SELECT count(*)::integer AS count FROM ${f.schema}.accounts`)).rows[0].count, 0);
    assert.equal((await user.ctx.cookies(f.origin)).some(cookie => cookie.name === 'larynx_session'), false);
  });

  await t.test('device revocation cannot cross accounts and self-revocation denies existing grants', async t => {
    const f = await fixture(t); const alice = await f.context(); const bob = await f.context();
    await f.register(alice, 'alice@example.com'); await f.register(bob, 'bob@example.com');
    const aliceTokens = await f.authorize(alice.page); const bobTokens = await f.authorize(bob.page);
    const aliceAccount = await f.account(aliceTokens); const bobAccount = await f.account(bobTokens);
    const bobDevice = bobAccount.devices[0]!.id;
    assert.equal((await f.api(`/v1/devices/${bobDevice}/revoke`, aliceTokens.access_token, 'POST')).status, 404);
    assert.equal((await f.api('/v1/account', bobTokens.access_token)).status, 200);
    assert.equal((await f.api(`/v1/devices/${aliceAccount.devices[0]!.id}/revoke`, aliceTokens.access_token, 'POST')).status, 200);
    assert.equal((await f.api('/v1/account', aliceTokens.access_token)).status, 401);
    assert.equal((await f.refresh(aliceTokens)).status, 400);
    assert.equal((await f.api('/v1/account', bobTokens.access_token)).status, 200);
  });
});
