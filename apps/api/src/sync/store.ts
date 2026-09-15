import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SocialStore } from '../social/store.js';
import type { SocialActor } from '../social/types.js';
import { CursorCodec, type CursorState } from './cursor.js';
import { SyncError, type ChangeRef, type SyncPage, type SyncResource, type SyncResources } from './types.js';

export const SYNC_LIMITS = Object.freeze({ recipients: 256, snapshotResources: 2000, snapshotBytes: 2 * 1024 * 1024,
  pageScans: 100, pageBytes: 512 * 1024, snapshotMs: 5 * 60 * 1000, cursorMs: 7 * 24 * 60 * 60 * 1000 });
interface Stream { position: string; auth_generation: string; retention_generation: string }
interface Options { schema?: string; cursorKeys: string[]; binding: (actor: SocialActor) => string; resources: SyncResources }
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Domain callers must use their policy transaction and canonical recipient IDs. */
export class SyncStore {
  readonly channel: string;
  private readonly schema: string;
  private readonly codec: CursorCodec;
  constructor(private readonly pool: Pool, private readonly social: Pick<SocialStore, 'withPolicy'>, private readonly options: Options) {
    this.schema = options.schema ?? 'larynx_sync';
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(this.schema)) throw new Error('Invalid SQL identifier');
    this.channel = `${this.schema}_wake`;
    this.codec = new CursorCodec(options.cursorKeys);
  }
  async migrate(): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${this.schema}:migration`]);
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema};
        CREATE TABLE IF NOT EXISTS ${this.schema}.global_state (id boolean PRIMARY KEY DEFAULT true CHECK(id), generation bigint NOT NULL DEFAULT 0);
        INSERT INTO ${this.schema}.global_state(id) VALUES(true) ON CONFLICT DO NOTHING;
        CREATE TABLE IF NOT EXISTS ${this.schema}.streams (participant_id uuid PRIMARY KEY, position bigint NOT NULL DEFAULT 0,
          auth_generation bigint NOT NULL DEFAULT 0, retention_generation bigint NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS ${this.schema}.changes (participant_id uuid NOT NULL REFERENCES ${this.schema}.streams(participant_id),
          position bigint NOT NULL, reference jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(participant_id,position));
        CREATE INDEX IF NOT EXISTS changes_retention ON ${this.schema}.changes(created_at);
        CREATE TABLE IF NOT EXISTS ${this.schema}.snapshots (id uuid PRIMARY KEY, participant_id uuid NOT NULL,
          binding text NOT NULL, resources jsonb NOT NULL, expires_at timestamptz NOT NULL);
        CREATE INDEX IF NOT EXISTS snapshots_participant ON ${this.schema}.snapshots(participant_id);
        CREATE INDEX IF NOT EXISTS snapshots_expiry ON ${this.schema}.snapshots(expires_at);`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  private async ensure(db: PoolClient, participant: string): Promise<void> {
    await db.query(`INSERT INTO ${this.schema}.streams(participant_id) VALUES($1) ON CONFLICT DO NOTHING`, [participant]);
  }
  async append(db: PoolClient, recipients: string[], changes: ChangeRef[]): Promise<void> {
    const sorted = [...new Set(recipients)].sort();
    if (sorted.length > SYNC_LIMITS.recipients) throw new SyncError(413, 'sync_fanout_exceeded');
    if (!changes.length) return;
    for (const participant of sorted) {
      await this.ensure(db, participant);
      // Counter reservation and row references become visible together, only at commit.
      const result = await db.query<{ position: string }>(`UPDATE ${this.schema}.streams SET position=position+$2 WHERE participant_id=$1 RETURNING position::text`, [participant, changes.length]);
      const end = BigInt(result.rows[0]!.position);
      for (const [index, reference] of changes.entries()) {
        await db.query(`INSERT INTO ${this.schema}.changes(participant_id,position,reference) VALUES($1,$2,$3::jsonb)`,
          [participant, (end - BigInt(changes.length) + BigInt(index + 1)).toString(), JSON.stringify(reference)]);
      }
      await db.query('SELECT pg_notify($1,$2)', [this.channel, participant]);
    }
  }
  async invalidate(db: PoolClient, participants: string[]): Promise<void> {
    const sorted = [...new Set(participants)].sort();
    if (sorted.length > SYNC_LIMITS.recipients) {
      await db.query(`UPDATE ${this.schema}.global_state SET generation=generation+1 WHERE id=true`);
      await db.query(`DELETE FROM ${this.schema}.snapshots`);
      await db.query('SELECT pg_notify($1,$2)', [this.channel, '*']);
      return;
    }
    for (const participant of sorted) {
      await this.ensure(db, participant);
      await db.query(`UPDATE ${this.schema}.streams SET auth_generation=auth_generation+1 WHERE participant_id=$1`, [participant]);
      await db.query(`DELETE FROM ${this.schema}.snapshots WHERE participant_id=$1`, [participant]);
      await db.query('SELECT pg_notify($1,$2)', [this.channel, participant]);
    }
  }
  async page(actor: SocialActor, input: { after?: string; limit?: number } = {}): Promise<SyncPage> {
    if (!actor.scopes.includes('sync:read')) throw new SyncError(403, 'insufficient_scope');
    const limit = input.limit ?? SYNC_LIMITS.pageScans;
    if (!Number.isInteger(limit) || limit < 1 || limit > SYNC_LIMITS.pageScans) throw new SyncError(400, 'invalid_sync_limit');
    const binding = this.codec.binding(actor, this.options.binding(actor));
    // Decode only after the policy transaction revalidates the current OAuth actor.
    return this.social.withPolicy(actor, async (db) => {
      const previous = input.after === undefined ? undefined : this.codec.decode(input.after, binding);
      const global = (await db.query<{ generation: string }>(`SELECT generation::text FROM ${this.schema}.global_state WHERE id=true FOR SHARE`)).rows[0]!.generation;
      await this.ensure(db, actor.participantId);
      const stream = (await db.query<Stream>(`SELECT position::text,auth_generation::text,retention_generation::text FROM ${this.schema}.streams WHERE participant_id=$1 FOR SHARE`, [actor.participantId])).rows[0]!;
      if (previous) {
        if (previous.auth !== stream.auth_generation || previous.global !== global) throw new SyncError(409, 'sync_reset_required');
        if (previous.retention !== stream.retention_generation) throw new SyncError(410, 'cursor_expired');
      }
      const state: CursorState = previous ?? { version: 1, binding, auth: stream.auth_generation, global,
        retention: stream.retention_generation, position: stream.position, high: stream.position, expires: Date.now() + SYNC_LIMITS.cursorMs };
      if (!previous) {
        const resources = await this.options.resources.snapshot(db, actor, SYNC_LIMITS.snapshotResources + 1);
        if (resources.length > SYNC_LIMITS.snapshotResources || size(resources) > SYNC_LIMITS.snapshotBytes
          || resources.some((resource) => size(resource) > SYNC_LIMITS.pageBytes - 4096)) throw new SyncError(413, 'sync_snapshot_too_large');
        state.snapshot = randomUUID(); state.offset = 0;
        const expires = Date.now() + SYNC_LIMITS.snapshotMs;
        await db.query(`INSERT INTO ${this.schema}.snapshots(id,participant_id,binding,resources,expires_at) VALUES($1,$2,$3,$4::jsonb,$5)`,
          [state.snapshot, actor.participantId, binding, JSON.stringify(resources), new Date(expires)]);
      }
      if (state.snapshot) return this.snapshotPage(db, actor, state, limit);
      if (state.position === state.high) state.high = stream.position;
      return this.deltaPage(db, actor, state, limit);
    });
  }
  private finish(state: CursorState, mode: SyncPage['mode'], resources: SyncResource[], hasMore: boolean): SyncPage {
    state.expires = Date.now() + SYNC_LIMITS.cursorMs;
    return { mode, resources, hasMore, cursor: this.codec.encode(state) };
  }
  private async snapshotPage(db: PoolClient, actor: SocialActor, state: CursorState, limit: number): Promise<SyncPage> {
    const row = (await db.query<{ resources: SyncResource[] }>(`SELECT resources FROM ${this.schema}.snapshots
      WHERE id=$1 AND participant_id=$2 AND binding=$3 AND expires_at>clock_timestamp()`, [state.snapshot, actor.participantId, state.binding])).rows[0];
    if (!row) throw new SyncError(410, 'cursor_expired');
    const resources: SyncResource[] = []; let bytes = 4096; let scans = 0;
    let offset = state.offset!;
    if (offset > row.resources.length) throw new SyncError(400, 'invalid_cursor');
    for (; offset < row.resources.length && scans < limit; offset++, scans++) {
      const resource = row.resources[offset]!;
      if (!await this.options.resources.visible(db, actor, resource)) continue;
      const resourceBytes = size(resource);
      if (bytes + resourceBytes > SYNC_LIMITS.pageBytes) break;
      resources.push(resource); bytes += resourceBytes;
    }
    const hasMore = offset < row.resources.length;
    if (hasMore) state.offset = offset;
    else { delete state.snapshot; delete state.offset; }
    // Keep manifests until expiry: a retry of the last page must remain safe and stable.
    return this.finish(state, 'snapshot', resources, hasMore);
  }
  private async deltaPage(db: PoolClient, actor: SocialActor, state: CursorState, limit: number): Promise<SyncPage> {
    const rows = (await db.query<{ position: string; reference: ChangeRef }>(`SELECT position::text,reference FROM ${this.schema}.changes
      WHERE participant_id=$1 AND position>$2 AND position<=$3 ORDER BY position LIMIT $4`, [actor.participantId, state.position, state.high, limit])).rows;
    const resources: SyncResource[] = []; let bytes = 4096;
    for (const row of rows) {
      const resource = await this.options.resources.read(db, actor, row.reference);
      if (resource) {
        const resourceBytes = size(resource);
        if (resourceBytes > SYNC_LIMITS.pageBytes - 4096) throw new SyncError(413, 'sync_resource_too_large');
        if (bytes + resourceBytes > SYNC_LIMITS.pageBytes) break;
        resources.push(resource); bytes += resourceBytes;
      }
      state.position = row.position;
    }
    // No sequence gaps exist: all reserved positions are inserted in the same transaction.
    if (!rows.length && state.position !== state.high) throw new SyncError(410, 'cursor_expired');
    return this.finish(state, 'delta', resources, state.position !== state.high);
  }
  /** Run periodically: at most 256 streams, 1,000 references per stream and 1,000 expired manifests. */
  async compact(): Promise<void> {
    const participants = (await this.pool.query<{ participant_id: string }>(`SELECT DISTINCT participant_id FROM ${this.schema}.changes
      WHERE created_at<clock_timestamp()-interval '7 days' ORDER BY participant_id LIMIT 256`)).rows;
    for (const { participant_id: participant } of participants) {
      const db = await this.pool.connect();
      try {
        // Domain hooks can visit recipients in a different order across resources.
        // Commit each stream before acquiring another so maintenance cannot invert it.
        await db.query('BEGIN');
        await db.query(`SELECT participant_id FROM ${this.schema}.streams WHERE participant_id=$1 FOR UPDATE`, [participant]);
        const result = await db.query(`DELETE FROM ${this.schema}.changes WHERE participant_id=$1 AND position IN (
          SELECT position FROM ${this.schema}.changes WHERE participant_id=$1 AND created_at<clock_timestamp()-interval '7 days'
          ORDER BY position LIMIT 1000)`, [participant]);
        if (result.rowCount) {
          await db.query(`UPDATE ${this.schema}.streams SET retention_generation=retention_generation+1 WHERE participant_id=$1`, [participant]);
          await db.query(`DELETE FROM ${this.schema}.snapshots WHERE participant_id=$1`, [participant]);
          await db.query('SELECT pg_notify($1,$2)', [this.channel, participant]);
        }
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    }
    // Separate autocommit cleanup holds no recipient stream locks.
    await this.pool.query(`DELETE FROM ${this.schema}.snapshots WHERE id IN (SELECT id FROM ${this.schema}.snapshots WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 1000)`);
  }
}
