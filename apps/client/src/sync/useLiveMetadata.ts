import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { accountRequest, apiOrigin, getSessionGeneration, hasSession, LocalizedError, restoreSession, subscribeSession, type Session } from '../auth/session';
import { createSyncController } from './controller';
import type { SyncView } from './types';

type LiveView = SyncView & { resetKey: string };
const empty = (): LiveView => ({ phase:'syncing',circles:[],conversations:[],epoch:0,resetKey:'initial' });
const foreground = () => Platform.OS === 'web' ? typeof document !== 'undefined' && document.visibilityState !== 'hidden' : AppState.currentState === 'active';
function sessionKey(session: Session): string {
  const ids = [session.accountId,session.participantId,session.deviceId,session.sessionId];
  if (ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) || typeof session.clientId !== 'string' || !session.clientId || !Array.isArray(session.scopes) || session.scopes.some(s=>typeof s!=='string')) throw new LocalizedError('common.error.invalidSession');
  return JSON.stringify([apiOrigin,...ids,session.clientId,[...session.scopes].sort(),getSessionGeneration()]);
}

/** Volatile screen-owned consumer. No private metadata or cursor is persisted. */
export function useLiveMetadata() {
  const [view,setView] = useState<LiveView>(empty);
  const [session,setSession] = useState<Session>();
  const controller = useRef<ReturnType<typeof createSyncController> | undefined>(undefined);
  useEffect(() => {
    let disposed = false; let run = 0;
    const restart = async () => {
      const current = ++run;
      controller.current?.stop(); controller.current = undefined;
      setSession(undefined); setView(empty());
      try {
        await restoreSession();
        if (disposed || current !== run) return;
        if (!hasSession()) { setView({phase:'paused',circles:[],conversations:[],epoch:0,resetKey:`${current}:signed-out`}); return; }
        const active = createSyncController({
          verify: async signal => {
            const next = await accountRequest<Session>('/v1/session','GET',undefined,{signal});
            const key = sessionKey(next);
            if (disposed || current !== run) throw new LocalizedError('common.error.signedOut');
            setSession(next); return key;
          },
          fetchPage: (after,wait,signal) => {
            const query = new URLSearchParams({limit:'100'});
            if (after) { query.set('after',after); query.set('wait',String(wait)); }
            return accountRequest(`/v1/sync?${query}`,'GET',undefined,{signal});
          },
          onChange: next => { if (!disposed && current === run) setView({...next,resetKey:`${current}:${next.epoch}`}); },
        });
        controller.current = active;
        if (foreground()) active.start(); else active.pause();
      } catch { if (!disposed && current === run) setView({phase:'error',circles:[],conversations:[],epoch:0,resetKey:`${current}:error`,errorCode:'sync_unavailable'}); }
    };
    const unsubscribe = subscribeSession(() => { void restart(); });
    const visibility = () => { if (foreground()) controller.current?.resume(); else controller.current?.pause(); };
    const native = Platform.OS === 'web' ? undefined : AppState.addEventListener('change',visibility);
    if (Platform.OS === 'web') document.addEventListener('visibilitychange',visibility);
    void restart();
    return () => {
      disposed = true; run++; unsubscribe(); native?.remove();
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange',visibility);
      controller.current?.stop(); controller.current = undefined;
    };
  },[]);
  return { view,session,refresh: () => controller.current?.refresh() ?? Promise.reject(new LocalizedError('common.error.signIn')) };
}
