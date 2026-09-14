# OAuth2/OIDC provider

Implemented in [#4](https://github.com/av-evolv/social-chat-platform/issues/4). The backend hosts oidc-provider 9.12.2 at `/oidc`, persists protocol artifacts in PostgreSQL, and exposes a scoped `/v1/session` boundary. Account signup, verification, trusted sessions/devices and client callback UI belong to [#5](https://github.com/av-evolv/social-chat-platform/issues/5). Until that directory is wired, interactive authentication returns `503 account_authentication_unavailable`; there is no username, invitation-token or environment-triggered authentication bypass. Protocol tests inject identities from test files only.

## Local setup

With the usual ignored `.env` and installed dependencies, run `npm run oauth:setup` before Compose or `npm run dev:api`. This creates ignored `.env.oauth` with mode 0600, a random persistent RSA signing key and cookie secret, and explicit local web/native clients. Re-running preserves existing secrets and client configuration. The values are local-only; never use this file as production configuration or commit it. `.dockerignore` excludes it from image builds; Compose reads it as an environment file.

Discovery: `http://127.0.0.1:3000/oidc/.well-known/openid-configuration`. JWKS publishes public signing material only. The configured API resource indicator/audience is `http://127.0.0.1:3000/api`; this is an audience identifier, while API route paths start at `/v1`. Every product resource must use the returned `authorize(request, requiredScopes)` function and then enforce its own object policy and transactional authorization. The operational health endpoints and OAuth protocol/bootstrap endpoints have their distinct authentication requirements.

The generated clients are `larynx-web` (loopback web callback) and `larynx-native` (`larynx://oauth/callback`), initially limited to `profile:read`. These registrations establish protocol configuration; no frontend callback handler or login flow is claimed implemented. Changing `API_PORT`/`WEB_PORT` after initial setup requires deliberately updating issuer/resource and registered origins/redirects in the local file; it is not silently overwritten.

## Provider policy

- Only authorization-code responses and authorization-code/refresh-token grants are supported. PKCE is required for every code flow, using S256. Implicit/hybrid, client credentials, device flow, CIBA, dynamic registration and development interactions are disabled.
- Resource indicators select one exact API audience. A per-client scope ceiling rejects unsupported resource scopes; OIDC `openid`/`offline_access` scopes are distinct from API resource permissions. Client names or first-party status give no bypass.
- API access tokens are opaque and expire after five minutes. Codes expire after one minute, ID tokens after five minutes, interactions after ten minutes; provider sessions/grants/refresh tokens have a maximum configured lifetime of 30 days. Refresh issuance additionally requires explicit `offline_access` consent and client eligibility.
- Refresh tokens rotate on each use. Consumed artifacts remain readable for reuse detection; reuse revokes the entire grant. The adapter makes consumption atomic and durably tombstones revoked grants, so a concurrent token save cannot resurrect a revoked grant. Callers must serialize refresh requests; racing a refresh intentionally invalidates that authorization and requires a fresh flow.
- Tokens are bound to a live provider session. Grants also have an immutable binding to the verified account login-session/device; account/device/session eligibility is checked through the injected directory before code/refresh issuance and API use. Account login recovery never restores encryption keys.
- Revocation is permitted only by the token's own registered client and revokes its full grant. Introspection also limits callers to their own client tokens and checks current account/device/session binding and consented scopes; a different confidential client receives an inactive response, not another application's token metadata.
- Consent is required according to missing permissions; no automatic first-party approval. The user sees the client ID and requested scopes. Interaction-cookie/UID matching, a signed CSRF token, exact Origin, bounded form input and atomic submission consumption protect consent/login completion. Denial returns `access_denied`; replay is rejected. Pages are escaped, not cached, not frameable, and send no referrer.

## Accounts and resources

`AccountDirectory` is an explicit integration boundary:

- `authenticate(IncomingMessage)` returns a verified `{accountId, deviceId, sessionId}` only from the account service's authenticated session. A request body cannot choose the actor.
- `findAccount(accountId)` returns a currently eligible account and canonical participant ID.
- `isSessionActive(VerifiedSession)` checks account, login-session and device state on the primary without extending revocation through caching.

#5 must implement these against canonical account/identity/device records, with real verification, browser session CSRF protections and enrollment policy. The provider binding stores opaque identifiers, not the account session's bearer credential. Bindings cannot be reassigned to another session/device, even through concurrent consent. Logging out or revoking a device must invalidate the account directory state immediately and clean up/revoke associated provider grants; API and refresh checks already fail closed when that state becomes inactive. No private cryptographic key is stored or returned by the provider.

`authorize` rejects missing/malformed/foreign tokens and ID tokens, checks audience, registered client, expiry, current grant, provider session, account/device binding and current resource scopes. Missing/invalid tokens return 401; a valid grant missing the operation scope returns 403. Database failures return 503 without pretending the caller is authenticated. `/v1/session` demonstrates `profile:read` and returns only account/participant/client/device IDs and granted scopes. It does not grant membership in other objects.

This is a request authorization boundary, not a replacement for the source/resource locks and coherent primary transaction required by the [domain contract](domain-contracts.md). #6/#8 must recheck authorization within protected writes, serialize policy changes and prove races with real SQL transactions. Clients generate and verify a fresh `state` and OIDC `nonce` per authorization, retain the PKCE verifier only for that flow, and validate ID-token issuer/audience/signature/nonce; an ID token is never an API bearer credential. Browser clients keep access tokens in memory; refresh credentials require the reviewed #5 session design (never localStorage). Native clients use protected OS storage and verified redirect handling; physical device/app-link checks remain #20.

## Persistence and operations

The versioned SQL migration creates the `larynx_oauth` schema with JSONB artifacts keyed by `(model,id)`, expiry, grant/session/user-code indexes and durable revoked-grant tombstones. Migration application is transactional and serialized with a database advisory lock; a newer schema version fails startup. The configured database must be the primary. Startup currently runs this migration and requires schema creation/DDL rights; separate least-privilege migration deployment is a production operations prerequisite under #19.

Artifact lookup filters expiry, and grant-affiliated writes/revocations take the same transaction lock. Consumed state cannot be cleared by a stale save. Tombstones are deliberately retained without automatic deletion; removing them prematurely permits delayed requests to recreate revoked state. #19 owns bounded expiry cleanup, retention policy, capacity/monitoring, and safe backup/restore. Restoring an old database must invalidate surviving sessions and grants rather than revive authorizations the user revoked.

The adapter test suite uses random schemas and never modifies shared application tables. The protocol suite drives real HTTP authorization/consent/token exchanges and PostgreSQL storage; it also tests process/provider restart, concurrent refresh replay, scope/audience/client isolation and inactive accounts/devices. Set `OAUTH_TEST_DATABASE_URL` to a local/disposable primary and run `npm run test --workspace @larynx/api`. Without that explicit URL, database tests are skipped; CI sets it after starting PostgreSQL, so those tests must pass before merge.

## Production configuration and client admission

Supply these from the deployment's secret/configuration service:

| Variable | Requirement |
| --- | --- |
| `OAUTH_MODE` | `production` (default); `local` explicitly allows loopback HTTP for development only |
| `OAUTH_ISSUER` | Stable HTTPS origin with exact `/oidc` path; no query, fragment, credentials or loopback host |
| `OAUTH_RESOURCE` | Same origin and exact `/api` audience identifier |
| `OAUTH_JWKS` | Private RSA JWKS, RS256, unique key IDs, at least 2048-bit keys; stable across replicas/restarts |
| `OAUTH_COOKIE_KEYS` | JSON array of distinct random base64url secrets, at least 32 random bytes per key |
| `OAUTH_CLIENTS` | Reviewed JSON list of approved client metadata, explicit `allowedScopes` and `origins` |
| `OAUTH_TRUST_PROXY` | Optional `true` only behind a trusted TLS-terminating proxy on a protected network that strips untrusted forwarded headers; otherwise false |

The application image serves HTTP; production must terminate HTTPS at that trusted ingress and prevent direct untrusted access. Do not enable proxy trust on a publicly accessible backend. No request headers can change the configured issuer/audience. Do not log authorization headers, cookies, OAuth query parameters, form bodies or generated secrets. Automatic Fastify request logging is disabled; operational errors remain sanitized.

Client admission is operator-reviewed configuration in this milestone, not an open registration endpoint. Specify stable `client_id`, exact redirect URIs, `response_types:["code"]`, the allowed code/refresh grants, `allowedScopes`, and explicit browser origins. Public browser/native clients use `token_endpoint_auth_method:"none"` and no secret. Confidential server clients use `client_secret_basic` with a separately delivered high-entropy secret and HTTPS. Exact HTTPS redirects are preferred; approved native custom schemes must identify the application (Larynx or reverse-domain schemes). Wildcards, URI credentials, fragment redirects and arbitrary HTTP origins are rejected. Redeploy all provider instances coherently for client removal/scope changes; process-local client caches are not a hot-reload mechanism.

Never regenerate signing material on each restart. Rotate by publishing a new configured key alongside retained keys, deploying consistently, selecting the new signing key and retaining old verification material for outstanding ID-token lifetimes. Rotate cookie keys with overlap across instances. Full production account/session integration, deployment hardening and external security review remain #5/#19/#20 gates.

The implementation follows the pinned [oidc-provider configuration](https://github.com/panva/node-oidc-provider/blob/v9.12.2/docs/README.md), [adapter contract](https://github.com/panva/node-oidc-provider/blob/v9.12.2/example/my_adapter.js), and [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html). Larynx's scope, binding, consent and revocation rules above are explicit application policies.
