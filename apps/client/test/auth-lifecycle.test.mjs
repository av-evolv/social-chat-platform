import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';
import vm from 'node:vm';
const compiled = await build({entryPoints:[new URL('../src/auth/session.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/^(expo-auth-session|expo-crypto|expo-secure-store|react-native|@larynx\/i18n)$|i18n\/state$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='react-native'?"export const Platform={OS:'ios'};":a.path==='expo-secure-store'?"export const getItemAsync=()=>globalThis.fixture.stored; export const setItemAsync=async()=>{if(globalThis.fixture.failWrite)throw new Error('Storage unavailable');}; export const deleteItemAsync=async()=>{globalThis.fixture.stored=null;}; export const WHEN_UNLOCKED_THIS_DEVICE_ONLY=1;":a.path==='expo-auth-session'?"export const AuthRequest=class{constructor(options){this.state=options.state;this.codeVerifier='verifier';}async makeAuthUrlAsync(){return 'http://localhost:3000/oidc/auth';}async promptAsync(){return {type:'success',url:'larynx://oauth/callback?code=test&state='+this.state+'&iss='+encodeURIComponent('http://localhost:3000/oidc')};}};export const CodeChallengeMethod={};export const ResponseType={};":a.path==='expo-crypto'?"export const randomUUID=()=>'';":a.path==='@larynx/i18n'?"export const translate=(_,key)=>key;":"export const initializeLocale=async()=>{};export const getLocale=()=> 'en';export const getLocaleVersion=()=>0;export const applyAccountLocale=async()=>{};",loader:'js'}));
}}]});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function setup(fetch,expired=false,overrides={}){const module={exports:{}};const fixture={stored:JSON.stringify({issuer:'http://localhost:3000/oidc',clientId:'larynx-native',accessToken:'test',refreshToken:'refresh',expiresAt:expired?0:Date.now()+3600000}),...overrides};vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,fixture,fetch,process:{env:{}},URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout});await module.exports.restoreSession();return module.exports;}
for(const stage of ['response','body']) test(`account request rejects stale successful ${stage}`,async()=>{const entered=deferred(),release=deferred();const api=await setup(async()=>{entered.resolve();if(stage==='response')await release.promise;return {ok:true,status:200,json:async()=>{if(stage==='body')await release.promise;return {private:'value'};}};});const pending=api.accountRequest('/v1/sync');await entered.promise;await api.clearSession();release.resolve();await assert.rejects(pending,/signedOut/);});
for(const before of [true,false])test(`caller cancellation ${before?'before':'during'} fetch`,async()=>{const entered=deferred();let calls=0;const api=await setup(async(_url,{signal})=>{calls++;entered.resolve();return new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});});const controller=new AbortController();if(before)controller.abort();const pending=api.accountRequest('/v1/sync','GET',undefined,{signal:controller.signal});if(!before){await entered.promise;controller.abort();}await assert.rejects(pending,{name:'AbortError'});if(before)assert.equal(calls,0);});
test('session subscriptions reset on clear, unsubscribe, but not refresh',async()=>{const api=await setup(async url=>url.includes('well-known')?{ok:true,json:async()=>({issuer:'http://localhost:3000/oidc',authorization_response_iss_parameter_supported:true,code_challenge_methods_supported:['S256'],authorization_endpoint:'http://localhost:3000/oidc/auth',token_endpoint:'http://localhost:3000/oidc/token'})}:url.endsWith('/token')?{ok:true,json:async()=>({access_token:'fresh',token_type:'Bearer',expires_in:3600})}:{ok:true,status:200,json:async()=>({})},true);const initial=api.getSessionGeneration();let changes=0;const unsubscribe=api.subscribeSession(()=>changes++);await api.accountRequest('/v1/sync');assert.equal(api.getSessionGeneration(),initial);assert.equal(changes,0);await api.clearSession();assert.equal(changes,1);assert.equal(api.getSessionGeneration(),initial+1);unsubscribe();await api.clearSession();assert.equal(changes,1);});

test('a newly confirmed grant invalidates successful requests from the previous grant', async () => {
  const entered = deferred(), release = deferred();
  const api = await setup(async url => {
    if (url.endsWith('/v1/old')) { entered.resolve(); await release.promise; return { ok: true, status: 200, json: async () => ({ private: 'old' }) }; }
    if (url.includes('well-known')) return { ok: true, json: async () => ({ issuer: 'http://localhost:3000/oidc', authorization_response_iss_parameter_supported: true, code_challenge_methods_supported: ['S256'], authorization_endpoint: 'http://localhost:3000/oidc/auth', token_endpoint: 'http://localhost:3000/oidc/token' }) };
    if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'new', token_type: 'Bearer', expires_in: 3600, id_token: 'confirmed-fixture' }) };
    return { ok: true, status: 200, json: async () => ({ locale: null }) };
  });
  const initial = api.getSessionGeneration();
  let changes = 0;
  api.subscribeSession(() => changes++);
  const pending = api.accountRequest('/v1/old');
  await entered.promise;
  await api.signIn();
  assert.equal(api.getSessionGeneration(), initial + 1);
  assert.equal(changes, 2);
  release.resolve();
  await assert.rejects(pending, /signedOut/);
});
test('caller abort remains connected while the response body is being read', async () => {
  const entered = deferred();
  const api = await setup(async (_url, { signal }) => ({ ok: true, status: 200, json: () => {
    entered.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }));
  const controller = new AbortController();
  const pending = api.accountRequest('/v1/sync', 'GET', undefined, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
test('an unauthorized account response clears the current session and notifies subscribers', async () => {
  const api = await setup(async () => ({ ok: false, status: 401 }));
  let changes = 0;
  api.subscribeSession(() => changes++);
  await assert.rejects(api.accountRequest('/v1/sync'), /ended/);
  assert.equal(api.hasSession(), false);
  assert.equal(changes, 1);
});

test('a failed new-grant storage write never leaves an accepted in-memory session', async () => {
  const api = await setup(async url => {
    if (url.includes('well-known')) return { ok: true, json: async () => ({ issuer: 'http://localhost:3000/oidc', authorization_response_iss_parameter_supported: true, code_challenge_methods_supported: ['S256'], authorization_endpoint: 'http://localhost:3000/oidc/auth', token_endpoint: 'http://localhost:3000/oidc/token' }) };
    if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'new', token_type: 'Bearer', expires_in: 3600, id_token: 'confirmed-fixture' }) };
    return { ok: true, status: 200, json: async () => ({ locale: null }) };
  }, false, { failWrite: true });
  const observed = [];
  api.subscribeSession(() => observed.push(api.hasSession()));
  await assert.rejects(api.signIn(), /Storage unavailable/);
  assert.equal(api.hasSession(), false);
  assert.ok(observed.every(value => value === false));
});
