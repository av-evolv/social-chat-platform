import { SyncProtocolError, type MetadataResource, type SyncPage } from './types';
export interface SyncCache { cursor?: string; installed: boolean; visible: ReadonlyMap<string, MetadataResource>; staging?: ReadonlyMap<string, MetadataResource>; stagedBytes: number }
export const emptySyncCache = (): SyncCache => ({ installed: false, visible: new Map(), stagedBytes: 0 });
export const resetSyncCache = emptySyncCache;
export function applySyncPage(cache: SyncCache, page: SyncPage, expectedCursor: string | undefined): SyncCache {
  if (cache.cursor !== expectedCursor || page.cursor === expectedCursor) throw new SyncProtocolError('Unexpected cursor');
  if (page.mode === 'delta' && (!cache.installed || cache.staging) || page.mode === 'snapshot' && cache.installed) throw new SyncProtocolError('Unexpected sync mode');
  const next = new Map(page.mode === 'snapshot' ? cache.staging : cache.visible);
  for (const resource of page.resources) {
    if (resource.type === 'message') continue;
    const key = `${resource.type}:${resource.id}`, previous = next.get(key);
    if (!previous || BigInt(resource.revision) > BigInt(previous.revision)) next.set(key, JSON.parse(JSON.stringify(resource)) as MetadataResource);
  }
  const stagedBytes = page.mode === 'snapshot' ? cache.stagedBytes + new TextEncoder().encode(JSON.stringify(page.resources)).length : 0;
  const visibleBytes = new TextEncoder().encode(JSON.stringify([...next.values()])).length;
  if (next.size > 2000 || stagedBytes > 2 * 1024 * 1024 || visibleBytes > 2 * 1024 * 1024) throw new SyncProtocolError('Sync cache capacity exceeded');
  if (page.mode === 'snapshot' && page.hasMore) return { ...cache, cursor: page.cursor, staging: next, stagedBytes };
  return { cursor: page.cursor, visible: next, installed: true, stagedBytes: 0 };
}
