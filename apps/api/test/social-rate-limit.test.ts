import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { mountSocial } from '../src/social/index.js';
import type { SocialStore } from '../src/social/store.js';
import { OAuthAccessError } from '../src/oauth/index.js';

test('Social rate limit spans routes and rejects before authorization regardless of forwarded headers', async t => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/health/live', async () => ({ status:'ok' }));
  app.get('/account/login', async () => ({ status:'issuer' }));
  let authorizations = 0;
  await mountSocial(app, { authorize: async () => { authorizations++; throw new OAuthAccessError(401,'invalid_token'); } }, {} as SocialStore);
  for (let i = 0; i < 120; i++) {
    const response = await app.inject({ url: i % 2 ? '/v1/social/circles' : '/v1/social/conversations', remoteAddress: '192.0.2.1' });
    assert.equal(response.statusCode, 401);
  }
  const limited = await app.inject({ url: '/v1/social/circles', remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for':'192.0.2.2' } });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), { error:'too_many_requests' });
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(authorizations, 120);
  for (const url of ['/health/live','/account/login']) assert.equal((await app.inject({url,remoteAddress:'192.0.2.1'})).statusCode,200);
  const other = await app.inject({ url:'/v1/social/circles', remoteAddress:'192.0.2.3' });
  assert.equal(other.statusCode,401);
  assert.equal(authorizations,121);
});
