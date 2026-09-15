import { Pool } from 'pg';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { readOAuthConfig } from './oauth/config.js';
import { createOAuth } from './oauth/index.js';
import { createIdentity } from './identity/index.js';
import { readIdentityConfig, keyed } from './identity/config.js';

import { SyncStore } from './sync/store.js';
import { MessageStore } from './messages/store.js';
import { SyncWakeHub } from './sync/wake.js';
import { mountSync } from './sync/index.js';
import { SocialStore } from './social/store.js';
import { mountSocial } from './social/index.js';
import { InvitationStore } from './invitations/store.js';
import { mountInvitations } from './invitations/index.js';
import { createInvitationMailer } from './invitations/mail.js';

const config = readConfig();
const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 3_000,
  query_timeout: 3_000,
  statement_timeout: 3_000,
  idleTimeoutMillis: 30_000,
  max: 10,
});
const app = buildApp(pool, { logger: true });

// pg emits errors from idle connections outside a request's promise chain.
pool.on('error', () => {
  app.log.error('An idle database connection failed');
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } catch {
    app.log.error('API shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  const oauthConfig = readOAuthConfig();
  const identityConfig = readIdentityConfig(oauthConfig);
  let social: SocialStore;
  let sync: SyncStore;
  let messages: MessageStore;
  const identity = await createIdentity(pool, identityConfig, oauthConfig, {
    onPrincipalChange: (db, participantId) => social.invalidateParticipant(db, participantId),
  });
  const oauth = await createOAuth(pool, oauthConfig, identity.directory, { loginPath: '/account/login' });
  social = new SocialStore(pool, { assertOAuth: oauth.assertTransaction, onPolicyChange: (db, participants) => sync.invalidate(db,participants) });
  await social.migrate();
  sync = new SyncStore(pool,social,{ cursorKeys: oauthConfig.cookieKeys, binding: oauth.syncBinding, resources: {
    snapshot: async (db,actor,maximum) => {
      const metadata = await social.syncSnapshot(db,actor,maximum);
      if (metadata.length > maximum) return metadata;
      return [...metadata,...await messages.snapshot(db,actor,maximum - metadata.length,2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(metadata)) - 1)];
    },
    read: (db,actor,ref) => messages.read(db,actor,ref),
    visible: (db,actor,resource) => resource.type === 'message' ? messages.visible(db,actor,resource) : social.syncVisible(db,actor,resource),
  } });
  await sync.migrate();
  messages = new MessageStore(pool,social,sync,{ admission: (db,actor,request) => social.assertContentAccess(db,actor,request.conversationId) });
  await messages.migrate();
  const wake = new SyncWakeHub(pool,sync.channel);
  const invitations = new InvitationStore(pool,social,identityConfig);
  await invitations.migrate();
  await oauth.mount(app);
  await identity.mount(app, oauth);
  await mountSocial(app, oauth, social);
  const frontend = oauthConfig.clients.find(client => client.client_id === 'larynx-web')?.redirect_uris?.[0] ?? identityConfig.origin;
  await mountInvitations(app,oauth,invitations,createInvitationMailer(identityConfig,frontend),async email => (await identity.store.findIdentity(keyed(identityConfig,'email',email)))?.locale);
  // Register shutdown before attempting LISTEN, including partial-startup cleanup.
  await mountSync(app,oauth,sync,messages,wake);
  await wake.start();
  let maintenance: Promise<void> | undefined;
  const runMaintenance = () => {
    if (maintenance) return;
    maintenance = sync.compact().catch(() => { app.log.warn('Sync retention maintenance failed'); }).finally(() => { maintenance = undefined; });
  };
  const maintenanceTimer = setInterval(runMaintenance,60_000);
  maintenanceTimer.unref();
  app.addHook('preClose',async () => { clearInterval(maintenanceTimer); await maintenance; });
  runMaintenance();
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error('API failed to start');
  process.exitCode = 1;
  await shutdown();
}
