import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { OAuthAccessError, type createOAuth } from '../oauth/index.js';
import { SocialError, type SocialActor } from '../social/types.js';
import { MessageError, type MessageEnvelopeInput } from '../messages/types.js';
import type { MessageStore } from '../messages/store.js';
import type { SyncStore } from './store.js';
import type { SyncWakeHub } from './wake.js';
import { SyncError } from './types.js';

type OAuth = Pick<Awaited<ReturnType<typeof createOAuth>>, 'authorize'>;
const invalid = (): never => { throw new SyncError(400,'invalid_request'); };
const uuid = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : invalid();
const decimal = (v: unknown): string => typeof v === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(v) ? v : invalid();
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function integer(v: unknown, fallback: number, minimum: number, maximum: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) return invalid();
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= minimum && n <= maximum ? n : invalid();
}
function envelope(body: Record<string, unknown>): MessageEnvelopeInput {
  if (body.envelope_version !== 1 || typeof body.ciphertext !== 'string') return invalid();
  return { envelopeVersion: 1, generation: decimal(body.generation), cryptoEpoch: decimal(body.crypto_epoch), ciphertext: body.ciphertext };
}

export async function mountSync(app: FastifyInstance, oauth: OAuth, sync: Pick<SyncStore,'page'>, messages: Pick<MessageStore,'create'|'update'|'delete'|'get'>, wake: Pick<SyncWakeHub,'watch'|'close'>) {
  if (!app.hasDecorator('rateLimit')) await app.register(rateLimit, { global: false, max: 120, timeWindow: 60_000, cache: 5000 });
  const limiter = app.rateLimit({ max: 120, timeWindow: 60_000 });
  // preClose runs before Fastify waits for active HTTP requests to drain.
  app.addHook('preClose', async () => { await wake.close(); });
  function route(method: 'GET'|'POST', path: string, scope: string, fields: string[], handler: (actor: SocialActor, id: string, body: Record<string,unknown>) => Promise<unknown>) {
    app.route({ method, url: path, bodyLimit: 96 * 1024, onRequest: limiter,
      errorHandler(error, _request, reply) {
        const status = error.statusCode === 413 ? 413 : error.statusCode === 429 ? 429 : 400;
        return reply.header('cache-control','no-store').code(status).send({ error: status === 413 ? 'payload_too_large' : status === 429 ? 'too_many_requests' : 'invalid_request' });
      },
      handler: async (request, reply) => {
        reply.header('cache-control','no-store');
        try {
          const actor = await oauth.authorize(request.raw,[scope]);
          if (path === '/v1/sync') {
            const query = object(request.query,['after','limit','wait']);
            if (query.after !== undefined && (typeof query.after !== 'string' || !query.after.length || query.after.length > 4096)) return invalid();
            const after = query.after as string | undefined;
            const limit = integer(query.limit,100,1,100);
            const wait = integer(query.wait,0,0,25);
            if (wait && !after) return invalid();
            const watch = wait ? wake.watch(actor.participantId) : undefined;
            const abort = new AbortController();
            const closed = () => abort.abort();
            reply.raw.once('close',closed);
            try {
              let page = await sync.page(actor,{ ...(after ? { after } : {}), limit });
              if (watch && page.mode === 'delta' && !page.hasMore && page.resources.length === 0) {
                await watch.wait(wait * 1000,abort.signal);
                if (!abort.signal.aborted) page = await sync.page(actor,{ after: page.cursor, limit });
              }
              return page;
            } finally { watch?.close(); reply.raw.off('close',closed); }
          }
          if (Object.keys(request.query as object).length) return invalid();
          const id = uuid((request.params as { id: string }).id);
          return await handler(actor,id,method === 'POST' ? object(request.body,fields) : {});
        } catch (error) {
          if (error instanceof OAuthAccessError || error instanceof SocialError || error instanceof SyncError || error instanceof MessageError) {
            if (error.status === 401) reply.header('www-authenticate','Bearer');
            if (error.status === 403 && error.code === 'insufficient_scope') reply.header('www-authenticate',`Bearer error="insufficient_scope", scope="${scope}"`);
            if (error.status === 429) reply.header('retry-after','1');
            return reply.code(error.status).send({ error: error.code });
          }
          request.log.error('Messaging or sync transaction failed');
          return reply.code(503).send({ error:'temporarily_unavailable' });
        }
      },
    });
  }
  route('GET','/v1/sync','sync:read',[],async () => invalid());
  route('GET','/v1/messages/:id','messages:read',[],(actor,id) => messages.get(actor,id));
  const envelopeFields = ['operation_key','envelope_version','generation','crypto_epoch','ciphertext'];
  route('POST','/v1/conversations/:id/messages','messages:write',[...envelopeFields,'id'],(actor,id,body) => messages.create(actor,id,uuid(body.operation_key),{ ...envelope(body),id:uuid(body.id) }));
  route('POST','/v1/messages/:id/update','messages:write',[...envelopeFields,'expected_revision'],(actor,id,body) => messages.update(actor,id,uuid(body.operation_key),{ ...envelope(body),expectedRevision:decimal(body.expected_revision) }));
  route('POST','/v1/messages/:id/delete','messages:write',['operation_key','generation','crypto_epoch','expected_revision'],(actor,id,body) => messages.delete(actor,id,uuid(body.operation_key),{ generation:decimal(body.generation),cryptoEpoch:decimal(body.crypto_epoch),expectedRevision:decimal(body.expected_revision) }));
}
