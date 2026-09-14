import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey } from 'node:crypto';
import type { ClientMetadata, JWKS } from 'oidc-provider';

export const API_SCOPES = [
  'profile:read', 'profile:write', 'circles:read', 'circles:write',
  'conversations:read', 'conversations:write', 'messages:read', 'messages:write',
  'events:read', 'events:write', 'media:read', 'media:write', 'sync:read',
] as const;

export interface ApprovedClient extends ClientMetadata {
  allowedScopes: string[];
  origins: string[];
}
export interface OAuthConfig {
  issuer: string;
  resource: string;
  mode: 'local' | 'production';
  jwks: JWKS;
  cookieKeys: string[];
  clients: ApprovedClient[];
  trustProxy?: boolean;
}
const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
const fail = (field: string): never => { throw new Error(`Invalid OAuth configuration: ${field}`); };
function json(value: string | undefined, field: string): unknown {
  try { if (!value) return fail(field); return JSON.parse(value); } catch { return fail(field); }
}

export function readOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const mode = env.OAUTH_MODE ?? 'production';
  if (mode !== 'local' && mode !== 'production') fail('OAUTH_MODE');
  let issuer: URL; let resource: URL;
  try {
    issuer = new URL(env.OAUTH_ISSUER ?? '');
    resource = new URL(env.OAUTH_RESOURCE ?? '');
  } catch { return fail('issuer/resource URL'); }
  if (issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/oidc') fail('OAUTH_ISSUER');
  if (resource.username || resource.password || resource.search || resource.hash || resource.origin !== issuer.origin || resource.pathname !== '/api') fail('OAUTH_RESOURCE');
  if (mode === 'production' ? issuer.protocol !== 'https:' || loopback(issuer.hostname) : issuer.protocol !== 'http:' || !loopback(issuer.hostname)) fail('issuer transport');
  if (env.OAUTH_TRUST_PROXY && !['true', 'false'].includes(env.OAUTH_TRUST_PROXY)) fail('OAUTH_TRUST_PROXY');
  if (mode === 'local' && env.OAUTH_TRUST_PROXY === 'true') fail('local proxy');

  const jwks = json(env.OAUTH_JWKS, 'OAUTH_JWKS') as JWKS;
  if (!jwks || !Array.isArray(jwks.keys) || !jwks.keys.length) fail('OAUTH_JWKS');
  const kids = new Set();
  for (const key of jwks.keys) {
    if (!key || typeof key !== 'object' || !('kty' in key) || key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' || !key.kid || kids.has(key.kid) || !('d' in key) || !key.d) fail('signing key');
    try {
      const privateKey = createPrivateKey({ key: key as JsonWebKey, format: 'jwk' });
      if ((privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail('signing key');
      const challenge = Buffer.from('Larynx signing-key configuration validation');
      if (!verify('sha256', challenge, createPublicKey(privateKey), sign('sha256', challenge, privateKey))) fail('signing key');
    } catch { fail('signing key'); }
    kids.add(key.kid);
  }
  const cookieKeys = json(env.OAUTH_COOKIE_KEYS, 'OAUTH_COOKIE_KEYS') as string[];
  if (!Array.isArray(cookieKeys) || !cookieKeys.length || cookieKeys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(key)) || new Set(cookieKeys).size !== cookieKeys.length) fail('cookie keys');
  const clients = json(env.OAUTH_CLIENTS, 'OAUTH_CLIENTS') as ApprovedClient[];
  if (!Array.isArray(clients) || clients.length > 100) fail('clients');
  const ids = new Set();
  for (const client of clients) {
    if (!client || typeof client.client_id !== 'string' || !client.client_id || ids.has(client.client_id)) fail('client ID');
    ids.add(client.client_id);
    if (!Array.isArray(client.allowedScopes) || client.allowedScopes.some(s => !API_SCOPES.includes(s as typeof API_SCOPES[number]))) fail('client scopes');
    if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.length) fail('redirect URIs');
    if (!['none', 'client_secret_basic'].includes(client.token_endpoint_auth_method ?? '')) fail('client authentication');
    if (client.token_endpoint_auth_method === 'none' && client.client_secret !== undefined) fail('public client secret');
    if (client.token_endpoint_auth_method === 'client_secret_basic' && (typeof client.client_secret !== 'string' || client.client_secret.length < 32)) fail('confidential client secret');
    if (JSON.stringify(client.response_types) !== '["code"]' || !Array.isArray(client.grant_types) || !client.grant_types.includes('authorization_code') || client.grant_types.some(g => !['authorization_code', 'refresh_token'].includes(g))) fail('client grants');
    for (const uri of client.redirect_uris!) {
      let url: URL;
      try { url = new URL(uri); } catch { return fail('redirect URI'); }
      const native = client.application_type === 'native' && (url.protocol === 'larynx:' || /^[a-z][a-z0-9+-]*\.[a-z0-9.+-]+:$/.test(url.protocol));
      const local = mode === 'local' && url.protocol === 'http:' && loopback(url.hostname);
      if (url.hash || url.username || url.password || uri.includes('*') || !(url.protocol === 'https:' || native || local)) fail('redirect URI');
    }
    if (!Array.isArray(client.origins) || client.origins.some(origin => {
      try { const url = new URL(origin); return url.origin !== origin || !(url.protocol === 'https:' || mode === 'local' && url.protocol === 'http:' && loopback(url.hostname)); } catch { return true; }
    })) fail('client origins');
  }
  return { issuer: issuer.href, resource: resource.href, mode: mode as OAuthConfig['mode'], jwks, cookieKeys, clients, trustProxy: env.OAUTH_TRUST_PROXY === 'true' };
}
