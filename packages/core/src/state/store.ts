import type { SessionState } from './types.js';

/**
 * Where sessions live. The default keeps them in process memory; implement this interface to use
 * Redis or a database. Only the scheduler writes, one event at a time per session.
 */
export interface SessionStore {
  get(id: string): Promise<SessionState | undefined>;
  set(state: SessionState): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface MemoryStoreOptions {
  /** Sessions untouched for this long are dropped. Defaults to 2 hours. */
  ttlMs?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** In-memory store with idle expiry. Expired sessions are removed lazily, without timers. */
export function createMemoryStore(options: MemoryStoreOptions = {}): SessionStore {
  const ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, { state: SessionState; touchedAt: number }>();
  let lastSweep = now();

  const expired = (touchedAt: number) => now() - touchedAt > ttlMs;
  const sweep = () => {
    if (now() - lastSweep < ttlMs / 2) return;
    lastSweep = now();
    for (const [id, entry] of sessions) if (expired(entry.touchedAt)) sessions.delete(id);
  };

  return {
    async get(id) {
      const entry = sessions.get(id);
      if (!entry) return undefined;
      if (expired(entry.touchedAt)) {
        sessions.delete(id);
        return undefined;
      }
      entry.touchedAt = now();
      return entry.state;
    },
    async set(state) {
      sessions.set(state.id, { state, touchedAt: now() });
      sweep();
    },
    async delete(id) {
      sessions.delete(id);
    },
  };
}
