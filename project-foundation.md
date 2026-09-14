# Social chat platform · project foundation

Condensed from the supplied project plan. This document records the product context for the brand work; no backend, authentication, encryption or messaging service is implemented in this repository yet.

## Product vision

A private social platform where chat is the primary interface and events, photos, videos and shared memories are first-class objects.

Circles represent relationships. Conversations represent context. Events represent shared experiences. Media represents shared memory.

The same underlying graph supports chat, calendar, photo timeline, event, circle and home views. Structure should emerge from conversation: a message suggesting lunch can become an event without losing its history. The product should organise real relationships without turning them into administrative work.

## Core principles

1. Chat first, with a familiar messenger experience.
2. Create events, topics, trips and albums from existing discussions.
3. Circles describe persistent relationships; they do not define all access rights.
4. Conversations have independent membership and notification preferences.
5. Events can span multiple circles and private conversations.
6. Media has its own identity, timestamps, metadata, links and permissions.
7. Privacy must inform architecture from the start. The intended encryption boundary prevents database owners and unauthorised operators from reading private content.

## Domain model

- **User:** stable account identity, using UUIDv7 identifiers where supported.
- **Identity:** verified or invited email, phone, username or external identifier; may exist before its user account. Sensitive lookup values require appropriate protection.
- **Circle / CircleMembership:** persistent group and membership state/role.
- **Conversation:** independently addressable general, topic, event, direct or temporary communication context.
- **ConversationAudienceSource:** declarative includes and excludes from circles, events or individual users.
- **ConversationMember:** materialised effective membership for efficient authorisation. Declarative audience relationships remain the source of truth.
- **ConversationSubscription:** notifications, mute, archive and pin, independently of access.
- **Event:** independent event document with time, timezone, location, recurrence and many-to-many circle/conversation associations.
- **EventAttendee:** invitation and RSVP state for registered users, invited identities and potentially named guests through a participant abstraction.
- **Message:** encrypted content within a conversation; structured entries can reference events, media and polls.
- **TimelineEntry:** references a canonical domain object, with separate creation and real-world effective timestamps.
- **Media / MediaLink:** independent photo/video objects linked to events, conversations, circles or messages.
- **Device:** cryptographic identity, credentials and revocation state for each device.

Effective conversation membership combines included circle members, explicit people and included event attendees, minus explicit exclusions. Centralised authorisation must enforce exact access. Sharing an event must not disclose its other private conversations.

## Selected architecture

The current authoritative stack and roadmap are in [social_chat_platform_plan.md](social_chat_platform_plan.md#55-language-and-framework-decisions-14-september-2026). Use TypeScript throughout: one Expo/React Native frontend for web, iOS and Android, with a separate Node.js 24/Fastify backend and an integrated OAuth2/OIDC provider. Begin with a modular monolith, PostgreSQL as the durable system of record, S3-compatible object storage for media and background workers for notifications and housekeeping. REST/JSON APIs handle durable operations; WebSockets notify clients of changes. Redis is optional ephemeral infrastructure, never the canonical conversation store.

Modules: accounts, circles, conversations, events, media, crypto, sync, notifications and invites.

Each client maintains an encrypted local database and a durable sync cursor. The sync API provides ordered changes; WebSocket delivery is not persistence. Local indexes support decrypted search, calendar queries and media organisation.

Upload media directly to object storage with scoped signed credentials and opaque object names. Under the intended E2EE model, clients generate thumbnails/previews and encrypt each object before upload. Opt-in trusted media processing would be an explicit privacy tradeoff.

## Identity and onboarding

Support email and phone without using either as a primary account identifier. Magic links/OTPs establish identity; passkeys are the preferred persistent authentication direction. Keep account recovery separate from encryption key recovery.

Invitations bind an identity to scoped access. A guest invited to lunch must not automatically join the inviter’s wider circle. A browser guest should be able to participate in the invited conversation/event, RSVP and share media, with historical authorship preserved when the identity becomes a registered account.

Start with explicit invitations. Do not upload raw address books or describe plain hashes of phone numbers as private discovery. Later discovery requires a deliberate privacy-preserving design.

## Encryption and privacy foundations

- A conversation is the messaging cryptographic group; a circle is not.
- Consider MLS for group agreement and membership changes, subject to protocol and security review.
- Model independent device identities and device verification/revocation.
- Encrypt each event document with a random event content key, shared only with authorised audiences. One event can serve multiple groups without exposing their conversations.
- Give each media object a fresh random key and authenticated encryption using a standard audited construction.
- Document server-visible metadata, including routing identifiers, timing and ciphertext sizes. Event titles, times, locations and media metadata may require client-only indexing when encrypted.
- Prefer opaque push notifications and local search.
- Recovery must deliberately address lost devices and keys. Restoring ciphertext cannot restore missing decryption secrets.
- E2EE should shape early architecture even if implemented after interaction prototypes. Do not make public security promises before implementation and review.

## Execution phases

0. Domain model, threat model, API conventions, cryptographic architecture, schema and sync protocol.
1. Backend foundations: identity, devices, circles, conversations, invitations, change log and realtime notification.
2. Primary mobile client: chat, membership, notifications, offline cache and sync.
3. Seamless onboarding: verification, passkeys, deep links, guests, identity claiming and linking.
4. Conversation graph: multiple circles, include/exclude rules, topic creation and subscriptions.
5. Events: create from chat, RSVP, cross-circle sharing, updates, reminders and calendar view.
6. Media: encrypted object uploads, derivatives, linking and galleries.
7. E2EE: device verification, group epochs, encrypted events/media, multi-device keys and recovery; external review before launch.
8. Calendar and memories: alternate views of the same underlying objects.
9. Private organisation: local rules for event suggestions, dates, photo association and trip grouping. The product remains useful without AI.

## MVP boundary

Users, identities, invitations, circles, independent conversations, messages, events, RSVP, photos, object storage, E2EE foundations, push and local sync/cache.

Defer public profiles, a global feed, followers, algorithmic discovery, stories, reels, public posting, face recognition and complex recommendations.

## First validation flows

**Shared lunch:** Alice registers, creates School Friends and invites Bob. They chat about lunch, turn a message into an event, RSVP, see the event in the calendar and upload photos that appear in the event. The same history is accessible through chat, event, calendar and photo views.

**Cross-circle birthday:** one birthday event is associated with School Friends and Work Friends, each with a separate conversation. An external guest is invited directly. Everyone sees the shared event; each group sees only its own conversation.

## Decisions to resolve early

- Which history newly added members can decrypt.
- Event visibility independently of its associated conversations.
- Full cryptographic participation for browser guests and any interim trust tradeoffs.
- The precise metadata visible to the service.
- Device replacement, encrypted key backup and account recovery policy.

## Reliability and security

Plan for PostgreSQL point-in-time recovery, protected backups, disaster-recovery exercises, object integrity and versioning, idempotent APIs, replay-safe sync, rate limits, invitation expiry and device revocation.

Threat modelling must cover stolen devices, compromised servers, malicious operators, database/object-store leaks, SIM swaps, compromised email, malicious/removed members, invitation leaks, push metadata, traffic analysis and recovery.

Key invariants: removed members cannot decrypt future messages; new-member history follows explicit policy; circle membership never grants unrelated conversation access; shared events never expose private discussions; leaked blobs are ciphertext; server compromise does not disclose intended E2EE plaintext.
