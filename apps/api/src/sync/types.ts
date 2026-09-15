import type { PoolClient } from 'pg';
import type { SocialActor } from '../social/types.js';

export interface ChangeRef { type: 'message'; id: string; revision: string; kind: 'upsert' | 'delete' }
export interface SyncResource { type: 'circle' | 'conversation' | 'message'; id: string; revision: string; data: unknown }
export interface SyncResources {
  snapshot(db: PoolClient, actor: SocialActor, maximum: number): Promise<SyncResource[]>;
  /** Current authorization, but exact immutable revision; undefined means filtered. */
  read(db: PoolClient, actor: SocialActor, ref: ChangeRef): Promise<SyncResource | undefined>;
  /** Recheck visibility/deletion only; never substitute current data into a snapshot. */
  visible(db: PoolClient, actor: SocialActor, resource: SyncResource): Promise<boolean>;
}
export interface SyncPage { mode: 'snapshot' | 'delta'; resources: SyncResource[]; cursor: string; hasMore: boolean }
export interface ChangeWriter {
  append(db: PoolClient, recipients: string[], changes: ChangeRef[]): Promise<void>;
  invalidate(db: PoolClient, participants: string[]): Promise<void>;
}
export class SyncError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 503, public readonly code: string) { super(code); }
}
