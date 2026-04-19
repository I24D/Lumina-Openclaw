/**
 * store.ts — In-memory session store with TTL eviction
 *
 * Tracks conversation state between brain turns.
 * Session keys off session_id provided by the OpenClaw Runtime.
 *
 * Architecture note: this is intentionally swappable with Redis.
 * To migrate, implement the same SessionStore interface against ioredis.
 */

import type { Message, ToolCall } from "@lumina/protocol";

// ── Session state ──────────────────────────────────────────────────────────

export interface Session {
  session_id: string;
  /** Full conversation history in chronological order */
  messages: Message[];
  /** Tool calls the brain requested — cleared once results are submitted */
  pending_tool_calls: ToolCall[];
  created_at: number;
  last_activity: number;
  metadata: Record<string, unknown>;
}

// ── Store interface (swappable with Redis) ─────────────────────────────────

export interface SessionStore {
  get(session_id: string): Session | undefined;
  set(session: Session): void;
  delete(session_id: string): void;
  count(): number;
  purgeExpired(): number;
}

// ── In-memory implementation ───────────────────────────────────────────────

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;

  constructor(ttlMs = 30 * 60 * 1000) {
    this.ttlMs = ttlMs;

    // Periodic cleanup every 5 minutes
    const interval = setInterval(() => {
      const evicted = this.purgeExpired();
      if (evicted > 0) {
        console.log(`[session-store] evicted ${evicted} expired sessions`);
      }
    }, 5 * 60 * 1000);

    // Do not hold the Node.js process open for cleanup
    interval.unref();
  }

  get(session_id: string): Session | undefined {
    const session = this.sessions.get(session_id);
    if (!session) return undefined;

    if (Date.now() - session.last_activity > this.ttlMs) {
      this.sessions.delete(session_id);
      return undefined;
    }

    return session;
  }

  set(session: Session): void {
    session.last_activity = Date.now();
    this.sessions.set(session.session_id, session);
  }

  delete(session_id: string): void {
    this.sessions.delete(session_id);
  }

  count(): number {
    return this.sessions.size;
  }

  purgeExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.last_activity > this.ttlMs) {
        this.sessions.delete(id);
        evicted++;
      }
    }
    return evicted;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createSession(session_id: string): Session {
  const now = Date.now();
  return {
    session_id,
    messages: [],
    pending_tool_calls: [],
    created_at: now,
    last_activity: now,
    metadata: {},
  };
}

// Singleton used across routes
const TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? "1800000", 10);
export const sessionStore = new MemorySessionStore(TTL_MS);
