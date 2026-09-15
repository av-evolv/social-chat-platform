import type { Notification, Pool, PoolClient } from 'pg';
import { SyncError } from './types.js';

interface WakeOptions {
  maxWaiters?: number;
  maxPerPrincipal?: number;
  reconnectDelayMs?: number;
}

interface Registration {
  participantId: string;
  hint(): void;
  close(): void;
}

interface Listener {
  client: PoolClient;
  dispose(): void;
}

/** Notifications only shorten the wait. Every outcome requires another durable read. */
export class SyncWakeHub {
  private readonly registrations = new Set<Registration>();
  private readonly counts = new Map<string, number>();
  private readonly maxWaiters: number;
  private readonly maxPerPrincipal: number;
  private readonly reconnectDelayMs: number;
  private retryDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private listener: Listener | undefined;
  private connecting: Promise<void> | undefined;
  private started = false;
  private closed = false;

  constructor(private readonly pool: Pool, private readonly channel: string, options: WakeOptions = {}) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) throw new Error('Invalid notification channel SQL identifier');
    this.maxWaiters = options.maxWaiters ?? 200;
    this.maxPerPrincipal = options.maxPerPrincipal ?? 2;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 100;
    for (const [value, maximum] of [[this.maxWaiters, 200], [this.maxPerPrincipal, 2], [this.reconnectDelayMs, 30_000]] as const) {
      if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Invalid sync wake limit');
    }
    this.retryDelayMs = this.reconnectDelayMs;
  }

  async start(): Promise<void> {
    if (this.closed) throw new SyncError(503, 'sync_unavailable');
    this.started = true;
    await this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.listener?.dispose();
    this.listener = undefined;
    for (const registration of [...this.registrations]) registration.close();
    await this.connecting?.catch(() => {});
  }

  /** Register before reading the cursor so a commit between read and wait cannot be lost. */
  watch(participantId: string): { wait(timeoutMs: number, signal?: AbortSignal): Promise<void>; close(): void } {
    if (!this.started || this.closed) throw new SyncError(503, 'sync_unavailable');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(participantId)) {
      throw new SyncError(400, 'invalid_sync_request');
    }
    if (this.registrations.size >= this.maxWaiters || (this.counts.get(participantId) ?? 0) >= this.maxPerPrincipal) {
      throw new SyncError(429, 'sync_wait_limit');
    }
    let ready = false;
    let closed = false;
    let waiting: Promise<void> | undefined;
    let resolve: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortSignal: AbortSignal | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener('abort', close);
      this.registrations.delete(registration);
      const remaining = (this.counts.get(participantId) ?? 1) - 1;
      if (remaining) this.counts.set(participantId, remaining);
      else this.counts.delete(participantId);
      resolve?.();
    };
    const registration: Registration = { participantId, close, hint: () => {
      ready = true;
      if (waiting) close();
    } };
    this.registrations.add(registration);
    this.counts.set(participantId, (this.counts.get(participantId) ?? 0) + 1);
    return { close, wait: (timeoutMs, signal) => {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 25_000) {
        close();
        return Promise.reject(new SyncError(400, 'invalid_sync_wait'));
      }
      if (waiting) return waiting;
      if (closed || ready || signal?.aborted) {
        close();
        return Promise.resolve();
      }
      waiting = new Promise<void>((done) => { resolve = done; });
      abortSignal = signal;
      signal?.addEventListener('abort', close, { once: true });
      timer = setTimeout(close, timeoutMs);
      return waiting;
    } };
  }

  private wakeAll(): void {
    for (const registration of this.registrations) registration.hint();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.listener || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {});
    }, this.retryDelayMs);
    this.reconnectTimer.unref();
    this.retryDelayMs = Math.min(30_000, this.retryDelayMs * 2);
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.closed || this.listener) return Promise.resolve();
    this.connecting = (async () => {
      let lease: Listener | undefined;
      try {
        const client = await this.pool.connect();
        if (this.closed) { client.release(true); return; }
        let disposed = false;
        const disconnected = () => {
          lease?.dispose();
          if (this.listener === lease) this.listener = undefined;
          this.wakeAll();
          this.scheduleReconnect();
        };
        const notification = (message: Notification) => {
          if (message.channel !== this.channel) return;
          if (message.payload === '*') this.wakeAll();
          else for (const registration of this.registrations) {
            if (registration.participantId === message.payload) registration.hint();
          }
        };
        lease = { client, dispose: () => {
          if (disposed) return;
          disposed = true;
          client.removeListener('notification', notification);
          client.removeListener('error', disconnected);
          client.removeListener('end', disconnected);
          // Destroy rather than return a LISTEN connection to the ordinary query pool.
          client.release(true);
        } };
        this.listener = lease;
        client.on('notification', notification);
        client.on('error', disconnected);
        client.on('end', disconnected);
        await client.query(`LISTEN ${this.channel}`);
        if (this.closed || disposed) return;
        this.retryDelayMs = this.reconnectDelayMs;
        // LISTEN takes effect at commit; reread durable state after every reconnect.
        this.wakeAll();
      } catch (error) {
        lease?.dispose();
        if (this.listener === lease) this.listener = undefined;
        this.wakeAll();
        throw error;
      } finally {
        this.connecting = undefined;
        this.scheduleReconnect();
      }
    })();
    return this.connecting;
  }
}
