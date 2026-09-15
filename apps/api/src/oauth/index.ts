import { matchLocale, translate } from '@larynx/i18n';
import { languageLinks, requestedLocale } from '../identity/locale.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import middie from '@fastify/middie';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import Provider, { errors, type AdapterPayload } from 'oidc-provider';
import type { Pool, PoolClient } from 'pg';
import { createAdapter, migrateOAuth } from './adapter.js';
import type { AccountDirectory, VerifiedSession } from './accounts.js';
import type { OAuthConfig } from './config.js';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function asBinding(value: AdapterPayload | undefined | void): VerifiedSession | undefined {
  return value && typeof value.accountId === 'string' && typeof value.deviceId === 'string' && typeof value.sessionId === 'string'
    ? { accountId: value.accountId, deviceId: value.deviceId, sessionId: value.sessionId } : undefined;
}

export async function createOAuth(pool: Pool, config: OAuthConfig, accounts: AccountDirectory, options: { schema?: string; loginPath?: string } = {}) {
  await migrateOAuth(pool, options);
  const Adapter = createAdapter(pool, options);
  const bindings = new Adapter('LarynxGrantBinding');
  const submissions = new Adapter('LarynxInteractionSubmission');
  const transactionContexts = new WeakMap<object, { tokenId: string; grantId: string; sessionUid: string; actor: string }>();
  const clients = new Map(config.clients.map(client => [client.client_id, client]));
  async function activeBinding(grantId: string | undefined, accountId: string) {
    if (!grantId) return undefined;
    const binding = asBinding(await bindings.find(grantId));
    return binding?.accountId === accountId && await accounts.isSessionActive(binding) ? binding : undefined;
  }
  const provider: Provider = new Provider(config.issuer, {
    adapter: Adapter,
    clients: config.clients.map(({ allowedScopes, origins: _origins, ...metadata }) => ({
      ...metadata, scope: ['openid', 'offline_access'].join(' '),
    })),
    jwks: config.jwks,
    cookies: { keys: config.cookieKeys, long: { httpOnly: true, sameSite: 'lax', secure: config.mode === 'production' }, short: { httpOnly: true, sameSite: 'lax', secure: config.mode === 'production' } },
    responseTypes: ['code'],
    scopes: ['openid', 'offline_access'],
    claims: { openid: ['sub'] },
    pkce: { required: () => true },
    rotateRefreshToken: true,
    expiresWithSession: () => true,
    revokeGrantPolicy: () => true,
    ttl: { IdToken: 300, AccessToken: 300, AuthorizationCode: 60, RefreshToken: 2_592_000, Session: 2_592_000, Grant: 2_592_000, Interaction: 600 },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false },
      clientCredentials: { enabled: false },
      deviceFlow: { enabled: false },
      ciba: { enabled: false },
      introspection: {
        enabled: true,
        allowedPolicy: async (_ctx, client, token) => {
          if (!('accountId' in token) || !token.accountId || token.clientId !== client.clientId || !clients.has(client.clientId)) return false;
          const binding = await activeBinding(token.grantId, token.accountId);
          if (!binding || !await accounts.findAccount(token.accountId) || !token.grantId) return false;
          const grant = await provider.Grant.find(token.grantId);
          if (!grant || grant.accountId !== token.accountId || grant.clientId !== token.clientId) return false;
          const permitted = clients.get(client.clientId)!.allowedScopes;
          return (token.scope ?? '').split(' ').filter(Boolean).every(scope => ['openid', 'offline_access'].includes(scope) || permitted.includes(scope) && grant.getResourceScope(config.resource).split(' ').includes(scope));
        },
      },
      revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => clients.has(client.clientId) && token.clientId === client.clientId },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => config.resource,
        useGrantedResource: () => true,
        getResourceServerInfo: async (ctx, resource, client) => {
          const approved = clients.get(client.clientId);
          if (!approved || resource !== config.resource) throw new errors.InvalidTarget();
          if ([...ctx.oidc.requestParamScopes].some(scope => !['openid', 'offline_access', ...approved.allowedScopes].includes(scope))) throw new errors.InvalidScope('Requested scope is not permitted for this client', 'scope');
          return { audience: config.resource, scope: approved.allowedScopes.join(' '), accessTokenFormat: 'opaque', accessTokenTTL: 300 };
        },
      },
    },
    interactions: { url: (_ctx, interaction) => `/oidc/interaction/${interaction.uid}` },
    loadExistingGrant: async ctx => {
      const grantId = ctx.oidc.result?.consent?.grantId || (ctx.oidc.client ? ctx.oidc.session?.grantIdFor(ctx.oidc.client.clientId) : undefined);
      if (!grantId) return undefined;
      const grant = await provider.Grant.find(grantId);
      if (!grant) return undefined;
      const verified = await accounts.authenticate(ctx.req);
      const binding = asBinding(await bindings.find(grantId));
      return verified && binding && verified.accountId === grant.accountId && binding.accountId === verified.accountId && binding.sessionId === verified.sessionId && binding.deviceId === verified.deviceId && await accounts.isSessionActive(verified) ? grant : undefined;
    },
    findAccount: async (_ctx, id, token) => {
      const account = await accounts.findAccount(id);
      if (!account || token && !await activeBinding(token.grantId, id)) return undefined;
      return { accountId: account.id, claims: async () => ({ sub: account.id }) };
    },
    extraTokenClaims: async (_ctx, token) => {
      if (!('accountId' in token) || typeof token.accountId !== 'string') throw new errors.InvalidGrant();
      const binding = await activeBinding(token.grantId, token.accountId);
      if (!binding) throw new errors.InvalidGrant();
      return { device_id: binding.deviceId, login_session_id: binding.sessionId };
    },
    clientBasedCORS: (_ctx, origin, client) => clients.get(client.clientId)?.origins.includes(origin) ?? false,
    renderError: async (ctx, output) => {
      if (ctx.method === 'GET' && ctx.get('accept').includes('text/html')) {
        const locale = requestedLocale(undefined,ctx.get('accept-language'));
        ctx.type = 'text/html';
        ctx.body = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(translate(locale,'server.oauth.title'))}</title><p>${escape(translate(locale,'server.oauth.unavailable'))}</p></html>`;
      } else { ctx.type = 'application/json'; ctx.body = { error: output.error }; }
    },
  });
  provider.proxy = config.trustProxy ?? false;

  async function authenticate(request: IncomingMessage) {
    const session = await accounts.authenticate(request);
    return session && await accounts.isSessionActive(session) && await accounts.findAccount(session.accountId) ? session : undefined;
  }
  const csrf = (uid: string, prompt: string, subject: string) => createHmac('sha256', config.cookieKeys[0]!).update(JSON.stringify([uid, prompt, subject])).digest('base64url');

  async function mount(app: FastifyInstance) {
    // Provider middleware owns only its exact prefix. Interaction pages remain
    // Fastify routes so raw form bodies are consumed exactly once.
    await app.register(middie);
    const callback = provider.callback();
    app.use((req, res, next) => {
      const path = req.url?.split('?')[0] ?? '';
      if (path.startsWith('/oidc/interaction/')) return next();
      if (path !== '/oidc' && !path.startsWith('/oidc/')) return next();
      req.url = req.url!.slice('/oidc'.length) || '/';
      void callback(req, res).catch(() => { if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"temporarily_unavailable"}'); });
    });
    await app.register(cors, {
      origin: [...new Set(config.clients.flatMap(client => client.origins))],
      methods: ['GET', 'POST'], allowedHeaders: ['Authorization', 'Content-Type', 'Accept-Language'], credentials: false, maxAge: 600,
    });
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_req, body, done) => done(null, new URLSearchParams(body as string)));
    app.route<{ Params: { uid: string }; Body: URLSearchParams }>({
      method: ['GET', 'POST'], url: '/oidc/interaction/:uid',
      handler: async (request, reply) => {
        reply.headers({ 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'x-content-type-options': 'nosniff' });
        const interactionError = (status: number, error: string) => {
          if (request.method !== 'GET' || !request.headers.accept?.includes('text/html')) return reply.code(status).send({error});
          const locale = matchLocale((request.query as Record<string,unknown>).lang) ?? requestedLocale(undefined,request.headers['accept-language']);
          return reply.code(status).type('text/html').send(`<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(translate(locale,'server.oauth.title'))}</title><p>${escape(translate(locale,'server.oauth.unavailable'))}</p></html>`);
        };
        try {
          const details = await provider.interactionDetails(request.raw, reply.raw);
          if (details.uid !== request.params.uid || !['login', 'consent'].includes(details.prompt.name)) return interactionError(400,'invalid_interaction');
          const approved = typeof details.params.client_id === 'string' ? clients.get(details.params.client_id) : undefined;
          const redirect = details.params.redirect_uri;
          if (typeof redirect !== 'string' || !approved?.redirect_uris?.includes(redirect)) return interactionError(400,'invalid_interaction');
          const destination = new URL(redirect);
          // Browsers apply form-action to the provider's redirect chain too.
          // Permit only this registered callback origin (or native app scheme).
          const formDestination = ['https:', 'http:'].includes(destination.protocol) ? destination.origin : destination.protocol;
          reply.header('content-security-policy', `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${formDestination}`);
          const verified = await authenticate(request.raw);
          const query = request.query as Record<string,unknown>;
          const explicitLocale = matchLocale(query.lang);
          const saved = verified ? await accounts.findAccount(verified.accountId) : undefined;
          const locale = explicitLocale ?? saved?.locale ?? requestedLocale(details.params.ui_locales,request.headers['accept-language']);
          const t = (key: string, values: Record<string,unknown> = {}) => escape(translate(locale,`server.${key}`,values));
          if (!verified) {
            if (request.method === 'GET' && options.loginPath) return reply.redirect(`${options.loginPath}?${new URLSearchParams({return_to:`/oidc/interaction/${details.uid}`,ui_locales:locale,...(explicitLocale ? {lang:explicitLocale} : {})})}`);
            return interactionError(503,'account_authentication_unavailable');
          }
          if (details.prompt.name === 'consent' && details.session?.accountId && details.session.accountId !== verified.accountId) return interactionError(403,'account_mismatch');
          const secret = csrf(details.uid, details.prompt.name, verified.accountId);
          if (request.method === 'GET') {
            await submissions.upsert(details.uid, {}, 600);
            const scope = typeof details.params.scope === 'string' ? details.params.scope : '';
            const client = typeof details.params.client_id === 'string' ? details.params.client_id : '';
            const permissions = scope.split(' ').filter(Boolean).map(permission => {
              const key = `server.scope.${permission}`;
              const label = translate(locale,key);
              return `<li>${escape(label === key ? translate(locale,'server.scope.unknown',{scope:permission}) : label)} <code>(${escape(permission)})</code></li>`;
            }).join('');
            return reply.type('text/html').send(`<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${t('oauth.title')}</title><body>${languageLinks(locale,`/oidc/interaction/${details.uid}`)}<h1>${t(details.prompt.name === 'login' ? 'oauth.continueHeading' : 'oauth.consentHeading')}</h1><p>${t('oauth.application',{name:client})}</p><p>${t('oauth.permissions')}</p><ul>${permissions}</ul><form method="post" action="/oidc/interaction/${escape(details.uid)}"><input type="hidden" name="csrf" value="${secret}">${explicitLocale ? `<input type="hidden" name="locale" value="${explicitLocale}">` : ''}<button name="decision" value="approve">${t(details.prompt.name === 'login' ? 'oauth.continue' : 'oauth.allow')}</button><button name="decision" value="deny">${t('oauth.cancel')}</button></form></body></html>`);
          }
          const body = request.body;
          const supplied = body instanceof URLSearchParams ? body.get('csrf') ?? '' : '';
          const decision = body instanceof URLSearchParams ? body.get('decision') : null;
          if (request.headers.origin !== new URL(config.issuer).origin || !(body instanceof URLSearchParams) || body.getAll('csrf').length !== 1 || body.getAll('decision').length !== 1 || !['approve', 'deny'].includes(decision ?? '') || Buffer.byteLength(supplied) !== Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) return interactionError(403,'invalid_csrf');
          const selectedLocale = body.get('locale');
          if (body.getAll('locale').length > 1 || selectedLocale !== null && selectedLocale !== 'en' && selectedLocale !== 'fr') return interactionError(400,'invalid_request');
          await submissions.consume(details.uid);
          // Persist explicit issuer selection only after the same session-bound,
          // single-use CSRF check that protects consent. Passive detection is read-only.
          if (selectedLocale) await accounts.saveLocale?.(verified,selectedLocale);
          let result;
          if (decision === 'deny') result = { error: 'access_denied' };
          else if (details.prompt.name === 'login') result = { login: { accountId: verified.accountId, remember: true } };
          else {
            const clientId = String(details.params.client_id);
            if (!clients.has(clientId) || details.session?.accountId !== verified.accountId) return interactionError(403,'invalid_consent');
            const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: verified.accountId, clientId });
            if (!grant || grant.accountId !== verified.accountId || grant.clientId !== clientId) return interactionError(403,'invalid_grant');
            const missing = details.prompt.details;
            if (Array.isArray(missing.missingOIDCScope)) grant.addOIDCScope(missing.missingOIDCScope as string[]);
            if (missing.missingResourceScopes && typeof missing.missingResourceScopes === 'object') {
              for (const [resource, scopes] of Object.entries(missing.missingResourceScopes)) {
                if (resource !== config.resource || !Array.isArray(scopes) || scopes.some(scope => !clients.get(clientId)!.allowedScopes.includes(scope))) return interactionError(403,'invalid_scope');
                grant.addResourceScope(resource, scopes as string[]);
              }
            }
            const grantId = await grant.save();
            await bindings.upsert(grantId, { ...verified, grantId }, 2_592_000);
            result = { consent: { grantId } };
          }
          const returnTo = await provider.interactionResult(request.raw, reply.raw, result, { mergeWithLastSubmission: details.prompt.name !== 'login' });
          return reply.redirect(returnTo);
        } catch { return interactionError(400,'invalid_interaction'); }
      },
    });
    app.get('/v1/session', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      try { return await authorize(request.raw, ['profile:read']); }
      catch (error) {
        if (error instanceof OAuthAccessError) {
          reply.header('www-authenticate', error.status === 401 ? 'Bearer' : 'Bearer error="insufficient_scope", scope="profile:read"');
          return reply.code(error.status).send({ error: error.code });
        }
        return reply.code(503).send({ error: 'temporarily_unavailable' });
      }
    });
  }

  // Reuse for product routes, then apply the resource's own primary transaction
  // and object policy. OAuth scopes alone never grant object membership.
  async function authorize(request: IncomingMessage, requiredScopes: readonly [string, ...string[]]) {
    const denied = (): never => { throw new OAuthAccessError(401, 'invalid_token'); };
    const header = request.headers.authorization;
    if (!header || !/^Bearer [A-Za-z0-9_-]+$/i.test(header)) return denied();
    const token = await provider.AccessToken.find(header.slice(7));
    if (!token || token.isExpired || token.aud !== config.resource || !token.accountId || !token.grantId || !token.sessionUid || !token.clientId || !clients.has(token.clientId)) return denied();
    const clientId = token.clientId;
    if (request.headers.origin && !clients.get(clientId)!.origins.includes(request.headers.origin)) return denied();
    const session = await provider.Session.findByUid(token.sessionUid);
    const account = await accounts.findAccount(token.accountId);
    const binding = await activeBinding(token.grantId, token.accountId);
    // Load the current grant after account checks; do not cache this decision.
    const grant = await provider.Grant.find(token.grantId);
    if (!grant || grant.isExpired || grant.accountId !== token.accountId || grant.clientId !== clientId || session?.accountId !== token.accountId || !account || !binding || token.extra?.device_id !== binding.deviceId || token.extra?.login_session_id !== binding.sessionId) return denied();
    const scopes = (token.scope ?? '').split(' ').filter(Boolean);
    if (scopes.some(scope => !clients.get(clientId)!.allowedScopes.includes(scope) || !grant.getResourceScope(config.resource).split(' ').includes(scope))) return denied();
    if (requiredScopes.some(scope => !scopes.includes(scope))) throw new OAuthAccessError(403, 'insufficient_scope');
    const actor = { accountId: account.id, participantId: account.participantId, clientId, deviceId: binding.deviceId, sessionId: binding.sessionId, scopes };
    transactionContexts.set(actor, { tokenId: token.jti, grantId: token.grantId, sessionUid: token.sessionUid, actor: JSON.stringify(actor) });
    return actor;
  }
  // Product transactions hold a shared grant lock through their protected write.
  // Grant revocation/consent changes take its exclusive counterpart in the adapter.
  // Context stays private: /v1/session never discloses token or grant identifiers.
  async function assertTransaction(db: PoolClient, actor: Awaited<ReturnType<typeof authorize>>) {
    const context = transactionContexts.get(actor);
    const denied = (): never => { throw new OAuthAccessError(401, 'invalid_token'); };
    if (!context || context.actor !== JSON.stringify(actor)) return denied();
    const schema = options.schema ?? 'larynx_oauth';
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [`${schema}:grant:${context.grantId}`]);
    if ((await db.query(`SELECT 1 FROM ${schema}.revoked_grants WHERE grant_id=$1`, [context.grantId])).rowCount) return denied();
    const rows = (await db.query<{ model: string; payload: AdapterPayload }>(`SELECT model,payload FROM ${schema}.artifacts
      WHERE (expires_at IS NULL OR expires_at > clock_timestamp()) AND
      ((model='AccessToken' AND id=$1 AND grant_id=$2) OR (model IN ('Grant','LarynxGrantBinding') AND id=$2)
        OR (model='Session' AND uid=$3)) FOR SHARE`, [context.tokenId,context.grantId,context.sessionUid])).rows;
    const token = rows.find(r => r.model === 'AccessToken')?.payload;
    const grant = rows.find(r => r.model === 'Grant')?.payload;
    const binding = asBinding(rows.find(r => r.model === 'LarynxGrantBinding')?.payload);
    const session = rows.find(r => r.model === 'Session')?.payload;
    if (!token || !grant || !binding || !session || token.accountId !== actor.accountId || token.clientId !== actor.clientId ||
      token.aud !== config.resource || token.sessionUid !== context.sessionUid || token.grantId !== context.grantId ||
      grant.accountId !== actor.accountId || grant.clientId !== actor.clientId || session.accountId !== actor.accountId ||
      binding.accountId !== actor.accountId || binding.deviceId !== actor.deviceId || binding.sessionId !== actor.sessionId ||
      (token.extra as Record<string, unknown> | undefined)?.device_id !== actor.deviceId ||
      (token.extra as Record<string, unknown> | undefined)?.login_session_id !== actor.sessionId) return denied();
    const currentGrant = new provider.Grant(grant);
    const allowed = currentGrant.getResourceScope(config.resource).split(' ');
    const scopes = typeof token.scope === 'string' ? token.scope.split(' ').filter(Boolean) : [];
    if (actor.scopes.some(scope => !scopes.includes(scope)) || scopes.some(scope => !allowed.includes(scope) || !clients.get(actor.clientId)?.allowedScopes.includes(scope))) return denied();
  }
  async function revokeSessions(sessionIds: string[]) {
    if (!sessionIds.length) return;
    const schema = options.schema ?? 'larynx_oauth'; // validated by createAdapter
    const grants = await pool.query(`SELECT id FROM ${schema}.artifacts WHERE model='LarynxGrantBinding' AND payload->>'sessionId'=ANY($1::text[])`, [sessionIds]);
    for (const row of grants.rows) await bindings.revokeByGrantId(row.id);
  }
  return { provider, mount, authorize, assertTransaction, revokeSessions };
}

export class OAuthAccessError extends Error {
  constructor(public readonly status: 401 | 403, public readonly code: 'invalid_token' | 'insufficient_scope') {
    super(code);
  }
}
