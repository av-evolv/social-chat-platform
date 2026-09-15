import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { IdentityStore } from '../src/identity/store.js';
import { OAuthAccessError } from '../src/oauth/index.js';
import { SocialStore } from '../src/social/store.js';
import type { SocialActor } from '../src/social/types.js';
import { SyncStore } from '../src/sync/store.js';
import { MessageStore } from '../src/messages/store.js';
import { SyncWakeHub } from '../src/sync/wake.js';
import { mountSync } from '../src/sync/index.js';
import type { SyncPage } from '../src/sync/types.js';

const databaseUrl = process.env.OAUTH_TEST_DATABASE_URL;
const integration = { skip: !databaseUrl, timeout: 30_000 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const suffix = randomBytes(6).toString('hex');
  const socialSchema = `sync_social_${suffix}`, identitySchema = `sync_identity_${suffix}`, syncSchema = `sync_http_${suffix}`, messageSchema = `sync_message_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const app = Fastify();
  t.after(async () => { await app.close(); try { for (const schema of [messageSchema,syncSchema,socialSchema,identitySchema]) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); } });
  let social: SocialStore; let sync: SyncStore; let messages: MessageStore;
  const identity = new IdentityStore(pool,{ schema:identitySchema,onPrincipalChange:(db,pid) => social.invalidateParticipant(db,pid) });
  await identity.migrate();
  social = new SocialStore(pool,{ schema:socialSchema,identitySchema,assertOAuth:async () => {},onPolicyChange:(db,pids) => sync.invalidate(db,pids) });
  await social.migrate();
  sync = new SyncStore(pool,social,{ schema:syncSchema,cursorKeys:['a'.repeat(64)],binding:a => `test-grant:${a.sessionId}`,resources:{
    snapshot:async (db,a,max) => [...await social.syncSnapshot(db,a,max),...await messages.snapshot(db,a,max)],
    read:(db,a,ref) => messages.read(db,a,ref),
    visible:(db,a,r) => r.type === 'message' ? messages.visible(db,a,r) : social.syncVisible(db,a,r),
  } });
  await sync.migrate();
  messages = new MessageStore(pool,social,sync,{ schema:messageSchema,admission:(db,a,r) => social.assertContentAccess(db,a,r.conversationId) });
  await messages.migrate();
  const wake = new SyncWakeHub(pool,sync.channel);
  const actors = new Map<string,SocialActor>();
  await mountSync(app,{ authorize:async (req,scopes) => {
    const a = actors.get(req.headers.authorization ?? '');
    if (!a) throw new OAuthAccessError(401,'invalid_token');
    if (scopes.some(s => !a.scopes.includes(s))) throw new OAuthAccessError(403,'insufficient_scope');
    return a;
  } },sync,messages,wake);
  await wake.start();
  async function actor(label: string, scopes = ['sync:read','circles:read','circles:write','conversations:read','conversations:write','messages:read','messages:write']) {
    const participantId = await identity.newId();
    const session = await identity.register({ accountId:await identity.newId(),participantId,emailHash:hash(label),emailCiphertext:`test:${label}`,
      credential:{ id:`credential:${label}`,publicKey:new Uint8Array([1,2,3]),counter:0,transports:['internal'] },deviceName:label,deviceHash:hash(`device:${label}`),sessionHash:hash(`session:${label}`) });
    const value: SocialActor = { ...session,participantId,scopes,clientId:'test-client' };
    const headers = { authorization:`Bearer ${label}` }; actors.set(headers.authorization,value);
    return { value,headers };
  }
  return { app,pool,identity,social,sync,wake,actor,id:() => identity.newId(),identitySchema,syncSchema };
}

test('Sync HTTP scopes metadata, resets on policy changes, and keeps production messages closed',integration,async t => {
  const f = await fixture(t); const alice = await f.actor('alice'); const bob = await f.actor('bob'); const limited = await f.actor('limited',['sync:read']);
  assert.equal((await f.app.inject('/v1/sync')).statusCode,401);
  const noScope = await f.actor('no-scope',[]);
  assert.equal((await f.app.inject({url:'/v1/sync',headers:noScope.headers})).statusCode,403);
  let circle = await f.social.createCircle(alice.value,await f.id());
  const conversation = await f.social.createConversation(alice.value,await f.id(),[]);
  const initial = await f.app.inject({url:'/v1/sync?limit=1',headers:alice.headers});
  assert.equal(initial.statusCode,200); assert.equal(initial.headers['cache-control'],'no-store');
  const first = initial.json<SyncPage>(); assert.equal(first.mode,'snapshot'); assert.equal(first.hasMore,true);
  const second = (await f.app.inject({url:`/v1/sync?after=${first.cursor}`,headers:alice.headers})).json<SyncPage>();
  assert.equal(second.hasMore,false); assert.deepEqual([...first.resources,...second.resources].map(r=>r.id).sort(),[circle.id,conversation.id].sort());
  assert.deepEqual((await f.sync.page(limited.value)).resources,[]);
  assert.deepEqual((await f.sync.page(bob.value)).resources,[]);
  circle = await f.social.inviteCircle(alice.value,circle.id,bob.value.participantId,circle.revision);
  const reset = await f.app.inject({url:`/v1/sync?after=${second.cursor}`,headers:alice.headers});
  assert.equal(reset.statusCode,409); assert.equal(reset.json().error,'sync_reset_required');
  const bobSnapshot = await f.sync.page(bob.value);
  assert.equal(bobSnapshot.resources.length,1); assert.equal((bobSnapshot.resources[0]!.data as { state: string }).state,'INVITED');
  await f.social.acceptCircle(bob.value,circle.id,circle.revision);
  await assert.rejects(f.sync.page(bob.value,{after:bobSnapshot.cursor}),{code:'sync_reset_required'});
  const denied = await f.app.inject({method:'POST',url:`/v1/conversations/${conversation.id}/messages`,headers:alice.headers,payload:{id:await f.id(),operation_key:await f.id(),generation:conversation.generation,crypto_epoch:'0',envelope_version:1,ciphertext:'YWJj'}});
  assert.equal(denied.statusCode,409); assert.equal(denied.json().error,'crypto_not_ready');
  const before = await f.sync.page(alice.value);
  await f.social.setAudience(alice.value,conversation.id,[{type:'USER',id:alice.value.participantId,operation:'INCLUDE'}],conversation.revision);
  await assert.rejects(f.sync.page(alice.value,{after:before.cursor}),{code:'sync_reset_required'});
  await f.identity.logout(alice.value);
  assert.equal((await f.app.inject({url:`/v1/sync?after=${before.cursor}`,headers:alice.headers})).statusCode,401);
});

test('Sync deletion and alias invalidation cannot resurrect prior snapshots',integration,async t => {
  const f = await fixture(t); const alice = await f.actor('alice');
  const one = await f.social.createCircle(alice.value,await f.id());
  await f.social.createCircle(alice.value,await f.id());
  const before = await f.sync.page(alice.value,{limit:1}); assert.equal(before.hasMore,true);
  await f.social.deleteCircle(alice.value,one.id,one.revision);
  await assert.rejects(f.sync.page(alice.value,{after:before.cursor}),{code:'sync_reset_required'});
  const fresh = await f.sync.page(alice.value); assert.equal(fresh.resources.some(r=>r.id===one.id),false);
  // Trusted fixture models the already-verified alias-binding transaction from #7.
  await f.social.withPolicy(alice.value,async db => {
    const alias = (await db.query(`INSERT INTO ${f.identitySchema}.participants DEFAULT VALUES RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO ${f.identitySchema}.participant_aliases VALUES($1,$2)`,[alias,alice.value.participantId]);
    await f.social.invalidateParticipant(db,alias);
  });
  await assert.rejects(f.sync.page(alice.value,{after:fresh.cursor}),{code:'sync_reset_required'});
});

test('Long-poll HTTP wakes on committed metadata, rechecks identity, and bounds untrusted requests',integration,async t => {
  const f = await fixture(t); const alice = await f.actor('alice');
  const initial = await f.sync.page(alice.value);
  const wait = f.app.inject({url:`/v1/sync?after=${initial.cursor}&wait=2`,headers:alice.headers});
  // inject starts upon consumption; let the first request reserve its interest.
  const result = Promise.resolve(wait);
  await new Promise(resolve=>setTimeout(resolve,50));
  await f.social.createCircle(alice.value,await f.id());
  assert.equal((await result).statusCode,409);
  const current = await f.sync.page(alice.value);
  const revoked = Promise.resolve(f.app.inject({url:`/v1/sync?after=${current.cursor}&wait=2`,headers:alice.headers}));
  await new Promise(resolve=>setTimeout(resolve,50));
  await f.identity.logout(alice.value);
  assert.equal((await revoked).statusCode,401);
  const bob = await f.actor('bob');
  for (const query of ['wait=1','wait=26','limit=0','limit=101','limit=1&limit=2','after=x&wait=-1','access_token=secret']) {
    const response = await f.app.inject({url:`/v1/sync?${query}`,headers:bob.headers}); assert.equal(response.statusCode,400,query);
  }
  const oversized = await f.app.inject({method:'POST',url:`/v1/conversations/${await f.id()}/messages`,headers:bob.headers,payload:{ciphertext:'A'.repeat(100_000)}});
  assert.equal(oversized.statusCode,413); assert.equal(oversized.headers['cache-control'],'no-store');
});
