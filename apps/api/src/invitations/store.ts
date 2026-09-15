import type { Pool, PoolClient } from 'pg';
import { canonicalEmail, digest, keyed, protectEmail, revealEmail, secret, type IdentityConfig } from '../identity/config.js';
import type { SocialStore } from '../social/store.js';
import { SocialError } from '../social/types.js';
import { InvitationError, type Delivery, type InvitationActor, type InvitationView, type IssuedInvitation, type Target } from './types.js';

type Row = {
  id: string; revision: string; target_type: Target['type']; target_id: string;
  sender_participant_id: string; sender_account_id: string; pending_participant_id: string;
  email_hash: string; email_ciphertext: string; credential_hash: string;
  created_at: Date; expires_at: Date; revoked_at: Date | null; accepted_at: Date | null;
  delivery: InvitationView['delivery']; expired: boolean;
};
const missing = () => new InvitationError(404, 'not_found');
const conflict = (code = 'invitation_unavailable') => new InvitationError(409, code);
const validSecret = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const targetOf = (row: Row): Target => ({ type: row.target_type, id: row.target_id });
const scopeFor = (type: Target['type'], access: 'read' | 'write') => `${type === 'CIRCLE' ? 'circles' : 'conversations'}:${access}`;

/** Committed invitation intent and fresh, session-bound email proof. All policy
 * changes share SocialStore's transaction; raw delivery credentials never persist. */
export class InvitationStore {
  private readonly schema: string;
  private readonly identity: string;
  constructor(private readonly pool: Pool, private readonly social: SocialStore, private readonly config: IdentityConfig,
    options: { schema?: string; identitySchema?: string } = {}) {
    this.schema = options.schema ?? 'larynx_invitations';
    this.identity = options.identitySchema ?? 'larynx_identity';
    for (const name of [this.schema, this.identity]) if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid SQL identifier');
  }
  async migrate(): Promise<void> {
    const db = await this.pool.connect(); const s = this.schema;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${s}:migrations`]);
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${s}; CREATE TABLE IF NOT EXISTS ${s}.migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
      const versions = (await db.query<{ version: number }>(`SELECT version FROM ${s}.migrations`)).rows;
      if (versions.some(row => row.version > 1)) throw new Error('Invitation schema is newer than this application');
      if (!versions.some(row => row.version === 1)) await db.query(`
        CREATE TABLE ${s}.invitations(
          id uuid PRIMARY KEY DEFAULT uuidv7(), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
          target_type text NOT NULL CHECK(target_type IN ('CIRCLE','CONVERSATION')),target_id uuid NOT NULL,
          sender_participant_id uuid NOT NULL REFERENCES ${this.identity}.participants(id),sender_account_id uuid NOT NULL REFERENCES ${this.identity}.accounts(id),
          pending_participant_id uuid NOT NULL UNIQUE REFERENCES ${this.identity}.participants(id),
          email_hash text NOT NULL,email_ciphertext text NOT NULL,credential_hash text NOT NULL UNIQUE,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
          revoked_at timestamptz,accepted_at timestamptz,delivery text NOT NULL DEFAULT 'PENDING' CHECK(delivery IN ('PENDING','SENT','FAILED')),
          CHECK(revoked_at IS NULL OR accepted_at IS NULL));
        CREATE INDEX ON ${s}.invitations(sender_participant_id,created_at);
        CREATE TABLE ${s}.operations(participant_id uuid NOT NULL,client_id text NOT NULL,operation_key uuid NOT NULL,input_digest text NOT NULL,invitation_id uuid NOT NULL REFERENCES ${s}.invitations(id),PRIMARY KEY(participant_id,client_id,operation_key));
        CREATE TABLE ${s}.proofs(id text PRIMARY KEY,invitation_id uuid NOT NULL REFERENCES ${s}.invitations(id),revision bigint NOT NULL,
          purpose text NOT NULL CHECK(purpose='claim'),target_type text NOT NULL,target_id uuid NOT NULL,email_hash text NOT NULL,
          account_id uuid NOT NULL,client_id text NOT NULL,device_id uuid NOT NULL,session_id uuid NOT NULL,
          expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',consumed_at timestamptz);
        CREATE INDEX ON ${s}.proofs(invitation_id);
        CREATE TABLE ${s}.claims(invitation_id uuid PRIMARY KEY REFERENCES ${s}.invitations(id),original_participant_id uuid NOT NULL,canonical_participant_id uuid NOT NULL,
          email_hash text NOT NULL,target_type text NOT NULL,target_id uuid NOT NULL,account_id uuid NOT NULL,client_id text NOT NULL,device_id uuid NOT NULL,session_id uuid NOT NULL,claimed_at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE TABLE ${s}.rate_limits(key text PRIMARY KEY,attempts integer NOT NULL,expires_at timestamptz NOT NULL);
        INSERT INTO ${s}.migrations(version) VALUES(1)`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  private requireScope(actor: InvitationActor, scope: string): void {
    if (!actor.scopes.includes(scope)) throw new InvitationError(403, 'insufficient_scope');
  }
  private email(value: string): string {
    try { return canonicalEmail(value); } catch { throw new InvitationError(400, 'invalid_email'); }
  }
  private view(row: Row): InvitationView {
    return { id: row.id, revision: row.revision, target: targetOf(row), recipientEmail: revealEmail(this.config, row.email_ciphertext),
      createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      state: row.accepted_at ? 'ACCEPTED' : row.revoked_at ? 'REVOKED' : row.expired ? 'EXPIRED' : 'PENDING', delivery: row.delivery };
  }
  private async row(db: PoolClient, id: string): Promise<Row> {
    const row = (await db.query<Row>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM ${this.schema}.invitations WHERE id=$1`, [id])).rows[0];
    if (!row) throw missing(); return row;
  }
  private async sender(db: PoolClient, actor: InvitationActor, row: Row): Promise<void> {
    if (row.sender_participant_id !== actor.participantId || row.sender_account_id !== actor.accountId) throw missing();
    this.requireScope(actor, scopeFor(row.target_type, 'write'));
    await this.social.checkInvitationAuthority(db, actor.participantId, targetOf(row));
  }
  private active(row: Row): void { if (row.accepted_at || row.revoked_at || row.expired) throw conflict(); }
  private revision(row: Row, expected: string): void { if (row.revision !== expected) throw conflict('revision_conflict'); }
  private async limited(db: PoolClient, key: string, limit: number, seconds: number): Promise<boolean> {
    return (await db.query(`INSERT INTO ${this.schema}.rate_limits AS r(key,attempts,expires_at) VALUES($1,1,clock_timestamp()+$3*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN r.expires_at<=clock_timestamp() THEN 1 ELSE r.attempts+1 END,
      expires_at=CASE WHEN r.expires_at<=clock_timestamp() THEN clock_timestamp()+$3*interval '1 second' ELSE r.expires_at END
      WHERE r.expires_at<=clock_timestamp() OR r.attempts<$2 RETURNING key`, [key,limit,seconds])).rowCount !== 1;
  }
  private async deliveryLimited(db: PoolClient, actor: InvitationActor, emailHash: string): Promise<boolean> {
    const sender = await this.limited(db, `sender:${actor.accountId}`, 20, 3600);
    const recipient = await this.limited(db, `recipient:${emailHash}`, 3, 600);
    return sender || recipient;
  }
  async create(actor: InvitationActor, input: { target: Target; email: string; operationKey: string; expectedRevision: string }): Promise<IssuedInvitation> {
    this.requireScope(actor, scopeFor(input.target.type, 'write'));
    const email = this.email(input.email); const emailHash = keyed(this.config, 'email', email);
    const inputDigest = digest(JSON.stringify([input.target.type, input.target.id, emailHash]));
    const result = await this.social.withPolicy(actor, async db => {
      // Authorization precedes replay/conflict, so an old operation cannot recover
      // a resource or recipient address after the sender loses management rights.
      await this.social.checkInvitationAuthority(db, actor.participantId, input.target);
      const old = (await db.query(`SELECT input_digest,invitation_id FROM ${this.schema}.operations WHERE participant_id=$1 AND client_id=$2 AND operation_key=$3`, [actor.participantId,actor.clientId,input.operationKey])).rows[0];
      if (old) {
        const row = await this.row(db, old.invitation_id); await this.sender(db, actor, row);
        if (old.input_digest !== inputDigest) throw conflict('idempotency_conflict');
        return { invitation: this.view(row) };
      }
      await this.social.checkInvitationAuthority(db, actor.participantId, input.target, input.expectedRevision);
      if (await this.deliveryLimited(db, actor, emailHash)) return undefined;
      const participant = (await db.query(`INSERT INTO ${this.identity}.participants DEFAULT VALUES RETURNING id`)).rows[0].id as string;
      const token = secret();
      const id = (await db.query(`INSERT INTO ${this.schema}.invitations(target_type,target_id,sender_participant_id,sender_account_id,pending_participant_id,email_hash,email_ciphertext,credential_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [input.target.type,input.target.id,actor.participantId,actor.accountId,participant,emailHash,protectEmail(this.config,email),digest(token)])).rows[0].id as string;
      await db.query(`INSERT INTO ${this.schema}.operations(participant_id,client_id,operation_key,input_digest,invitation_id) VALUES($1,$2,$3,$4,$5)`, [actor.participantId,actor.clientId,input.operationKey,inputDigest,id]);
      const row = await this.row(db, id);
      return { invitation: this.view(row), delivery: { email, token, kind: 'invitation' as const, invitationId: id, revision: row.revision } };
    }, { operation: `invitation:create:${input.operationKey}` });
    // Commit rate counters even when issuance is throttled.
    if (!result) throw new InvitationError(429, 'rate_limited'); return result;
  }
  async list(actor: InvitationActor): Promise<InvitationView[]> {
    if (!actor.scopes.includes('circles:read') && !actor.scopes.includes('conversations:read')) throw new InvitationError(403, 'insufficient_scope');
    return this.social.withPolicy(actor, async db => {
      const rows = (await db.query<Row>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM ${this.schema}.invitations WHERE sender_participant_id=$1 AND sender_account_id=$2 ORDER BY created_at DESC,id DESC`, [actor.participantId,actor.accountId])).rows;
      const result: InvitationView[] = [];
      for (const row of rows) {
        if (!actor.scopes.includes(scopeFor(row.target_type, 'read'))) continue;
        try { await this.social.checkInvitationAuthority(db, actor.participantId, targetOf(row)); }
        catch (error) { if (error instanceof SocialError && [404,409].includes(error.status)) continue; throw error; }
        result.push(this.view(row));
      }
      return result;
    });
  }
  async resend(actor: InvitationActor, id: string, expectedRevision: string): Promise<IssuedInvitation> {
    const result = await this.social.withPolicy(actor, async db => {
      const row = await this.row(db, id); await this.sender(db, actor, row); this.revision(row, expectedRevision);
      if (row.accepted_at || row.revoked_at) throw conflict();
      if (await this.deliveryLimited(db, actor, row.email_hash)) return undefined;
      const token = secret();
      await db.query(`UPDATE ${this.schema}.invitations SET credential_hash=$2,revision=revision+1,expires_at=clock_timestamp()+interval '7 days',delivery='PENDING' WHERE id=$1`, [id,digest(token)]);
      await db.query(`DELETE FROM ${this.schema}.proofs WHERE invitation_id=$1`, [id]);
      const updated = await this.row(db, id);
      return { invitation: this.view(updated), delivery: { email: revealEmail(this.config,row.email_ciphertext),token,kind:'invitation' as const,invitationId:id,revision:updated.revision } };
    });
    if (!result) throw new InvitationError(429, 'rate_limited'); return result;
  }
  async revoke(actor: InvitationActor, id: string, expectedRevision: string): Promise<InvitationView> {
    return this.social.withPolicy(actor, async db => {
      const row = await this.row(db, id); await this.sender(db, actor, row); this.revision(row, expectedRevision);
      if (row.accepted_at) throw conflict();
      if (!row.revoked_at) {
        await db.query(`UPDATE ${this.schema}.invitations SET revoked_at=clock_timestamp(),revision=revision+1 WHERE id=$1`, [id]);
        await db.query(`DELETE FROM ${this.schema}.proofs WHERE invitation_id=$1`, [id]);
      }
      return this.view(await this.row(db, id));
    });
  }
  private async credential(db: PoolClient, token: string, emailHash: string): Promise<Row | undefined> {
    return (await db.query<Row>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM ${this.schema}.invitations
      WHERE credential_hash=$1 AND email_hash=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [digest(token),emailHash])).rows[0];
  }
  async requestProof(actor: InvitationActor, input: { token: string; email: string }): Promise<{ delivery?: Delivery }> {
    this.requireScope(actor, 'profile:write');
    let email: string; try { email = canonicalEmail(input.email); } catch { return {}; }
    if (!validSecret(input.token)) return {};
    const emailHash = keyed(this.config, 'email', email);
    return this.social.withPolicy(actor, async db => {
      const actorLimited = await this.limited(db, `proof-actor:${actor.accountId}`, 10, 600);
      if (actorLimited) return {};
      const row = await this.credential(db, input.token, emailHash);
      if (!row) return {};
      this.requireScope(actor, scopeFor(row.target_type, 'write'));
      try { await this.social.checkInvitationAuthority(db, row.sender_participant_id, targetOf(row)); }
      catch (error) { if (error instanceof SocialError && [404,409].includes(error.status)) return {}; throw error; }
      if (await this.limited(db, `proof-recipient:${emailHash}`, 3, 600)) return {};
      const code = secret();
      await db.query(`INSERT INTO ${this.schema}.proofs(id,invitation_id,revision,purpose,target_type,target_id,email_hash,account_id,client_id,device_id,session_id)
        VALUES($1,$2,$3,'claim',$4,$5,$6,$7,$8,$9,$10)`, [digest(code),row.id,row.revision,row.target_type,row.target_id,emailHash,actor.accountId,actor.clientId,actor.deviceId,actor.sessionId]);
      return { delivery: { email, token:code, kind:'verification' as const, invitationId:row.id,revision:row.revision } };
    });
  }
  async accept(actor: InvitationActor, input: { token: string; email: string; code: string; confirmAccept: boolean }): Promise<{ target: Target }> {
    this.requireScope(actor, 'profile:write');
    if (!input.confirmAccept) throw new InvitationError(400, 'confirmation_required');
    let email: string; try { email = canonicalEmail(input.email); } catch { throw conflict(); }
    if (!validSecret(input.token) || !validSecret(input.code)) throw conflict();
    const emailHash = keyed(this.config, 'email', email);
    return this.social.withPolicy(actor, async db => {
      const row = await this.credential(db, input.token, emailHash);
      if (!row) throw conflict();
      this.requireScope(actor, scopeFor(row.target_type, 'write'));
      this.active(row);
      const proof = (await db.query(`SELECT 1 FROM ${this.schema}.proofs WHERE id=$1 AND invitation_id=$2 AND revision=$3 AND purpose='claim'
        AND target_type=$4 AND target_id=$5 AND email_hash=$6 AND account_id=$7 AND client_id=$8 AND device_id=$9 AND session_id=$10 AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
        [digest(input.code),row.id,row.revision,row.target_type,row.target_id,emailHash,actor.accountId,actor.clientId,actor.deviceId,actor.sessionId])).rowCount;
      if (!proof) throw conflict();
      await this.social.checkInvitationAuthority(db, row.sender_participant_id, targetOf(row));
      const owner = (await db.query(`SELECT account_id FROM ${this.identity}.identities WHERE email_hash=$1`, [emailHash])).rows[0];
      // Email proof authenticates the mailbox, not permission to modify this
      // OAuth account's recovery identities. Account linking needs separate step-up.
      if (!owner || owner.account_id !== actor.accountId) throw conflict();
      if ((await db.query(`SELECT 1 FROM ${this.identity}.accounts WHERE participant_id=$1`, [row.pending_participant_id])).rowCount) throw conflict();
      const alias = (await db.query(`SELECT canonical_participant_id FROM ${this.identity}.participant_aliases WHERE alias_id=$1`, [row.pending_participant_id])).rows[0];
      if (alias && alias.canonical_participant_id !== actor.participantId) throw conflict();
      if (!alias) await db.query(`INSERT INTO ${this.identity}.participant_aliases(alias_id,canonical_participant_id) VALUES($1,$2)`, [row.pending_participant_id,actor.participantId]);
      await this.social.acceptInvitation(db, row.pending_participant_id, targetOf(row));
      await this.social.invalidateParticipant(db, actor.participantId);
      await db.query(`INSERT INTO ${this.schema}.claims(invitation_id,original_participant_id,canonical_participant_id,email_hash,target_type,target_id,account_id,client_id,device_id,session_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [row.id,row.pending_participant_id,actor.participantId,emailHash,row.target_type,row.target_id,actor.accountId,actor.clientId,actor.deviceId,actor.sessionId]);
      await db.query(`UPDATE ${this.schema}.proofs SET consumed_at=clock_timestamp() WHERE id=$1`, [digest(input.code)]);
      await db.query(`UPDATE ${this.schema}.invitations SET accepted_at=clock_timestamp(),revision=revision+1 WHERE id=$1`, [row.id]);
      return { target:targetOf(row) };
    }, { emailHash });
  }
  async recordDelivery(delivery: Delivery, sent: boolean): Promise<void> {
    if (delivery.kind !== 'invitation') return;
    await this.pool.query(`UPDATE ${this.schema}.invitations SET delivery=$4 WHERE id=$1 AND revision=$2 AND credential_hash=$3 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [delivery.invitationId,delivery.revision,digest(delivery.token),sent ? 'SENT' : 'FAILED']);
  }
}
