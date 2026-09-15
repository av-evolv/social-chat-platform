import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SocialActor } from '../social/types.js';
import { SyncError } from './types.js';

export interface CursorState {
  version: 1; binding: string; auth: string; global: string; retention: string;
  position: string; high: string; expires: number; snapshot?: string; offset?: number;
}
const integer = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
export class CursorCodec {
  private readonly keys: Buffer[];
  constructor(keys: string[]) {
    if (!keys.length || keys.some((key) => !key)) throw new Error('Cursor keys are required');
    this.keys = keys.map((key) => createHash('sha256').update('larynx:sync:cursor:v1\0').update(key).digest());
  }
  binding(actor: SocialActor, grant: string): string {
    return createHash('sha256').update(JSON.stringify([actor.accountId, actor.participantId, actor.clientId,
      actor.deviceId, actor.sessionId, [...new Set(actor.scopes)].sort(), grant])).digest('base64url');
  }
  encode(value: CursorState): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[0]!, iv);
    cipher.setAAD(Buffer.from('larynx:sync:cursor:v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }
  decode(token: string, binding: string): CursorState {
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new SyncError(400, 'invalid_cursor');
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== token) throw new SyncError(400, 'invalid_cursor');
    for (const key of this.keys) {
      let value: CursorState;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from('larynx:sync:cursor:v1'));
        decipher.setAuthTag(bytes.subarray(12, 28));
        value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as CursorState;
      } catch { continue; }
      if (!value || value.version !== 1 || value.binding !== binding || !integer(value.auth) || !integer(value.global)
        || !integer(value.retention) || !integer(value.position) || !integer(value.high) || BigInt(value.position) > BigInt(value.high)
        || !Number.isSafeInteger(value.expires) || (value.snapshot !== undefined && (typeof value.snapshot !== 'string'
          || !/^[0-9a-f-]{36}$/.test(value.snapshot) || !Number.isSafeInteger(value.offset) || value.offset! < 0))) {
        throw new SyncError(400, 'invalid_cursor');
      }
      if (value.expires <= Date.now()) throw new SyncError(410, 'cursor_expired');
      return value;
    }
    throw new SyncError(400, 'invalid_cursor');
  }
}
