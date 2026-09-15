import type { Pool, PoolClient } from 'pg';
import type { VerifiedSession } from '../oauth/accounts.js';

export class IdentityStoreError extends Error {
  constructor(readonly code: 'identity_conflict' | 'identity_ineligible' | 'identity_not_found') { super(code); }
}
export interface CredentialInput { id: string; publicKey: Uint8Array; counter: number; transports: string[]; deviceType?: 'singleDevice' | 'multiDevice'; backedUp?: boolean }
export interface Registration {
  accountId: string; participantId: string; emailHash: string; emailCiphertext: string;
  credential: CredentialInput; deviceName: string; sessionHash: string; deviceHash: string;
}
export interface StoredCredential extends CredentialInput { accountId: string; revokedAt: string | null }
export interface SessionResult extends VerifiedSession { revokedSessionIds: string[] }
const denied = () => new IdentityStoreError('identity_ineligible');

// All eligibility-changing writes lock the account first. Authorization reads use
// a single primary snapshot; a response authorized before revocation may finish.
export class IdentityStore {
  private readonly schema: string;
  constructor(private readonly pool: Pool, options: { schema?: string } = {}) {
    this.schema = options.schema ?? 'larynx_identity';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schema)) throw new Error('Invalid SQL identifier');
  }
  private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new IdentityStoreError('identity_conflict');
      }
      throw error;
    } finally { db.release(); }
  }
  async migrate(): Promise<void> {
    const s = this.schema;
    await this.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${s}:migrations`]);
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
      const versions = await db.query<{ version: number }>(`SELECT version FROM ${s}.migrations ORDER BY version`);
      if (versions.rows.some(({ version }) => version > 1)) throw new Error('Identity schema is newer than this application');
      if (versions.rows.some(({ version }) => version === 1)) return;
      await db.query(`
        CREATE TABLE ${s}.participants (
          id uuid PRIMARY KEY DEFAULT uuidv7(), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE ${s}.accounts (
          id uuid PRIMARY KEY DEFAULT uuidv7(), participant_id uuid NOT NULL UNIQUE REFERENCES ${s}.participants(id),
          status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
          recovery_generation integer NOT NULL DEFAULT 0 CHECK (recovery_generation >= 0),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE ${s}.identities (
          email_hash text PRIMARY KEY, email_ciphertext text NOT NULL,
          account_id uuid NOT NULL UNIQUE REFERENCES ${s}.accounts(id),
          verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE ${s}.credentials (
          id text PRIMARY KEY, account_id uuid NOT NULL REFERENCES ${s}.accounts(id),
          public_key bytea NOT NULL, counter bigint NOT NULL CHECK (counter BETWEEN 0 AND 4294967295),
          transports text[] NOT NULL, device_type text NOT NULL DEFAULT 'singleDevice' CHECK (device_type IN ('singleDevice', 'multiDevice')), backed_up boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz
        );
        CREATE TABLE ${s}.devices (
          id uuid PRIMARY KEY DEFAULT uuidv7(), account_id uuid NOT NULL REFERENCES ${s}.accounts(id),
          device_hash text NOT NULL, name text NOT NULL, crypto_state text NOT NULL DEFAULT 'pending' CHECK (crypto_state = 'pending'),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
          UNIQUE (account_id, device_hash), UNIQUE (id, account_id)
        );
        CREATE TABLE ${s}.sessions (
          id uuid PRIMARY KEY DEFAULT uuidv7(), account_id uuid NOT NULL REFERENCES ${s}.accounts(id),
          device_id uuid NOT NULL, session_hash text NOT NULL UNIQUE,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '30 days'), revoked_at timestamptz, oauth_cleanup_at timestamptz,
          FOREIGN KEY (device_id, account_id) REFERENCES ${s}.devices(id, account_id)
        );
        CREATE INDEX ON ${s}.sessions (account_id, device_id);
        CREATE INDEX ON ${s}.sessions (revoked_at, id) WHERE revoked_at IS NOT NULL AND oauth_cleanup_at IS NULL;
        CREATE INDEX ON ${s}.credentials (account_id);
        CREATE TABLE ${s}.challenges (
          id text PRIMARY KEY, purpose text NOT NULL, browser_hash text NOT NULL, payload jsonb NOT NULL,
          expires_at timestamptz NOT NULL, consumed_at timestamptz
        );
        CREATE TABLE ${s}.rate_limits (
          key text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL
        );
        INSERT INTO ${s}.migrations (version) VALUES (1)
      `);
    });
  }
  async newId(): Promise<string> {
    return (await this.pool.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
  }
  async putChallenge(id: string, purpose: string, browserHash: string, payload: object, ttlSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error('Invalid challenge lifetime');
    // A repeated identifier must never overwrite bindings or revive consumption.
    await this.pool.query(`INSERT INTO ${this.schema}.challenges (id,purpose,browser_hash,payload,expires_at)
      VALUES ($1,$2,$3,$4::jsonb,clock_timestamp() + $5 * interval '1 second')`, [id,purpose,browserHash,JSON.stringify(payload),ttlSeconds]);
  }
  async takeChallenge(id: string, purpose: string, browserHash: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query(`UPDATE ${this.schema}.challenges SET consumed_at = clock_timestamp()
      WHERE id=$1 AND purpose=$2 AND browser_hash=$3 AND consumed_at IS NULL AND expires_at > clock_timestamp() RETURNING payload`, [id,purpose,browserHash]);
    return result.rows[0]?.payload as Record<string, unknown> | undefined;
  }
  async rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) throw new Error('Invalid rate limit');
    const result = await this.pool.query(`INSERT INTO ${this.schema}.rate_limits AS r (key,attempts,expires_at)
      VALUES ($1,1,clock_timestamp() + $3 * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET
        attempts = CASE WHEN r.expires_at <= clock_timestamp() THEN 1 ELSE r.attempts + 1 END,
        expires_at = CASE WHEN r.expires_at <= clock_timestamp() THEN clock_timestamp() + $3 * interval '1 second' ELSE r.expires_at END
      WHERE r.expires_at <= clock_timestamp() OR r.attempts < $2 RETURNING attempts`, [key,limit,windowSeconds]);
    return result.rowCount === 1;
  }
  async findIdentity(emailHash: string): Promise<{ accountId: string; participantId: string; recoveryGeneration: number; status: string; emailCiphertext: string } | undefined> {
    return (await this.pool.query(`SELECT a.id AS "accountId", a.participant_id AS "participantId", a.recovery_generation AS "recoveryGeneration", a.status, i.email_ciphertext AS "emailCiphertext"
      FROM ${this.schema}.identities i JOIN ${this.schema}.accounts a ON a.id=i.account_id WHERE i.email_hash=$1`, [emailHash])).rows[0];
  }
  async credential(id: string): Promise<StoredCredential | undefined> {
    const row = (await this.pool.query(`SELECT id,account_id,public_key,counter,transports,device_type,backed_up,revoked_at FROM ${this.schema}.credentials WHERE id=$1`, [id])).rows[0];
    if (!row) return undefined;
    return { id: row.id, accountId: row.account_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports, deviceType: row.device_type, backedUp: row.backed_up, revokedAt: row.revoked_at?.toISOString() ?? null };
  }
  private async lockAccount(db: PoolClient, accountId: string): Promise<{ participant_id: string; recovery_generation: number }> {
    const row = (await db.query(`SELECT participant_id,recovery_generation,status FROM ${this.schema}.accounts WHERE id=$1 FOR UPDATE`, [accountId])).rows[0];
    if (!row || row.status !== 'active') throw denied();
    return row;
  }
  private async checkActor(db: PoolClient, actor: VerifiedSession): Promise<void> {
    await this.lockAccount(db, actor.accountId);
    if (!(await db.query(`SELECT 1 FROM ${this.schema}.sessions s JOIN ${this.schema}.devices d ON d.id=s.device_id AND d.account_id=s.account_id
      WHERE s.id=$1 AND s.account_id=$2 AND s.device_id=$3 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND d.revoked_at IS NULL`, [actor.sessionId,actor.accountId,actor.deviceId])).rowCount) throw denied();
  }
  private async insertCredential(db: PoolClient, accountId: string, credential: CredentialInput): Promise<void> {
    if (!Number.isSafeInteger(credential.counter) || credential.counter < 0 || credential.counter > 4294967295) throw denied();
    await db.query(`INSERT INTO ${this.schema}.credentials (id,account_id,public_key,counter,transports,device_type,backed_up) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [credential.id,accountId,Buffer.from(credential.publicKey),credential.counter,credential.transports,credential.deviceType ?? 'singleDevice',credential.backedUp ?? false]);
  }
  private async issueSession(db: PoolClient, accountId: string, deviceHash: string, deviceName: string, sessionHash: string): Promise<SessionResult> {
    const existing = (await db.query(`SELECT id,revoked_at FROM ${this.schema}.devices WHERE account_id=$1 AND device_hash=$2`, [accountId,deviceHash])).rows[0];
    if (existing?.revoked_at) throw denied();
    const deviceId: string = existing?.id ?? (await db.query(`INSERT INTO ${this.schema}.devices (account_id,device_hash,name) VALUES ($1,$2,$3) RETURNING id`, [accountId,deviceHash,deviceName])).rows[0].id;
    await db.query(`UPDATE ${this.schema}.devices SET last_seen_at=clock_timestamp(), name=$2 WHERE id=$1`, [deviceId,deviceName]);
    const revoked = await db.query(`UPDATE ${this.schema}.sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND device_id=$2 AND revoked_at IS NULL RETURNING id`, [accountId,deviceId]);
    const sessionId: string = (await db.query(`INSERT INTO ${this.schema}.sessions (account_id,device_id,session_hash) VALUES ($1,$2,$3) RETURNING id`, [accountId,deviceId,sessionHash])).rows[0].id;
    return { accountId,deviceId,sessionId,revokedSessionIds: revoked.rows.map((r: { id: string }) => r.id) };
  }
  async register(input: Registration): Promise<SessionResult> {
    return this.transaction(async (db) => {
      await db.query(`INSERT INTO ${this.schema}.participants (id) VALUES ($1)`, [input.participantId]);
      await db.query(`INSERT INTO ${this.schema}.accounts (id,participant_id) VALUES ($1,$2)`, [input.accountId,input.participantId]);
      await db.query(`INSERT INTO ${this.schema}.identities (email_hash,email_ciphertext,account_id) VALUES ($1,$2,$3)`, [input.emailHash,input.emailCiphertext,input.accountId]);
      await this.insertCredential(db,input.accountId,input.credential);
      return this.issueSession(db,input.accountId,input.deviceHash,input.deviceName,input.sessionHash);
    });
  }
  async authenticateCredential(input: { credentialId: string; expectedCounter: number; newCounter: number; deviceHash: string; deviceName: string; sessionHash: string }): Promise<SessionResult> {
    return this.transaction(async (db) => {
      const initial = (await db.query(`SELECT account_id FROM ${this.schema}.credentials WHERE id=$1`, [input.credentialId])).rows[0];
      if (!initial) throw denied();
      await this.lockAccount(db,initial.account_id);
      const row = (await db.query(`SELECT counter,revoked_at FROM ${this.schema}.credentials WHERE id=$1 AND account_id=$2`, [input.credentialId,initial.account_id])).rows[0];
      if (!row || row.revoked_at || Number(row.counter) !== input.expectedCounter || !Number.isSafeInteger(input.newCounter) || input.newCounter < 0 || input.newCounter > 4294967295 ||
        ((input.expectedCounter !== 0 || input.newCounter !== 0) && input.newCounter <= input.expectedCounter)) throw denied();
      await db.query(`UPDATE ${this.schema}.credentials SET counter=$2 WHERE id=$1`, [input.credentialId,input.newCounter]);
      return this.issueSession(db,initial.account_id,input.deviceHash,input.deviceName,input.sessionHash);
    });
  }
  async recover(input: Registration & { expectedRecoveryGeneration: number }): Promise<SessionResult> {
    return this.transaction(async (db) => {
      const account = await this.lockAccount(db,input.accountId);
      if (account.participant_id !== input.participantId || account.recovery_generation !== input.expectedRecoveryGeneration ||
        !(await db.query(`SELECT 1 FROM ${this.schema}.identities WHERE email_hash=$1 AND account_id=$2`, [input.emailHash,input.accountId])).rowCount) throw denied();
      await db.query(`UPDATE ${this.schema}.credentials SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL`, [input.accountId]);
      await db.query(`UPDATE ${this.schema}.devices SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL`, [input.accountId]);
      const revoked = await db.query(`UPDATE ${this.schema}.sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL RETURNING id`, [input.accountId]);
      await db.query(`UPDATE ${this.schema}.accounts SET recovery_generation=recovery_generation+1 WHERE id=$1`, [input.accountId]);
      await this.insertCredential(db,input.accountId,input.credential);
      const result = await this.issueSession(db,input.accountId,input.deviceHash,input.deviceName,input.sessionHash);
      result.revokedSessionIds.push(...revoked.rows.map((r: { id: string }) => r.id));
      return result;
    });
  }
  async session(sessionHash: string): Promise<VerifiedSession | undefined> {
    return (await this.pool.query(`SELECT s.id AS "sessionId",s.account_id AS "accountId",s.device_id AS "deviceId"
      FROM ${this.schema}.sessions s JOIN ${this.schema}.accounts a ON a.id=s.account_id JOIN ${this.schema}.devices d ON d.id=s.device_id AND d.account_id=s.account_id
      WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND a.status='active' AND d.revoked_at IS NULL`, [sessionHash])).rows[0];
  }
  async findAccount(id: string): Promise<{ id: string; participantId: string } | undefined> {
    return (await this.pool.query(`SELECT id,participant_id AS "participantId" FROM ${this.schema}.accounts WHERE id=$1 AND status='active'`, [id])).rows[0];
  }
  async isSessionActive(actor: VerifiedSession): Promise<boolean> {
    return (await this.pool.query(`SELECT 1 FROM ${this.schema}.sessions s JOIN ${this.schema}.accounts a ON a.id=s.account_id JOIN ${this.schema}.devices d ON d.id=s.device_id AND d.account_id=s.account_id
      WHERE s.id=$1 AND s.account_id=$2 AND s.device_id=$3 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND a.status='active' AND d.revoked_at IS NULL`, [actor.sessionId,actor.accountId,actor.deviceId])).rowCount === 1;
  }
  async accountView(actor: VerifiedSession): Promise<{ accountId: string; participantId: string; recoveryGeneration: number; devices: { id: string; name: string; createdAt: string; lastSeenAt: string; revokedAt: string | null; cryptoState: 'pending' }[] } | undefined> {
    const row = (await this.pool.query(`SELECT a.id AS "accountId",a.participant_id AS "participantId",a.recovery_generation AS "recoveryGeneration",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'createdAt',d.created_at,'lastSeenAt',d.last_seen_at,'revokedAt',d.revoked_at,'cryptoState',d.crypto_state) ORDER BY d.created_at,d.id)
      FROM ${this.schema}.devices d WHERE d.account_id=a.id), '[]'::jsonb) AS devices FROM ${this.schema}.accounts a
      JOIN ${this.schema}.sessions s ON s.account_id=a.id JOIN ${this.schema}.devices current_device ON current_device.id=s.device_id AND current_device.account_id=a.id
      WHERE a.id=$1 AND a.status='active' AND s.id=$2 AND s.device_id=$3 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND current_device.revoked_at IS NULL`, [actor.accountId,actor.sessionId,actor.deviceId])).rows[0];
    if (!row) return undefined;
    row.devices = row.devices.map((device: { createdAt: string; lastSeenAt: string; revokedAt: string | null }) => ({ ...device, createdAt: new Date(device.createdAt).toISOString(), lastSeenAt: new Date(device.lastSeenAt).toISOString(), revokedAt: device.revokedAt === null ? null : new Date(device.revokedAt).toISOString() }));
    return row;
  }
  async revokeDevice(actor: VerifiedSession, targetId: string): Promise<string[]> {
    return this.transaction(async (db) => {
      await this.checkActor(db,actor);
      if (!(await db.query(`UPDATE ${this.schema}.devices SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND account_id=$2 RETURNING id`, [targetId,actor.accountId])).rowCount) throw new IdentityStoreError('identity_not_found');
      return (await db.query(`UPDATE ${this.schema}.sessions SET revoked_at=clock_timestamp() WHERE device_id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING id`, [targetId,actor.accountId])).rows.map((r: { id: string }) => r.id);
    });
  }
  async logout(actor: VerifiedSession): Promise<string[]> {
    return this.transaction(async (db) => {
      await this.checkActor(db,actor);
      return (await db.query(`UPDATE ${this.schema}.sessions SET revoked_at=clock_timestamp() WHERE id=$1 RETURNING id`, [actor.sessionId])).rows.map((r: { id: string }) => r.id);
    });
  }
  // Revoked rows are the durable cleanup queue. Current primary eligibility
  // denies access immediately; retries only remove obsolete OAuth artifacts.
  async pendingRevocations(limit = 100): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid cleanup batch size');
    return (await this.pool.query(`SELECT id FROM ${this.schema}.sessions WHERE revoked_at IS NOT NULL AND oauth_cleanup_at IS NULL ORDER BY revoked_at,id LIMIT $1`, [limit])).rows.map((row: { id: string }) => row.id);
  }
  async completeRevocations(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.pool.query(`UPDATE ${this.schema}.sessions SET oauth_cleanup_at=COALESCE(oauth_cleanup_at,clock_timestamp()) WHERE id=ANY($1::uuid[]) AND revoked_at IS NOT NULL`, [ids]);
  }

}
