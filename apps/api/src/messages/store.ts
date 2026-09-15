import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SocialStore } from '../social/store.js';
import { SocialError, type SocialActor } from '../social/types.js';
import { SyncError, type ChangeRef, type ChangeWriter, type SyncResource } from '../sync/types.js';
import { MessageError, type MessageAdmission, type MessageCreateInput, type MessageDeleteInput, type MessageMetadata, type MessageReceipt, type MessageUpdateInput, type MessageView } from './types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const missing = () => new MessageError(404, 'not_found');
const invalid = () => new MessageError(400, 'invalid_request');
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const resource = (data: MessageMetadata | MessageView): SyncResource => ({ type: 'message', id: data.id, revision: data.revision, data });
const receipt = (data: MessageMetadata): MessageReceipt => ({ id: data.id, conversationId: data.conversationId, revision: data.revision, deleted: data.deleted });
const denied = (error: unknown) => (error instanceof MessageError || error instanceof SocialError) &&
  (error.status === 403 || error.status === 404 || (error.status === 409 && error.code === 'crypto_not_ready'));
export const MESSAGE_SNAPSHOT_SCAN_LIMIT = 10_000;

/** Encrypted envelopes only. Admission is an internal service dependency, never
 * a request-supplied roster or a replacement for #10 cryptographic validation. */
export class MessageStore {
  private readonly schema: string;
  private readonly admission: MessageAdmission;
  constructor(private readonly pool: Pool, private readonly social: Pick<SocialStore, 'withPolicy'>,
    private readonly changes: ChangeWriter, options: { schema?: string; admission: MessageAdmission }) {
    this.schema = options.schema ?? 'larynx_messages';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schema)) throw new Error('Invalid SQL identifier');
    this.admission = options.admission;
  }
  async migrate(): Promise<void> {
    const db = await this.pool.connect(); const s = this.schema;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${s}:migrations`]);
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${s};
        CREATE TABLE IF NOT EXISTS ${s}.messages (
          id uuid PRIMARY KEY, conversation_id uuid NOT NULL, author_id uuid NOT NULL,
          revision bigint NOT NULL CHECK(revision>0), deleted boolean NOT NULL DEFAULT false, metadata jsonb NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_conversation ON ${s}.messages(conversation_id,id);
        CREATE TABLE IF NOT EXISTS ${s}.versions (
          message_id uuid NOT NULL REFERENCES ${s}.messages(id), revision bigint NOT NULL,
          envelope jsonb NOT NULL, recipients uuid[] NOT NULL, PRIMARY KEY(message_id,revision)
        );
        CREATE TABLE IF NOT EXISTS ${s}.operations (
          principal_id uuid NOT NULL, client_id text NOT NULL, operation text NOT NULL, operation_key uuid NOT NULL,
          digest text NOT NULL, message_id uuid NOT NULL REFERENCES ${s}.messages(id), receipt jsonb NOT NULL,
          PRIMARY KEY(principal_id,client_id,operation,operation_key)
        );`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  private scope(actor: SocialActor, scope: string): void {
    if (!actor.scopes.includes(scope)) throw new MessageError(403, 'insufficient_scope');
  }
  private id(value: string): void { if (typeof value !== 'string' || !uuid.test(value)) throw invalid(); }
  private integer(value: string, zero = false): void {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n || (!zero && value === '0')) throw invalid();
  }
  private envelope(input: MessageCreateInput | MessageUpdateInput): void {
    if (input.envelopeVersion !== 1 || typeof input.ciphertext !== 'string' || !input.ciphertext.length) throw invalid();
    if (input.ciphertext.length > 87384) throw new MessageError(413, 'message_too_large');
    const bytes = Buffer.from(input.ciphertext, 'base64');
    if (bytes.toString('base64') !== input.ciphertext) throw invalid();
    if (bytes.length > 65536) throw new MessageError(413, 'message_too_large');
  }
  private async current(db: PoolClient, id: string): Promise<MessageMetadata | undefined> {
    return (await db.query<{ metadata: MessageMetadata }>(`SELECT metadata FROM ${this.schema}.messages WHERE id=$1`, [id])).rows[0]?.metadata;
  }
  private async admit(db: PoolClient, actor: SocialActor, action: 'create' | 'update' | 'delete', conversationId: string,
    input: { generation: string; cryptoEpoch: string }, message?: MessageMetadata): Promise<string[]> {
    const policy = await this.admission(db, actor, { action, conversationId, generation: input.generation,
      cryptoEpoch: input.cryptoEpoch, ...(message ? { message } : {}) });
    if (policy.generation !== input.generation || policy.cryptoEpoch !== input.cryptoEpoch) throw new MessageError(409, 'crypto_epoch_conflict');
    const recipients = [...new Set(policy.recipients)].sort();
    if (!recipients.includes(actor.participantId) || recipients.some(id => !uuid.test(id))) throw new Error('Invalid message admission recipients');
    if (action !== 'delete' && recipients.length > 256) throw new MessageError(413, 'message_fanout_exceeded');
    return recipients;
  }
  private async replay(db: PoolClient, actor: SocialActor, operation: string, key: string, hash: string): Promise<MessageReceipt | undefined> {
    const existing = (await db.query<{ digest: string; receipt: MessageReceipt }>(`SELECT digest,receipt FROM ${this.schema}.operations
      WHERE principal_id=$1 AND client_id=$2 AND operation=$3 AND operation_key=$4`, [actor.participantId, actor.clientId, operation, key])).rows[0];
    if (!existing) return undefined;
    if (existing.digest !== hash) throw new MessageError(409, 'idempotency_conflict');
    // Receipts deliberately contain no ciphertext or mutable authorization data.
    return existing.receipt;
  }
  private async record(db: PoolClient, actor: SocialActor, operation: string, key: string, hash: string, data: MessageMetadata): Promise<MessageReceipt> {
    const result = receipt(data);
    await db.query(`INSERT INTO ${this.schema}.operations VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.participantId, actor.clientId, operation, key, hash, data.id, result]);
    return result;
  }
  async create(actor: SocialActor, conversationId: string, operationKey: string, input: MessageCreateInput): Promise<MessageReceipt> {
    this.scope(actor, 'messages:write'); this.id(conversationId); this.id(operationKey); this.id(input.id);
    this.integer(input.generation); this.integer(input.cryptoEpoch, true); this.envelope(input);
    const hash = digest([conversationId, input.id, input.envelopeVersion, input.generation, input.cryptoEpoch, input.ciphertext]);
    return this.social.withPolicy(actor, async db => {
      const existing = await this.current(db, input.id);
      const recipients = await this.admit(db, actor, 'create', conversationId, input, existing?.conversationId === conversationId ? existing : undefined);
      const replay = await this.replay(db, actor, 'create', operationKey, hash); if (replay) return replay;
      if (existing) throw new MessageError(409, 'id_conflict');
      const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
      const metadata: MessageMetadata = { id: input.id, conversationId, authorId: actor.participantId, authorDeviceId: actor.deviceId,
        senderDeviceId: actor.deviceId, revision: '1', createdAt: now, updatedAt: now, deleted: false,
        generation: input.generation, cryptoEpoch: input.cryptoEpoch, envelopeVersion: 1 };
      await db.query(`INSERT INTO ${this.schema}.messages VALUES($1,$2,$3,1,false,$4)`, [input.id, conversationId, actor.participantId, metadata]);
      await db.query(`INSERT INTO ${this.schema}.versions VALUES($1,1,$2,$3)`, [input.id, { ...metadata, ciphertext: input.ciphertext }, recipients]);
      await this.changes.append(db, recipients, [{ type: 'message', id: input.id, revision: '1', kind: 'upsert' }]);
      return this.record(db, actor, 'create', operationKey, hash, metadata);
    }, { operation: `message:create:${operationKey}` });
  }
  async update(actor: SocialActor, id: string, operationKey: string, input: MessageUpdateInput): Promise<MessageReceipt> {
    this.envelope(input);
    return this.mutate(actor, id, operationKey, input, 'update');
  }
  async delete(actor: SocialActor, id: string, operationKey: string, input: MessageDeleteInput): Promise<MessageReceipt> {
    return this.mutate(actor, id, operationKey, input, 'delete');
  }
  private async mutate(actor: SocialActor, id: string, operationKey: string, input: MessageUpdateInput | MessageDeleteInput,
    action: 'update' | 'delete'): Promise<MessageReceipt> {
    this.scope(actor, 'messages:write'); this.id(id); this.id(operationKey); this.integer(input.expectedRevision);
    this.integer(input.generation); this.integer(input.cryptoEpoch, true);
    const update = action === 'update' ? input as MessageUpdateInput : undefined;
    const hash = digest([id, input.expectedRevision, input.generation, input.cryptoEpoch, update?.envelopeVersion, update?.ciphertext]);
    return this.social.withPolicy(actor, async db => {
      const current = await this.current(db, id); if (!current) throw missing();
      const recipients = await this.admit(db, actor, action, current.conversationId, input, current);
      if (current.authorId !== actor.participantId) throw missing();
      const replay = await this.replay(db, actor, action, operationKey, hash); if (replay) return replay;
      if (current.deleted) throw missing();
      if (current.revision !== input.expectedRevision) throw new MessageError(409, 'revision_conflict');
      const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
      const metadata: MessageMetadata = { ...current, revision: (BigInt(current.revision) + 1n).toString(), updatedAt: now,
        senderDeviceId: actor.deviceId, generation: input.generation, cryptoEpoch: input.cryptoEpoch, deleted: action === 'delete' };
      await db.query(`UPDATE ${this.schema}.messages SET revision=$2,deleted=$3,metadata=$4 WHERE id=$1`, [id, metadata.revision, metadata.deleted, metadata]);
      if (update) {
        await db.query(`INSERT INTO ${this.schema}.versions VALUES($1,$2,$3,$4)`, [id, metadata.revision, { ...metadata, ciphertext: update.ciphertext }, recipients]);
      } else {
        const historical = (await db.query<{ recipient: string }>(`SELECT DISTINCT unnest(recipients) AS recipient FROM ${this.schema}.versions WHERE message_id=$1`, [id])).rows.map(row => row.recipient);
        await db.query(`DELETE FROM ${this.schema}.versions WHERE message_id=$1`, [id]);
        // Includes old recipients whose fixed snapshots might still contain the
        // payload. The writer's global fallback must never block deletion.
        await this.changes.invalidate(db, [...new Set([...historical, ...recipients])].sort());
      }
      // Oversized deletions have already installed a global reset fence. They
      // must erase content even when current fanout cannot fit a bounded append.
      if (recipients.length <= 256) await this.changes.append(db, recipients, [{ type: 'message', id, revision: metadata.revision, kind: update ? 'upsert' : 'delete' }]);
      return this.record(db, actor, action, operationKey, hash, metadata);
    }, { operation: `message:${action}:${operationKey}` });
  }
  async get(actor: SocialActor, id: string): Promise<MessageView> {
    this.scope(actor, 'messages:read'); this.id(id);
    return this.social.withPolicy(actor, async db => {
      const current = await this.current(db, id); if (!current || current.deleted) throw missing();
      const result = await this.read(db, actor, { type: 'message', id, revision: current.revision, kind: 'upsert' });
      if (!result) throw missing(); return result.data as MessageView;
    });
  }
  async read(db: PoolClient, actor: SocialActor, ref: ChangeRef): Promise<SyncResource | undefined> {
    if (!actor.scopes.includes('messages:read')) return undefined;
    const current = await this.current(db, ref.id); if (!current) return undefined;
    let data: MessageMetadata | MessageView;
    if (ref.kind === 'delete') {
      if (!current.deleted || current.revision !== ref.revision) return undefined;
      data = current;
    } else {
      if (current.deleted) return undefined;
      const row = (await db.query<{ envelope: MessageView }>(`SELECT envelope FROM ${this.schema}.versions WHERE message_id=$1 AND revision=$2`, [ref.id, ref.revision])).rows[0];
      if (!row) return undefined; data = row.envelope;
    }
    try { await this.admission(db, actor, { action: 'read', conversationId: data.conversationId, message: data }); }
    catch (error) { if (denied(error)) return undefined; throw error; }
    return resource(data);
  }
  async snapshot(db: PoolClient, actor: SocialActor, maximum: number, maximumBytes = 2 * 1024 * 1024): Promise<SyncResource[]> {
    if (!actor.scopes.includes('messages:read')) return [];
    const results: SyncResource[] = []; let after = '00000000-0000-0000-0000-000000000000'; let scanned = 0; let bytes = 2;
    while (true) {
      const rows = (await db.query<{ id: string; revision: string }>(`SELECT id,revision::text FROM ${this.schema}.messages WHERE id>$1 AND NOT deleted ORDER BY id LIMIT 100`, [after])).rows;
      // #10/#19 must replace this bounded fallback with indexed, server-owned
      // conversation/history candidates. Never claim a partial authorized cache.
      if (scanned + rows.length > MESSAGE_SNAPSHOT_SCAN_LIMIT) throw new SyncError(413, 'sync_snapshot_too_large');
      scanned += rows.length;
      for (const row of rows) {
        const item = await this.read(db, actor, { type: 'message', ...row, kind: 'upsert' });
        if (item) {
          bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
          if (bytes > maximumBytes) throw new SyncError(413, 'sync_snapshot_too_large');
          results.push(item);
        }
        if (results.length > maximum) return results;
      }
      if (rows.length < 100) return results;
      after = rows[rows.length - 1]!.id;
    }
  }
  async visible(db: PoolClient, actor: SocialActor, item: SyncResource): Promise<boolean> {
    return !!await this.read(db, actor, { type: 'message', id: item.id, revision: item.revision, kind: 'upsert' });
  }
}
