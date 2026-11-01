import type { StateStorePort } from "../shared/state-store.js";
/**
 * mesh-runtime.ts — What turns the mesh modules into a running service.
 *
 * Everything under `src/mesh/` up to here decides things and performs no I/O of
 * its own: the outbox decides delivery state, the dispatcher runs one pass when
 * asked, the inbox decides whether an effect may run twice. Nothing scheduled
 * them. This module is the scheduler, and it is the only file in the mesh that
 * owns a timer.
 *
 * ## Where the SQL runs
 *
 * The stores arrive as `StateStorePort`s. In production those come from
 * `api.runtime.state.openKeyedStore({ retention: "retained" })`, which the host
 * serves from its plugin-state SQLite worker — `createAsyncKeyedStore` goes
 * through `observePluginStateInWorker`, so the statements execute off the
 * Gateway main thread and this code only awaits a result. That is what
 * `docs/reference/database-schemas/worker-access.md` requires, and it is why
 * the mesh does not need a process of its own to satisfy that rule. What runs
 * on the main thread here is an `await` and a `setTimeout`.
 *
 * ## Why polling, and why it backs off
 *
 * `lumina_events` is not in the project's Realtime publication, so there is no
 * push to subscribe to; polling is not a fallback here, it is the only channel.
 * A notification could only ever make delivery *sooner*. The interval doubles
 * while nothing happens and drops back to the floor the moment a pass does
 * work, so an idle gateway is not billing a query every two seconds and a busy
 * one is not waiting a minute.
 *
 * ## What an unhandled topic does
 *
 * A message for a topic with no registered handler is **not** marked applied.
 * Claiming to have applied something nobody handled is how a queue quietly
 * loses messages. It is recorded in `unhandled`, counted in the snapshot, and
 * the cursor still advances past it — otherwise one unroutable message stops
 * every later one. An operator sees the count; nothing pretends to be done.
 */
import type { SupabaseConfig } from "../supabase/supabase-client.js";
import { MeshDispatcher, type MeshDispatchPass, type MeshTransport } from "./dispatcher.js";
import type { MeshEnvelope, MeshParty } from "./envelope.js";
import {
  MeshInbox,
  type MeshEffectKind,
  type MeshProcessedRecord,
  type MeshApplyOutcome,
} from "./inbox.js";
import { MeshOutbox, type MeshOutboxRecord } from "./outbox.js";
import {
  createSupabaseMeshTransport,
  readMeshEnvelopes,
  resolveMeshSupabaseConfig,
  type ReadMeshEnvelopesResult,
} from "./supabase-transport.js";

/** What a topic handler does with one inbound envelope. */
export type MeshHandler = {
  /** `external` makes an interrupted attempt `needs-manual` instead of retrying. */
  readonly effect: MeshEffectKind;
  run(envelope: MeshEnvelope): Promise<string | void>;
};

/** A message nobody claimed, kept so the count is never a guess. */
export type MeshUnhandledRecord = {
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly topic: string;
  readonly origin: MeshParty;
  readonly observedAt: string;
};

export type MeshRuntimeLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type MeshRuntimeOptions = {
  /** This gateway's party id: the recipient rows are read for. */
  readonly party: MeshParty;
  readonly outboxStore: StateStorePort<MeshOutboxRecord>;
  readonly inboxStore: StateStorePort<MeshProcessedRecord>;
  /** Holds the inbound cursor and the unhandled log. Separate so a reset of
   * one does not disturb the other. */
  readonly journalStore: StateStorePort<unknown>;
  readonly logger: MeshRuntimeLogger;
  readonly now?: () => number;
  /** Resolved by the caller, or read from the environment on first use. */
  readonly config?: SupabaseConfig;
  /** Floor interval, used while passes are doing work. */
  readonly activeIntervalMs?: number;
  /** Ceiling the idle backoff grows to. */
  readonly idleIntervalMs?: number;
  readonly inboundLimit?: number;
  /** Injected in tests; production uses the globals. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Injected in tests so no pass touches a network. */
  readonly transport?: MeshTransport;
  readonly readInbound?: typeof readMeshEnvelopes;
};

const DEFAULT_ACTIVE_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_INTERVAL_MS = 60_000;
const DEFAULT_INBOUND_LIMIT = 50;
const CURSOR_KEY = "inbound_cursor";
const UNHANDLED_PREFIX = "unhandled_";
const MAX_UNHANDLED = 200;

/** Everything the CLI, the health route and the Control UI read. Real counts. */
export type MeshRuntimeSnapshot = {
  readonly running: boolean;
  readonly party: MeshParty;
  /** Null until the first pass; never a placeholder. */
  readonly lastPassAt: string | null;
  readonly intervalMs: number;
  readonly passes: number;
  readonly outbound: Awaited<ReturnType<MeshOutbox["metrics"]>> | null;
  readonly inbound: Awaited<ReturnType<MeshInbox["metrics"]>> | null;
  readonly cursor: string | null;
  readonly unhandled: number;
  readonly handlers: readonly string[];
  /** The last transport or reader error, so a silent stall is visible. */
  readonly lastError: string | null;
  readonly lastPass: MeshDispatchPass | null;
};

function isoFrom(now: () => number): string {
  return new Date(now()).toISOString();
}

export class MeshRuntime {
  private readonly options: MeshRuntimeOptions;
  private readonly now: () => number;
  private readonly outbox: MeshOutbox;
  private readonly inbox: MeshInbox;
  private readonly dispatcher: MeshDispatcher;
  private readonly handlers = new Map<string, MeshHandler>();
  private readonly activeIntervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly readInbound: typeof readMeshEnvelopes;

  private timer: unknown;
  private running = false;
  private intervalMs: number;
  private passes = 0;
  private lastPassAt: string | null = null;
  private lastError: string | null = null;
  private lastPass: MeshDispatchPass | null = null;
  private cursor: string | null = null;
  private unhandledCount = 0;
  private transport: MeshTransport | undefined;
  private config: SupabaseConfig | undefined;
  private tickInFlight: Promise<void> | undefined;

  constructor(options: MeshRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.activeIntervalMs = options.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS;
    this.idleIntervalMs = Math.max(
      options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS,
      this.activeIntervalMs,
    );
    this.intervalMs = this.activeIntervalMs;
    this.setTimer =
      options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref?.() ?? setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
    this.readInbound = options.readInbound ?? readMeshEnvelopes;
    this.transport = options.transport;
    this.config = options.config;
    this.outbox = new MeshOutbox({ store: options.outboxStore, now: this.now });
    this.inbox = new MeshInbox({
      store: options.inboxStore,
      now: this.now,
      party: options.party,
    });
    this.dispatcher = new MeshDispatcher({
      outbox: this.outbox,
      dispatcherId: `${options.party}:${process.pid}`,
      route: (recipient) => this.routeFor(recipient),
    });
  }

  /** Registers the effect for one topic. Last registration wins, by design:
   * a reload replaces a handler rather than stacking a second one. */
  handle(topic: string, handler: MeshHandler): void {
    this.handlers.set(topic, handler);
  }

  get outboxPort(): MeshOutbox {
    return this.outbox;
  }

  get inboxPort(): MeshInbox {
    return this.inbox;
  }

  /**
   * A transport is built once, lazily, so a gateway with no Supabase
   * credentials starts clean and says so instead of failing at registration.
   */
  private routeFor(_recipient: MeshParty): MeshTransport | undefined {
    if (this.transport) {
      return this.transport;
    }
    const resolved = this.resolveConfig();
    if (!resolved) {
      return undefined;
    }
    this.transport = createSupabaseMeshTransport({ config: resolved });
    return this.transport;
  }

  private resolveConfig(): SupabaseConfig | undefined {
    if (this.config) {
      return this.config;
    }
    const result = resolveMeshSupabaseConfig({});
    if (!result.ok) {
      this.lastError = `supabase config unavailable: ${result.error}`;
      return undefined;
    }
    this.config = result.config;
    return this.config;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.cursor = await this.readCursor();
    this.unhandledCount = await this.countUnhandled();
    this.options.logger.info(
      `[mesh] runtime started as ${this.options.party}; cursor=${this.cursor ?? "none"}, ` +
        `handlers=${this.handlers.size}, interval=${this.intervalMs}ms`,
    );
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    // A pass holds a claim and a lease; let it settle rather than abandoning it
    // for the next process to reclaim after a timeout.
    await this.tickInFlight;
    this.options.logger.info(`[mesh] runtime stopped after ${this.passes} passes`);
  }

  private schedule(ms: number): void {
    if (!this.running) {
      return;
    }
    this.timer = this.setTimer(() => {
      void this.tick();
    }, ms);
  }

  /** One scheduled beat: outbound pass, then inbound poll, then reschedule. */
  async tick(): Promise<void> {
    if (this.tickInFlight) {
      return this.tickInFlight;
    }
    this.tickInFlight = this.runTick().finally(() => {
      this.tickInFlight = undefined;
    });
    return this.tickInFlight;
  }

  private async runTick(): Promise<void> {
    let worked = false;
    try {
      const pass = await this.dispatcher.runOnce();
      this.lastPass = pass;
      worked =
        pass.claimed > 0 || pass.delivered > 0 || pass.reclaimed > 0 || pass.deadLettered > 0;
      if (pass.problems.length > 0) {
        this.lastError = pass.problems[0]?.reason ?? null;
      } else if (pass.delivered > 0) {
        this.lastError = null;
      }
      worked = (await this.pollInbound()) || worked;
    } catch (error) {
      // A thrown pass must not kill the loop: the next beat retries, and the
      // reason is visible in the snapshot rather than only in the log.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(`[mesh] pass failed: ${this.lastError}`);
    } finally {
      this.passes += 1;
      this.lastPassAt = isoFrom(this.now);
      this.intervalMs = worked
        ? this.activeIntervalMs
        : Math.min(this.intervalMs * 2, this.idleIntervalMs);
      this.schedule(this.intervalMs);
    }
  }

  /** Reads what is addressed to this party past the cursor and applies it. */
  private async pollInbound(): Promise<boolean> {
    const config = this.resolveConfig();
    if (!config) {
      return false;
    }
    const result: ReadMeshEnvelopesResult = await this.readInbound(config, {
      recipient: this.options.party,
      since: this.cursor ?? undefined,
      limit: this.options.inboundLimit ?? DEFAULT_INBOUND_LIMIT,
    });
    if (!result.ok) {
      this.lastError = `inbound read failed: ${result.error}`;
      return false;
    }
    for (const rejection of result.rejected) {
      this.options.logger.warn(
        `[mesh] row ${rejection.id || "(no id)"} rejected: ` +
          rejection.problems.map((problem) => `${problem.field}: ${problem.reason}`).join("; "),
      );
    }
    for (const envelope of result.envelopes) {
      await this.applyInbound(envelope);
    }
    if (result.cursor && result.cursor !== this.cursor) {
      this.cursor = result.cursor;
      await this.options.journalStore.register(CURSOR_KEY, { cursor: result.cursor });
    }
    return result.envelopes.length > 0;
  }

  private async applyInbound(envelope: MeshEnvelope): Promise<void> {
    const handler = this.handlers.get(envelope.topic);
    if (!handler) {
      await this.recordUnhandled(envelope);
      return;
    }
    const outcome: MeshApplyOutcome = await this.inbox.apply(
      envelope,
      async () => handler.run(envelope),
      { effectKind: handler.effect },
    );
    if (outcome.status === "applied" || outcome.status === "duplicate") {
      return;
    }
    // `conflict` means the key already named a different effect, which is a
    // sender bug rather than a transport one; it belongs in the snapshot beside
    // the failures so it cannot pass for a successful pass.
    this.lastError =
      outcome.status === "failed"
        ? `${envelope.topic}: ${outcome.error}`
        : `${envelope.topic}: ${outcome.status}`;
    this.options.logger.warn(`[mesh] ${envelope.topic} -> ${outcome.status}: ${this.lastError}`);
  }

  private async recordUnhandled(envelope: MeshEnvelope): Promise<void> {
    const record: MeshUnhandledRecord = {
      idempotencyKey: envelope.idempotency_key,
      messageId: envelope.message_id,
      topic: envelope.topic,
      origin: envelope.origin,
      observedAt: isoFrom(this.now),
    };
    await this.options.journalStore.register(
      `${UNHANDLED_PREFIX}${envelope.idempotency_key}`,
      record,
    );
    this.unhandledCount = await this.countUnhandled();
    this.options.logger.warn(
      `[mesh] no handler for topic ${envelope.topic} from ${envelope.origin}; ` +
        `recorded as unhandled (${this.unhandledCount})`,
    );
  }

  private async readCursor(): Promise<string | null> {
    const stored = await this.options.journalStore.lookup(CURSOR_KEY);
    if (stored && typeof stored === "object" && "cursor" in stored) {
      const value = (stored as { cursor?: unknown }).cursor;
      return typeof value === "string" ? value : null;
    }
    return null;
  }

  private async countUnhandled(): Promise<number> {
    const entries = await this.options.journalStore.entries();
    const keys = entries.filter((entry) => entry.key.startsWith(UNHANDLED_PREFIX));
    // Bounded on purpose: this is a diagnostic log, not a second queue. The
    // oldest entries go once the cap is reached, and the count stays truthful.
    if (keys.length > MAX_UNHANDLED) {
      for (const stale of keys.slice(0, keys.length - MAX_UNHANDLED)) {
        await this.options.journalStore.delete(stale.key);
      }
      return MAX_UNHANDLED;
    }
    return keys.length;
  }

  /** Reads every live counter. Nothing here is cached or invented. */
  async snapshot(): Promise<MeshRuntimeSnapshot> {
    const [outbound, inbound] = await Promise.all([
      this.outbox.metrics().catch(() => null),
      this.inbox.metrics().catch(() => null),
    ]);
    return {
      running: this.running,
      party: this.options.party,
      lastPassAt: this.lastPassAt,
      intervalMs: this.intervalMs,
      passes: this.passes,
      outbound,
      inbound,
      cursor: this.cursor,
      unhandled: this.unhandledCount,
      handlers: [...this.handlers.keys()].toSorted(),
      lastError: this.lastError,
      lastPass: this.lastPass,
    };
  }
}
