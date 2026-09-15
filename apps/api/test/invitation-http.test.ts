import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { IncomingMessage } from 'node:http';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { digest, keyed, protectEmail, type IdentityConfig } from '../src/identity/config.js';
import { IdentityStore } from '../src/identity/store.js';
import { mountInvitations } from '../src/invitations/index.js';
import { InvitationStore } from '../src/invitations/store.js';
import type { Delivery, InvitationView } from '../src/invitations/types.js';
import { OAuthAccessError } from '../src/oauth/index.js';
import { mountSocial } from '../src/social/index.js';
import { SocialStore } from '../src/social/store.js';
import type { SocialActor } from '../src/social/types.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for isolated PostgreSQL integration tests' };
async function fixture(t: TestContext) {
  const suffix = randomBytes(8).toString('hex');
  const schema = `invitation_http_${suffix}`; const identitySchema = `invite_http_identity_${suffix}`; const socialSchema = `invite_http_social_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${socialSchema} CASCADE; DROP SCHEMA IF EXISTS ${identitySchema} CASCADE`); }
    finally { await pool.end(); }
  });
  const config: IdentityConfig = { origin: 'http://localhost:3000', rpId: 'localhost', mode: 'local', encryptionKey: randomBytes(32), lookupKey: randomBytes(32), smtp: { host: 'localhost', port: 1025, secure: false, from: 'no-reply@example.test' } };
  let social: SocialStore;
  const identity = new IdentityStore(pool, { schema: identitySchema, onPrincipalChange: async (db, participantId) => social.invalidateParticipant(db, participantId) });
  await identity.migrate();
  social = new SocialStore(pool, { schema: socialSchema, identitySchema, assertOAuth: async () => {} });
  await social.migrate();
  const invitations = new InvitationStore(pool, social, config, { schema, identitySchema });
  await invitations.migrate();
  const actors = new Map<string, SocialActor>();
  async function actor(label: string, scopes = ['profile:write', 'circles:read', 'circles:write', 'conversations:read', 'conversations:write']) {
    const participantId = await identity.newId();
    const session = await identity.register({ accountId: await identity.newId(), participantId,
      emailHash: keyed(config, 'email', `${label}@example.test`), emailCiphertext: protectEmail(config, `${label}@example.test`),
      credential: { id: `credential:${label}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
      deviceName: label, deviceHash: digest(`device:${label}`), sessionHash: digest(`session:${label}`),
    });
    const value: SocialActor = { ...session, participantId, scopes, clientId: 'trusted-http-test' };
    actors.set(`Bearer ${label}`, value);
    return { value, headers: { authorization: `Bearer ${label}` } };
  }
  const oauth = { authorize: async (request: IncomingMessage, scopes: readonly [string, ...string[]]) => {
    const actor = actors.get(request.headers.authorization ?? '');
    if (!actor) throw new OAuthAccessError(401, 'invalid_token');
    if (scopes.some(scope => !actor.scopes.includes(scope))) throw new OAuthAccessError(403, 'insufficient_scope');
    return actor;
  } };
  // The real OAuth provider has its own tests. Here trusted actor fixtures isolate
  // the transport contract; the stores still enforce live identity and policy.
  await mountSocial(app, oauth, social);
  const mail: { fail: boolean; deliveries: Delivery[]; committed: boolean[] } = { fail: false, deliveries: [], committed: [] };
  await mountInvitations(app, oauth, invitations, async delivery => {
    // A separate pooled connection must observe committed intent before SMTP.
    const row = delivery.kind === 'invitation'
      ? (await pool.query(`SELECT credential_hash AS hash FROM ${schema}.invitations WHERE id=$1`, [delivery.invitationId])).rows[0]
      : (await pool.query(`SELECT id AS hash FROM ${schema}.proofs WHERE id=$1`, [digest(delivery.token)])).rows[0];
    mail.committed.push(row?.hash === digest(delivery.token));
    mail.deliveries.push(delivery);
    if (mail.fail) throw new Error('fixture SMTP unavailable');
  });
  return { app, identity, social, invitations, actor, pool, schema, identitySchema, mail, id: () => identity.newId() };
}

test('Invitation HTTP sends only after commit, hides credentials and preserves generic proof responses', integration, async t => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.social.createCircle(alice.value, await f.id());
  const created = await f.app.inject({ method: 'POST', url: '/v1/invitations', headers: alice.headers, payload: { target: { type: 'CIRCLE', id: circle.id }, email: 'bob@example.test', operation_key: await f.id(), expected_revision: circle.revision } });
  assert.equal(created.statusCode, 200); assert.equal(created.headers['cache-control'], 'no-store');
  assert.equal(created.json<InvitationView>().delivery, 'SENT');
  const invitation = f.mail.deliveries[0]!;
  assert.equal(invitation.kind, 'invitation'); assert.equal(f.mail.committed[0], true);
  assert.ok(!created.body.includes(invitation.token)); assert.equal(created.json().delivery?.token, undefined);
  const list = await f.app.inject({ url: '/v1/invitations', headers: alice.headers });
  assert.equal(list.statusCode, 200); assert.ok(!list.body.includes(invitation.token));
  const valid = await f.app.inject({ method: 'POST', url: '/v1/invitations/proof', headers: bob.headers, payload: { token: invitation.token, email: invitation.email } });
  const unknown = await f.app.inject({ method: 'POST', url: '/v1/invitations/proof', headers: bob.headers, payload: { token: randomBytes(32).toString('base64url'), email: invitation.email } });
  const mismatch = await f.app.inject({ method: 'POST', url: '/v1/invitations/proof', headers: bob.headers, payload: { token: invitation.token, email: 'different@example.test' } });
  for (const result of [valid, unknown, mismatch]) {
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), { sent: true }); assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.equal(f.mail.deliveries.length, 2); const proof = f.mail.deliveries[1]!;
  assert.equal(proof.kind, 'verification'); assert.equal(f.mail.committed[1], true); assert.ok(!valid.body.includes(proof.token));
  assert.equal((await f.social.circle(alice.value, circle.id)).members?.length, 1);
});

test('Failed email delivery remains retryable; resend invalidates prior credentials and replay does not redeliver', integration, async t => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const circle = await f.social.createCircle(alice.value, await f.id());
  const request = { method: 'POST' as const, url: '/v1/invitations', headers: alice.headers, payload: { target: { type: 'CIRCLE', id: circle.id }, email: 'bob@example.test', operation_key: await f.id(), expected_revision: circle.revision } };
  f.mail.fail = true;
  const created = await f.app.inject(request); assert.equal(created.statusCode, 200);
  const failed = created.json<InvitationView>(); assert.equal(failed.delivery, 'FAILED');
  assert.equal((await f.invitations.list(alice.value))[0]?.delivery, 'FAILED');
  const old = f.mail.deliveries[0]!;
  f.mail.fail = false;
  const replay = await f.app.inject(request); assert.equal(replay.statusCode, 200); assert.equal(replay.json().id, failed.id); assert.equal(f.mail.deliveries.length, 1);
  const resent = await f.app.inject({ method: 'POST', url: `/v1/invitations/${failed.id}/resend`, headers: alice.headers, payload: { expected_revision: failed.revision } });
  assert.equal(resent.statusCode, 200); assert.equal(resent.json().delivery, 'SENT');
  const current = f.mail.deliveries[1]!; assert.notEqual(current.token, old.token);
  const invalidated = await f.app.inject({ method: 'POST', url: '/v1/invitations/proof', headers: bob.headers, payload: { token: old.token, email: old.email } });
  assert.deepEqual(invalidated.json(), { sent: true }); assert.equal(f.mail.deliveries.length, 2);
  f.mail.fail = true;
  const proofFailure = await f.app.inject({ method: 'POST', url: '/v1/invitations/proof', headers: bob.headers, payload: { token: current.token, email: current.email } });
  assert.equal(proofFailure.statusCode, 200); assert.deepEqual(proofFailure.json(), { sent: true });
  assert.ok(f.mail.committed.every(Boolean));
});

test('HTTP acceptance requires fresh proof and explicit confirmation and joins only the selected resource', integration, async t => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob');
  const selected = await f.social.createCircle(alice.value, await f.id()); const other = await f.social.createCircle(alice.value, await f.id());
  for (const circle of [selected, other]) {
    const result = await f.app.inject({ method: 'POST', url: '/v1/invitations', headers: alice.headers, payload: { target: { type: 'CIRCLE', id: circle.id }, email: 'bob@example.test', operation_key: await f.id(), expected_revision: circle.revision } });
    assert.equal(result.statusCode, 200);
  }
  const invitation = f.mail.deliveries[0]!;
  assert.equal((await f.app.inject({ method: 'POST', url: '/v1/invitations/proof', headers: bob.headers, payload: { token: invitation.token, email: invitation.email } })).statusCode, 200);
  const code = f.mail.deliveries[2]!.token;
  const payload = { token: invitation.token, email: invitation.email, code };
  for (const extra of [{}, { confirm_accept: false }, { confirm_accept: 'true' }, { confirm_accept: true, target: { type: 'CIRCLE', id: other.id } }]) {
    const invalid = await f.app.inject({ method: 'POST', url: '/v1/invitations/accept', headers: bob.headers, payload: { ...payload, ...extra } });
    assert.equal(invalid.statusCode, 400); assert.deepEqual(invalid.json(), { error: 'invalid_request' });
  }
  const accepted = await f.app.inject({ method: 'POST', url: '/v1/invitations/accept', headers: bob.headers, payload: { ...payload, confirm_accept: true } });
  assert.equal(accepted.statusCode, 200); assert.deepEqual(accepted.json(), { target: { type: 'CIRCLE', id: selected.id } });
  assert.ok(!accepted.body.includes(code)); assert.ok(!accepted.body.includes(invitation.token));
  assert.equal((await f.social.circle(bob.value, selected.id)).state, 'ACTIVE');
  const unrelated = await f.app.inject({ url: `/v1/social/circles/${other.id}`, headers: bob.headers });
  assert.equal(unrelated.statusCode, 404);
  const replay = await f.app.inject({ method: 'POST', url: '/v1/invitations/accept', headers: bob.headers, payload: { ...payload, confirm_accept: true } });
  assert.equal(replay.statusCode, 409);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.identitySchema}.identities WHERE account_id=$1`, [bob.value.accountId])).rows[0].n, 1);
});

test('Invitation routes reject invalid input, missing scopes and inaccessible resources without disclosure', integration, async t => {
  const f = await fixture(t); const owner = await f.actor('owner'); const stranger = await f.actor('stranger'); const reader = await f.actor('reader', ['circles:read']);
  const circle = await f.social.createCircle(owner.value, await f.id());
  const payload = { target: { type: 'CIRCLE', id: circle.id }, email: 'reader@example.test', operation_key: await f.id(), expected_revision: circle.revision };
  const missing = await f.app.inject('/v1/invitations'); assert.equal(missing.statusCode, 401); assert.equal(missing.headers['www-authenticate'], 'Bearer');
  const forbidden = await f.app.inject({ method: 'POST', url: '/v1/invitations', headers: reader.headers, payload });
  assert.equal(forbidden.statusCode, 403); assert.match(String(forbidden.headers['www-authenticate']), /insufficient_scope/);
  for (const id of [circle.id, await f.id()]) {
    const inaccessible = await f.app.inject({ method: 'POST', url: '/v1/invitations', headers: stranger.headers, payload: { ...payload, target: { type: 'CIRCLE', id } } });
    assert.equal(inaccessible.statusCode, 404); assert.deepEqual(inaccessible.json(), { error: 'not_found' });
  }
  for (const invalid of [ { ...payload, role: 'OWNER' }, { ...payload, target: { type: 'EVENT', id: circle.id } }, { ...payload, target: { ...payload.target, participants: [owner.value.participantId] } }, { ...payload, operation_key: randomUUID() }, { ...payload, expected_revision: 1 }, { ...payload, email: 'not-an-email' } ]) {
    const result = await f.app.inject({ method: 'POST', url: '/v1/invitations', headers: owner.headers, payload: invalid });
    assert.equal(result.statusCode, 400); assert.deepEqual(result.json(), { error: 'invalid_request' });
  }
  const oversized = await f.app.inject({ method: 'POST', url: '/v1/invitations', headers: owner.headers, payload: { ...payload, padding: 'x'.repeat(9000) } });
  assert.equal(oversized.statusCode, 413);
  assert.equal(f.mail.deliveries.length, 0);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.schema}.invitations`)).rows[0].n, 0);
});

test('Invitation rate limiting precedes OAuth, spans routes and coexists with social middleware', async t => {
  const app = Fastify(); t.after(() => app.close());
  app.get('/health/live', async () => ({ status: 'ok' }));
  let authorizations = 0;
  const oauth = { authorize: async (): Promise<SocialActor> => { authorizations++; throw new OAuthAccessError(401, 'invalid_token'); } };
  await mountSocial(app, oauth, {} as SocialStore);
  await mountInvitations(app, oauth, {} as InvitationStore, async () => { assert.fail('unauthorized requests must never send mail'); });
  for (let index = 0; index < 60; index++) {
    const response = await app.inject({ method: index % 2 ? 'GET' : 'POST', url: index % 2 ? '/v1/invitations' : '/v1/invitations/proof', remoteAddress: '192.0.2.1', ...(index % 2 ? {} : { payload: {} }) });
    assert.equal(response.statusCode, 401);
  }
  const limited = await app.inject({ url: '/v1/invitations', remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for': '192.0.2.2' } });
  assert.equal(limited.statusCode, 429); assert.deepEqual(limited.json(), { error: 'too_many_requests' });
  assert.equal(limited.headers['cache-control'], 'no-store'); assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(authorizations, 60);
  assert.equal((await app.inject({ url: '/v1/social/circles', remoteAddress: '192.0.2.1' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/invitations', remoteAddress: '192.0.2.3' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/health/live', remoteAddress: '192.0.2.1' })).statusCode, 200);
  assert.equal(authorizations, 62);
});
