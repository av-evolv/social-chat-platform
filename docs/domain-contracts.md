# Larynx domain, authorization and sync contracts

Status: M0 implementation contract for [#2](https://github.com/av-evolv/social-chat-platform/issues/2). This specifies required behavior; the current foundation implements health endpoints, not these product APIs or database tables. Feature PRs must implement and test the relevant scenarios below. Encryption protocol selection and key lifecycle belong to [#3](https://github.com/av-evolv/social-chat-platform/issues/3).

## 1. Identity and ownership

All domain IDs are UUIDv7, represented as lowercase canonical UUID strings on the wire and PostgreSQL `uuid` values in storage. IDs identify objects; they never authorize access or establish commit order. UUIDv7 embeds a timestamp: do not treat it as a secret or trust a client-generated timestamp. Persist authoritative server `created_at`/`updated_at` instants separately. API timestamps use RFC 3339 UTC strings; event timezone is an IANA name in the event document. Revisions and sync positions are decimal strings on the wire to avoid JavaScript integer precision loss. [UUID specification](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7).

| Entity | Ownership and invariant | Implementation issue |
| --- | --- | --- |
| User | Registered account, account state and canonical participant. Email/phone is never its primary key. | [#5](https://github.com/av-evolv/social-chat-platform/issues/5) |
| Participant | Stable historical actor. Registered account or a particular invited identity/guest; an unclaimed invitation is not an authenticated actor. | #5, [#7](https://github.com/av-evolv/social-chat-platform/issues/7) |
| Identity | Type, protected canonical value, verification state and nullable owning user. One verified identity cannot belong to two users. | #5, #7 |
| Device | Bound to an authenticated principal, with independent account-session and cryptographic trust/revocation state. | #5, [#10](https://github.com/av-evolv/social-chat-platform/issues/10) |
| Invitation / ScopedAccessGrant | Target participant/identity, exact resources and capabilities, inviter, expiry and consumption/revocation state. Acceptance proves control of the intended identity. | #7, [#21](https://github.com/av-evolv/social-chat-platform/issues/21) |
| Circle / CircleMembership | Relationship group and accepted membership; circle roles govern only that circle. | [#6](https://github.com/av-evolv/social-chat-platform/issues/6) |
| Conversation / AudienceSource / ConversationMember | Independent resource, declarative rules and versioned derived membership intervals. Explicit conversation roles are separate from inheritance. | #6 |
| Event / EventAudience / EventAttendee | Independent resource audience, roles and per-participant RSVP. Association and attendance do not replace authorization. | [#12](https://github.com/av-evolv/social-chat-platform/issues/12) |
| Message / TimelineEntry | Immutable author participant, resource, authoritative revision and content envelope; timeline entries reference canonical objects. | [#8](https://github.com/av-evolv/social-chat-platform/issues/8) |
| Media / MediaGrant / MediaLink | Uploader, storage lifecycle and explicit resource grants. A link is presentation context, not an automatic grant. | [#15](https://github.com/av-evolv/social-chat-platform/issues/15) |

Every authorship/attendance/membership reference uses `participant_id`. The earlier plan's `user_id` membership examples describe registered participants; they must not require rewriting a guest's history at signup. One user can bind previously invited participant records as aliases to its canonical participant. Historical authorship IDs remain immutable. API projections may show their current account profile without replacing the original author.

Authorization resolves all participant aliases to their current canonical principal **before** audience union, exclusion, role checks and RSVP uniqueness. This prevents a claimed identity from bypassing an exclusion under a second ID. One canonical principal has one effective membership/RSVP per resource. On claim, lock identity and participant bindings, require a fresh purpose-bound identity verification, check uniqueness, bind aliases, reconcile affected policy generations and invalidate old guest sessions/cursors atomically. Duplicate RSVP records need an explicit reconciliation result (keep the registered principal's existing response if present, otherwise the guest response); never silently create duplicate attendance. Preserve an audit record of the binding and response reconciliation.

M1 #7 accepts invitation claims only when the invited email already belongs to the signed-in account; new recipients register first. Adding a different recovery email requires issuer-hosted recent-passkey step-up (#45), not a generic delegated profile:write grant.

Invited email delivery or possession of an invitation URL alone does not verify identity, bind an account or grant object access. Store only hashed, expiring single-use invitation/verification credentials, with purpose and resource binding. Opaque invitation landing pages disclose no private resource details before verification. Guest access still uses short-lived, narrowly scoped OAuth tokens. Registering broadens account capabilities only; it does not join the inviter's circle or unrelated conversations. Linking an identity already owned by another user is a conflict requiring a separate account-recovery/linking flow; automatic account merging is outside MVP. Email normalization must not apply provider-specific dot/plus folding globally; exact canonicalization rules and unique lookup indexes are reviewed in #5/#7.

## 2. Audience and authority

### 2.1 Declarative resolution

For a conversation, resolve each source to a set of canonical principals, then compute:

```text
eligible = union(INCLUDE source sets) minus union(EXCLUDE source sets)
```

Exclusion wins over every inclusion, including explicit inclusion and aliases. Duplicate/overlapping sources grant access once. Removing one inclusion does not remove membership if another still grants it. Sources are `USER` (registered or invited participant reference), `CIRCLE` (ACTIVE accepted members) or `EVENT` (authorized event attendees with GOING or MAYBE response). RSVP filtering applies only to EVENT source sets: INVITED, WAITLISTED and DECLINED do not contribute through that event. Declining an event does not cancel an independent USER or CIRCLE inclusion. Circle sources omit LEFT/REMOVED members; suspended accounts and unverified guests cannot become active through any source. Invited principals can remain pending candidates until acceptance and cryptographic admission.

USER is the wire rule type for a principal reference; it resolves via Participant rather than requiring a registered User. Source membership cannot confer a conversation role. An explicit per-conversation role assignment is required for OWNER or ADMIN. MEMBER may read/send only after admission and within its granted scopes. ADMIN can manage membership subject to owner protection; only OWNER can transfer ownership, change owner roles or delete the conversation. Editing/deleting another person's message requires a separately specified moderation capability, not an inferred circle or event role.

Creating a conversation requires a user-facing audience preview. The creator must be authorized to reference each source and inspect its membership; guessing a circle/event ID cannot enumerate or subscribe to it. Seed the creator with explicit inclusion and OWNER role. Direct conversation administration must retain at least one active owner. Upstream circle/event membership removal, circle deletion, RSVP changes and account/device revocation are never rejected to preserve conversation ownership: if they remove the last usable owner, freeze owner-only changes pending a separately verified recovery/transfer flow. No server administrator receives private content access by becoming a resource owner in SQL.

Event audience rules use explicit participants and circles; they cannot recursively inherit conversation membership. A conversation may inherit accepted event attendees, but an EventConversation association does not create that rule. This one-way dependency keeps the MVP audience graph acyclic. Reject unsupported source types and cycles; do not silently broaden access. Circle deletion removes its contribution; it does not cascade-delete independently owned conversations/events.

### 2.2 Materialization and membership intervals

The declarative graph is authoritative. Materialized membership records carry resource ID, canonical principal, role, source provenance, policy generation, state, admission boundary and end boundary. Track all contributing sources (a separate relation is appropriate); a single `membership_source` string is insufficient for overlapping sources. Role grants and effective access are separate records, and a retained role cannot bypass absent membership.

Membership states are PENDING (eligible but not admitted), ACTIVE, LEFT or REMOVED. Inheritance expresses eligibility, not authorization to distribute old encryption keys. New members receive history only from accepted cryptographic admission. Rejoining creates a new interval; it must not expose the absence interval or automatically restore old keys. Explicit history sharing, if implemented later, is a new audited action with its own key grants. A user's mute/archive/pin settings never change access; a self-leave writes a participant exclusion so inherited membership cannot immediately add them back. Rejoining removes that exclusion only through explicit acceptance of a new invitation/admission.

Every source change bumps a source version. Every affected resource policy change invalidates its derived membership generation. Serving an old ACTIVE row while an included circle has removed a member is forbidden. Before authorizing, the primary must either prove the materialization matches **all** current source versions or recompute/deny until reconciliation. Cross-resource changes may mark derived policies dirty instead of synchronously expanding a large graph, but dirty data never grants access. Removing a member takes effect at the committed primary policy change; a background worker cannot extend permission while it catches up.

Cryptographic roster transitions are a separate gate. Additions/removals pause application sends/key distribution until the protocol proves the exact authorized device roster for the current policy generation. Removed principals immediately lose new API reads/grants. Existing authorized members may still read history allowed by their own intervals during reconciliation. New principals do not become ACTIVE just because a worker inserted a row. Clients and server check epoch/policy generation on writes; stale offline writes must reconcile membership and be re-encrypted by a trusted client, not relabeled by the server. The security contract specifies device trust and protocol checks.

### 2.3 Independent event and media boundaries

| Operation | Required authority | Does not grant |
| --- | --- | --- |
| Read event | Active event audience plus `events:read` and available event key for private content | Associated private conversations, circle roster or other attendees' profiles |
| RSVP | Own active invitation/audience grant plus `events:write`; update own response only | Editing event details, conversation access without a separate audience rule |
| Edit event | Explicit event ORGANIZER role plus `events:write` and expected revision | Conversation administration, keys for associated chats |
| Associate event/chat | Explicit edit/link authority on both resources; validate both on primary | Reciprocal read permission or key sharing |
| Read message/timeline reference | Active conversation access and allowed history interval plus `messages:read`; separately authorize referenced object | Private event/media body through a timeline title, preview or count |
| Sign media download | READY object and an active explicit media grant for an authorized resource, plus `media:read` | The private source chat merely because the same media is shared to an event |
| Share media to another audience | Explicit reshare right plus destination authority, recipient preview and client key distribution | Access created merely by inserting a MediaLink |

Private event title, description, times, timezone, precise location and RSVP details belong in the encrypted event document; the service sees only deliberate routing/authorization metadata. Server-side attendance records store the minimum response state necessary for audience rules. Do not expose attendee lists or counts to a caller without the explicit event roster capability. Include only separately authorized event/chat associations in responses, counts and search; omit unavailable references or show a generic unavailable marker without titles, participants or IDs that reveal private associations. An event cancellation does not delete its independent chats.

Private media grants include the content-key distribution policy. Unlinking a message is distinct from revoking a resource grant, and revoking one grant does not revoke another deliberate share. Global uploader deletion, authorized by the object's ownership policy, tombstones the object and revokes all grants in one SQL transaction; it is not rolled back if later physical S3 deletion fails. The durable deletion outbox retries idempotently. Do not promise to invalidate previously issued signed URLs instantly or erase downloaded ciphertext/plaintext. #15 defines bounded URL lifetimes, direct resumable multipart transfers, final server validation and orphan cleanup.

## 3. OAuth and request authorization

All product REST, sync, media coordination and realtime access uses OAuth2 access tokens. Health probes and the provider's protocol endpoints are infrastructure/authentication exceptions, not unauthenticated product APIs. Provider endpoints use their protocol-specific authentication; #4 must implement authorization code + PKCE, redirect validation and client registration/consent according to [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html). An OIDC ID token is not an API access token.

The resource server validates issuer, audience, expiry, token type, authorized client, current grant/revocation state and scopes, then binds the principal and device/session. Do not infer the actor from a request body's `user_id`/`participant_id`; a claimed sender different from the token principal is rejected. Product user operations require a user/verified-guest delegated grant; client-credentials tokens cannot impersonate participants. Third-party clients receive no broader resource or key access than their explicit consent and device trust permit.

Initial scope vocabulary is `profile:read`, `profile:write`, `circles:read`, `circles:write`, `conversations:read`, `conversations:write`, `messages:read`, `messages:write`, `events:read`, `events:write`, `media:read`, `media:write`, and `sync:read`. `offline_access` controls refresh eligibility at the provider; it is not an object permission. `sync:read` allows the transport only: each returned object also requires its domain read scope. No wildcard, admin-by-client-name or implicit first-party bypass. #4 freezes exact registration/consent semantics before exposing the provider.

Authorization is the intersection of current account/session/device eligibility, client consent/scopes, resource policy, action role, guest resource bounds, history interval and crypto gate where relevant. Possessing ciphertext, a UUID, subscription row, search hit, cursor or valid token alone is insufficient. Use one object policy for individual GETs, lists, counts, sync, WebSocket delivery, previews and signed URLs. Missing/invalid tokens return 401; authenticated callers lacking a scope receive 403 without object details; an inaccessible/missing object returns indistinguishable 404. Invalid revision/idempotency/epoch conflicts return 409 only after authenticating and authorizing the resource. Responses use stable machine codes without SQL/key/identity leaks.

## 4. Transactions, retries and replicas

M1 [#6](https://github.com/av-evolv/social-chat-platform/issues/6) implements this policy boundary with a coarse graph lock after shared OAuth-grant and actor-account locks; see [audiences.md](audiences.md). All current conversation memberships remain PENDING, with only the documented owner/admin bootstrap metadata permission. #8 owns durable stream/outbox integration and #10 owns signed device admission; neither is implied by a membership row.

Every mutation is a primary transaction: validate current authorization, lock policy dependencies, check expected revision, mutate canonical rows, update membership/generations as necessary, append durable sync changes and enqueue external side effects, then commit. Never send email, push or S3 deletes before durable intent is committed. Workers use at-least-once delivery with deduplication/reconciliation. A WebSocket notification is a hint emitted after commit; failures do not lose the durable change.

Policy mutations and protected writes acquire locks on the same authorization dependencies that conflict between a policy mutation and a protected write (for example shared policy locks for protected operations and exclusive policy locks for policy mutations) so a removal cannot race a stale authorized write into committing after it. Implementations must establish one lock order (idempotency key, source policies by ID, resource policies by ID, recipient stream rows by ID) and retry deadlock/serialization failures as a whole transaction with bounded backoff. Determine and revalidate affected resources under source locks; source-edge creation/removal follows the same lock order. A stale initial graph read is not sufficient. #6/#8 must demonstrate this with real concurrent PostgreSQL sessions.

Each mutable entity has a server-incremented revision. Clients send `expected_revision` for updates/deletes; exactly one concurrent update to a given revision succeeds. Return 409 `revision_conflict` to the other authorized caller; do not silently last-write-win event details or audience policies. Changes require a new operation key after reconciliation. Create requests carry a UUIDv7 operation key; a client-generated object ID is separately validated and cannot overwrite or claim an existing object. Subject/tenant fields are server-derived.

Idempotency is scoped to canonical principal, OAuth client, operation name and operation key. Store a digest of canonical validated inputs, including target, expected revision and ciphertext bytes. The unique key is reserved in the same transaction as the effect; concurrent duplicates wait for that transaction and then replay its result. For #6 circle/conversation creates, identical retries return the original committed ID with a fresh authorized metadata projection/current revision (never a cached roster); mismatched payloads return 409 `idempotency_conflict`. Rollback leaves no successful replay record. Authenticate and recheck current access **before** returning a cached result, so revoked callers cannot retrieve old data through replay. Short-lived signed URLs are generated afresh after authorization rather than replayed after expiry. Key retention and retry horizon must be explicit in #8; keep successful operation identities at least as long as their canonical object/tombstone and reject out-of-horizon retries instead of creating duplicate effects.

MVP authorization, user-scoped reads, sync, writes and read-after-write use the primary. Do not offload private payload reads to a lagging replica after a separate primary authorization check: policy and data must be read at a coherent boundary. Replicas initially serve only deliberately stale-tolerant non-private/public projections. #19 may add private reads only with a proved replay watermark, current primary authorization and version-consistent payload selection. Token introspection caches/materialized memberships never extend revocation past the documented authorization boundary.

Reads linearize at their final primary authorization snapshot. A read already authorized before a removal can finish afterward; bytes already sent cannot be withdrawn. Requests authorized after the removal commit must deny. Signed capabilities have their documented expiry boundary. This is the precise meaning of immediate API revocation, not a promise to erase data or cancel every in-flight response.

## 5. Durable synchronization

### 5.1 Commit ordering and recipient streams

The initial design is a durable **per-canonical-participant change stream**, shared across that principal's authorized devices. Each entry contains an immutable stream position, change ID, resource ID/type, resource revision, kind (`upsert`, `delete`, `access_revoked`) and minimum routing metadata. Payload delivery always rechecks current authorization and history/key eligibility; log presence is not permission. Expired/deleted payloads must not survive as retrievable immutable log bodies. Device-specific key envelopes remain addressed to the correct trusted device.

Increment a transactional counter row for each recipient while holding its row lock until commit; append entries and the domain mutation in that same transaction. Lock multiple recipients in canonical ID order. Positions become visible with their entries on commit; rollback rolls back the counter increment. Concurrent writers for the same recipient cannot publish a higher position while a lower reserved position is uncommitted. UUIDv7 order, wall clocks and bare `BIGSERIAL`/`nextval()` high-water marks are **not** sync cursors: PostgreSQL sequence allocation is not transaction commit ordering. [PostgreSQL sequence behavior](https://www.postgresql.org/docs/18/functions-sequence.html).

Audience/grant changes append changes or invalidation markers for affected principals, including removed principals. Large fan-out may later use a durable outbox/sequencer, but it must preserve this ordering/replay invariant before replacing synchronous fan-out. Delayed materialization first marks the affected authorization state dirty; sync cannot declare that dirty state current or serve stale grants. #8 must specify capacity bounds and resume/reconciliation behavior; no unbounded fan-out transaction is assumed production-ready.

### 5.2 Cursor and page contract

`GET /sync?after=<opaque cursor>&limit=<bounded integer>` requires `sync:read` and relevant domain scopes. The cursor is integrity-protected and binds format version, principal, OAuth client/grant and scope fingerprint, device where needed, authorization generation, stream retention generation, last scanned position and the current page-window high watermark. It expires; raw positions supplied by the client are never trusted. Cursor signing is transport integrity, not content encryption.

At the first page, capture the committed high watermark H at a consistent primary boundary. Scan `(last_position, H]` in increasing order with bounded work and payload size. Next cursor advances to the **last scanned** position, including omitted unauthorized/expired entries, not just the last returned item; otherwise filtering can loop forever. `has_more` indicates unscanned positions at or below H. An empty filtered page may still have `has_more=true`. After finishing H, the next request opens a new committed window. Never advance past an uncommitted gap or use an ever-moving end point that starves a busy stream.

A delta identifies its resource revision; clients apply newer revisions idempotently and ignore duplicates/older versions. Persist applied changes and the next cursor in one local transaction. Disconnects/retries may deliver duplicates, never require trusting WebSocket delivery, and never advance a cursor before the local state is durable. For multiple events on one resource within a window, #8 must return the version at that position or coalesce to the latest version **within H**; loading an unconstrained current row can leak post-H state or make a checkpoint misleading. Tombstones supersede earlier updates and must not expose deleted private payloads.

Before every page, revalidate current scopes, device/grant status and authorization generation. A policy change increments the affected principal's authorization generation before any subsequent read may use stale materialization. A generation mismatch returns 409 `sync_reset_required` with no private payload. Access removal produces a minimal removal marker if incremental reconciliation is safe; otherwise reset the authorized cache. Grant/scope changes and identity claiming require reset. Invalid/tampered or foreign cursors return 400 `invalid_cursor` without revealing the referenced principal; expired/compacted cursors return 410 `cursor_expired` with reset instructions. Client caches must remove revoked resources and keys on reconciliation; an offline/untrusted client may retain earlier copies.

### 5.3 Initial snapshot and retention

A first sync or reset obtains a bounded, expiring server snapshot manifest of authorized resource IDs/revisions at watermark H and authorization generation G. Capture H and the snapshot under one consistent database snapshot; materialize the manifest/version references rather than holding a database transaction across HTTP requests. Page by stable manifest position, never offset against a changing live list. Retain the necessary object versions/log interval through manifest expiry or return an explicit reset-required response; never silently fall back to live versions. Recheck authorization generation/current deletions for each page, including payload fetches. A revocation or deletion may invalidate the snapshot; it must not resurrect removed data from retained versions.

Clients build a replacement cache in a staging namespace, atomically install it only when the complete snapshot is verified, then resume changes after H. Keep locally authored unsent drafts separate so a reset does not silently transmit or destroy them; revalidate audience/keys before resending. A failed/expired snapshot restarts without claiming a complete cache. Tombstones/change entries must survive the supported offline horizon; clients older than retention rebuild. #8 sets and exposes concrete retention/expiry/size limits before implementation, and #18 implements local key/cache cleanup. Read Committed statements do not by themselves form one consistent multipage snapshot; the implementation must use the designed snapshot boundary. [PostgreSQL isolation](https://www.postgresql.org/docs/18/transaction-iso.html).

## 6. Acceptance and adversarial scenarios

These are required acceptance cases for downstream feature PRs, not claims that the current foundation has implemented them. Test authorization with distinct clients, scopes, users/aliases, devices and guest grants. Concurrency cases require actual PostgreSQL transactions, not only mocked policy helpers.

| ID | Setup / action | Required outcome | Owner |
| --- | --- | --- | --- |
| D01 | Circle admin has no chat membership; guesses chat ID | 404; no roster, preview or message access and no inherited admin role | #6 |
| D02 | Alice included through two circles; one inclusion removed | Remains eligible through the other source, without duplicated membership | #6 |
| D03 | Alice explicitly included but excluded by a circle or identity alias | Exclusion wins after canonicalization | #5, #6 |
| D04 | Source removal commits while materialized chat membership is stale | Subsequent authorization recomputes/denies; stale ACTIVE row never grants | #6 |
| D05 | Invite URL forwarded to another identity | No private landing details or access; verification must match the bound target | #7 |
| D06 | Two accounts concurrently claim one invited identity | At most one verified binding; conflict cannot transfer history to the loser | #5, #7 |
| D07 | Guest registers or adds an alias | Authorship IDs retained, exclusion respected, RSVP reconciled; guest session/cursor reset | #5, #21 |
| D08 | Attendee reads event linked to three private chats | Only separately authorized associations appear; no hidden chat titles/counts | #12 |
| D09 | RSVP changes GOING to DECLINED, removing sole inherited chat grant | Dirty policy denies immediately; history interval ends and crypto roster reconciles | #6, #12, #10 |
| D10 | Member mutes/archive/pins; later explicitly leaves | Preferences preserve access; leave excludes inherited membership until explicit rejoin | #6, #11 |
| D11 | New member joins or removed member rejoins | No pre-admission history or absence-gap keys; new crypto admission interval | #10 |
| D12 | Revocation races message submission with old epoch | Ordered primary transaction either commits before removal or rejects stale sender/epoch | #6, #8, #10 |
| D13 | Token is valid but scope, client, device or guest resource is wrong | Deny on each API/list/sync/socket/signed-URL path | #4, #8, #15 |
| D14 | Two event edits use one revision | Exactly one commits; other gets authorized 409 and cannot silently overwrite | #12 |
| D15 | Same operation arrives concurrently; then payload changes under same key | One domain effect/log entry; identical replay stable, changed input conflicts | #8 |
| D16 | Successful mutation replayed after principal loses access | No cached private response or fresh signed capability | #8, #15 |
| D17 | Writer A reserves a stream position then stalls; B writes same recipient | B cannot publish later position ahead of A; commit/rollback yields lossless resume | #8 |
| D18 | Entire sync page filtered, but later entries eligible | Cursor progresses by scanned entries; no loop or missing later data | #8 |
| D19 | Commit after H updates a row already present in the current page window | Page does not substitute post-H state; next window delivers later revision | #8 |
| D20 | Scope narrowed, identity claimed, device revoked or membership lost between pages | Reset/deny before private payload; no cursor-based access continuation | #4, #8 |
| D21 | Client crashes between receiving delta and storing cursor | Atomic local apply allows safe duplicate replay, no missing state | #9 |
| D22 | Resource deleted during paginated snapshot; cursor older than retention | No resurrection; invalidate/rebuild snapshot explicitly | #8, #9 |
| D23 | Replica still has active grant/deleted payload after primary removal | MVP private path uses primary; replica state cannot restore access | #19 |
| D24 | Media linked to event without explicit media grant/key distribution | No signed download or plaintext preview; linkage is not sharing authority | #15, #16 |
| D25 | Object tombstone commits and S3 deletion fails or worker crashes | API visibility denied, durable retry/reconciliation; previous capability expiry acknowledged | #15 |
| D26 | Source edit introduces recursive inheritance; direct chat edit removes last owner | Reject the cycle or direct owner removal; require ownership transfer for the latter | #6 |
| D27 | RSVP decline removes EVENT inclusion but USER/CIRCLE independently includes the participant | Preserve membership through the independent source | #6, #12 |
| D28 | Circle removal/deletion or RSVP change removes last usable chat owner | Upstream change proceeds; freeze owner-only chat administration rather than blocking the source change | #6, #12 |

### Database design experiment

Run `node --env-file=.env scripts/check-sync-ordering.mjs` after `npm ci` against local/disposable PostgreSQL with schema creation rights. It creates a uniquely named probe schema and removes it afterward. The experiment reproduces a late commit missed by a bare sequence cursor, observes the second writer blocked on the transactional recipient counter, then verifies committed publication and rollback behavior with three real database connections. It does not implement the sync API or prove fan-out, snapshot, revocation or application transaction correctness; those remain #8 acceptance tests.

## 7. Implementation handoff

[#4](https://github.com/av-evolv/social-chat-platform/issues/4) implements scoped OAuth and token revocation. #5/#7 implement principal/identity constraints and verified claiming; #6 implements relational audience policy and transactional freshness; #8 implements the idempotency and sync protocol; #9 implements atomic local application; #10 implements reviewed cryptographic admission; #12/#14 implement event authorization/encryption; #15 implements signed media and transactional deletion intent; #19 proves production consistency and scaling. Every feature PR links its implemented scenario IDs and remaining cases. Shared TypeScript types must not replace server runtime validation, and the frontend never imports server policy/secret-bearing modules.
