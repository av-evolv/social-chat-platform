import { AuthRequest, CodeChallengeMethod, ResponseType } from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { callbackCode, parsePendingFlow, type PendingFlow } from './protocol';

const configuredOrigin = process.env.EXPO_PUBLIC_API_ORIGIN ?? 'http://localhost:3000';
export const apiOrigin = configuredOrigin.replace(/\/$/, '');
const issuer = `${apiOrigin}/oidc`;
const resource = `${apiOrigin}/api`;
const clientId = Platform.OS === 'web' ? 'larynx-web' : 'larynx-native';
const pendingKey = 'larynx.oauth.pending';
const tokenKey = 'larynx.oauth.tokens';
interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number }
interface Discovery { authorizationEndpoint: string; tokenEndpoint: string }
export interface Session { accountId: string; participantId: string; clientId: string; deviceId: string; scopes: string[] }
export interface Account { accountId: string; participantId: string; recoveryGeneration: number; devices: { id: string; name: string; createdAt: string; lastSeenAt: string; revokedAt: string | null; cryptoState: 'pending' }[] }
let tokens: Tokens | undefined;
let generation = 0;
let refreshPending: Promise<Tokens> | undefined;
let restorePending: Promise<void> | undefined;
let callbackPending: Promise<void> | undefined;
let storageQueue = Promise.resolve();
let signInPending = false;

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try { return await fetch(url, { ...init, signal: controller.signal, credentials: 'omit', cache: 'no-store' }); }
  finally { clearTimeout(timer); }
}

async function discovery(): Promise<Discovery> {
  const origin = new URL(apiOrigin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== apiOrigin || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) throw new Error('The account service URL must use HTTPS outside local development.');
  const response = await request(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error('The account service is unavailable. Please try again.');
  const data = await response.json();
  if (data.issuer !== issuer || data.authorization_response_iss_parameter_supported !== true || !Array.isArray(data.code_challenge_methods_supported) || !data.code_challenge_methods_supported.includes('S256')) throw new Error('The account service configuration is invalid.');
  for (const value of [data.authorization_endpoint, data.token_endpoint]) {
    if (typeof value !== 'string') throw new Error('The account service configuration is incomplete.');
    const endpoint = new URL(value);
    if (endpoint.origin !== apiOrigin || !endpoint.pathname.startsWith('/oidc/') || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('The account service endpoint is invalid.');
  }
  return { authorizationEndpoint: data.authorization_endpoint, tokenEndpoint: data.token_endpoint };
}

function persist(next: Tokens | undefined, expected: number): Promise<void> {
  storageQueue = storageQueue.catch(() => {}).then(async () => {
    if (expected !== generation || Platform.OS === 'web') return;
    if (next) await SecureStore.setItemAsync(tokenKey, JSON.stringify({ issuer, clientId, ...next }), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    else await SecureStore.deleteItemAsync(tokenKey);
  });
  return storageQueue;
}

export async function clearSession(): Promise<void> {
  generation += 1;
  tokens = undefined;
  await persist(undefined, generation);
}

export async function restoreSession(): Promise<void> {
  if (!restorePending) restorePending = (async () => {
    if (Platform.OS === 'web') return;
    const expected = generation;
    const stored = await SecureStore.getItemAsync(tokenKey);
    if (!stored || expected !== generation) return;
    try {
      const saved = JSON.parse(stored);
      if (saved.issuer !== issuer || saved.clientId !== clientId || typeof saved.accessToken !== 'string' || typeof saved.expiresAt !== 'number' || (saved.refreshToken !== undefined && typeof saved.refreshToken !== 'string')) throw new Error('Invalid saved session');
      tokens = saved;
    } catch { await clearSession(); }
  })();
  await restorePending;
}

async function tokenRequest(endpoint: string, fields: Record<string, string>): Promise<{ value: Tokens; idToken?: string }> {
  const response = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, resource, ...fields }).toString() });
  if (!response.ok) throw new Error('Your sign-in could not be renewed. Please sign in again.');
  const body = await response.json();
  if (typeof body.access_token !== 'string' || body.token_type?.toLowerCase() !== 'bearer' || typeof body.expires_in !== 'number' || body.expires_in <= 0 || (body.refresh_token !== undefined && typeof body.refresh_token !== 'string')) throw new Error('The account service returned an invalid session.');
  return { value: { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 }, idToken: body.id_token };
}

async function exchange(url: string, flow: PendingFlow): Promise<void> {
  const code = callbackCode(url, flow, Date.now(), issuer);
  const expected = generation;
  const metadata = await discovery();
  const result = await tokenRequest(metadata.tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier });
  if (typeof result.idToken !== 'string') throw new Error('The account service did not confirm your identity.');
  // The trusted issuer verifies signature, issuer, audience, subject and the exact nonce.
  // No session is accepted by the app until this authenticated confirmation succeeds.
  const confirmed = await request(`${apiOrigin}/v1/session/confirm`, { method: 'POST', headers: { Authorization: `Bearer ${result.value.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: result.idToken, nonce: flow.nonce }) });
  if (!confirmed.ok) throw new Error('Your identity could not be confirmed. Please start sign-in again.');
  if (expected !== generation) throw new Error('Sign-in was cancelled.');
  await persist(result.value, expected);
  if (expected === generation) tokens = result.value;
}

export async function signIn(): Promise<void> {
  if (signInPending) return;
  signInPending = true;
  try {
    const metadata = await discovery();
    const nonce = Crypto.randomUUID() + Crypto.randomUUID();
    const redirectUri = Platform.OS === 'web' ? `${window.location.origin}/oauth/callback` : 'larynx://oauth/callback';
    const auth = new AuthRequest({ state: Crypto.randomUUID() + Crypto.randomUUID(), clientId, redirectUri, responseType: ResponseType.Code, codeChallengeMethod: CodeChallengeMethod.S256, usePKCE: true, scopes: ['openid', 'offline_access', 'profile:read', 'profile:write', 'circles:read', 'circles:write', 'conversations:read', 'conversations:write'], extraParams: { resource, nonce } });
    const url = await auth.makeAuthUrlAsync(metadata);
    if (!auth.codeVerifier) throw new Error('Could not prepare a secure sign-in request.');
    const flow: PendingFlow = { state: auth.state, nonce, verifier: auth.codeVerifier, redirectUri, createdAt: Date.now() };
    if (Platform.OS === 'web') {
      window.sessionStorage.setItem(pendingKey, JSON.stringify(flow));
      window.location.assign(url);
    } else {
      const result = await auth.promptAsync(metadata, { url });
      if (result.type !== 'success') throw new Error('Sign-in was cancelled.');
      await exchange(result.url, flow);
    }
  } finally { signInPending = false; }
}

export function completeWebSignIn(): Promise<void> {
  if (!callbackPending) callbackPending = (async () => {
    if (Platform.OS !== 'web') return;
    const url = window.location.href;
    const pending = window.sessionStorage.getItem(pendingKey);
    window.sessionStorage.removeItem(pendingKey);
    window.history.replaceState(null, '', '/oauth/callback');
    const flow = parsePendingFlow(pending);
    if (flow.redirectUri !== `${window.location.origin}/oauth/callback`) throw new Error('The pending sign-in belongs to another app.');
    await exchange(url, flow);
  })();
  return callbackPending;
}

async function access(): Promise<Tokens> {
  await restoreSession();
  if (!tokens) throw new Error('Please sign in to view your account.');
  if (tokens.expiresAt > Date.now() + 30_000) return tokens;
  if (!refreshPending) {
    const previous = tokens;
    const expected = generation;
    refreshPending = (async () => {
      try {
        if (!previous.refreshToken) throw new Error('Your session has expired. Please sign in again.');
        const metadata = await discovery();
        const result = await tokenRequest(metadata.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: previous.refreshToken });
        if (expected !== generation) throw new Error('You have signed out.');
        await persist(result.value, expected);
        if (expected !== generation) throw new Error('You have signed out.');
        tokens = result.value;
        return tokens;
      } catch (error) { if (expected === generation) await clearSession(); throw error; }
      finally { refreshPending = undefined; }
    })();
  }
  return refreshPending;
}

export async function accountRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const current = await access();
  const response = await request(`${apiOrigin}${path}`, { method, headers: { Authorization: `Bearer ${current.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 401) { await clearSession(); throw new Error('Your session has ended. Please sign in again.'); }
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined);
    const messages: Record<string, string> = {
      too_many_requests: 'Too many requests. Wait a minute and try again.',
      revision_conflict: 'This has changed since you opened it. Review the refreshed details and try again.',
      last_owner: 'Choose another owner before leaving or removing this owner.',
      crypto_not_ready: 'Encryption is not ready yet. Messages remain unavailable.',
      idempotency_conflict: 'This request key was already used for a different action. Refresh and try again.',
    };
    throw new Error(messages[detail?.error] ?? (response.status === 404 ? 'This item is unavailable or you no longer have access.' : response.status === 409 ? 'This action conflicts with the current membership. Review the refreshed details and try again.' : response.status === 403 ? 'This action is not allowed for your session. Sign in again if you have not approved the requested access.' : response.status === 400 ? 'Check the contact codes and audience choices, then try again.' : 'The service is unavailable. Please try again.'));
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function hasSession(): boolean { return Boolean(tokens); }

export async function signOut(): Promise<void> {
  try { if (tokens) await accountRequest('/v1/logout', 'POST'); }
  finally { await clearSession(); }
}
