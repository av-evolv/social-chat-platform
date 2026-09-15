# Live client metadata sync

[#49](https://github.com/av-evolv/social-chat-platform/issues/49) / [PR #50](https://github.com/av-evolv/social-chat-platform/pull/50) delivers the first independent part of [#9](https://github.com/av-evolv/social-chat-platform/issues/9): foreground circle/conversation updates in the universal social screen. It consumes the [server sync contract](sync.md).

## Current behavior

The screen verifies the current OAuth session and starts one serialized sync consumer. Complete snapshots replace visible metadata atomically in memory; incomplete pages stay in staging. Delta application and cursor advance occur together. The controller follows empty filtered pages, compares decimal revisions without floating-point loss and never substitutes an older revision. It bounds page parsing, snapshot/cached data and retry work.

The current API origin, account, canonical participant, OAuth client, device, identity session, sorted scopes and local auth generation identify the volatile run. New authorization grants and sign-out invalidate older responses; a new native grant is not installed until protected credential persistence succeeds; ordinary token refresh preserves the generation. An HTTP result is rejected if authentication changed while the request or body parsing was pending. Caller abort is composed with the request deadline.

A 409/410 reset immediately clears visible/staged metadata before rebuilding. One foreign-cursor recovery is allowed; repeated incomplete recovery fails visibly instead of spinning. Successfully completed recovery resets the consecutive-failure budget, so normal membership changes do not eventually disable updates. Network/server/rate failures clear stale controls and retry with bounded exponential backoff and jitter. Terminal errors offer explicit refresh. Background/hidden, sign-out and unmount cancel the consumer; foreground starts with fresh session verification. A late response from a cancelled run cannot publish data, even if its transport ignored abort.

Existing circle and conversation operations still use authenticated HTTP writes and revision checks. The screen derives details from the current synchronized records. A monotonic reset epoch, prefixed by the local run ID, invalidates editor/preview state even when React batches an entire reset and recovery into one render. Delayed preview responses must match that boundary. Reset, missing records or changed revisions invalidate selections and audience previews; mutation controls stay disabled until reconciliation completes. Connection states use the shared English/French catalogs and accessible status text.

## Deliberate boundaries

This is a **volatile metadata cache**, not protected offline storage. No metadata, cursor, token, message or decrypting key is written to a new browser/native persistence store. Leaving the screen or losing authorization drops the cache. Message envelopes encountered in sync are structurally checked then discarded; this consumer cannot decrypt, display, queue or send messages. A future full message consumer must start from its own complete snapshot rather than reuse a metadata-only cursor.

Parent #9 still owns encrypted IndexedDB and native SQLite/SQLCipher adapters, key lifecycle, crash-safe atomic data/cursor transactions (D21), local search, drafts/outbox and chat UI. #10 owns real device/epoch/history admission and message cryptography. This in-memory state transition contract does not prove disk durability, protocol ratchet safety or native key storage. It intentionally introduces no persistence dependency or encryption bypass. Native exports validate shared bundling only; physical-device verification remains #20.

## Verification

`apps/client/test/sync-core.test.mjs` proves complete snapshot installation, absent-resource replacement, revision ordering, cursor chaining, strict page validation, reset/retry budgets, cancellation fencing, single-request serialization, memory bounds and explicit recovery. `auth-lifecycle.test.mjs` reproduces and fixes successful-response-after-sign-out and lost-caller-cancellation races, including delayed body parsing and grant exchange.

The desktop/mobile-web invitation flow removes a selected circle membership through a separate authenticated sender request and verifies that the recipient's list and open details disappear without pressing Refresh. Existing English/French account, audience and invitation flows remain regression coverage. No additional account registrations were added to the shared browser suite's delivery quota.
