import { createPublicKey, timingSafeEqual, type JsonWebKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Pool } from 'pg';
import type { AccountDirectory, VerifiedSession } from '../oauth/accounts.js';
import { OAuthAccessError, type createOAuth } from '../oauth/index.js';
import type { OAuthConfig } from '../oauth/config.js';
import { canonicalEmail, digest, keyed, protectEmail, revealEmail, secret, type IdentityConfig } from './config.js';
import { createMailer, type VerificationMailer } from './mail.js';
import { IdentityStore, IdentityStoreError, type Registration, type SessionResult, type IdentityStoreOptions } from './store.js';

type OAuth = Awaited<ReturnType<typeof createOAuth>>;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const string = (v: unknown, max = 4096): string => { if (typeof v !== 'string' || v.length > max) throw new Error('Invalid request'); return v; };
const returnPath = (v: unknown) => typeof v === 'string' && /^\/oidc\/interaction\/[A-Za-z0-9_-]+$/.test(v) ? v : '/account/complete';
function cookie(request: IncomingMessage, name: string): string | undefined {
  const values = (request.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export async function createIdentity(pool: Pool, config: IdentityConfig, oauthConfig: OAuthConfig, options: IdentityStoreOptions & { mailer?: VerificationMailer } = {}) {
  const store = new IdentityStore(pool, options);
  await store.migrate();
  const mail = options.mailer ?? createMailer(config);
  const prefix = config.mode === 'production' ? '__Host-' : '';
  const names = { flow: `${prefix}larynx_flow`, session: `${prefix}larynx_session`, device: `${prefix}larynx_device` };
  const setCookie = (reply: FastifyReply, name: string, value: string, maxAge: number) => {
    const existing = reply.getHeader('set-cookie');
    reply.header('set-cookie', [...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []), `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.mode === 'production' ? '; Secure' : ''}`]);
  };
  const directory: AccountDirectory = {
    authenticate: async request => { const value = cookie(request, names.session); return value ? store.session(digest(value)) : undefined; },
    findAccount: id => store.findAccount(id), isSessionActive: value => store.isSessionActive(value),
  };
  const csrf = (flow: string) => keyed(config, 'csrf', flow);
  function formContext(request: FastifyRequest) {
    const flow = cookie(request.raw, names.flow); const supplied = request.headers['x-larynx-csrf'];
    if (request.headers.origin !== config.origin || !flow || typeof supplied !== 'string' || supplied.length !== csrf(flow).length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf(flow)))) throw new OAuthAccessError(403, 'invalid_token');
    return digest(flow);
  }
  const bodyOf = (request: FastifyRequest): Record<string, unknown> => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new Error('Invalid request');
    return request.body as Record<string, unknown>;
  };
  const publicKeys = createLocalJWKSet({ keys: oauthConfig.jwks.keys.map(key => ({ ...createPublicKey({ key: key as JsonWebKey, format: 'jwk' }).export({ format: 'jwk' }), kid: String(key.kid), alg: 'RS256', use: 'sig' })) });

  async function mount(app: FastifyInstance, oauth: OAuth) {
    let cleaning = false;
    async function cleanup() {
      if (cleaning) return;
      cleaning = true;
      try {
        const pending = await store.pendingRevocations();
        await oauth.revokeSessions(pending);
        await store.completeRevocations(pending);
      } catch { app.log.warn('Revoked account sessions await OAuth artifact cleanup'); }
      finally { cleaning = false; }
    }
    await cleanup();
    const cleanupTimer = setInterval(() => { void cleanup(); }, 60_000);
    cleanupTimer.unref();
    app.addHook('onClose', async () => { clearInterval(cleanupTimer); });
    const finish = async (reply: FastifyReply, result: SessionResult, session: string, device: string, destination: unknown) => {
      // Eligibility is already invalid on the primary even if cleanup fails.
      await cleanup();
      setCookie(reply, names.session, session, 2_592_000); setCookie(reply, names.device, device, 31_536_000);
      setCookie(reply, names.flow, secret(), 600);
      return reply.send({ returnTo: returnPath(destination) });
    };
    app.get('/account/login', async (request, reply) => {
      const flow = cookie(request.raw, names.flow) ?? secret(); setCookie(reply, names.flow, flow, 600);
      const query = request.query as Record<string, unknown>;
      reply.headers({ 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'x-content-type-options': 'nosniff' });
      return reply.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="larynx-csrf" content="${csrf(flow)}"><meta name="larynx-return" content="${escape(returnPath(query.return_to))}"><title>Sign in to Larynx</title><link rel="stylesheet" href="/account/style.css"><script src="/account/browser.js" defer></script></head><body><main><a class="brand" href="/account/login">Larynx</a><h1>Your people, together.</h1><p>Sign in securely with a passkey, or start with your email.</p><button id="signin">Sign in with a passkey</button><label class="check"><input id="new-device" type="checkbox">Register this browser as a new device (for a revoked or lost device session).</label><hr><form id="email"><label for="email-address">Email address</label><input id="email-address" name="email" type="email" autocomplete="email" required maxlength="254"><label for="purpose">I want to</label><select id="purpose" name="purpose"><option value="register">Create an account</option><option value="recover">Recover my account</option></select><p id="recovery-note" hidden>Recovery replaces all passkeys and signs out all devices. It cannot restore encrypted history or encryption keys.</p><label id="recovery-ack" class="check" hidden><input id="recovery-confirm" type="checkbox">I understand the recovery changes above (required for recovery).</label><button type="submit">Send verification code</button></form><form id="verify" hidden><label for="verification-code">Code from your email</label><input id="verification-code" autocomplete="one-time-code" required><label for="device-name">Name this device</label><input id="device-name" maxlength="80" value="My device" required><button type="submit">Verify email and create passkey</button></form><p id="status" role="status" aria-live="polite"></p><p class="fine">Your passkey stays with your device or password manager.</p></main></body></html>`);
    });
    app.get('/account/style.css', async (_request, reply) => reply.type('text/css').send(`body{margin:0;background:#f5f4ee;color:#20372f;font:16px/1.5 system-ui,sans-serif}main{max-width:460px;margin:5vh auto;padding:32px;background:white;border:1px solid #d9dfd5;border-radius:24px}.brand{font-weight:700;font-size:24px;color:inherit;text-decoration:none}h1{font-size:32px;letter-spacing:-1px}label{display:block;margin-top:14px;font-weight:600}input,select,button{box-sizing:border-box;font:inherit;width:100%;padding:12px;border:1px solid #a8b5a5;border-radius:8px}button{margin-top:16px;background:#20372f;color:white;cursor:pointer}button:disabled{opacity:.5}.check{font-size:13px}.check input{width:auto}hr{border:0;border-top:1px solid #d9dfd5;margin:24px 0}.fine,#recovery-note{font-size:13px;color:#58675d}#status{font-weight:600}[hidden]{display:none!important}@media(max-width:540px){main{margin:16px;padding:24px}}`));
    app.get('/account/browser.js', async (_request, reply) => reply.type('text/javascript').send(await readFile(new URL('./browser.js', import.meta.url), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return readFile(new URL('../../dist/identity/browser.js', import.meta.url), 'utf8'); })));
    app.get('/account/complete', async (_request, reply) => reply.header('cache-control', 'no-store').type('text/html').send('<!doctype html><html lang="en"><title>Account ready</title><h1>Your account is ready</h1><p>Return to the Larynx app and choose Sign in to continue.</p></html>'));
    async function bootstrap(path: string, handler: (request: FastifyRequest, reply: FastifyReply, body: Record<string, unknown>, browserHash: string) => Promise<unknown>) {
      app.post(path, { bodyLimit: 32_768 }, async (request, reply) => {
        reply.header('cache-control', 'no-store');
        try {
          const browser = formContext(request);
          if (!await store.rateLimit(keyed(config, 'attempt-browser', browser), 60, 600) || !await store.rateLimit(keyed(config, 'attempt-ip', request.ip), 180, 600)) return reply.code(429).send({ error: 'try_again_later' });
          return await handler(request, reply, bodyOf(request), browser);
        } catch (error) {
          if (error instanceof OAuthAccessError) return reply.code(error.status).send({ error: 'invalid_request' });
          // Validation, credentials and identity conflicts share one response.
          return reply.code(400).send({ error: 'unable_to_continue' });
        }
      });
    }
    await bootstrap('/account/email', async (request, reply, body, browser) => {
      const email = canonicalEmail(body.email); const purpose = body.purpose;
      if (!['register', 'recover'].includes(String(purpose)) || purpose === 'recover' && body.confirmRecovery !== true) throw new Error('Invalid request');
      const emailHash = keyed(config, 'email', email);
      if (!await store.rateLimit(keyed(config, 'email-issue', emailHash), 3, 600) || !await store.rateLimit(keyed(config, 'email-ip', request.ip), 10, 600)) return reply.code(202).send({ sent: true });
      const existing = await store.findIdentity(emailHash);
      const token = secret();
      await store.putChallenge(digest(token), 'email', browser, { purpose, emailHash, emailCiphertext: protectEmail(config, email),
        accountId: existing?.accountId ?? await store.newId(), participantId: existing?.participantId ?? await store.newId(),
        existing: Boolean(existing), recoveryGeneration: existing?.recoveryGeneration ?? 0, returnTo: returnPath(body.returnTo) }, 600);
      try { await mail(email, token, purpose as 'register' | 'recover'); } catch { app.log.warn('Verification email delivery failed'); }
      return reply.code(202).send({ sent: true });
    });
    await bootstrap('/account/register/options', async (_request, reply, body, browser) => {
      const proof = await store.takeChallenge(digest(string(body.code, 100)), 'email', browser);
      if (!proof || proof.purpose === 'register' && proof.existing || proof.purpose === 'recover' && (!proof.existing || body.confirmRecovery !== true)) throw new Error('Invalid proof');
      const accountId = string(proof.accountId);
      const options = await generateRegistrationOptions({ rpName: 'Larynx', rpID: config.rpId, userName: `Larynx ${accountId.slice(-8)}`, userID: new TextEncoder().encode(accountId), attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 300_000 });
      const id = secret();
      await store.putChallenge(digest(id), 'register', browser, { ...proof, challenge: options.challenge, deviceName: string(body.deviceName, 80).trim() || 'My device' }, 300);
      return reply.send({ id, options });
    });
    await bootstrap('/account/register/finish', async (_request, reply, body, browser) => {
      const proof = await store.takeChallenge(digest(string(body.id, 100)), 'register', browser);
      if (!proof) throw new Error('Invalid proof');
      const checked = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge: string(proof.challenge), expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: true });
      if (!checked.verified) throw new Error('Invalid passkey');
      const session = secret(); const device = secret(); const credential = checked.registrationInfo.credential;
      const data: Registration = { accountId: string(proof.accountId), participantId: string(proof.participantId), emailHash: string(proof.emailHash), emailCiphertext: string(proof.emailCiphertext),
        credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports ?? [], deviceType: checked.registrationInfo.credentialDeviceType, backedUp: checked.registrationInfo.credentialBackedUp },
        sessionHash: digest(session), deviceHash: digest(device), deviceName: string(proof.deviceName, 80) };
      const result = proof.purpose === 'recover' ? await store.recover({ ...data, expectedRecoveryGeneration: Number(proof.recoveryGeneration) }) : await store.register(data);
      return finish(reply, result, session, device, proof.returnTo);
    });
    await bootstrap('/account/login/options', async (_request, reply, body, browser) => {
      const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', timeout: 300_000 }); const id = secret();
      await store.putChallenge(digest(id), 'authenticate', browser, { challenge: options.challenge, returnTo: returnPath(body.returnTo), newDevice: body.newDevice === true }, 300);
      return reply.send({ id, options });
    });
    await bootstrap('/account/login/finish', async (request, reply, body, browser) => {
      const proof = await store.takeChallenge(digest(string(body.id, 100)), 'authenticate', browser);
      if (!proof) throw new Error('Invalid proof');
      const response = body.response as AuthenticationResponseJSON;
      const stored = await store.credential(string(response?.id, 2048));
      if (!stored || stored.revokedAt || !response.response.userHandle || Buffer.from(response.response.userHandle, 'base64url').toString('utf8') !== stored.accountId) throw new Error('Invalid credential');
      const checked = await verifyAuthenticationResponse({ response, expectedChallenge: string(proof.challenge), expectedOrigin: config.origin, expectedRPID: config.rpId,
        credential: { id: stored.id, publicKey: new Uint8Array(stored.publicKey), counter: stored.counter }, requireUserVerification: true });
      if (!checked.verified) throw new Error('Invalid passkey');
      const session = secret(); const device = proof.newDevice === true ? secret() : cookie(request.raw, names.device) ?? secret();
      const result = await store.authenticateCredential({ credentialId: stored.id, expectedCounter: stored.counter, newCounter: checked.authenticationInfo.newCounter,
        sessionHash: digest(session), deviceHash: digest(device), deviceName: 'My device' });
      return finish(reply, result, session, device, proof.returnTo);
    });
    async function product(path: string, scope: 'profile:read' | 'profile:write', handler: (request: FastifyRequest, reply: FastifyReply, actor: Awaited<ReturnType<OAuth['authorize']>>) => Promise<unknown>, method: 'GET' | 'POST' = 'POST') {
      app.route({ method, url: path, bodyLimit: 16_384, handler: async (request, reply) => {
        reply.header('cache-control', 'no-store');
        try { return await handler(request, reply, await oauth.authorize(request.raw, [scope])); }
        catch (error) {
          if (error instanceof OAuthAccessError) return reply.code(error.status).send({ error: error.code });
          if (error instanceof IdentityStoreError) return reply.code(error.code === 'identity_not_found' ? 404 : 401).send({ error: error.code === 'identity_not_found' ? 'not_found' : 'invalid_token' });
          return reply.code(400).send({ error: 'unable_to_continue' });
        }
      } });
    }
    await product('/v1/account', 'profile:read', async (_request, reply, actor) => { const account = await store.accountView(actor); if (!account) throw new OAuthAccessError(401, 'invalid_token'); const { protectedEmails, ...view } = account; return reply.send({ ...view, emails: protectedEmails.map(value => revealEmail(config,value)) }); }, 'GET');
    await product('/v1/devices/:id/revoke', 'profile:write', async (request, reply, actor) => {
      await store.revokeDevice(actor, (request.params as { id: string }).id); await cleanup();
      if ((request.params as { id: string }).id === actor.deviceId) { setCookie(reply, names.session, '', 0); setCookie(reply, names.device, '', 0); }
      return reply.send({ revoked: true });
    });
    await product('/v1/logout', 'profile:write', async (_request, reply, actor) => {
      await store.logout(actor); await cleanup(); setCookie(reply, names.session, '', 0); return reply.send({ loggedOut: true });
    });
    await product('/v1/session/confirm', 'profile:read', async (request, reply, actor) => {
      const body = bodyOf(request); const nonce = string(body.nonce, 256);
      const verified = await jwtVerify(string(body.idToken, 12_000), publicKeys, { issuer: oauthConfig.issuer, audience: actor.clientId, algorithms: ['RS256'] });
      if (!nonce || verified.payload.nonce !== nonce || verified.payload.sub !== actor.accountId || verified.payload.azp && verified.payload.azp !== actor.clientId) throw new Error('Invalid identity token');
      return reply.send({ confirmed: true });
    });
  }
  return { store, directory, mount };
}
