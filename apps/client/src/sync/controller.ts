import { applySyncPage, emptySyncCache } from './cache';
import { parseSyncPage } from './protocol';
import { SyncProtocolError, type SyncView } from './types';
export interface SyncControllerOptions {
  verify(signal: AbortSignal): Promise<string>;
  fetchPage(after: string | undefined, wait: number, signal: AbortSignal): Promise<unknown>;
  onChange(view: SyncView): void;
  retryDelay?(attempt: number): number;
}
export function createSyncController(options: SyncControllerOptions) {
  let epoch = 0;
  let cache = emptySyncCache(), phase: SyncView['phase'] = 'paused', errorCode: string | undefined;
  let active = false, stopped = false, running = false, generation = 0, abort: AbortController | undefined;
  let identity: string | undefined, resets = 0, foreignReset = false;
  let pending: { promise: Promise<void>; resolve(): void; reject(reason: Error): void } | undefined;
  const publish = () => options.onChange(JSON.parse(JSON.stringify({ epoch, phase, errorCode, circles: [...cache.visible.values()].flatMap(r => r.type === 'circle' ? [r.data] : []), conversations: [...cache.visible.values()].flatMap(r => r.type === 'conversation' ? [r.data] : []) })) as SyncView);
  const clear = () => { epoch++; cache = emptySyncCache(); errorCode = undefined; };
  const rejectPending = (code: string) => { pending?.reject(new Error(code)); pending = undefined; };
  const delay = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
  });
  async function run() {
    if (running || !active || stopped) return;
    running = true;
    const mine = generation, controller = new AbortController(); abort = controller;
    const current = () => active && !stopped && mine === generation && !controller.signal.aborted;
    let verify = true, failures = 0;
    try {
      while (current()) {
        try {
          if (verify) {
            const verified = await options.verify(controller.signal); if (!current()) return;
            if (!verified) throw new SyncProtocolError('Missing verified identity');
            if (identity !== undefined && verified !== identity) clear();
            identity = verified; verify = false;
          }
          const after = cache.cursor;
          const raw = await options.fetchPage(after, cache.installed && !cache.staging ? 25 : 0, controller.signal);
          if (!current()) return;
          const page = parseSyncPage(raw);
          cache = applySyncPage(cache, page, after); failures = 0;
          phase = page.hasMore ? 'syncing' : 'live'; errorCode = undefined; publish();
          if (!page.hasMore) { resets = 0; pending?.resolve(); pending = undefined; }
          if (!page.hasMore && page.resources.length === 0) await delay(50, controller.signal);
        } catch (error) {
          if (!current()) return;
          const e = error as { status?: number; code?: string };
          const reset = e.status === 409 && e.code === 'sync_reset_required' || e.status === 410 && e.code === 'cursor_expired';
          const foreign = e.status === 400 && e.code === 'invalid_cursor' && cache.cursor !== undefined && !foreignReset;
          if ((reset || foreign) && resets < 3) {
            resets++; foreignReset ||= foreign; clear(); phase = 'syncing'; publish(); verify = true; continue;
          }
          const transient = !(error instanceof SyncProtocolError) && (e.status === undefined || e.status === 429 || e.status === 503 || e.status === 502 || e.status === 504);
          if (transient) {
            clear(); phase = 'retrying'; errorCode = 'sync_retrying'; publish(); verify = true;
            failures++;
            const requested = options.retryDelay?.(failures) ?? Math.min(30000, 500 * 2 ** Math.min(failures, 6)) * (0.75 + Math.random() * 0.5);
            await delay(Math.max(50, Math.min(30000, requested)), controller.signal); continue;
          }
          clear(); active = false; phase = 'error'; errorCode = error instanceof SyncProtocolError ? error.code : e.code ?? 'sync_failed'; publish(); rejectPending(errorCode); return;
        }
      }
    } finally { running = false; if (abort === controller) abort = undefined; if (active && !stopped) void run(); }
  }
  const restart = () => { generation++; abort?.abort(); active = true; clear(); phase = 'syncing'; publish(); void run(); };
  return {
    start() { if (!stopped && !active) { resets = 0; foreignReset = false; restart(); } },
    resume() { if (!stopped && !active) { resets = 0; foreignReset = false; restart(); } },
    pause() { if (stopped) return; active = false; generation++; abort?.abort(); clear(); phase = 'paused'; publish(); rejectPending('sync_paused'); },
    refresh(): Promise<void> {
      if (stopped || (!active && phase !== 'error')) return Promise.reject(new Error('sync_paused'));
      if (pending) return pending.promise;
      let resolve!: () => void, reject!: (reason: Error) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); pending = { promise, resolve, reject };
      resets = 0; foreignReset = false; restart(); return promise;
    },
    stop() { if (stopped) return; stopped = true; active = false; generation++; abort?.abort(); clear(); phase = 'paused'; publish(); rejectPending('sync_stopped'); },
  };
}
