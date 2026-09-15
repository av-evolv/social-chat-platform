// Explicit local configuration only. Preserve account keys on repeated runs.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const oauthPath = '.env.oauth';
let oauth = await readFile(oauthPath, 'utf8');
if (!/^OAUTH_MODE='local'$/m.test(oauth)) throw new Error('Account bootstrap requires local OAuth configuration');
const port = process.env.API_PORT ?? '3000';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid API_PORT');
// WebAuthn RP IDs require a hostname. Upgrade only the generated loopback issuer;
// explicit custom issuer/client configurations must be reviewed by the operator.
for (const [name, path] of [['OAUTH_ISSUER', 'oidc'], ['OAUTH_RESOURCE', 'api']]) {
  const pattern = new RegExp(`^${name}='http://(?:127\\.0\\.0\\.1|localhost):${port}/${path}'$`, 'm');
  if (!pattern.test(oauth)) throw new Error('Review local OAuth issuer/resource before configuring accounts');
  oauth = oauth.replace(pattern, `${name}='http://localhost:${port}/${path}'`);
}
const clientsMatch = oauth.match(/^OAUTH_CLIENTS='([^'\n]+)'$/m);
if (!clientsMatch) throw new Error('Review local OAuth clients before configuring accounts');
const clients = JSON.parse(clientsMatch[1]);
for (const client of clients) {
  if (['larynx-web', 'larynx-native'].includes(client.client_id)) client.allowedScopes = [...new Set([...client.allowedScopes, 'profile:write'])];
}
oauth = oauth.replace(clientsMatch[0], `OAUTH_CLIENTS='${JSON.stringify(clients)}'`);
await writeFile(oauthPath, oauth, { mode: 0o600 });
try {
  await readFile('.env.accounts');
  console.log('Keeping existing account keys and mail configuration.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const fields = { IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), IDENTITY_LOOKUP_KEY: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: process.env.MAILPIT_SMTP_PORT ?? '1025', SMTP_FROM: 'accounts@larynx.test' };
  if (!/^\d+$/.test(fields.SMTP_PORT) || Number(fields.SMTP_PORT) < 1 || Number(fields.SMTP_PORT) > 65535) throw new Error('Invalid SMTP port');
  await writeFile('.env.accounts', Object.entries(fields).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Created private local account keys and Mailpit configuration.');
}
console.log('Local OAuth issuer is localhost; Larynx clients can request profile:write with consent.');
