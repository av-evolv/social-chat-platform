# Accounts, identities and devices

Implementation: [#5](https://github.com/av-evolv/social-chat-platform/issues/5), building on the [OAuth provider](oauth-provider.md). Public product APIs require scoped OAuth tokens. The issuer's `/account/login` pages are the authentication bootstrap surface for web and native system browsers; they do not create a cookie bypass for product APIs.

## Local development

Run `npm run oauth:setup`, then `npm run accounts:setup`, then `docker compose up --build --detach --wait`. Account setup preserves signing and identity keys, upgrades the generated local issuer/resource to `http://localhost:3000`, and allows the two local clients to request `profile:write` with consent. WebAuthn needs a hostname RP ID: the issuer uses `localhost`; the app can remain at `http://127.0.0.1:8088`. Existing custom issuer/client configurations require deliberate review. Restart the API after setup changes.

Open the app's account screen and choose **Sign in or create account**. Registration sends a code to the local Mailpit inbox at `http://127.0.0.1:8025`; paste it into the initiating browser and create a passkey. Mailpit captures messages and does not forward them. SMTP listens on loopback port 1025 for host development; Compose uses the internal `mailpit:1025` service. Override `MAILPIT_HTTP_PORT`/`MAILPIT_SMTP_PORT` in `.env` for another local stack. Never expose the inbox publicly.

The ignored `.env.accounts` file contains independent 32-byte encryption and lookup keys plus mail settings and is created with mode 0600. It is excluded from Docker build context. Host development loads it alongside `.env.oauth`; containers receive it as an environment file. Do not regenerate these identity keys on restart: changing the lookup key loses identity lookup and changing the encryption key loses access to protected identity values. Reviewed key rotation and retention belong to #19.

## Identity and passkey policy

PostgreSQL18 creates UUIDv7 account, participant, device and session IDs. Historical participant IDs survive account recovery. The initial schema supports one verified email per account; phone numbers, additional identity linking and guest claim operations need subsequent migrations and #7's explicit claim policy. No automatic account merge is implemented. #6 adds the alias mapping table and an in-transaction audience invalidation hook; #7 implements verified invited-participant alias claims using an email already owned by the signed-in account; see [invitations.md](invitations.md). Additional recovery-email linking requires the issuer-hosted recent-passkey step-up tracked in #45. Delegated profile:write tokens cannot add recovery channels.

Email accepts conservative ASCII dot-atom addresses, trims surrounding whitespace, preserves local-part case/dots/plus tags and lowercases the domain. It does not apply Gmail-style folding globally. Values are encrypted with AES-256-GCM and a versioned purpose binding; lookup uses a separate HMAC key with a unique index. Email is not a primary key or an anonymous identifier.

Email proof is a random 256-bit, ten-minute, single-use code. Only its hash is stored as a challenge ID; protected identity data, purpose and the initiating browser hash accompany it. GET never consumes a proof or creates an account. Bootstrap POSTs require exact issuer Origin and a flow-bound HMAC CSRF header; challenges are atomically consumed. Database-backed limits cover browser/IP attempts and email/IP issuance. Issuance responses are generic, including delivery failure and suppressed retries. This is a bounded initial control; distributed abuse monitoring and operational capacity remain #19.

SimpleWebAuthn verifies discoverable passkeys with user verification required, exact origin/RP, challenge, credential ownership, user handle, signature and counter. Counter updates and account eligibility checks serialize on the account row. Credential identifiers/public keys, counters and authenticator backup classification are stored; private keys never leave the authenticator. A synchronized passkey authenticates an account and does not identify or approve an encryption device.

## Sessions, revocation and recovery

Account-session cookies are opaque, hashed in storage, HttpOnly, SameSite=Lax and Secure with a `__Host-` prefix in production. Sessions expire after 30 days and rotate on sign-in. A separate random device cookie identifies a browser installation and is not an authentication credential. Account state, session expiry and device revocation are checked on the primary. Device-management mutations revalidate the actor under the account lock; foreign/missing targets are indistinguishable 404 responses after valid authentication.

All account devices start with independent `crypto_state=pending`. #10 supplies trusted-device approval and signed cryptographic admission; OAuth or email verification never performs it. A revoked device record stays revoked. After a valid passkey ceremony, the explicit **Register this browser as a new device** choice creates a fresh pending record; it cannot restore old device trust or history. Remote logout/revocation ends current sessions; possession of an otherwise valid account passkey can authorize a new login. Account recovery replaces the passkeys themselves when they are lost or compromised.

Recovery requires a fresh email proof bound to the requesting browser, explicit acknowledgement and a new verified passkey. It preserves account/participant IDs, increments a visible recovery generation, and transactionally revokes all previous credentials/devices/sessions. Existing access and refresh tokens fail immediately through current-primary checks. Recovery restores login, never encryption keys or old history; encrypted recovery remains #18.

Revoked session rows durably track pending OAuth artifact cleanup. Cleanup runs at startup, after identity mutations and every minute in bounded batches. A temporary artifact-cleanup failure is logged without credentials and retried; it does not undo revocation or discard a successfully committed login/recovery cookie. OAuth's primary account/session checks enforce the revocation while cleanup is pending. Expired artifacts, rate-limit rows and challenge retention need the operational cleanup policy in #19.

## Shared clients and deployment

The universal account screen uses the same OAuth scopes and device API on web/iOS/Android. Browser access/refresh tokens remain in module memory; sessionStorage holds only the short-lived, one-use state/nonce/PKCE flow during redirects, which is consumed and removed before code exchange. Reloading requires another authorization flow. Native uses the system authentication browser and Expo SecureStore, with serialized refresh and logout invalidation. Expo Go is not a supported OAuth callback test environment; physical development-build/app-link/storage verification remains #20.

The client validates the exact callback, issuer parameter, state, flow age and S256 exchange. Before accepting initial tokens it calls OAuth-protected `/v1/session/confirm`, which verifies the ID-token signature, configured issuer, audience, nonce and current account/client against the accompanying access token. Signature verification is delegated to the trusted issuer over HTTPS, avoiding an assumed WebCrypto implementation in React Native. ID tokens never authorize product APIs. Callback routes disable access logging and referrers so authorization codes do not enter request logs.

Set `EXPO_PUBLIC_API_ORIGIN` at client build time for deployment. Production uses a stable HTTPS issuer hostname as the RP ID, identity keys from the secret manager, and `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. Port465 uses implicit TLS; port587 requires STARTTLS; both validate certificates. The local Compose mail override is development-only. Ingress must preserve configured host/origin, strip untrusted forwarded headers, enforce TLS and avoid logging authentication bodies/cookies/query credentials. Production migration privileges and operations remain #19.

English and French localization of the shared app, issuer pages, accessibility text and mail is tracked in [#42](https://github.com/av-evolv/social-chat-platform/issues/42) and required before public launch. The current surfaces are English.

## Verification

Run the API tests with `OAUTH_TEST_DATABASE_URL` pointing to a disposable local primary and `OAUTH_TEST_BROWSER=1` after building the API browser bundle and installing Playwright Chromium. Tests use isolated schemas, real WebAuthn virtual authenticators and test-only mail capture. `npm run test:web` additionally covers the exported app and real Mailpit SMTP delivery in Compose. No tests send external email. Virtual authenticators prove protocol integration, not physical mobile keystore protection.

Sources: [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server), [browser](https://simplewebauthn.dev/docs/packages/browser), [Expo authentication](https://docs.expo.dev/guides/authentication/), [SMTP TLS](https://nodemailer.com/smtp), [Mailpit Docker](https://mailpit.axllent.org/docs/install/docker/).
