import { translate, type Locale } from '@larynx/i18n';
import { applyAccountLocale, getLocale, getLocaleVersion, initializeLocale } from '../i18n/state';
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
export interface Account { locale: Locale | null; emails: string[]; accountId: string; participantId: string; recoveryGeneration: number; devices: { id: string; name: string; createdAt: string; lastSeenAt: string; revokedAt: string | null; cryptoState: 'pending' }[] }
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
  try { return await fetch(url, { ...init, headers: { 'Accept-Language': getLocale(), ...init.headers }, signal: controller.signal, credentials: 'omit', cache: 'no-store' }); }
  finally { clearTimeout(timer); }
}

async function discovery(): Promise<Discovery> {
  const origin = new URL(apiOrigin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== apiOrigin || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) throw new LocalizedError('common.error.https');
  const response = await request(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new LocalizedError('common.error.accountUnavailable');
  const data = await response.json();
  if (data.issuer !== issuer || data.authorization_response_iss_parameter_supported !== true || !Array.isArray(data.code_challenge_methods_supported) || !data.code_challenge_methods_supported.includes('S256')) throw new LocalizedError('common.error.config');
  for (const value of [data.authorization_endpoint, data.token_endpoint]) {
    if (typeof value !== 'string') throw new LocalizedError('common.error.configIncomplete');
    const endpoint = new URL(value);
    if (endpoint.origin !== apiOrigin || !endpoint.pathname.startsWith('/oidc/') || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new LocalizedError('common.error.endpoint');
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
  if (!response.ok) throw new LocalizedError('common.error.renewal');
  const body = await response.json();
  if (typeof body.access_token !== 'string' || body.token_type?.toLowerCase() !== 'bearer' || typeof body.expires_in !== 'number' || body.expires_in <= 0 || (body.refresh_token !== undefined && typeof body.refresh_token !== 'string')) throw new LocalizedError('common.error.invalidSession');
  return { value: { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 }, idToken: body.id_token };
}

async function exchange(url: string, flow: PendingFlow): Promise<void> {
  const code = callbackCode(url, flow, Date.now(), issuer);
  const expected = generation;
  const metadata = await discovery();
  const result = await tokenRequest(metadata.tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier });
  if (typeof result.idToken !== 'string') throw new LocalizedError('common.error.identityMissing');
  // The trusted issuer verifies signature, issuer, audience, subject and the exact nonce.
  // No session is accepted by the app until this authenticated confirmation succeeds.
  const confirmed = await request(`${apiOrigin}/v1/session/confirm`, { method: 'POST', headers: { Authorization: `Bearer ${result.value.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: result.idToken, nonce: flow.nonce }) });
  if (!confirmed.ok) throw new LocalizedError('common.error.identityConfirmation');
  if (expected !== generation) throw new LocalizedError('common.error.cancelled');
  await persist(result.value, expected);
  if (expected === generation) { tokens = result.value; await restoreAccountLocale(); }
}

export async function signIn(): Promise<void> {
  if (signInPending) return;
  signInPending = true;
  try {
    await initializeLocale();
    const metadata = await discovery();
    const nonce = Crypto.randomUUID() + Crypto.randomUUID();
    const redirectUri = Platform.OS === 'web' ? `${window.location.origin}/oauth/callback` : 'larynx://oauth/callback';
    const auth = new AuthRequest({ state: Crypto.randomUUID() + Crypto.randomUUID(), clientId, redirectUri, responseType: ResponseType.Code, codeChallengeMethod: CodeChallengeMethod.S256, usePKCE: true, scopes: ['openid', 'offline_access', 'profile:read', 'profile:write', 'circles:read', 'circles:write', 'conversations:read', 'conversations:write'], extraParams: { resource, nonce, ui_locales: getLocale() } });
    const url = await auth.makeAuthUrlAsync(metadata);
    if (!auth.codeVerifier) throw new LocalizedError('common.error.prepare');
    const flow: PendingFlow = { state: auth.state, nonce, verifier: auth.codeVerifier, redirectUri, createdAt: Date.now() };
    if (Platform.OS === 'web') {
      window.sessionStorage.setItem(pendingKey, JSON.stringify(flow));
      window.location.assign(url);
    } else {
      const result = await auth.promptAsync(metadata, { url });
      if (result.type !== 'success') throw new LocalizedError('common.error.cancelled');
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
    if (flow.redirectUri !== `${window.location.origin}/oauth/callback`) throw new LocalizedError('common.error.wrongApp');
    await exchange(url, flow);
  })();
  return callbackPending;
}

async function access(): Promise<Tokens> {
  await restoreSession();
  if (!tokens) throw new LocalizedError('common.error.signIn');
  if (tokens.expiresAt > Date.now() + 30_000) return tokens;
  if (!refreshPending) {
    const previous = tokens;
    const expected = generation;
    refreshPending = (async () => {
      try {
        if (!previous.refreshToken) throw new LocalizedError('common.error.expired');
        const metadata = await discovery();
        const result = await tokenRequest(metadata.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: previous.refreshToken });
        if (expected !== generation) throw new LocalizedError('common.error.signedOut');
        await persist(result.value, expected);
        if (expected !== generation) throw new LocalizedError('common.error.signedOut');
        tokens = result.value;
        return tokens;
      } catch (error) { if (expected === generation) await clearSession(); throw error; }
      finally { refreshPending = undefined; }
    })();
  }
  return refreshPending;
}

export class LocalizedError extends Error {
  constructor(public readonly translationKey: string) { super(translate(getLocale(),translationKey)); }
}
export function localizeError(failure: unknown, locale: Locale): string {
  return translate(locale,failure instanceof LocalizedError ? failure.translationKey : 'common.error.unavailable');
}

export class AccountRequestError extends LocalizedError {
  constructor(public readonly status: number, public readonly code: string | undefined, message: string) { super(message); }
}

export async function accountRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const expected = generation;
  await initializeLocale();
  const localeVersion = getLocaleVersion();
  const current = await access();
  if (expected !== generation) throw new LocalizedError('common.error.signedOut');
  const response = await request(`${apiOrigin}${path}`, { method, headers: { Authorization: `Bearer ${current.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 401) { if (expected === generation) await clearSession(); throw new LocalizedError('common.error.ended'); }
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined);
    const codes = ['invitation_unavailable','invalid_email','rate_limited','too_many_requests','revision_conflict','last_owner','crypto_not_ready','idempotency_conflict'];
    const code = typeof detail?.error === 'string' ? detail.error : undefined;
    const key = code && codes.includes(code) ? `common.error.${code}` : response.status === 404 ? 'common.error.notFound' : response.status === 409 ? 'common.error.conflict' : response.status === 403 ? 'common.error.forbidden' : response.status === 400 ? 'common.error.invalidRequest' : 'common.error.unavailable';
    throw new AccountRequestError(response.status,code,key);
  }
  const result = response.status === 204 ? undefined : await response.json();
  if (path === '/v1/account' && method === 'GET' && expected === generation) {
    try { await applyAccountLocale(result?.locale,localeVersion); } catch { /* Keep the in-memory preference when device storage is unavailable. */ }
  }
  return result as T;
}

export function hasSession(): boolean { return Boolean(tokens); }

export async function signOut(): Promise<void> {
  try { if (tokens) await accountRequest('/v1/logout', 'POST'); }
  finally { await clearSession(); }
}

async function restoreAccountLocale(): Promise<void> {
  try { await accountRequest<Account>('/v1/account'); }
  catch { /* Preference availability does not grant or invalidate authentication. */ }
}
export async function saveLocalePreference(locale: Locale): Promise<void> {
  await accountRequest('/v1/account/locale','POST',{locale});
}
