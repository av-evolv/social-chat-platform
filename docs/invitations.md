# Email invitations and identity claims

[#7](https://github.com/av-evolv/social-chat-platform/issues/7) adds email invitations to existing circles and independent conversations. The sender must currently administer the target and hold its write scope. Invitations create a separate unclaimed participant and pending grant; no circle membership or conversation source is installed before acceptance. Sender responses never disclose whether an email is registered.

Recipients sign in with the account already registered to the invited email. New recipients complete the existing verified-email/passkey signup first. On the shared `/invitations` screen, they enter the email and invitation code, request a fresh verification code, and explicitly accept. Invitation possession alone grants nothing. The proof is bound to purpose, exact invitation/resource/revision/email and the current OAuth client/account/device/session; it expires after ten minutes and is consumed only with successful acceptance. Invalid proof requests return the same generic response. Switching accounts or sessions requires new proof.

Acceptance requires the email already belong to that account. It cannot insert identities, merge accounts or add recovery channels. A delegated application with `profile:write` must not be able to add its own email and recover the user's account. [#45](https://github.com/av-evolv/social-chat-platform/issues/45) separately tracks additional-email linking with issuer-hosted recent-passkey confirmation. The existing verified email is shown on the account screen to help recipients select the correct account.

## Scope and transaction boundary

A claim maps only the accepted invitation's original participant ID to the account's canonical participant. Historical attribution IDs remain unchanged, with a durable audit of who claimed which alias for which invitation/resource. Other pending invitations remain pending. Acceptance adds MEMBER circle membership or a USER conversation source; existing active membership/roles are preserved. Canonical exclusions and durable conversation self-leave remain effective. Accepting a circle may make the user eligible for conversations explicitly including that circle, as in normal circle acceptance. All conversation memberships remain PENDING and content/send gates CLOSED until #10.

The primary transaction follows operation lock (for creates), identity-email lock (for claims/registration), OAuth grant lock, recipient account lock and the shared social-policy lock. It rechecks the invitation's expiry/revocation/consumption, current inviter authority, target existence, recipient eligibility and identity ownership, then binds the alias, accepts the selected grant, reconciles affected policies and consumes proof atomically. Current inviter demotion, resource deletion and invitation/device/OAuth revocation are tested against acceptance with real concurrent PostgreSQL connections.

Guest accounts/OAuth, browser guest messaging and actual deep-link handoff are #21. No guest sessions/cursors or RSVP records exist to migrate in this implementation; #21/#8/#12 must join alias changes and their invalidation/reconciliation to this transaction before shipping those features. Event invitations await #12; encrypted admission/history remains #10. These are explicit integration boundaries, not implicit permission grants from an alias.

## Delivery, retries and limits

Invitation codes contain 256 random bits, persist only as hashes and expire after seven days. Email addresses are protected using the identity service's encrypted value and keyed lookup. Email content contains no private titles, rosters or messages. The public entry link is generic: credentials are pasted into the signed-in app, never placed in URLs, browser persistence or logs.

The invitation intent commits before SMTP delivery. The sender sees `PENDING` (unconfirmed/interrupted delivery), `SENT` (SMTP accepted) or `FAILED`. There is no automatic delivery queue in this issue. Explicit resend retries delivery with a new credential/revision and invalidates previous invitation/proof codes. A crash between commit and delivery/status recording leaves a retryable PENDING state; an email accepted by SMTP is not proof the recipient read it. Delivery status updates match the original invitation revision/credential and cannot resurrect revoked or replaced invitations.

Create requests use retained UUIDv7 operation keys scoped to principal and OAuth client. Identical retries reuse the original invitation and never send another email. Current authority is checked before replay or conflict details. Resend/revoke use `expected_revision`. Sender quotas are 20 deliveries/hour and three deliveries per recipient/ten minutes. Verification issuance has account and recipient bounds. Routes also share a per-process limit of 60 requests/minute/IP before OAuth/database work, with bounded cache and Retry-After. Distributed abuse controls, retention and a future durable mail worker remain #19/#8.

## APIs and verification

- GET `/v1/invitations`: sender's currently authorized invitations, filtered by target read scope.
- POST `/v1/invitations`: `{target:{type:CIRCLE|CONVERSATION,id},email,operation_key,expected_revision}`; target write scope.
- POST `/v1/invitations/:id/resend` or `/revoke`: `{expected_revision}`; sender and current target write authority.
- POST `/v1/invitations/proof`: `{email,token}`; `profile:write` and matched target write scope; generic `{sent:true}`.
- POST `/v1/invitations/accept`: `{email,token,code,confirm_accept:true}`; fresh current authority and proof; returns only the accepted target.

Run API tests with `OAUTH_TEST_DATABASE_URL` for isolated PostgreSQL schemas. Tests cover binding/isolation, token lifecycle, ownership/takeover denial, retry/delivery behavior and ordered races. Browser tests use Mailpit and real virtual passkeys/OAuth for new recipient signup and acceptance. The shared screen, errors and email templates support English and French through [#42](https://github.com/av-evolv/social-chat-platform/issues/42); see [localization](localization.md) for recipient preference and fallback behavior.

## Planned friends, previews and calendar consent

The shipped behavior above remains unchanged until [#51](https://github.com/av-evolv/social-chat-platform/issues/51), [#23](https://github.com/av-evolv/social-chat-platform/issues/23) and [#41](https://github.com/av-evolv/social-chat-platform/issues/41) implement the [product admission rules](../social_chat_platform_plan.md#351-friends-and-circle-admission-planned). Authorized administrators can directly add accepted friends or verified active co-organisation members. Other recipients receive a pending invitation with a narrowly scoped intended-recipient preview of members, description and optional logo/header before acceptance. Preview is an explicit exception to the current pre-acceptance disclosure rule, not public bearer-link access. Preserve sender email-enumeration resistance.

For an unregistered email recipient, a verified calendar ACCEPTED response may record consent to the explicitly named circle disclosed in the event request. Trusted reply ingestion validates recipient control, invitation/event/revision binding and current authority before recording idempotent consent; it does not bypass OAuth on application APIs. It cannot bind an existing account or claim other invitations. Verified identity claim later reconciles that evidence without requesting duplicate circle consent, while preserving leave/exclusion and cryptographic admission gates. Calendar-provider reply verification and an unsupported/unverifiable-reply path must be designed and tested before enabling this feature.
