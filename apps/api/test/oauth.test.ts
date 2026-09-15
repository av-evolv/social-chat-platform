import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createAdapter } from '../src/oauth/adapter.js';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { test, type TestContext } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import type { AccountDirectory, VerifiedSession } from '../src/oauth/accounts.js';
import type { OAuthConfig } from '../src/oauth/config.js';
import { createOAuth } from '../src/oauth/index.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const accountId = '0194a714-9a00-7000-8000-000000000001';
const participantId = '0194a714-9a00-7000-8000-000000000002';
const deviceId = '0194a714-9a00-7000-8000-000000000003';
const sessionId = '0194a714-9a00-7000-8000-000000000004';
const callback = 'https://client.example/callback';
const confidentialSecret = 'fixture-confidential-secret-for-protocol-tests-only';
const privateJwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/** A minimal cookie jar for real HTTP provider redirects, never used by application code. */
class Browser {
  private cookies = new Map<string, string>();

  constructor(private readonly origin: string, authenticated = true) {
    if (authenticated) this.cookies.set('fixture_session', 'verified');
  }

  async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.origin);
    assert.equal(url.origin, this.origin, 'Tests must not fetch the external client redirect');
    const headers = new Headers(options.headers);
    headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(url, { ...options, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]!;
      const separator = pair.indexOf('=');
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/max-age=0/i.test(cookie) || value === '') this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    return response;
  }
}

interface Tokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
  id_token?: string;
}

interface Authorization {
  browser: Browser;
  response: Response;
  verifier: string;
}

async function fixture(t: TestContext, redirectUri = callback) {
  const schema = `oauth_http_${randomBytes(8).toString('hex')}`;
  const pool = new Pool({ connectionString: databaseUrl! });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let eligible = true;
  let deviceEligible = true;
  const verified: VerifiedSession = { accountId, deviceId, sessionId };
  const accounts: AccountDirectory = {
    authenticate: async (request) => eligible && deviceEligible && /(?:^|; )fixture_session=verified(?:;|$)/.test(request.headers.cookie ?? '')
      ? verified : undefined,
    findAccount: async (id) => eligible && id === accountId ? { id, participantId } : undefined,
    isSessionActive: async (session) => deviceEligible && session.accountId === accountId
      && session.deviceId === deviceId && session.sessionId === sessionId,
  };
  const config: OAuthConfig = {
    issuer: `${origin}/oidc`, resource: `${origin}/api`, mode: 'local',
    jwks: { keys: [{ ...privateJwk, alg: 'RS256', use: 'sig', kid: 'fixture-signing-key' }] },
    cookieKeys: ['fixture-cookie-signing-key-with-at-least-thirty-two-bytes'],
    clients: [{
      client_id: 'fixture-public', client_name: 'Fixture application',
      redirect_uris: [redirectUri], response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      allowedScopes: ['profile:read', 'messages:read'], origins: [new URL(redirectUri).origin],
    }, {
      client_id: 'fixture-other', client_name: 'Another fixture application',
      redirect_uris: [redirectUri], response_types: ['code'], grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none', allowedScopes: ['profile:read'], origins: [new URL(redirectUri).origin],
    }, {
      client_id: 'fixture-confidential', client_secret: confidentialSecret,
      redirect_uris: [redirectUri], response_types: ['code'], grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'client_secret_basic', allowedScopes: ['profile:read'], origins: [],
    }],
  };
  let app: FastifyInstance;
  let oauth: Awaited<ReturnType<typeof createOAuth>>;
  async function start(): Promise<void> {
    app = Fastify({ logger: false });
    oauth = await createOAuth(pool, config, accounts, { schema });
    await oauth.provider.Client.find('fixture-public');
    await oauth.mount(app);
    await app.listen({ host: '127.0.0.1', port });
  }
  t.after(async () => {
    await app?.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });
  await start();

  const discoveryResponse = await fetch(`${config.issuer}/.well-known/openid-configuration`);
  assert.equal(discoveryResponse.status, 200);
  const discovery = await discoveryResponse.json() as Record<string, unknown>;
  const authorizationEndpoint = String(discovery.authorization_endpoint);
  const tokenEndpoint = String(discovery.token_endpoint);
  const revocationEndpoint = String(discovery.revocation_endpoint);

  async function begin(overrides: Record<string, string | undefined> = {}, authenticated = true): Promise<Authorization> {
    const browser = new Browser(origin, authenticated);
    const verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({
      client_id: 'fixture-public', redirect_uri: redirectUri,
      response_type: 'code', scope: 'openid offline_access profile:read',
      resource: config.resource, state: 'fixture-state', nonce: 'fixture-nonce',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', prompt: 'consent',
    });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) params.delete(key);
      else params.set(key, value);
    }
    return { browser, verifier, response: await browser.request(`${authorizationEndpoint}?${params}`) };
  }

  async function complete(auth: Authorization, decision = 'approve'): Promise<URL> {
    let response = auth.response;
    for (let step = 0; step < 12; step += 1) {
      const location = response.headers.get('location');
      if (location) {
        const next = new URL(location, origin);
        if (next.origin === new URL(redirectUri).origin) return next;
        response = await auth.browser.request(next.href);
        continue;
      }
      const html = await response.text();
      assert.equal(response.status, 200, html);
      const csrf = /name=["']csrf["'][^>]*value=["']([^"']+)["']/.exec(html)
        ?? /value=["']([^"']+)["'][^>]*name=["']csrf["']/.exec(html);
      assert.ok(csrf?.[1], `Expected an interaction CSRF form: ${html}`);
      response = await auth.browser.request(response.url, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
        body: new URLSearchParams({ csrf: csrf[1], decision }),
      });
    }
    assert.fail('Authorization did not terminate within the bounded redirect budget');
  }

  async function exchange(code: string, verifier: string, extra: Record<string, string> = {}): Promise<Response> {
    return fetch(tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'fixture-public',
        code, code_verifier: verifier, redirect_uri: redirectUri, resource: config.resource, ...extra }),
    });
  }

  async function authorize(scope = 'openid offline_access profile:read'): Promise<Tokens> {
    const auth = await begin({ scope });
    const destination = await complete(auth);
    assert.equal(destination.searchParams.get('state'), 'fixture-state');
    assert.equal(destination.searchParams.get('error'), null, destination.href);
    const code = destination.searchParams.get('code');
    assert.ok(code);
    const response = await exchange(code, auth.verifier);
    const tokens = await response.json() as Tokens;
    assert.equal(response.status, 200, JSON.stringify(tokens));
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.access_token);
    return tokens;
  }

  async function session(token?: string, scheme = 'Bearer'): Promise<Response> {
    return fetch(`${origin}/v1/session`, { headers: token ? { authorization: `${scheme} ${token}` } : {} });
  }

  async function refresh(token: string): Promise<Response> {
    return fetch(tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'fixture-public',
        refresh_token: token, resource: config.resource }),
    });
  }

  async function introspect(token: string, confidential = false): Promise<Record<string, unknown>> {
    const response = await fetch(String(discovery.introspection_endpoint), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
        ...(confidential ? { authorization: `Basic ${Buffer.from(`fixture-confidential:${confidentialSecret}`).toString('base64')}` } : {}) },
      body: new URLSearchParams({ token, ...(confidential ? {} : { client_id: 'fixture-public' }) }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Record<string, unknown>>;
  }

  return { origin, config, pool, schema, discovery, begin, complete, exchange, authorize, session, refresh, introspect,
    revocationEndpoint, provider: () => oauth.provider, oauth: () => oauth,
    disableAccount: () => { eligible = false; },
    disableDevice: () => { deviceEligible = false; },
    restart: async () => { await app.close(); await start(); },
  };
}

test('OAuth protocol and current authorization against PostgreSQL', {
  skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL to a disposable PostgreSQL database',
  timeout: 120_000,
}, async (t) => {
  await t.test('discovery, PKCE consent flow, ID token and delegated account session', async (t) => {
    const f = await fixture(t);
    assert.equal(f.discovery.issuer, f.config.issuer);
    assert.deepEqual(f.discovery.response_types_supported, ['code']);
    assert.deepEqual(f.discovery.code_challenge_methods_supported, ['S256']);
    const jwksResponse = await fetch(String(f.discovery.jwks_uri));
    assert.equal(jwksResponse.status, 200);
    const jwks = await jwksResponse.json() as { keys: Record<string, unknown>[] };
    assert.ok(jwks.keys.some((key) => key.kid === 'fixture-signing-key'));
    assert.ok(jwks.keys.every((key) => !('d' in key) && !('p' in key)));
    const tokens = await f.authorize();
    assert.ok(tokens.refresh_token);
    assert.ok(tokens.id_token);
    const response = await f.session(tokens.access_token);
    assert.equal(response.status, 200, await response.clone().text());
    const principal = await response.json() as Record<string, unknown>;
    assert.equal(principal.accountId, accountId);
    assert.equal(principal.participantId, participantId);
    assert.equal(principal.deviceId, deviceId);
    assert.equal(principal.clientId, 'fixture-public');
    assert.equal((await f.session(tokens.id_token)).status, 401, 'An ID token cannot access product APIs');
  });

  await t.test('Chromium completes cookie-bound login and consent with its automatic form Origin', {
    skip: process.env.OAUTH_TEST_BROWSER === '1' ? false : 'Set OAUTH_TEST_BROWSER=1 after installing Playwright Chromium',
    timeout: 30_000,
  }, async (t) => {
    // Playwright routing does not intercept every hop in an HTTP redirect chain.
    // A second real server exercises the cross-origin callback without DNS or interception.
    const callbackApp = Fastify();
    callbackApp.get('/callback', (_request, reply) => reply.type('text/html').send('<!doctype html><title>Fixture callback</title>'));
    const callbackOrigin = await callbackApp.listen({ host: '127.0.0.1', port: 0 });
    t.after(() => callbackApp.close());
    const browserCallback = `${callbackOrigin}/callback`;
    const f = await fixture(t, browserCallback);
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([{ name: 'fixture_session', value: 'verified', url: f.origin,
      httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(5_000);
    const submissionOrigins: Promise<string | undefined>[] = [];
    const browserDiagnostics: string[] = [];
    page.on('console', message => browserDiagnostics.push(message.text()));
    page.on('requestfailed', request => browserDiagnostics.push(`${new URL(request.url()).pathname} ${request.failure()?.errorText}`));
    page.on('response', response => browserDiagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`));
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().startsWith(`${f.origin}/oidc/interaction/`)) {
        submissionOrigins.push(request.allHeaders().then((headers) => headers.origin));
      }
    });
    const isCallback = (url: URL) => url.origin === callbackOrigin && url.pathname === '/callback';
    const verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({
      client_id: 'fixture-public', redirect_uri: browserCallback,
      response_type: 'code', scope: 'openid offline_access profile:read',
      resource: f.config.resource, state: 'chromium-state', nonce: 'chromium-nonce',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', prompt: 'consent',
    });
    const interactionPage = await page.goto(`${String(f.discovery.authorization_endpoint)}?${params}`);
    assert.ok(interactionPage);
    const interactionHeaders = interactionPage.headers();
    assert.equal(interactionHeaders['referrer-policy'], 'same-origin');
    const csp = interactionHeaders['content-security-policy'] ?? '';
    const directives = csp.split(';').map(directive => directive.trim());
    assert.ok(directives.includes("default-src 'none'"));
    assert.ok(directives.includes("frame-ancestors 'none'"));
    const formAction = directives.find(directive => directive.startsWith('form-action '));
    assert.ok(formAction);
    assert.deepEqual(new Set(formAction.split(/\s+/).slice(1)), new Set(["'self'", callbackOrigin]));
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    try { await page.getByRole('button', { name: 'Allow', exact: true }).waitFor(); }
    catch (error) {
      t.diagnostic(JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(),
        origins: await Promise.all(submissionOrigins), browserDiagnostics,
        cookies: (await context.cookies()).map(({ name, path, sameSite, httpOnly, secure }) => ({ name, path, sameSite, httpOnly, secure })) }));
      throw error;
    }
    try {
      await Promise.all([
        page.waitForURL(isCallback),
        page.getByRole('button', { name: 'Allow', exact: true }).click(),
      ]);
    } catch (error) {
      await page.waitForTimeout(100);
      t.diagnostic(JSON.stringify({ url: page.url(), browserDiagnostics }));
      throw error;
    }
    const destination = new URL(page.url());
    assert.equal(destination.searchParams.get('state'), 'chromium-state');
    assert.equal(destination.searchParams.get('error'), null);
    const code = destination.searchParams.get('code');
    assert.ok(code);
    assert.deepEqual(await Promise.all(submissionOrigins), [f.origin, f.origin]);
    const exchanged = await f.exchange(code, verifier);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const tokens = await exchanged.json() as Tokens;
    assert.equal((await f.session(tokens.access_token)).status, 200);
  });

  await t.test('missing credentials, malformed tokens and unsupported schemes deny access', async (t) => {
    const f = await fixture(t);
    assert.equal((await f.session()).status, 401);
    assert.equal((await f.session('not-a-token')).status, 401);
    const tokens = await f.authorize();
    assert.equal((await f.session(tokens.access_token, 'Basic')).status, 401);
  });

  await t.test('approved browser origins receive exact CORS headers and unauthorized origins cannot read the session', async (t) => {
    const f = await fixture(t);
    const tokens = await f.authorize();
    const approvedOrigin = 'https://client.example';
    const approved = await fetch(`${f.origin}/v1/session`, {
      headers: { authorization: `Bearer ${tokens.access_token}`, origin: approvedOrigin },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.headers.get('access-control-allow-origin'), approvedOrigin);
    assert.equal((await approved.json() as { accountId: string }).accountId, accountId);
    const preflight = await fetch(`${f.origin}/v1/session`, {
      method: 'OPTIONS', headers: { origin: approvedOrigin,
        'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), approvedOrigin);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /(?:^|[,\s])GET(?:$|[,\s])/);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /(?:^|[,\s])authorization(?:$|[,\s])/i);
    const denied = await fetch(`${f.origin}/v1/session`, {
      headers: { authorization: `Bearer ${tokens.access_token}`, origin: 'https://unapproved.example' },
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.doesNotMatch(await denied.text(), new RegExp(accountId));
    const deniedPreflight = await fetch(`${f.origin}/v1/session`, {
      method: 'OPTIONS', headers: { origin: 'https://unapproved.example',
        'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);
  });

  await t.test('encoded or duplicate provider prefixes never bypass product authentication', async (t) => {
    const f = await fixture(t);
    const paths = [
      '/oidc/../v1/session', '/oidc/%2e%2e/v1/session', '/oidc%2fv1/session',
      '/oidc%252fv1/session', '/oidc/oidc/v1/session', '/oidc//v1/session',
    ];
    for (const path of paths) {
      const response = await fetch(`${f.origin}${path}?accountId=${accountId}`, { redirect: 'manual' });
      assert.ok(response.status === 400 || response.status === 401 || response.status === 404,
        `Unexpected response to ${path}: ${response.status}`);
      const body = await response.text();
      assert.doesNotMatch(body, /"participantId"|"deviceId"|"scopes"/);
    }
  });

  await t.test('an unverified browser cannot authenticate by supplying an account ID', async (t) => {
    const f = await fixture(t);
    const auth = await f.begin({ accountId, login_hint: accountId }, false);
    let response = auth.response;
    for (let i = 0; i < 8 && response.headers.has('location'); i += 1) {
      response = await auth.browser.request(response.headers.get('location')!);
    }
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: string }).error, 'account_authentication_unavailable');
    const submitted = await auth.browser.request(response.url, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: f.origin },
      body: new URLSearchParams({ accountId, decision: 'approve', csrf: 'invented' }),
    });
    assert.equal(submitted.status, 503);
    assert.equal(submitted.headers.get('location'), null);
    assert.equal((await f.session()).status, 401);
  });

  await t.test('PKCE omission, unsupported resource and redirect mismatch cannot authorize', async (t) => {
    const f = await fixture(t);
    for (const overrides of [
      { code_challenge: undefined, code_challenge_method: undefined },
      { resource: 'https://other.example/api' },
      { redirect_uri: 'https://evil.example/callback' },
      { redirect_uri: 'https://client.example/unregistered' },
      { redirect_uri: `${callback}?unregistered=1` },
    ]) {
      const auth = await f.begin(overrides);
      const location = auth.response.headers.get('location');
      if (location && new URL(location, f.origin).origin === 'https://client.example') {
        assert.ok(new URL(location, f.origin).searchParams.get('error'));
      } else {
        assert.ok(auth.response.status >= 400, `Expected rejection, got ${auth.response.status} ${location}`);
      }
    }
  });

  await t.test('wrong verifier and reused authorization code cannot produce a second grant', async (t) => {
    const f = await fixture(t);
    const wrong = await f.begin();
    const wrongDestination = await f.complete(wrong);
    const rejected = await f.exchange(wrongDestination.searchParams.get('code')!, randomBytes(32).toString('base64url'));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { error: string }).error, 'invalid_grant');
    const noVerifier = await f.begin();
    const noVerifierDestination = await f.complete(noVerifier);
    const missing = await f.exchange(noVerifierDestination.searchParams.get('code')!, '');
    assert.equal(missing.status, 400);
    const auth = await f.begin();
    const destination = await f.complete(auth);
    const code = destination.searchParams.get('code')!;
    const wrongClient = await f.exchange(code, auth.verifier, { client_id: 'fixture-other' });
    assert.equal(wrongClient.status, 400);
    const first = await f.exchange(code, auth.verifier);
    assert.equal(first.status, 200, await first.clone().text());
    const tokens = await first.json() as Tokens;
    const replay = await f.exchange(code, auth.verifier);
    assert.equal(replay.status, 400);
    assert.equal((await f.session(tokens.access_token)).status, 401, 'Code reuse revokes its token family');
  });

  await t.test('denied consent and invalid CSRF never issue a code', async (t) => {
    const f = await fixture(t);
    const denied = await f.complete(await f.begin(), 'deny');
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(denied.searchParams.get('code'), null);
    const auth = await f.begin();
    let response = auth.response;
    for (let i = 0; i < 8 && response.headers.has('location'); i += 1) {
      response = await auth.browser.request(response.headers.get('location')!);
    }
    assert.equal(response.status, 200);
    const rejected = await auth.browser.request(response.url, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: f.origin },
      body: new URLSearchParams({ decision: 'approve', csrf: 'forged' }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('location'), null);
  });

  await t.test('an authenticated token with insufficient scope gets 403', async (t) => {
    const f = await fixture(t);
    const tokens = await f.authorize('openid messages:read');
    assert.equal(tokens.refresh_token, undefined, 'Refresh eligibility requires offline_access');
    assert.equal((await f.session(tokens.access_token)).status, 403);
  });

  await t.test('an unavailable account authenticator cannot create a login session', async (t) => {
    const f = await fixture(t);
    f.disableAccount();
    const auth = await f.begin();
    let response = auth.response;
    for (let i = 0; i < 8 && response.headers.has('location'); i += 1) {
      response = await auth.browser.request(response.headers.get('location')!);
    }
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: string }).error, 'account_authentication_unavailable');
  });

  await t.test('current account eligibility is checked after token issuance', async (t) => {
    const f = await fixture(t);
    const tokens = await f.authorize();
    f.disableAccount();
    assert.equal((await f.introspect(tokens.access_token)).active, false);
    assert.equal((await f.session(tokens.access_token)).status, 401);
    assert.equal((await f.refresh(tokens.refresh_token!)).status, 400);
  });

  await t.test('a revoked device session loses API and refresh access while its account remains active', async (t) => {
    const f = await fixture(t);
    const tokens = await f.authorize();
    assert.equal((await f.introspect(tokens.access_token)).active, true);
    f.disableDevice();
    assert.equal((await f.introspect(tokens.access_token)).active, false);
    assert.equal((await f.session(tokens.access_token)).status, 401);
    assert.equal((await f.refresh(tokens.refresh_token!)).status, 400);
  });

  await t.test('a different confidential client cannot introspect or revoke another application grant', async (t) => {
    const f = await fixture(t);
    const tokens = await f.authorize();
    assert.equal((await f.introspect(tokens.access_token, true)).active, false);
    const response = await fetch(f.revocationEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`fixture-confidential:${confidentialSecret}`).toString('base64')}` },
      body: new URLSearchParams({ token: tokens.refresh_token! }),
    });
    assert.ok(response.status === 200 || response.status === 400);
    assert.equal((await f.session(tokens.access_token)).status, 200, 'Another application must not revoke this grant');
  });

  await t.test('refresh rotation detects replay and invalidates the entire grant', async (t) => {
    const f = await fixture(t);
    const original = await f.authorize();
    const rotatedResponse = await f.refresh(original.refresh_token!);
    assert.equal(rotatedResponse.status, 200, await rotatedResponse.clone().text());
    const rotated = await rotatedResponse.json() as Tokens;
    assert.notEqual(rotated.refresh_token, original.refresh_token);
    assert.equal((await f.session(rotated.access_token)).status, 200);
    const replay = await f.refresh(original.refresh_token!);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as { error: string }).error, 'invalid_grant');
    assert.equal((await f.session(original.access_token)).status, 401);
    assert.equal((await f.session(rotated.access_token)).status, 401);
    assert.equal((await f.refresh(rotated.refresh_token!)).status, 400);
  });

  await t.test('concurrent refresh replay cannot leave a usable winning token', async (t) => {
    const f = await fixture(t);
    const original = await f.authorize();
    const responses = await Promise.all([f.refresh(original.refresh_token!), f.refresh(original.refresh_token!)]);
    assert.ok(responses.some((response) => response.status === 400));
    assert.ok(responses.every((response) => response.status === 200 || response.status === 400));
    for (const response of responses) {
      const result = await response.json() as Tokens & { error?: string };
      if (response.status === 200) {
        assert.equal((await f.session(result.access_token)).status, 401);
        assert.equal((await f.refresh(result.refresh_token!)).status, 400);
      } else assert.equal(result.error, 'invalid_grant');
    }
    assert.equal((await f.session(original.access_token)).status, 401);
  });

  await t.test('sessions survive process restart and revocation survives another restart', async (t) => {
    const f = await fixture(t);
    const tokens = await f.authorize();
    await f.restart();
    assert.equal((await f.session(tokens.access_token)).status, 200);
    const revoked = await fetch(f.revocationEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'fixture-public', token: tokens.refresh_token!, token_type_hint: 'refresh_token' }),
    });
    assert.equal(revoked.status, 200, await revoked.text());
    await f.restart();
    assert.equal((await f.session(tokens.access_token)).status, 401);
    assert.equal((await f.refresh(tokens.refresh_token!)).status, 400);
  });

  await t.test('wrong audience and expired opaque tokens are rejected', async (t) => {
    const f = await fixture(t);
    const tokens = await f.authorize();
    const token = await f.provider().AccessToken.find(tokens.access_token);
    assert.ok(token);
    await f.pool.query(`UPDATE ${f.schema}.artifacts SET payload = jsonb_set(payload, '{aud}', to_jsonb($1::text))
      WHERE model = 'AccessToken' AND id = $2`, ['https://other.example/api', token.jti]);
    assert.equal((await f.session(tokens.access_token)).status, 401);
    await f.pool.query(`UPDATE ${f.schema}.artifacts SET payload = jsonb_set(payload, '{aud}', to_jsonb($1::text)),
      expires_at = clock_timestamp() - interval '1 second' WHERE model = 'AccessToken' AND id = $2`, [f.config.resource, token.jti]);
    assert.equal((await f.session(tokens.access_token)).status, 401);
  });
});


test('OAuth grants stay current and locked throughout a product transaction', {
  skip: !databaseUrl, timeout: 30_000,
}, async t => {
  const f = await fixture(t);
  const tokens = await f.authorize();
  const oauth = f.oauth();
  const actor = await oauth.authorize({ headers: { authorization: `Bearer ${tokens.access_token}` } } as IncomingMessage, ['profile:read']);
  const token = await f.provider().AccessToken.find(tokens.access_token);
  assert.ok(token?.grantId);
  const db = await f.pool.connect();
  try {
  await db.query('BEGIN');
  await assert.rejects(oauth.assertTransaction(db, { ...actor }), { code: 'invalid_token' });
  await oauth.assertTransaction(db, actor);
  const Adapter = createAdapter(f.pool, { schema: f.schema });
  let revoked = false;
  const pending = new Adapter('Grant').revokeByGrantId(token.grantId).then(() => { revoked = true; });
  // Observe the real lock waiter, rather than guessing from elapsed time.
  let waiting = false;
  for (let i = 0; i < 100; i++) {
    const result = await f.pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
      AND objid=(hashtextextended($1,0) & 4294967295)::oid`, [`${f.schema}:grant:${token.grantId}`]);
    if (result.rowCount) { waiting = true; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(waiting, true);
  assert.equal(revoked, false);
  await db.query('COMMIT');
  await pending;
  await db.query('BEGIN');
  await assert.rejects(oauth.assertTransaction(db, actor), { code: 'invalid_token' });
  await db.query('ROLLBACK');
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('OAuth transaction assertion rechecks narrowed consent and token expiry', {
  skip: !databaseUrl, timeout: 30_000,
}, async t => {
  const f = await fixture(t);
  const tokens = await f.authorize();
  const oauth = f.oauth();
  const actor = await oauth.authorize({ headers: { authorization: `Bearer ${tokens.access_token}` } } as IncomingMessage, ['profile:read']);
  const token = await f.provider().AccessToken.find(tokens.access_token);
  assert.ok(token?.grantId);
  const grant = await f.provider().Grant.find(token.grantId);
  assert.ok(grant);
  grant.rejectResourceScope(f.config.resource, 'profile:read');
  await grant.save();
  const db = await f.pool.connect();
  try {
  await db.query('BEGIN');
  await assert.rejects(oauth.assertTransaction(db, actor), { code: 'invalid_token' });
  await db.query('ROLLBACK');
  const fresh = await f.authorize();
  const freshActor = await oauth.authorize({ headers: { authorization: `Bearer ${fresh.access_token}` } } as IncomingMessage, ['profile:read']);
  const freshToken = await f.provider().AccessToken.find(fresh.access_token);
  assert.ok(freshToken);
  await f.pool.query(`UPDATE ${f.schema}.artifacts SET expires_at=clock_timestamp()-interval '1 second' WHERE model='AccessToken' AND id=$1`, [freshToken.jti]);
  await db.query('BEGIN');
  await assert.rejects(oauth.assertTransaction(db, freshActor), { code: 'invalid_token' });
  await db.query('ROLLBACK');
  } finally { await db.query('ROLLBACK'); db.release(); }
});
