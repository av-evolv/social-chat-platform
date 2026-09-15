import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { IdentityStore } from '../src/identity/store.js';
import { OAuthAccessError } from '../src/oauth/index.js';
import { mountSocial } from '../src/social/index.js';
import { SocialStore } from '../src/social/store.js';
import type { CircleView, ConversationView, SocialActor } from '../src/social/types.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set OAUTH_TEST_DATABASE_URL for isolated PostgreSQL integration tests' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext) {
  const suffix = randomBytes(8).toString('hex');
  const schema = `social_http_${suffix}`; const identitySchema = `social_http_identity_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${identitySchema} CASCADE`); }
    finally { await pool.end(); }
  });
  let social: SocialStore;
  const identity = new IdentityStore(pool, { schema: identitySchema, onPrincipalChange: async (db, participantId) => social.invalidateParticipant(db, participantId) });
  await identity.migrate();
  social = new SocialStore(pool, { schema, identitySchema, assertOAuth: async () => {} });
  await social.migrate();
  const actors = new Map<string, SocialActor>();
  async function actor(label: string, scopes = ['circles:read', 'circles:write', 'conversations:read', 'conversations:write']) {
    const participantId = await identity.newId();
    const session = await identity.register({
      accountId: await identity.newId(), participantId, emailHash: hash(`email:${label}`), emailCiphertext: `encrypted:${label}`,
      credential: { id: `credential:${label}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
      deviceName: label, deviceHash: hash(`device:${label}`), sessionHash: hash(`session:${label}`),
    });
    const value: SocialActor = { ...session, participantId, scopes, clientId: 'trusted-http-test-client' };
    actors.set(`Bearer ${label}`, value);
    return { value, headers: { authorization: `Bearer ${label}` } };
  }
  // Transport tests use trusted actors; OAuth token/grant verification is exercised
  // independently against the real provider. SocialStore still checks live identity.
  await mountSocial(app, { authorize: async (request, scopes) => {
    const value = actors.get(request.headers.authorization ?? '');
    if (!value) throw new OAuthAccessError(401, 'invalid_token');
    if (scopes.some((scope) => !value.scopes.includes(scope))) throw new OAuthAccessError(403, 'insufficient_scope');
    return value;
  } }, social);
  return { app, identity, social, actor, id: () => identity.newId() };
}

test('Social HTTP routes enforce authentication, scopes, current identity and indistinguishable object access', integration, async (t) => {
  const { app, actor, identity, id } = await fixture(t);
  const owner = await actor('owner'); const stranger = await actor('stranger'); const reader = await actor('reader', ['circles:read']);
  const missing = await app.inject('/v1/social/circles');
  assert.equal(missing.statusCode, 401); assert.equal(missing.headers['www-authenticate'], 'Bearer');
  assert.deepEqual(missing.json(), { error: 'invalid_token' });
  const forbidden = await app.inject({ method: 'POST', url: '/v1/social/circles', headers: reader.headers, payload: { operation_key: await id() } });
  assert.equal(forbidden.statusCode, 403); assert.match(String(forbidden.headers['www-authenticate']), /circles:write/);
  const created = await app.inject({ method: 'POST', url: '/v1/social/circles', headers: owner.headers, payload: { operation_key: await id() } });
  assert.equal(created.statusCode, 200); assert.equal(created.headers['cache-control'], 'no-store');
  const circle = created.json<CircleView>();
  assert.match(circle.id, /^[0-9a-f-]{14}7/); assert.equal(circle.role, 'OWNER'); assert.equal(circle.state, 'ACTIVE');
  assert.equal(typeof circle.createdAt, 'string'); assert.equal(typeof circle.revision, 'string');
  for (const circleId of [circle.id, await id()]) {
    const inaccessible = await app.inject({ method: 'GET', url: `/v1/social/circles/${circleId}`, headers: stranger.headers });
    assert.equal(inaccessible.statusCode, 404); assert.deepEqual(inaccessible.json(), { error: 'not_found' });
  }
  await identity.logout(owner.value);
  const stale = await app.inject({ method: 'POST', url: `/v1/social/circles/${circle.id}/delete`, headers: owner.headers, payload: { expected_revision: circle.revision } });
  assert.equal(stale.statusCode, 401); assert.equal(stale.headers['www-authenticate'], 'Bearer');
});

test('Social HTTP rejects unsupported shapes, identifiers, revisions and oversized bodies before policy mutation', integration, async (t) => {
  const { app, actor, id, social } = await fixture(t);
  const owner = await actor('owner'); const operationKey = await id();
  const circle = await social.createCircle(owner.value, await id());
  const cases = [
    { url: '/v1/social/circles', payload: { operation_key: operationKey, owner: owner.value.participantId } },
    { url: '/v1/social/circles', payload: { operation_key: randomUUID() } },
    { url: '/v1/social/circles', payload: {} },
    { url: `/v1/social/circles/${randomUUID()}/delete`, payload: { expected_revision: '1' } },
    { url: `/v1/social/circles/${circle.id}/delete`, payload: { expected_revision: '9999999999999999999' } },
    { url: `/v1/social/circles/${circle.id}/delete`, payload: { expected_revision: 1 } },
    { url: '/v1/social/preview', payload: { sources: [{ type: 'CONVERSATION', id: operationKey, operation: 'INCLUDE' }] } },
    { url: '/v1/social/preview', payload: { sources: [{ type: 'USER', id: operationKey, operation: 'UNION' }] } },
    { url: '/v1/social/preview', payload: { sources: [{ type: 'USER', id: operationKey, operation: 'INCLUDE', participants: [owner.value.participantId] }] } },
  ];
  for (const value of cases) {
    const response = await app.inject({ method: 'POST', headers: owner.headers, ...value });
    assert.equal(response.statusCode, 400, JSON.stringify(value)); assert.deepEqual(response.json(), { error: 'invalid_request' });
  }
  const oversized = await app.inject({ method: 'POST', url: '/v1/social/preview', headers: owner.headers, payload: { sources: [], padding: 'x'.repeat(33_000) } });
  assert.equal(oversized.statusCode, 413);
  assert.equal((await social.circle(owner.value, circle.id)).revision, circle.revision);
});

test('Social HTTP preview and conversation creation expose camel-case pending metadata and reject stale revisions', integration, async (t) => {
  const { app, actor, id } = await fixture(t);
  const owner = await actor('owner');
  const sources = [{ type: 'USER', id: owner.value.participantId, operation: 'INCLUDE' }];
  const preview = await app.inject({ method: 'POST', url: '/v1/social/preview', headers: owner.headers, payload: { sources } });
  assert.equal(preview.statusCode, 200); assert.equal(preview.json().eligible[0].participantId, owner.value.participantId);
  const key = await id();
  const created = await app.inject({ method: 'POST', url: '/v1/social/conversations', headers: owner.headers, payload: { operation_key: key, sources } });
  assert.equal(created.statusCode, 200);
  const conversation = created.json<ConversationView>();
  assert.equal(conversation.memberState, 'PENDING'); assert.equal(conversation.sendGate, 'CLOSED');
  assert.equal(typeof conversation.createdAt, 'string'); assert.equal(conversation.members?.[0]?.participantId, owner.value.participantId);
  const replay = await app.inject({ method: 'POST', url: '/v1/social/conversations', headers: owner.headers, payload: { operation_key: key, sources } });
  assert.equal(replay.statusCode, 200); assert.equal(replay.json().id, conversation.id);
  const mutation = { method: 'POST' as const, url: `/v1/social/conversations/${conversation.id}/audience`, headers: owner.headers, payload: { expected_revision: conversation.revision, sources } };
  assert.equal((await app.inject(mutation)).statusCode, 200);
  const stale = await app.inject(mutation);
  assert.equal(stale.statusCode, 409); assert.deepEqual(stale.json(), { error: 'revision_conflict' });
});
