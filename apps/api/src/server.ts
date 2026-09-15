import { Pool } from 'pg';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { readOAuthConfig } from './oauth/config.js';
import { createOAuth } from './oauth/index.js';
import { createIdentity } from './identity/index.js';
import { readIdentityConfig } from './identity/config.js';

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
  const identity = await createIdentity(pool, identityConfig, oauthConfig, {
    onPrincipalChange: (db, participantId) => social.invalidateParticipant(db, participantId),
  });
  const oauth = await createOAuth(pool, oauthConfig, identity.directory, { loginPath: '/account/login' });
  social = new SocialStore(pool, { assertOAuth: oauth.assertTransaction });
  await social.migrate();
  const invitations = new InvitationStore(pool,social,identityConfig);
  await invitations.migrate();
  await oauth.mount(app);
  await identity.mount(app, oauth);
  await mountSocial(app, oauth, social);
  const frontend = oauthConfig.clients.find(client => client.client_id === 'larynx-web')?.redirect_uris?.[0] ?? identityConfig.origin;
  await mountInvitations(app,oauth,invitations,createInvitationMailer(identityConfig,frontend));
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error('API failed to start');
  process.exitCode = 1;
  await shutdown();
}
