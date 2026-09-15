import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getLocales } from 'expo-localization';
import { matchLocale, type Locale } from '@larynx/i18n';
const key = 'larynx.locale';
let locale: Locale = 'en';
let version = 0;
let explicit = false;
let initialized: Promise<void> | undefined;
let initializationComplete = false;
let storageQueue = Promise.resolve();
const listeners = new Set<() => void>();
export const getLocale = () => locale;
export const getLocaleVersion = () => version;
export const subscribeLocale = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function detected(): Locale {
  const tags = Platform.OS === 'web' ? typeof navigator === 'undefined' ? [] : navigator.languages : getLocales().map(value => value.languageTag);
  return tags.map(matchLocale).find((value): value is Locale => value !== undefined) ?? 'en';
}
function publish(next: Locale) { locale = next; version += 1; listeners.forEach(listener => listener()); }
export async function initializeLocale(): Promise<void> {
  if (!initialized) initialized = (async () => {
    const before = version;
    let saved: string | null = null;
    try { saved = Platform.OS === 'web' ? window.localStorage.getItem(key) : await SecureStore.getItemAsync(key); } catch { /* Detection still works when local storage is unavailable. */ }
    if (version !== before) return;
    const requested = Platform.OS === 'web' ? new URL(window.location.href).searchParams.getAll('lang') : [];
    const linkLocale = requested.length === 1 ? matchLocale(requested[0]) : undefined;
    explicit = Boolean(linkLocale || matchLocale(saved));
    if (linkLocale) {
      try { await setLocale(linkLocale); } catch { /* The chosen language remains active in memory. */ }
    } else publish(matchLocale(saved) ?? detected());
  })().finally(() => { initializationComplete = true; });
  return initialized;
}
export async function setLocale(next: Locale): Promise<void> {
  explicit = true; publish(next);
  storageQueue = storageQueue.catch(() => {}).then(async () => {
    if (Platform.OS === 'web') window.localStorage.setItem(key,next);
    else await SecureStore.setItemAsync(key,next);
  });
  return storageQueue;
}
export async function applyAccountLocale(value: unknown, expectedVersion: number): Promise<void> {
  const next = matchLocale(value);
  if (next && version === expectedVersion) await setLocale(next);
}
// Foreground detection must not invalidate a saved preference still being read.
if (Platform.OS !== 'web') AppState.addEventListener('change', state => { if (state === 'active' && initializationComplete && !explicit) publish(detected()); });
