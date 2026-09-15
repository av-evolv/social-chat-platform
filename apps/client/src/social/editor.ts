import type { Source } from './types';

export function sourceFingerprint(sources: Source[]): string {
  return JSON.stringify(sources.map(source => `${source.type}:${source.id.toLowerCase()}:${source.operation}`).sort());
}

export function addSource(sources: Source[], type: 'USER' | 'CIRCLE', id: string, operation: Source['operation']): Source[] {
  const normalized = id.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) throw new Error('Enter a complete contact or circle code.');
  const source = { type, id: normalized, operation };
  return sources.some(value => value.type === type && value.id === normalized && value.operation === operation) ? sources : [...sources, source];
}

// Fresh UUIDv7 request identity. Retain it across retries of the same creation.
export function operationKey(now: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48 || random.length !== 16) throw new Error('Invalid request identity input');
  const bytes = new Uint8Array(random);
  let time = now;
  for (let index = 5; index >= 0; index--) { bytes[index] = time % 256; time = Math.floor(time / 256); }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
