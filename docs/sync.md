# Durable messaging and sync

Implementation: [#8](https://github.com/av-evolv/social-chat-platform/issues/8), [PR #47](https://github.com/av-evolv/social-chat-platform/pull/47). Contract: [domain-contracts.md](domain-contracts.md), especially D12–D22.

## Transport decision

Use ordinary OAuth HTTP writes and HTTP long polling for foreground sync. Any API instance can serve a cursor from the primary; no sticky session, WebSocket ticket or URL bearer token is required. `LISTEN/NOTIFY` is only a low-latency wake hint. The recipient stream is the delivery record, so a dropped hint, server restart or reconnect does not lose changes. Each waiting request releases its database transaction and connection before waiting, then checks current OAuth, account, session, device and object policy again.

Long polling still holds HTTP connections and incurs a request on each wake/timeout. It does not inherently cost less than WebSockets. It fits the initial HTTP stack; measure connection count, wake frequency and database load before changing transport. WebSockets remain an optional future typing/presence hint channel. Mobile APNs/FCM hints and subscriptions belong to [#11](https://github.com/av-evolv/social-chat-platform/issues/11); foreground/resume always synchronizes even when no push arrived. Background push is not guaranteed delivery or ordered storage. See [Apple background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app), [FCM collapsible messages](https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types), and [PostgreSQL LISTEN](https://www.postgresql.org/docs/18/sql-listen.html).

## What is usable now

Circle and conversation metadata can be synchronized with current domain scopes. Metadata policy changes conservatively reset affected participants to a fresh snapshot, including departed and aliased participants. Ordinary reads do not reset an unchanged policy. Account/device/session invalidation joins the same transaction. Above 256 affected principals, a global generation fence resets every cursor; security revocation is never rejected for excessive fan-out.

Message routes and encrypted-envelope persistence are implemented behind a server-owned admission adapter. **Production content remains closed**: `SocialStore.assertContentAccess` returns `crypto_not_ready` for eligible pending conversations. [#10](https://github.com/av-evolv/social-chat-platform/issues/10) must implement authenticated devices, current crypto epochs, roster generation and history admission before enabling it. Tests inject an explicitly trusted policy fixture; they prove SQL behavior, not cryptographic interoperability. There is no plaintext composer or fake encryption path.

## HTTP contract

All routes require an Authorization bearer header and return `Cache-Control: no-store`. Request fields use snake case; responses use camel case. UUID inputs are UUIDv7; revisions/generations/epochs are decimal strings, not JavaScript numbers.

| Route | Scope | Request |
| --- | --- | --- |
| `GET /v1/sync` | `sync:read` plus each returned domain's read scope | Optional `after`, `limit` (1–100), `wait` (0–25 seconds) |
| `GET /v1/messages/:id` | `messages:read` | Current authorized envelope |
| `POST /v1/conversations/:id/messages` | `messages:write` | `id`, `operation_key`, `envelope_version: 1`, `generation`, `crypto_epoch`, `ciphertext` |
| `POST /v1/messages/:id/update` | `messages:write` | Same envelope fields, `operation_key`, `expected_revision` |
| `POST /v1/messages/:id/delete` | `messages:write` | `operation_key`, `expected_revision`, `generation`, `crypto_epoch` |

A sync response is `{mode: 'snapshot' | 'delta', resources: [{type,id,revision,data}], cursor, hasMore}`. `wait` requires an existing cursor; only an empty, caught-up delta waits. An initial or continuing snapshot and an unfinished delta window return immediately. Empty filtered pages may have `hasMore: true`; always follow their returned cursor. API failures are stable machine codes. #9 must present them with English/French catalog messages and never translate user-authored message content.

An inaccessible object returns indistinguishable 404; missing/invalid authentication is 401 and insufficient scopes 403. Invalid/foreign/tampered cursors return 400 `invalid_cursor`; authorization changes return 409 `sync_reset_required`; expired manifests/cursors or compacted stream generations return 410 `cursor_expired`. On 409/410, discard incomplete staging state and request a new snapshot. Wait limits return 429 `sync_wait_limit`; capacity overflow returns 413 `sync_snapshot_too_large` or `message_fanout_exceeded`. No partial snapshot is reported as complete.

## Transactions and versions

Domain writes use `SocialStore.withPolicy`: operation lock, current shared OAuth grant lock, account row and policy lock. An admission callback runs inside that transaction and supplies canonical recipients from server policy. It must check the action, current device, message history and epoch. Never accept recipients or an admission decision from request data. Roster `generation` and cryptographic `cryptoEpoch` are distinct.

Messages retain immutable author/device/conversation identity, server timestamps and revisioned encrypted envelopes. Updates/deletes require the expected revision; only the original author can mutate a message after current admission. Ciphertext must be nonempty canonical base64, decoded size at most 64 KiB. The service does not infer plaintext or validate cryptographic authenticity itself.

Each principal/client/operation/UUIDv7 operation key stores a digest including target, all preconditions and exact envelope bytes. Repeated identical operations return stable metadata-only receipts; changed input conflicts. Current authorization precedes replay, including when the message already exists or was deleted. Receipt identities and tombstones are not automatically pruned. Deletion erases every stored envelope version and affected snapshot manifests; oversized deletion fan-out uses a global reset instead of blocking erasure.

A message effect, per-recipient counter increments, immutable change references and `pg_notify` calls commit atomically. Sorted recipient row locks prevent a later reservation becoming visible ahead of an uncommitted earlier one. Rollback restores both counter and data. Notifications carry only an internal participant routing ID (or global `*`), never message bodies or keys.

## Cursors and snapshot boundaries

AES-256-GCM cursors use random nonces and domain-separated keys derived from the shared issuer cookie-key ring. All API instances must share the same configured keys. The cursor binds format, account/principal, OAuth client and stable grant/provider-session fingerprint, identity device/session, sorted scopes, authorization/global/retention generations, last scanned position, fixed window H and expiry. An access-token refresh for the same grant can resume; a different grant cannot. Key rotation can retain previous decryption keys. Cursors confer no independent object authorization.

First sync materializes immutable metadata/envelopes and H under the primary policy transaction. All domain writers join this policy lock; the stream generation/counter is also protected against append/compaction. This is a consistent protected boundary despite the transaction's Read Committed isolation, not an assumption that separate live queries form a snapshot. No SQL transaction stays open across pages. Each page rechecks current authorization and deletion before returning retained data. Delta pages read the exact referenced revision at or below H; changes committed afterward belong to the next window. The cursor advances by scanned entries, including filtered ones.

[#9](https://github.com/av-evolv/social-chat-platform/issues/9) owns atomic local application of data plus cursor, revision deduplication and staged replacement-cache installation. Do not install a snapshot until its final page; preserve unsent drafts separately and revalidate keys/audience before sending.

## Capacity and maintenance

| Limit | Current value |
| --- | --- |
| Message write fan-out | 256 canonical recipients; reject before mutation |
| Encrypted envelope | 64 KiB decoded; HTTP body 96 KiB |
| Snapshot | 2,000 resources, 2 MiB total; checked incrementally by production collectors |
| Snapshot candidate scan | 10,000 social candidates and 10,000 message candidates; explicit overflow |
| Snapshot manifest lifetime | 5 minutes |
| Page | 100 scanned entries, 512 KiB including response reserve |
| Cursor/offline stream horizon | 7 days |
| Waiting requests | 200/API process, 2/principal/process, 25 seconds each |
| HTTP rate budget | 120 requests/IP/minute, bounded limiter cache |
| Listener | One dedicated, nontransactional PG connection/API process |

The API runs retention maintenance at startup and every minute, without overlapping local runs. Each run handles up to 256 streams, at most 1,000 expired references per stream in separate transactions, and up to 1,000 expired manifests. It removes expired stream entries in bounded batches, invalidates affected retention generations/manifests, and removes expired manifests. Multiple instances may safely run it. Operations and message version history are retained until object deletion; this job is not a user-content expiry feature. Maintenance errors are logged without exposing SQL or private data and retried on the next interval. Listener failure wakes waiters and reconnects with bounded backoff; even a missed wake is recovered by the timeout's durable reread. Shutdown drains maintenance and cancels waits before closing the pool.

These are initial capacity limits, not a claim of production load-test results. The inherited coarse policy lock and global audience reconciliation still serialize policy-sensitive work. Candidate caps prevent unlimited snapshot enumeration but do not remove that existing reconciliation cost. [#19](https://github.com/av-evolv/social-chat-platform/issues/19) must add indexed authorized candidate enumeration, scoped reconciliation/lock partitioning, retention throughput/lag metrics, fleet-wide quotas where needed, listener/connection-budget metrics and load tests. Keep all private authorization and sync reads on the primary until replica safety is proven. Configure reverse-proxy idle timeouts above the 25-second poll plus request overhead.

Fresh `larynx_sync` and `larynx_messages` schemas are created under migration locks at startup; existing identity/social tables are preserved. There are no additional service dependencies. Local setup must rerun `npm run accounts:setup` to add first-party messages/sync consent scopes while retaining existing keys; existing grants need renewed consent.

## Verification and handoffs

`sync-store.test.ts`, `sync-wake.test.ts`, `message-store.test.ts`, `sync-http.test.ts` and the OAuth grant-binding tests exercise real PostgreSQL ordering/rollback, filtered and fixed-H pages, scope/grant/device binding, policy/alias/deletion resets, retention, idempotency, concurrent revisions, crypto gate denial, long-poll wake/reconnect and released transactions. Trusted transport fixtures are separate from real cryptographic admission.

- #9: shared UI, local atomic cache/cursor, reset staging, draft handling, EN/FR presentation.
- #10: implement the production admission adapter and indexed history candidates; prove actual encrypted multi-device interoperability and revocation races.
- #11: durable subscription/push worker, opaque hints, background/foreground recovery; no delivery guarantee from push.
- #19: operational budgets, authorization-safe scaling/replicas, maintenance/load verification. Media and email external-delivery workers remain their own features; PostgreSQL wake hints are not a generic durable external-side-effect worker.
