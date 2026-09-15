import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { OAuthConfig } from '../oauth/config.js';

export interface IdentityConfig {
  origin: string; rpId: string; mode: 'local' | 'production';
  encryptionKey: Buffer; lookupKey: Buffer;
  smtp: { host: string; port: number; secure: boolean; user?: string | undefined; password?: string | undefined; from: string };
}
export function canonicalEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254) throw new Error('Invalid email');
  const email = value.trim();
  const parts = email.split('@');
  const local = parts[0] ?? ''; const domain = parts[1] ?? '';
  if (parts.length !== 2 || !local || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domain)) throw new Error('Invalid email');
  // Preserve local-part case, dots and plus tags; no provider-specific folding.
  return `${local}@${domain.toLowerCase()}`;
}
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
export const secret = () => randomBytes(32).toString('base64url');
export function keyed(config: IdentityConfig, purpose: string, value: string) {
  return createHmac('sha256', config.lookupKey).update(JSON.stringify([purpose, value])).digest('base64url');
}
export function protectEmail(config: IdentityConfig, email: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  cipher.setAAD(Buffer.from('larynx:identity:email:v1'));
  const ciphertext = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function revealEmail(config: IdentityConfig, value: string) {
  const [version, iv, tag, ciphertext, extra] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra) throw new Error('Invalid protected identity');
  const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from('larynx:identity:email:v1')); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
export function readIdentityConfig(oauth: OAuthConfig, env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const fail = (): never => { throw new Error('Invalid account configuration'); };
  const readKey = (name: string) => {
    const value = env[name];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return fail();
    const key = Buffer.from(value, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== value) return fail();
    return key;
  };
  const encryptionKey = readKey('IDENTITY_ENCRYPTION_KEY'); const lookupKey = readKey('IDENTITY_LOOKUP_KEY');
  if (encryptionKey.equals(lookupKey)) fail();
  const issuer = new URL(oauth.issuer);
  if (oauth.mode === 'local' ? issuer.hostname !== 'localhost' : !/^[a-z0-9.-]+$/.test(issuer.hostname) || /^\d+(\.\d+){3}$/.test(issuer.hostname)) fail();
  const host = env.SMTP_HOST ?? ''; const port = Number(env.SMTP_PORT);
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) fail();
  if (oauth.mode === 'local' ? !['localhost', '127.0.0.1', 'mailpit'].includes(host) : !env.SMTP_USER || !env.SMTP_PASSWORD || ![465, 587].includes(port)) fail();
  let from: string; try { from = canonicalEmail(env.SMTP_FROM); } catch { return fail(); }
  return { origin: issuer.origin, rpId: issuer.hostname, mode: oauth.mode, encryptionKey, lookupKey,
    smtp: { host, port, secure: oauth.mode === 'production' && port === 465, from, user: env.SMTP_USER, password: env.SMTP_PASSWORD } };
}
