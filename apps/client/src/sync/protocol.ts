import type { Circle, Conversation } from '../social/types';
import { SyncProtocolError, type SyncPage, type SyncResource } from './types';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimal = /^[1-9][0-9]{0,19}$/;
function assert(value: unknown): asserts value { if (!value) throw new SyncProtocolError('Invalid sync response'); }
function object(value: unknown): Record<string, unknown> { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, allowed: string[]) { assert(Object.keys(value).every(key => allowed.includes(key))); }
function id(value: unknown) { assert(typeof value === 'string' && uuid.test(value)); }
function revision(value: unknown) { assert(typeof value === 'string' && decimal.test(value)); }
function date(value: unknown) { assert(typeof value === 'string' && value.length <= 32 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))); }
function one(value: unknown, values: string[]) { assert(typeof value === 'string' && values.includes(value)); }
function list(value: unknown, visit: (item: unknown) => void, maximum = 2000) { assert(Array.isArray(value) && value.length <= maximum); value.forEach(visit); }
const role = (value: unknown) => one(value, ['OWNER', 'ADMIN', 'MEMBER']);
function source(value: unknown) { const v = object(value); keys(v, ['type', 'id', 'operation']); id(v.id); one(v.type, ['USER', 'CIRCLE', 'EVENT']); one(v.operation, ['INCLUDE', 'EXCLUDE']); }
function metadata(type: 'circle' | 'conversation', value: unknown): Circle | Conversation {
  const v = object(value); id(v.id); revision(v.revision); date(v.createdAt);
  if (type === 'circle') {
    keys(v, ['id', 'revision', 'createdAt', 'role', 'state', 'members']); role(v.role); one(v.state, ['INVITED', 'ACTIVE', 'LEFT', 'REMOVED']);
    if (v.members !== undefined) list(v.members, item => { const m = object(item); keys(m, ['participantId', 'role', 'state']); id(m.participantId); role(m.role); one(m.state, ['INVITED', 'ACTIVE', 'LEFT', 'REMOVED']); });
  } else {
    one(v.sendGate, ['CLOSED']); one(v.memberState, ['PENDING', 'LEFT']);
    if (v.memberState === 'LEFT') keys(v, ['id', 'revision', 'createdAt', 'memberState', 'sendGate']);
    else {
      keys(v, ['id', 'revision', 'createdAt', 'generation', 'role', 'memberState', 'orphaned', 'sendGate', 'sources', 'members']); revision(v.generation); role(v.role); assert(typeof v.orphaned === 'boolean');
      if (v.sources !== undefined) list(v.sources, source);
      if (v.members !== undefined) list(v.members, item => { const m = object(item); keys(m, ['participantId', 'role', 'state', 'intervalId', 'provenance']); id(m.participantId); id(m.intervalId); role(m.role); one(m.state, ['PENDING']); list(m.provenance, source); });
    }
  }
  return JSON.parse(JSON.stringify(v)) as Circle | Conversation;
}
function resource(value: unknown): SyncResource {
  const v = object(value); keys(v, ['type', 'id', 'revision', 'data']); id(v.id); revision(v.revision); one(v.type, ['circle', 'conversation', 'message']);
  const data = object(v.data); assert(data.id === v.id && data.revision === v.revision);
  if (v.type === 'message') {
    id(data.conversationId); assert(typeof data.deleted === 'boolean');
    if (!data.deleted) { id(data.authorId); id(data.authorDeviceId); id(data.senderDeviceId); revision(data.generation); assert(data.cryptoEpoch === '0' || typeof data.cryptoEpoch === 'string' && decimal.test(data.cryptoEpoch)); assert(data.envelopeVersion === 1); date(data.createdAt); date(data.updatedAt); assert(typeof data.ciphertext === 'string' && data.ciphertext.length <= 87384 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.ciphertext) && data.ciphertext.length > 0); }
    return { type: 'message', id: v.id as string, revision: v.revision as string, data: null };
  }
  return { type: v.type, id: v.id, revision: v.revision, data: metadata(v.type as 'circle' | 'conversation', data) } as SyncResource;
}
export function parseSyncPage(value: unknown): SyncPage {
  let encoded: string; try { encoded = JSON.stringify(value); } catch { throw new SyncProtocolError('Invalid sync response'); }
  assert(typeof encoded === 'string' && new TextEncoder().encode(encoded).length <= 512 * 1024);
  const v = object(value); keys(v, ['mode', 'resources', 'cursor', 'hasMore']); one(v.mode, ['snapshot', 'delta']); assert(typeof v.cursor === 'string' && v.cursor.length > 0 && v.cursor.length <= 4096); assert(typeof v.hasMore === 'boolean'); assert(Array.isArray(v.resources) && v.resources.length <= 100);
  return { mode: v.mode as SyncPage['mode'], resources: v.resources.map(resource), cursor: v.cursor, hasMore: v.hasMore };
}
