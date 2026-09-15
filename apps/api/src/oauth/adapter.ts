import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import type { Pool, PoolClient } from 'pg';

export interface OAuthStorageOptions { schema?: string }

function schemaName(options: OAuthStorageOptions): string {
  const schema = options.schema ?? 'larynx_oauth';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('OAuth schema must be a lowercase SQL identifier (maximum 63 characters)');
  }
  return schema;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockGrant(client: PoolClient, schema: string, grantId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${schema}:grant:${grantId}`]);
}

async function revoked(client: Pool | PoolClient, schema: string, grantId: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM ${schema}.revoked_grants WHERE grant_id = $1`, [grantId]);
  return result.rowCount !== 0;
}

async function revokeLocked(client: PoolClient, schema: string, grantId: string): Promise<void> {
  await client.query(`INSERT INTO ${schema}.revoked_grants (grant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [grantId]);
  await client.query(`DELETE FROM ${schema}.artifacts WHERE grant_id = $1`, [grantId]);
}

/** All authorization persistence and revocation checks use the primary pool. */
export async function isGrantRevoked(pool: Pool, grantId: string, options: OAuthStorageOptions = {}): Promise<boolean> {
  return revoked(pool, schemaName(options), grantId);
}

/** Versioned, transactional migration; safe for concurrent application starts. */
export async function migrateOAuth(pool: Pool, options: OAuthStorageOptions = {}): Promise<void> {
  const schema = schemaName(options);
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${schema}:migrations`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const applied = await client.query(`SELECT version FROM ${schema}.migrations ORDER BY version`);
    if (applied.rows.some((row: { version: number }) => row.version > 1)) {
      throw new Error('OAuth database schema is newer than this application');
    }
    if (applied.rows.some((row: { version: number }) => row.version === 1)) return;
    await client.query(`CREATE TABLE ${schema}.artifacts (
      model text NOT NULL,
      id text NOT NULL,
      payload jsonb NOT NULL,
      expires_at timestamptz,
      grant_id text,
      uid text,
      user_code text,
      consumed bigint,
      PRIMARY KEY (model, id)
    )`);
    await client.query(`CREATE INDEX ON ${schema}.artifacts (grant_id) WHERE grant_id IS NOT NULL`);
    await client.query(`CREATE INDEX ON ${schema}.artifacts (model, uid) WHERE uid IS NOT NULL`);
    await client.query(`CREATE INDEX ON ${schema}.artifacts (model, user_code) WHERE user_code IS NOT NULL`);
    await client.query(`CREATE INDEX ON ${schema}.artifacts (expires_at) WHERE expires_at IS NOT NULL`);
    // Tombstones outlive artifacts: delayed refresh/code saves must never recreate a revoked grant.
    await client.query(`CREATE TABLE ${schema}.revoked_grants (
      grant_id text PRIMARY KEY, revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await client.query(`INSERT INTO ${schema}.migrations (version) VALUES (1)`);
  });
}

export function createAdapter(pool: Pool, options: OAuthStorageOptions = {}) {
  const schema = schemaName(options);
  return class PostgresOAuthAdapter implements Adapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn < 0)) {
        throw new Error('Invalid OAuth artifact lifetime');
      }
      const grantId = this.model === 'Grant' ? id : payload.grantId ?? null;
      const accepted = await transaction(pool, async (client) => {
        if (grantId !== null) {
          await lockGrant(client, schema, grantId);
          if (await revoked(client, schema, grantId)) return false;
        }
        const result = await client.query(`INSERT INTO ${schema}.artifacts
          (model, id, payload, expires_at, grant_id, uid, user_code, consumed)
          VALUES ($1, $2, $3::jsonb - 'consumed',
            CASE WHEN $4::double precision IS NULL THEN NULL
              ELSE clock_timestamp() + $4 * interval '1 second' END, $5, $6, $7, $8)
          ON CONFLICT (model, id) DO UPDATE SET
            payload = EXCLUDED.payload,
            expires_at = EXCLUDED.expires_at,
            uid = EXCLUDED.uid,
            user_code = EXCLUDED.user_code,
            consumed = COALESCE(artifacts.consumed, EXCLUDED.consumed)
          WHERE artifacts.grant_id IS NOT DISTINCT FROM EXCLUDED.grant_id
            AND ($1 <> 'LarynxGrantBinding' OR artifacts.payload = EXCLUDED.payload)
          RETURNING id`, [this.model, id, JSON.stringify(payload), expiresIn ?? null, grantId,
          payload.uid ?? null, payload.userCode ?? null, payload.consumed ?? null]);
        if (result.rowCount !== 1) throw new errors.InvalidGrant('OAuth artifact grant association or binding cannot change');
        return true;
      });
      if (!accepted) throw new errors.InvalidGrant('The grant has been revoked');
    }

    private async findBy(column: 'id' | 'uid' | 'user_code', value: string): Promise<AdapterPayload | undefined> {
      const result = await pool.query<{ payload: AdapterPayload }>(`SELECT
        a.payload || CASE WHEN a.consumed IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object('consumed', a.consumed) END AS payload
        FROM ${schema}.artifacts a
        WHERE a.model = $1 AND a.${column} = $2
          AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM ${schema}.revoked_grants r WHERE r.grant_id = a.grant_id)
        LIMIT 1`, [this.model, value]);
      return result.rows[0]?.payload;
    }

    async find(id: string): Promise<AdapterPayload | undefined> { return this.findBy('id', id); }
    async findByUid(uid: string): Promise<AdapterPayload | undefined> { return this.findBy('uid', uid); }
    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> { return this.findBy('user_code', userCode); }

    async consume(id: string): Promise<void> {
      // Resolve the grant before taking its lock, then use a conditional UPDATE under that lock.
      // A replay commits revocation before throwing; rolling it back would resurrect the winner's tokens.
      const accepted = await transaction(pool, async (client) => {
        const artifact = await client.query<{ grant_id: string | null }>(
          `SELECT grant_id FROM ${schema}.artifacts WHERE model = $1 AND id = $2`, [this.model, id]);
        const grantId = artifact.rows[0]?.grant_id;
        if (grantId != null) {
          await lockGrant(client, schema, grantId);
          if (await revoked(client, schema, grantId)) return false;
        }
        const result = await client.query(`UPDATE ${schema}.artifacts
          SET consumed = floor(extract(epoch FROM clock_timestamp()))::bigint
          WHERE model = $1 AND id = $2 AND consumed IS NULL
            AND (expires_at IS NULL OR expires_at > clock_timestamp())
          RETURNING id`, [this.model, id]);
        if (result.rowCount === 1) return true;
        if (grantId != null) await revokeLocked(client, schema, grantId);
        return false;
      });
      if (!accepted) throw new errors.InvalidGrant('The artifact is expired, missing, or already consumed');
    }

    async destroy(id: string): Promise<void> {
      if (this.model === 'Grant') {
        await this.revokeByGrantId(id);
        return;
      }
      await transaction(pool, async client => {
        const row = (await client.query(`SELECT grant_id FROM ${schema}.artifacts WHERE model=$1 AND id=$2`, [this.model,id])).rows[0];
        if (row?.grant_id) await lockGrant(client, schema, row.grant_id);
        await client.query(`DELETE FROM ${schema}.artifacts WHERE model = $1 AND id = $2`, [this.model, id]);
      });
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await transaction(pool, async (client) => {
        await lockGrant(client, schema, grantId);
        await revokeLocked(client, schema, grantId);
      });
    }
  };
}
