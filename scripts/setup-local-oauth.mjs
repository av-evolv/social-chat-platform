// Explicit local-only bootstrap: persistent secrets, never generated on API boot.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
const file = '.env.oauth';
try {
  await readFile(file);
  console.log('.env.oauth already exists; keeping its signing keys and clients.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const port = process.env.API_PORT ?? '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid API_PORT');
  const origin = `http://127.0.0.1:${port}`;
  const webPort = process.env.WEB_PORT ?? '8088';
  if (!/^\d+$/.test(webPort) || Number(webPort) < 1 || Number(webPort) > 65535) throw new Error('Invalid WEB_PORT');
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const fields = {
    OAUTH_MODE: 'local', OAUTH_ISSUER: `${origin}/oidc`, OAUTH_RESOURCE: `${origin}/api`,
    OAUTH_JWKS: JSON.stringify({ keys: [{ ...key, alg: 'RS256', use: 'sig', kid: randomBytes(16).toString('hex') }] }),
    OAUTH_COOKIE_KEYS: JSON.stringify([randomBytes(32).toString('base64url')]),
    OAUTH_CLIENTS: JSON.stringify([
      { client_id: 'larynx-web', client_name: 'Larynx web', redirect_uris: [`${webOrigin}/oauth/callback`], response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', allowedScopes: ['profile:read'], origins: [webOrigin] },
      { client_id: 'larynx-native', client_name: 'Larynx native', application_type: 'native', redirect_uris: ['larynx://oauth/callback'], response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', allowedScopes: ['profile:read'], origins: [] },
    ]),
  };
  // Generated values contain no single quotes/newlines; quote JSON for dotenv/Compose.
  await writeFile(file, Object.entries(fields).map(([name, value]) => `${name}='${value}'`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Created local-only .env.oauth with persistent signing keys. Run npm run accounts:setup before starting the account service.');
}
