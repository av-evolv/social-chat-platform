import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { OAuthAccessError, type createOAuth } from '../oauth/index.js';
import { SocialError } from '../social/types.js';
import { canonicalEmail } from '../identity/config.js';
import type { InvitationStore } from './store.js';
import type { InvitationMailer } from './mail.js';
import { InvitationError, type Delivery, type InvitationActor, type IssuedInvitation, type Target } from './types.js';

type OAuth = Pick<Awaited<ReturnType<typeof createOAuth>>, 'authorize'>;
const invalid = (): never => { throw new InvitationError(400,'invalid_request'); };
const uuid = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : invalid();
const revision = (v: unknown): string => typeof v === 'string' && /^[1-9][0-9]{0,17}$/.test(v) ? v : invalid();
const credential = (v: unknown): string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : invalid();
const email = (v: unknown): string => { try { return canonicalEmail(v); } catch { return invalid(); } };
function bodyOf(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(key => !keys.includes(key))) return invalid();
  return v as Record<string, unknown>;
}
function target(v: unknown): Target {
  const value = bodyOf(v,['type','id']);
  if (value.type !== 'CIRCLE' && value.type !== 'CONVERSATION') return invalid();
  return {type:value.type,id:uuid(value.id)};
}
export async function mountInvitations(app: FastifyInstance, oauth: OAuth, store: InvitationStore, mail: InvitationMailer) {
  if (!app.hasDecorator('rateLimit')) await app.register(rateLimit,{global:false});
  const limited = app.rateLimit({max:60,timeWindow:60_000,cache:5000});
  async function authorize(request: FastifyRequest, scopes: string[]): Promise<InvitationActor> {
    for (const scope of scopes) {
      try { return await oauth.authorize(request.raw,[scope]); }
      catch (error) { if (!(error instanceof OAuthAccessError && error.status === 403)) throw error; }
    }
    throw new OAuthAccessError(403,'insufficient_scope');
  }
  async function deliver(delivery: Delivery | undefined): Promise<'PENDING' | 'SENT' | 'FAILED'> {
    if (!delivery) return 'PENDING';
    let sent = false;
    try { await mail(delivery); sent = true; } catch { app.log.warn('Invitation email delivery failed'); }
    try { await store.recordDelivery(delivery,sent); } catch { app.log.warn('Invitation delivery status awaits explicit retry'); return 'PENDING'; }
    return sent ? 'SENT' : 'FAILED';
  }
  async function sendIssued(issued: IssuedInvitation) {
    return {...issued.invitation,delivery:issued.delivery ? await deliver(issued.delivery) : issued.invitation.delivery};
  }
  function route(method:'GET'|'POST',path:string,scopes:string[],fields:string[],handler:(actor:InvitationActor,id:string,body:Record<string,unknown>)=>Promise<unknown>) {
    app.route({method,url:`/v1/invitations${path}`,bodyLimit:8192,onRequest:limited,
      errorHandler(error,_request,reply) { if(error.statusCode===429) return reply.header('cache-control','no-store').code(429).send({error:'too_many_requests'}); return reply.send(error); },
      handler:async(request,reply)=>{
        reply.header('cache-control','no-store');
        try {
          const actor=await authorize(request,scopes);
          const id=path.includes(':id')?uuid((request.params as {id:string}).id):'';
          return await handler(actor,id,method==='POST'?bodyOf(request.body,fields):{});
        } catch(error) {
          if(error instanceof InvitationError || error instanceof SocialError || error instanceof OAuthAccessError) {
            if(error.status===401) reply.header('www-authenticate','Bearer');
            if(error.status===403 && error.code==='insufficient_scope') reply.header('www-authenticate','Bearer error="insufficient_scope"');
            if(error.status===429) reply.header('retry-after','600');
            return reply.code(error.status).send({error:error.code});
          }
          app.log.error('Invitation operation failed');
          return reply.code(503).send({error:'temporarily_unavailable'});
        }
      }});
  }
  const read=['circles:read','conversations:read']; const write=['circles:write','conversations:write'];
  route('GET','',read,[],a=>store.list(a));
  route('POST','',write,['target','email','operation_key','expected_revision'],async(a,_id,b)=>{
    const issued=await store.create(a,{target:target(b.target),email:email(b.email),operationKey:uuid(b.operation_key),expectedRevision:revision(b.expected_revision)});
    return sendIssued(issued);
  });
  route('POST','/:id/resend',write,['expected_revision'],async(a,id,b)=>{
    return sendIssued(await store.resend(a,id,revision(b.expected_revision)));
  });
  route('POST','/:id/revoke',write,['expected_revision'],(a,id,b)=>store.revoke(a,id,revision(b.expected_revision)));
  route('POST','/proof',['profile:write'],['token','email'],async(a,_id,b)=>{
    const issued=await store.requestProof(a,{token:credential(b.token),email:email(b.email)}); await deliver(issued.delivery);
    return {sent:true};
  });
  route('POST','/accept',['profile:write'],['token','email','code','confirm_accept'],(a,_id,b)=>{
    if(b.confirm_accept!==true) return invalid();
    return store.accept(a,{token:credential(b.token),email:email(b.email),code:credential(b.code),confirmAccept:true});
  });
}
