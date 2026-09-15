import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SocialError, unavailableEventSources, type AssertOAuthTransaction, type CircleView, type ConversationView, type EventSourceAdapter, type PendingConversationView, type Preview, type Role, type SocialActor, type Source } from './types.js';

const missing = () => new SocialError(404, 'not_found');
const conflict = (code = 'revision_conflict') => new SocialError(409, code);
const sourceKey = (source: Source) => `${source.operation}:${source.type}:${source.id}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = (sources: Source[]) => [...new Map(sources.map(source => [sourceKey(source), source])).values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
const iso = (value: Date | string) => new Date(value).toISOString();
type Resolution = Preview & { fingerprint: string };
type CircleRow = { id: string; revision: string; created_at: Date; deleted_at: Date | null };
type ConversationRow = CircleRow & { generation: string; fingerprint: string; orphaned: boolean };

/** Primary-only policy store. The coarse graph lock is also the integration
 * boundary for identity and future event mutations; never lock accounts below it. */
export class SocialStore {
  private readonly schema: string;
  private readonly identity: string;
  private readonly assertOAuth: AssertOAuthTransaction;
  private readonly events: EventSourceAdapter;
  constructor(private readonly pool: Pool, options: { schema?: string; identitySchema?: string; assertOAuth: AssertOAuthTransaction; eventSources?: EventSourceAdapter }) {
    this.schema = options.schema ?? 'larynx_social';
    this.identity = options.identitySchema ?? 'larynx_identity';
    for (const name of [this.schema, this.identity]) if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid SQL identifier');
    this.assertOAuth = options.assertOAuth;
    this.events = options.eventSources ?? unavailableEventSources;
  }
  private async rawTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = await this.pool.connect();
      try {
        await db.query('BEGIN');
        const result = await work(db);
        await db.query('COMMIT');
        return result;
      } catch (error) {
        await db.query('ROLLBACK');
        const code = (error as { code?: string }).code;
        if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error;
      } finally { db.release(); }
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  private async graphLock(db: PoolClient): Promise<void> {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${this.schema}:policy`]);
  }
  private async transaction<T>(actor: SocialActor, work: (db: PoolClient) => Promise<T>, operation?: string): Promise<T> {
    return this.rawTransaction(async db => {
      if (operation) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${this.schema}:operation:${actor.participantId}:${actor.clientId}:${operation}`]);
      await this.assertOAuth(db, actor);
      const account = (await db.query(`SELECT participant_id,status FROM ${this.identity}.accounts WHERE id=$1 FOR UPDATE`, [actor.accountId])).rows[0];
      if (!account || account.status !== 'active' || account.participant_id !== actor.participantId) throw new SocialError(401, 'invalid_token');
      if (!(await db.query(`SELECT 1 FROM ${this.identity}.sessions s JOIN ${this.identity}.devices d ON d.id=s.device_id AND d.account_id=s.account_id
        WHERE s.id=$1 AND s.account_id=$2 AND s.device_id=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND d.revoked_at IS NULL`, [actor.sessionId, actor.accountId, actor.deviceId])).rowCount) throw new SocialError(401, 'invalid_token');
      await this.graphLock(db);
      await this.reconcileAll(db);
      return work(db);
    });
  }
  async migrate(): Promise<void> {
    const s = this.schema;
    await this.rawTransaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${s}:migrations`]);
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${s}; CREATE TABLE IF NOT EXISTS ${s}.migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
      const versions = (await db.query<{ version: number }>(`SELECT version FROM ${s}.migrations`)).rows;
      if (versions.some(row => row.version > 1)) throw new Error('Social schema is newer than this application');
      if (versions.some(row => row.version === 1)) return;
      await db.query(`
        CREATE TABLE ${s}.circles(id uuid PRIMARY KEY DEFAULT uuidv7(),revision bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz);
        CREATE TABLE ${s}.circle_memberships(circle_id uuid NOT NULL REFERENCES ${s}.circles(id),participant_id uuid NOT NULL REFERENCES ${this.identity}.participants(id),role text NOT NULL CHECK(role IN ('OWNER','ADMIN','MEMBER')),state text NOT NULL CHECK(state IN ('INVITED','ACTIVE','LEFT','REMOVED')),PRIMARY KEY(circle_id,participant_id));
        CREATE INDEX ON ${s}.circle_memberships(participant_id,circle_id);
        CREATE TABLE ${s}.conversations(id uuid PRIMARY KEY DEFAULT uuidv7(),revision bigint NOT NULL DEFAULT 1,generation bigint NOT NULL DEFAULT 0,fingerprint text NOT NULL DEFAULT '',orphaned boolean NOT NULL DEFAULT false,send_gate text NOT NULL DEFAULT 'CLOSED' CHECK(send_gate='CLOSED'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz);
        CREATE TABLE ${s}.audience_sources(conversation_id uuid NOT NULL REFERENCES ${s}.conversations(id),type text NOT NULL CHECK(type IN ('USER','CIRCLE','EVENT')),source_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('INCLUDE','EXCLUDE')),PRIMARY KEY(conversation_id,type,source_id,operation));
        CREATE INDEX ON ${s}.audience_sources(type,source_id);
        CREATE TABLE ${s}.conversation_roles(conversation_id uuid NOT NULL REFERENCES ${s}.conversations(id),participant_id uuid NOT NULL REFERENCES ${this.identity}.participants(id),role text NOT NULL CHECK(role IN ('OWNER','ADMIN','MEMBER')),PRIMARY KEY(conversation_id,participant_id));
        CREATE TABLE ${s}.self_exclusions(conversation_id uuid NOT NULL REFERENCES ${s}.conversations(id),participant_id uuid NOT NULL REFERENCES ${this.identity}.participants(id),PRIMARY KEY(conversation_id,participant_id));
        CREATE TABLE ${s}.membership_intervals(id uuid PRIMARY KEY DEFAULT uuidv7(),conversation_id uuid NOT NULL REFERENCES ${s}.conversations(id),participant_id uuid NOT NULL REFERENCES ${this.identity}.participants(id),state text NOT NULL CHECK(state IN ('PENDING','ACTIVE','LEFT','REMOVED')),generation bigint NOT NULL,provenance jsonb NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),ended_at timestamptz);
        CREATE UNIQUE INDEX ON ${s}.membership_intervals(conversation_id,participant_id) WHERE ended_at IS NULL;
        CREATE TABLE ${s}.operations(participant_id uuid NOT NULL,client_id text NOT NULL,operation text NOT NULL,operation_key uuid NOT NULL,input_digest text NOT NULL,object_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(participant_id,client_id,operation,operation_key));
        INSERT INTO ${s}.migrations(version) VALUES(1)`);
    });
  }
  private async canonical(db: PoolClient, id: string): Promise<string> {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const row = (await db.query(`SELECT canonical_participant_id FROM ${this.identity}.participant_aliases WHERE alias_id=$1`, [id])).rows[0];
      if (!row) return id;
      id = row.canonical_participant_id;
    }
    throw new SocialError(409, 'invalid_participant_binding');
  }
  private async eligible(db: PoolClient, id: string): Promise<boolean> {
    return (await db.query(`SELECT 1 FROM ${this.identity}.accounts WHERE participant_id=$1 AND status='active'`, [id])).rowCount === 1;
  }
  private async circleMembers(db: PoolClient, id: string): Promise<{ participantId: string; role: Role; state: string }[]> {
    const rows = (await db.query(`SELECT participant_id,role,state FROM ${this.schema}.circle_memberships WHERE circle_id=$1 ORDER BY participant_id`, [id])).rows;
    const members = new Map<string, { participantId: string; role: Role; state: string }>();
    for (const row of rows) {
      const participantId = await this.canonical(db, row.participant_id);
      if (!await this.eligible(db, participantId)) continue;
      const existing = members.get(participantId);
      // Accepted membership wins alias duplication; authority is explicit, never source inherited.
      if (!existing || ['REMOVED','LEFT','INVITED','ACTIVE'].indexOf(row.state) > ['REMOVED','LEFT','INVITED','ACTIVE'].indexOf(existing.state) || (row.state === existing.state && ['MEMBER','ADMIN','OWNER'].indexOf(row.role) > ['MEMBER','ADMIN','OWNER'].indexOf(existing.role))) members.set(participantId, { participantId, role: row.role, state: row.state });
    }
    return [...members.values()].sort((a,b) => a.participantId.localeCompare(b.participantId));
  }
  private async circleParticipantRefs(db: PoolClient, id: string, participantId: string): Promise<string[]> {
    const refs: string[] = [];
    for (const row of (await db.query(`SELECT participant_id FROM ${this.schema}.circle_memberships WHERE circle_id=$1`, [id])).rows) if (await this.canonical(db,row.participant_id) === participantId) refs.push(row.participant_id);
    return refs;
  }
  private async circleView(db: PoolClient, actor: SocialActor, id: string, requireActive = false): Promise<CircleView> {
    const row = (await db.query<CircleRow>(`SELECT * FROM ${this.schema}.circles WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    const members = await this.circleMembers(db, id);
    const own = members.find(member => member.participantId === actor.participantId);
    if (!row || !own || (own.state !== 'ACTIVE' && (requireActive || own.state !== 'INVITED'))) throw missing();
    return { id: row.id, revision: row.revision, createdAt: iso(row.created_at), role: own.role, state: own.state as CircleView['state'], ...(own.state === 'ACTIVE' ? { members } : {}) };
  }
  private expect(revision: string, expected: string): void { if (revision !== expected) throw conflict(); }
  private manager(role: Role): void { if (role !== 'OWNER' && role !== 'ADMIN') throw missing(); }
  private owner(role: Role): void { if (role !== 'OWNER') throw missing(); }
  private async checkCircleOwners(db: PoolClient, id: string): Promise<void> {
    if (!(await this.circleMembers(db,id)).some(member => member.state === 'ACTIVE' && member.role === 'OWNER')) throw conflict('last_owner');
  }
  private async updateCircle(db: PoolClient, id: string): Promise<void> {
    await db.query(`UPDATE ${this.schema}.circles SET revision=revision+1 WHERE id=$1`, [id]);
    await this.reconcileAll(db);
  }
  async listCircles(actor: SocialActor): Promise<CircleView[]> {
    return this.transaction(actor, async db => {
      const rows = (await db.query(`SELECT id FROM ${this.schema}.circles WHERE deleted_at IS NULL ORDER BY created_at,id`)).rows;
      const result: CircleView[] = [];
      for (const row of rows) { try { result.push(await this.circleView(db,actor,row.id)); } catch (error) { if (!(error instanceof SocialError && error.status === 404)) throw error; } }
      return result;
    });
  }
  async circle(actor: SocialActor, id: string): Promise<CircleView> { return this.transaction(actor, db => this.circleView(db,actor,id)); }
  private async operation(db: PoolClient, actor: SocialActor, operation: string, key: string, input: unknown, create: () => Promise<string>): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) throw new SocialError(400,'invalid_operation_key');
    const hash = digest(input);
    const row = (await db.query(`SELECT input_digest,object_id FROM ${this.schema}.operations WHERE participant_id=$1 AND client_id=$2 AND operation=$3 AND operation_key=$4`, [actor.participantId,actor.clientId,operation,key])).rows[0];
    if (row) {
      // Replay conflicts must not expose retained operation state after access loss.
      if (operation === 'create_circle') await this.circleView(db,actor,row.object_id);
      else await this.conversationView(db,actor,row.object_id);
      if (row.input_digest !== hash) throw conflict('idempotency_conflict');
      return row.object_id;
    }
    const id = await create();
    await db.query(`INSERT INTO ${this.schema}.operations(participant_id,client_id,operation,operation_key,input_digest,object_id) VALUES($1,$2,$3,$4,$5,$6)`, [actor.participantId,actor.clientId,operation,key,hash,id]);
    return id;
  }
  async createCircle(actor: SocialActor, operationKey: string): Promise<CircleView> {
    return this.transaction(actor, async db => {
      const id = await this.operation(db,actor,'create_circle',operationKey,{},async () => {
        const id: string = (await db.query(`INSERT INTO ${this.schema}.circles DEFAULT VALUES RETURNING id`)).rows[0].id;
        await db.query(`INSERT INTO ${this.schema}.circle_memberships VALUES($1,$2,'OWNER','ACTIVE')`, [id,actor.participantId]);
        return id;
      });
      return this.circleView(db,actor,id);
    }, `create_circle:${operationKey}`);
  }
  async inviteCircle(actor: SocialActor, id: string, participantId: string, expectedRevision: string): Promise<CircleView> {
    return this.transaction(actor, async db => {
      const view = await this.circleView(db,actor,id,true); this.manager(view.role); this.expect(view.revision,expectedRevision);
      participantId = await this.canonical(db,participantId);
      if (!await this.eligible(db,participantId)) throw missing();
      const target = view.members!.find(member => member.participantId === participantId);
      if (target?.state === 'ACTIVE' || target?.state === 'INVITED') throw conflict('already_member');
      await db.query(`UPDATE ${this.schema}.circle_memberships SET state='INVITED',role='MEMBER' WHERE circle_id=$1 AND participant_id=ANY($2::uuid[])`, [id,await this.circleParticipantRefs(db,id,participantId)]);
      await db.query(`INSERT INTO ${this.schema}.circle_memberships VALUES($1,$2,'MEMBER','INVITED') ON CONFLICT(circle_id,participant_id) DO UPDATE SET state='INVITED',role='MEMBER'`, [id,participantId]);
      await this.updateCircle(db,id); return this.circleView(db,actor,id);
    });
  }
  async acceptCircle(actor: SocialActor, id: string, expectedRevision: string): Promise<CircleView> {
    return this.transaction(actor, async db => {
      const view = await this.circleView(db,actor,id); this.expect(view.revision,expectedRevision);
      if (view.state !== 'INVITED') throw conflict('not_invited');
      await db.query(`UPDATE ${this.schema}.circle_memberships SET state='ACTIVE' WHERE circle_id=$1 AND participant_id=ANY($2::uuid[])`, [id,await this.circleParticipantRefs(db,id,actor.participantId)]);
      await this.updateCircle(db,id); return this.circleView(db,actor,id);
    });
  }
  async leaveCircle(actor: SocialActor, id: string, expectedRevision: string): Promise<CircleView> {
    return this.transaction(actor, async db => {
      const view = await this.circleView(db,actor,id); this.expect(view.revision,expectedRevision);
      await db.query(`UPDATE ${this.schema}.circle_memberships SET state='LEFT' WHERE circle_id=$1 AND participant_id=ANY($2::uuid[])`, [id,await this.circleParticipantRefs(db,id,actor.participantId)]);
      if (view.role === 'OWNER' && view.state === 'ACTIVE') await this.checkCircleOwners(db,id); await this.updateCircle(db,id);
      return { id, revision: (BigInt(view.revision)+1n).toString(),createdAt:view.createdAt,role:view.role,state:'LEFT' };
    });
  }
  async removeCircleMember(actor: SocialActor, id: string, participantId: string, expectedRevision: string): Promise<CircleView> {
    return this.transaction(actor, async db => {
      const view = await this.circleView(db,actor,id,true); this.manager(view.role); this.expect(view.revision,expectedRevision);
      participantId = await this.canonical(db,participantId);
      const target = view.members!.find(member => member.participantId === participantId);
      if (!target || !['ACTIVE','INVITED'].includes(target.state)) throw missing();
      if (target.role === 'OWNER') this.owner(view.role);
      if (participantId === actor.participantId) throw conflict('use_leave');
      await db.query(`UPDATE ${this.schema}.circle_memberships SET state='REMOVED' WHERE circle_id=$1 AND participant_id=ANY($2::uuid[])`, [id,await this.circleParticipantRefs(db,id,participantId)]);
      await this.checkCircleOwners(db,id); await this.updateCircle(db,id); return this.circleView(db,actor,id);
    });
  }
  async circleRole(actor: SocialActor, id: string, participantId: string, role: Role, expectedRevision: string): Promise<CircleView> {
    return this.transaction(actor, async db => {
      const view = await this.circleView(db,actor,id,true); this.owner(view.role); this.expect(view.revision,expectedRevision);
      participantId = await this.canonical(db,participantId);
      if (!view.members!.some(member => member.participantId === participantId && member.state === 'ACTIVE')) throw missing();
      await db.query(`UPDATE ${this.schema}.circle_memberships SET role=$3 WHERE circle_id=$1 AND participant_id=ANY($2::uuid[])`, [id,await this.circleParticipantRefs(db,id,participantId),role]);
      await this.checkCircleOwners(db,id); await this.updateCircle(db,id); return this.circleView(db,actor,id);
    });
  }
  async deleteCircle(actor: SocialActor, id: string, expectedRevision: string): Promise<{ deleted: true }> {
    return this.transaction(actor, async db => {
      const view = await this.circleView(db,actor,id,true); this.owner(view.role); this.expect(view.revision,expectedRevision);
      await db.query(`UPDATE ${this.schema}.circles SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1`, [id]);
      await this.reconcileAll(db); return { deleted: true };
    });
  }
  private async canReferenceUser(db: PoolClient, actor: SocialActor, participantId: string): Promise<boolean> {
    if (actor.participantId === participantId) return true;
    const circles = (await db.query(`SELECT id FROM ${this.schema}.circles WHERE deleted_at IS NULL`)).rows;
    for (const circle of circles) {
      const members = await this.circleMembers(db,circle.id);
      if (members.some(member => member.participantId === actor.participantId && member.state === 'ACTIVE') && members.some(member => member.participantId === participantId && member.state === 'ACTIVE')) return true;
    }
    return false;
  }
  private async resolve(db: PoolClient, input: Source[], actor?: SocialActor, selfExcluded: string[] = [], contextUsers: Set<string> = new Set()): Promise<Resolution> {
    const sources = normalize(input);
    // Check the complete requested capability set before resolving any source.
    if (actor && ((sources.some(source => source.type === 'CIRCLE') && !actor.scopes.includes('circles:read')) || (sources.some(source => source.type === 'EVENT') && !actor.scopes.includes('events:read')))) throw new SocialError(403,'insufficient_scope');
    const included = new Map<string, Source[]>();
    const excluded = new Set<string>();
    const versions: unknown[] = [];
    let unavailable = false;
    for (const source of sources) {
      let ids: string[] = [];
      let version = '';
      if (source.type === 'USER') {
        const id = await this.canonical(db,source.id);
        const active = await this.eligible(db,id);
        if (actor && !contextUsers.has(id) && (!active || !await this.canReferenceUser(db,actor,id))) throw missing();
        ids = active ? [id] : [];
        version = `${id}:${active}`;
      } else if (source.type === 'CIRCLE') {
        const circle = (await db.query<CircleRow>(`SELECT * FROM ${this.schema}.circles WHERE id=$1 AND deleted_at IS NULL`, [source.id])).rows[0];
        const members = circle ? await this.circleMembers(db,source.id) : [];
        if (actor && !members.some(member => member.participantId === actor.participantId && member.state === 'ACTIVE')) throw missing();
        ids = members.filter(member => member.state === 'ACTIVE').map(member => member.participantId);
        version = circle?.revision ?? 'deleted';
      } else if (source.type === 'EVENT') {
        const event = await this.events.resolve(db,source.id);
        if (!event) unavailable = true;
        const viewers = event ? await Promise.all(event.rosterViewers.map(id => this.canonical(db,id))) : [];
        if (actor && (!event || !viewers.includes(actor.participantId))) throw missing();
        ids = event?.participants ?? [];
        version = event?.version ?? 'unavailable';
      } else throw new SocialError(400,'invalid_source');
      const canonicalIds = new Set<string>();
      for (const id of ids) { const canonical = await this.canonical(db,id); if (await this.eligible(db,canonical)) canonicalIds.add(canonical); }
      const canonicalList = [...canonicalIds].sort();
      versions.push([sourceKey(source),version,canonicalList]);
      for (const id of canonicalList) {
        if (source.operation === 'EXCLUDE') excluded.add(id);
        else included.set(id,[...(included.get(id) ?? []),source]);
      }
    }
    for (const id of selfExcluded) excluded.add(await this.canonical(db,id));
    // An unavailable source is not an authoritative empty set: dropping an
    // EXCLUDE source could otherwise grant new access. Freeze the whole policy
    // until the adapter can provide a versioned roster, including explicit empty.
    const eligible = unavailable ? [] : [...included].filter(([id]) => !excluded.has(id)).map(([participantId,provenance]) => ({ participantId,provenance })).sort((a,b) => a.participantId.localeCompare(b.participantId));
    return { sources,eligible,excluded:[...excluded].sort(),fingerprint:digest([versions,[...excluded].sort()]) };
  }
  private async contextUsers(db: PoolClient, id: string): Promise<Set<string>> {
    const current = await this.resolution(db,id);
    const users = new Set(current.eligible.map(member => member.participantId));
    for (const source of current.sources) if (source.type === 'USER') users.add(await this.canonical(db,source.id));
    return users;
  }
  async preview(actor: SocialActor, sources: Source[], conversationId?: string): Promise<Preview> {
    return this.transaction(actor, async db => {
      let users = new Set<string>();
      let excluded: string[] = [];
      if (conversationId !== undefined) {
        await this.conversationView(db,actor,conversationId,true);
        users = await this.contextUsers(db,conversationId);
        excluded = await this.exclusions(db,conversationId);
      }
      const { fingerprint: _fingerprint, ...preview } = await this.resolve(db,sources,actor,excluded,users);
      return preview;
    });
  }
  private async sources(db: PoolClient, id: string): Promise<Source[]> {
    return (await db.query<Source>(`SELECT type,source_id AS id,operation FROM ${this.schema}.audience_sources WHERE conversation_id=$1 ORDER BY operation,type,source_id`, [id])).rows;
  }
  private async exclusions(db: PoolClient, id: string): Promise<string[]> {
    return (await db.query(`SELECT participant_id FROM ${this.schema}.self_exclusions WHERE conversation_id=$1 ORDER BY participant_id`, [id])).rows.map(row => row.participant_id as string);
  }
  private async roles(db: PoolClient, id: string): Promise<Map<string, Role>> {
    const rows = (await db.query(`SELECT participant_id,role FROM ${this.schema}.conversation_roles WHERE conversation_id=$1`, [id])).rows;
    const result = new Map<string,Role>();
    for (const row of rows) {
      const canonical = await this.canonical(db,row.participant_id);
      const existing = result.get(canonical) ?? 'MEMBER';
      if (['MEMBER','ADMIN','OWNER'].indexOf(row.role) >= ['MEMBER','ADMIN','OWNER'].indexOf(existing)) result.set(canonical,row.role);
    }
    return result;
  }
  private async resolution(db: PoolClient, id: string): Promise<Resolution> {
    return this.resolve(db,await this.sources(db,id),undefined,await this.exclusions(db,id));
  }
  private async reconcile(db: PoolClient, id: string, force = false): Promise<void> {
    const row = (await db.query<ConversationRow>(`SELECT * FROM ${this.schema}.conversations WHERE id=$1`, [id])).rows[0];
    if (!row) return;
    const resolution = row.deleted_at ? { eligible: [], fingerprint:'deleted' } : await this.resolution(db,id);
    const roles = await this.roles(db,id);
    const orphaned = !resolution.eligible.some(member => roles.get(member.participantId) === 'OWNER');
    const changed = row.fingerprint !== resolution.fingerprint || row.orphaned !== orphaned || force;
    const generation = changed ? (BigInt(row.generation)+1n).toString() : row.generation;
    // Never trust an ACTIVE materialization: admission belongs to #10. Current
    // canonical eligibility is checked even if a stale writer forged that state.
    const open = (await db.query(`SELECT id,participant_id,state,provenance FROM ${this.schema}.membership_intervals WHERE conversation_id=$1 AND ended_at IS NULL`, [id])).rows;
    const eligible = new Map(resolution.eligible.map(member => [member.participantId,member]));
    const selfExcluded = new Set(await Promise.all((await this.exclusions(db,id)).map(participantId => this.canonical(db,participantId))));
    for (const interval of open) {
      if (!eligible.has(interval.participant_id)) await db.query(`UPDATE ${this.schema}.membership_intervals SET ended_at=clock_timestamp(),state=$2,generation=$3 WHERE id=$1`, [interval.id,selfExcluded.has(interval.participant_id) ? 'LEFT' : 'REMOVED',generation]);
      else await db.query(`UPDATE ${this.schema}.membership_intervals SET state='PENDING',generation=$2,provenance=$3::jsonb WHERE id=$1`, [interval.id,generation,JSON.stringify(eligible.get(interval.participant_id)!.provenance)]);
    }
    for (const member of resolution.eligible) {
      if (!open.some(interval => interval.participant_id === member.participantId)) await db.query(`INSERT INTO ${this.schema}.membership_intervals(conversation_id,participant_id,state,generation,provenance) VALUES($1,$2,'PENDING',$3,$4::jsonb)`, [id,member.participantId,generation,JSON.stringify(member.provenance)]);
    }
    await db.query(`UPDATE ${this.schema}.conversations SET generation=$2,fingerprint=$3,orphaned=$4,send_gate='CLOSED' WHERE id=$1`, [id,generation,resolution.fingerprint,orphaned]);
  }
  private async reconcileAll(db: PoolClient): Promise<void> {
    for (const row of (await db.query(`SELECT id FROM ${this.schema}.conversations WHERE deleted_at IS NULL ORDER BY id`)).rows) await this.reconcile(db,row.id);
  }
  /** Caller already holds the affected identity account lock, in its own SQL
   * transaction. Revocation is never rejected to preserve social ownership. */
  async invalidateParticipant(db: PoolClient, participantId: string): Promise<void> {
    await this.graphLock(db);
    const canonical = await this.canonical(db,participantId);
    const affected = new Set<string>();
    for (const row of (await db.query(`SELECT conversation_id,participant_id FROM ${this.schema}.membership_intervals WHERE ended_at IS NULL`)).rows) if (await this.canonical(db,row.participant_id) === canonical) affected.add(row.conversation_id);
    await this.reconcileAll(db);
    for (const id of affected) await this.reconcile(db,id,true);
  }
  /** #12 must acquire this same policy lock before mutating its event source and
   * call this hook in that transaction, before commit. */
  async invalidateEvent(db: PoolClient, eventId: string): Promise<void> {
    await this.graphLock(db);
    const rows = (await db.query(`SELECT DISTINCT conversation_id FROM ${this.schema}.audience_sources WHERE type='EVENT' AND source_id=$1 ORDER BY conversation_id`, [eventId])).rows;
    for (const row of rows) await this.reconcile(db,row.conversation_id,true);
  }
  private async conversationView(db: PoolClient, actor: SocialActor, id: string, manage: true): Promise<PendingConversationView>;
  private async conversationView(db: PoolClient, actor: SocialActor, id: string, manage?: false): Promise<ConversationView>;
  private async conversationView(db: PoolClient, actor: SocialActor, id: string, manage: boolean): Promise<ConversationView>;
  private async conversationView(db: PoolClient, actor: SocialActor, id: string, manage = false): Promise<ConversationView> {
    const row = (await db.query<ConversationRow>(`SELECT * FROM ${this.schema}.conversations WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!row) throw missing();
    const resolution = await this.resolution(db,id);
    const roles = await this.roles(db,id);
    const role = roles.get(actor.participantId) ?? 'MEMBER';
    const eligible = resolution.eligible.some(member => member.participantId === actor.participantId);
    const left = (await Promise.all((await this.exclusions(db,id)).map(participantId => this.canonical(db,participantId)))).includes(actor.participantId);
    if (!eligible && !left) throw missing();
    if (manage && (!eligible || (role !== 'OWNER' && role !== 'ADMIN'))) throw missing();
    if (!eligible) return { id,revision:row.revision,createdAt:iso(row.created_at),memberState:'LEFT',sendGate:'CLOSED' };
    const view: PendingConversationView = { id,revision:row.revision,generation:row.generation,createdAt:iso(row.created_at),role,memberState:'PENDING',orphaned:row.orphaned,sendGate:'CLOSED' };
    if (eligible && (role === 'OWNER' || role === 'ADMIN')) {
      view.sources = resolution.sources;
      const intervals = (await db.query(`SELECT id,participant_id FROM ${this.schema}.membership_intervals WHERE conversation_id=$1 AND ended_at IS NULL`, [id])).rows;
      view.members = resolution.eligible.map(member => ({ ...member,role:roles.get(member.participantId) ?? 'MEMBER',state:'PENDING',intervalId:intervals.find(interval => interval.participant_id === member.participantId)!.id as string }));
    }
    return view;
  }
  async listConversations(actor: SocialActor): Promise<ConversationView[]> {
    return this.transaction(actor, async db => {
      const rows = (await db.query(`SELECT id FROM ${this.schema}.conversations WHERE deleted_at IS NULL ORDER BY created_at,id`)).rows;
      const result: ConversationView[] = [];
      for (const row of rows) { try { result.push(await this.conversationView(db,actor,row.id)); } catch (error) { if (!(error instanceof SocialError && error.status === 404)) throw error; } }
      return result;
    });
  }
  async conversation(actor: SocialActor, id: string): Promise<ConversationView> { return this.transaction(actor,db => this.conversationView(db,actor,id)); }
  private async writeSources(db: PoolClient, id: string, sources: Source[]): Promise<void> {
    await db.query(`DELETE FROM ${this.schema}.audience_sources WHERE conversation_id=$1`, [id]);
    for (const source of normalize(sources)) await db.query(`INSERT INTO ${this.schema}.audience_sources(conversation_id,type,source_id,operation) VALUES($1,$2,$3,$4)`, [id,source.type,source.id,source.operation]);
  }
  private async checkConversationOwners(db: PoolClient, id: string): Promise<void> {
    const roles = await this.roles(db,id);
    if (!(await this.resolution(db,id)).eligible.some(member => roles.get(member.participantId) === 'OWNER')) throw conflict('last_owner');
  }
  async createConversation(actor: SocialActor, operationKey: string, sources: Source[]): Promise<ConversationView> {
    return this.transaction(actor, async db => {
      const seeded = normalize([...sources,{ type:'USER',id:actor.participantId,operation:'INCLUDE' }]);
      const id = await this.operation(db,actor,'create_conversation',operationKey,seeded,async () => {
        await this.resolve(db,seeded,actor);
        const id: string = (await db.query(`INSERT INTO ${this.schema}.conversations DEFAULT VALUES RETURNING id`)).rows[0].id;
        await this.writeSources(db,id,seeded);
        await db.query(`INSERT INTO ${this.schema}.conversation_roles VALUES($1,$2,'OWNER')`, [id,actor.participantId]);
        await this.checkConversationOwners(db,id); await this.reconcile(db,id); return id;
      });
      return this.conversationView(db,actor,id);
    }, `create_conversation:${operationKey}`);
  }
  async setAudience(actor: SocialActor, id: string, sources: Source[], expectedRevision: string): Promise<ConversationView> {
    return this.transaction(actor, async db => {
      const view = await this.conversationView(db,actor,id,true); this.expect(view.revision,expectedRevision);
      if (view.orphaned) throw conflict('orphaned_conversation');
      const before = await this.resolution(db,id);
      const proposed = await this.resolve(db,sources,actor,await this.exclusions(db,id),await this.contextUsers(db,id));
      if (view.role === 'ADMIN') {
        const roles = await this.roles(db,id);
        if (before.eligible.some(member => roles.get(member.participantId) === 'OWNER' && !proposed.eligible.some(next => next.participantId === member.participantId))) throw missing();
      }
      await this.writeSources(db,id,sources); await this.checkConversationOwners(db,id);
      await db.query(`UPDATE ${this.schema}.conversations SET revision=revision+1 WHERE id=$1`, [id]);
      await this.reconcile(db,id);
      // An administrator can remove their own inherited contribution. Return no
      // private roster after losing authority; this update instead requires an
      // explicit leave so the response and continued client control are defined.
      return this.conversationView(db,actor,id,true);
    });
  }
  async conversationRole(actor: SocialActor, id: string, participantId: string, role: Role, expectedRevision: string): Promise<ConversationView> {
    return this.transaction(actor, async db => {
      const view = await this.conversationView(db,actor,id,true); this.owner(view.role); this.expect(view.revision,expectedRevision);
      if (view.orphaned) throw conflict('orphaned_conversation');
      participantId = await this.canonical(db,participantId);
      if (!(await this.resolution(db,id)).eligible.some(member => member.participantId === participantId)) throw missing();
      for (const row of (await db.query(`SELECT participant_id FROM ${this.schema}.conversation_roles WHERE conversation_id=$1`, [id])).rows) {
        if (await this.canonical(db,row.participant_id) === participantId) await db.query(`UPDATE ${this.schema}.conversation_roles SET role=$3 WHERE conversation_id=$1 AND participant_id=$2`, [id,row.participant_id,role]);
      }
      await db.query(`INSERT INTO ${this.schema}.conversation_roles VALUES($1,$2,$3) ON CONFLICT(conversation_id,participant_id) DO UPDATE SET role=EXCLUDED.role`, [id,participantId,role]);
      await this.checkConversationOwners(db,id);
      await db.query(`UPDATE ${this.schema}.conversations SET revision=revision+1 WHERE id=$1`, [id]);
      await this.reconcile(db,id,true); return this.conversationView(db,actor,id);
    });
  }
  async leaveConversation(actor: SocialActor, id: string, expectedRevision: string): Promise<{ left: true }> {
    return this.transaction(actor, async db => {
      const view = await this.conversationView(db,actor,id); if (view.memberState !== 'PENDING') throw missing(); this.expect(view.revision,expectedRevision);
      await db.query(`INSERT INTO ${this.schema}.self_exclusions VALUES($1,$2) ON CONFLICT DO NOTHING`, [id,actor.participantId]);
      if (!view.orphaned) await this.checkConversationOwners(db,id);
      await db.query(`UPDATE ${this.schema}.conversations SET revision=revision+1 WHERE id=$1`, [id]);
      await this.reconcile(db,id); return { left:true };
    });
  }
  async rejoinConversation(actor: SocialActor, id: string, expectedRevision: string): Promise<ConversationView> {
    return this.transaction(actor, async db => {
      const view = await this.conversationView(db,actor,id); if (view.memberState !== 'LEFT') throw missing(); this.expect(view.revision,expectedRevision);
      const rows = (await db.query(`SELECT participant_id FROM ${this.schema}.self_exclusions WHERE conversation_id=$1`, [id])).rows;
      for (const row of rows) if (await this.canonical(db,row.participant_id) === actor.participantId) await db.query(`DELETE FROM ${this.schema}.self_exclusions WHERE conversation_id=$1 AND participant_id=$2`, [id,row.participant_id]);
      if (!(await this.resolution(db,id)).eligible.some(member => member.participantId === actor.participantId)) throw missing();
      await db.query(`UPDATE ${this.schema}.conversations SET revision=revision+1 WHERE id=$1`, [id]);
      await this.reconcile(db,id); return this.conversationView(db,actor,id);
    });
  }
  async deleteConversation(actor: SocialActor, id: string, expectedRevision: string): Promise<{ deleted: true }> {
    return this.transaction(actor, async db => {
      const view = await this.conversationView(db,actor,id,true); this.owner(view.role); this.expect(view.revision,expectedRevision);
      if (view.orphaned) throw conflict('orphaned_conversation');
      await db.query(`UPDATE ${this.schema}.conversations SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1`, [id]);
      await this.reconcile(db,id); return { deleted:true };
    });
  }
  async withConversationAccess<T>(actor: SocialActor, id: string, action: 'manage' | 'content', callback: (db: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(actor, async db => {
      const view = await this.conversationView(db,actor,id,action === 'manage');
      if (view.memberState !== 'PENDING') throw missing();
      if (action === 'content') throw new SocialError(409,'crypto_not_ready');
      if (view.orphaned) throw conflict('orphaned_conversation');
      return callback(db);
    });
  }
}
