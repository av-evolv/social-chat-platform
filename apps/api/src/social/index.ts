import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { OAuthAccessError, type createOAuth } from '../oauth/index.js';
import type { SocialStore } from './store.js';
import { SocialError, type Role, type Source, type SocialActor } from './types.js';

type OAuth = Pick<Awaited<ReturnType<typeof createOAuth>>, 'authorize'>;
const invalid = (): never => { throw new SocialError(400, 'invalid_request'); };
const uuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : invalid();
const revision = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]{0,17}$/.test(value) ? value : invalid();
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function sources(value: unknown): Source[] {
  if (!Array.isArray(value) || value.length > 100) return invalid();
  return value.map(item => {
    const s = object(item, ['type','id','operation']);
    if (!['USER','CIRCLE','EVENT'].includes(String(s.type)) || !['INCLUDE','EXCLUDE'].includes(String(s.operation))) return invalid();
    return { type: s.type as Source['type'], id: uuid(s.id), operation: s.operation as Source['operation'] };
  });
}
const role = (value: unknown): Role => ['OWNER','ADMIN','MEMBER'].includes(String(value)) ? value as Role : invalid();

export async function mountSocial(app: FastifyInstance, oauth: OAuth, store: SocialStore) {
  await app.register(rateLimit, { global: false, max: 120, timeWindow: 60_000, cache: 5000 });
  // Reuse one limiter so changing social routes cannot reset an IP's budget.
  // Fastify's request.ip honors forwarding headers only with trusted proxies.
  const socialRateLimit = app.rateLimit();
  function route(method: 'GET' | 'POST', path: string, scope: string, fields: string[], handler: (actor: SocialActor, id: string, body: Record<string, unknown>) => Promise<unknown>) {
    app.route({ method, url: `/v1/social/${path}`, bodyLimit: 32_768, onRequest: socialRateLimit,
      errorHandler(error, _request, reply) {
        if (error.statusCode === 429) return reply.header('cache-control','no-store').code(429).send({ error:'too_many_requests' });
        return reply.send(error);
      }, handler: async (request: FastifyRequest, reply) => {
      reply.header('cache-control','no-store');
      try {
        const actor = await oauth.authorize(request.raw, [scope]);
        const id = path.includes(':id') ? uuid((request.params as { id: string }).id) : '';
        const body = method === 'POST' ? object(request.body, fields) : {};
        return await handler(actor,id,body);
      } catch (error) {
        if (error instanceof OAuthAccessError || error instanceof SocialError) {
          if (error.status === 401) reply.header('www-authenticate','Bearer');
          if (error.status === 403 && error.code === 'insufficient_scope') reply.header('www-authenticate',error instanceof OAuthAccessError ? `Bearer error="insufficient_scope", scope="${scope}"` : 'Bearer error="insufficient_scope"');
          return reply.code(error.status).send({ error: error.code });
        }
        request.log.error('Audience transaction failed');
        return reply.code(503).send({ error: 'temporarily_unavailable' });
      }
    } });
  }
  route('GET','circles','circles:read',[], a => store.listCircles(a));
  route('GET','circles/:id','circles:read',[], (a,id) => store.circle(a,id));
  route('POST','circles','circles:write',['operation_key'], (a,_id,b) => store.createCircle(a,uuid(b.operation_key)));
  route('POST','circles/:id/invite','circles:write',['participant_id','expected_revision'], (a,id,b) => store.inviteCircle(a,id,uuid(b.participant_id),revision(b.expected_revision)));
  route('POST','circles/:id/remove','circles:write',['participant_id','expected_revision'], (a,id,b) => store.removeCircleMember(a,id,uuid(b.participant_id),revision(b.expected_revision)));
  route('POST','circles/:id/role','circles:write',['participant_id','role','expected_revision'], (a,id,b) => store.circleRole(a,id,uuid(b.participant_id),role(b.role),revision(b.expected_revision)));
  route('POST','circles/:id/accept','circles:write',['expected_revision'], (a,id,b) => store.acceptCircle(a,id,revision(b.expected_revision)));
  route('POST','circles/:id/leave','circles:write',['expected_revision'], (a,id,b) => store.leaveCircle(a,id,revision(b.expected_revision)));
  route('POST','circles/:id/delete','circles:write',['expected_revision'], (a,id,b) => store.deleteCircle(a,id,revision(b.expected_revision)));
  route('POST','preview','conversations:write',['sources','conversation_id'], (a,_id,b) => store.preview(a,sources(b.sources),b.conversation_id === undefined ? undefined : uuid(b.conversation_id)));
  route('GET','conversations','conversations:read',[], a => store.listConversations(a));
  route('GET','conversations/:id','conversations:read',[], (a,id) => store.conversation(a,id));
  route('POST','conversations','conversations:write',['operation_key','sources'], (a,_id,b) => store.createConversation(a,uuid(b.operation_key),sources(b.sources)));
  route('POST','conversations/:id/audience','conversations:write',['sources','expected_revision'], (a,id,b) => store.setAudience(a,id,sources(b.sources),revision(b.expected_revision)));
  route('POST','conversations/:id/role','conversations:write',['participant_id','role','expected_revision'], (a,id,b) => store.conversationRole(a,id,uuid(b.participant_id),role(b.role),revision(b.expected_revision)));
  route('POST','conversations/:id/leave','conversations:write',['expected_revision'], (a,id,b) => store.leaveConversation(a,id,revision(b.expected_revision)));
  route('POST','conversations/:id/rejoin','conversations:write',['expected_revision'], (a,id,b) => store.rejoinConversation(a,id,revision(b.expected_revision)));
  route('POST','conversations/:id/delete','conversations:write',['expected_revision'], (a,id,b) => store.deleteConversation(a,id,revision(b.expected_revision)));
}
