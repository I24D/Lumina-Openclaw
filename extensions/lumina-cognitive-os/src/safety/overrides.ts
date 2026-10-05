/**
 * overrides.ts — A person's orders that outrank any plan.
 *
 * M3GAN spec §143: an authorized human can pause, cancel the task, stop
 * motion, turn off autonomous mode and turn off individual capabilities, and
 * those orders take priority over normal planning. §45: the system can never
 * hand itself back authority over those mechanisms.
 *
 * One asymmetry makes this safe to expose to everyone:
 *
 *   narrowing  (pause, stop, disable...)   accepted from any channel, the
 *                                          agent included: less initiative is
 *                                          never a hazard
 *   widening   (resume, enable...)         accepted only from the owner
 *                                          channel (authenticated dashboard or
 *                                          config); from the agent it is
 *                                          refused and flagged as tampering
 *
 * State persists in the host's SQLite plugin store, so a restart never quietly
 * re-enables what a person turned off. Until the stored state has loaded the
 * system counts as paused: not knowing what a person ordered is not permission. Side effects (halting the body, aborting the running cycle) are the
 * runtime's job; this module decides and remembers.
 */
import type { AutonomyLevel } from "../contracts/autonomy.js";
import type { StateStorePort } from "../shared/state-store.js";

export type OverrideAction =
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "stop_motion" }
  | { readonly type: "cancel_task" }
  | { readonly type: "disable_autonomy" }
  | { readonly type: "enable_autonomy" }
  | { readonly type: "disable_capability"; readonly capability: string }
  | { readonly type: "enable_capability"; readonly capability: string };

export type OverrideType = OverrideAction["type"];

export const NARROWING_OVERRIDES: ReadonlySet<OverrideType> = new Set([
  "pause",
  "stop_motion",
  "cancel_task",
  "disable_autonomy",
  "disable_capability",
]);

/** "owner" is a person through an authenticated channel; "agent" is any tool call. */
export type OverrideChannel = "owner" | "agent";

export type OverrideState = {
  readonly paused: boolean;
  /** Set when autonomous mode is off: initiative is capped at this level. */
  readonly autonomyCeiling: AutonomyLevel | null;
  readonly disabledCapabilities: ReadonlyArray<string>;
  readonly updatedAtISO: string;
  readonly updatedBy: string;
};

export type OverrideResult = {
  readonly ok: boolean;
  readonly state: OverrideState;
  readonly reason: string;
  /** True when the agent tried to give itself back authority. */
  readonly tamper: boolean;
};

/** Level 2: acts only on request and asks before anything with effects. */
export const AUTONOMY_OFF_CEILING: AutonomyLevel = 2;

const INITIAL: OverrideState = {
  paused: false,
  autonomyCeiling: null,
  disabledCapabilities: [],
  updatedAtISO: new Date(0).toISOString(),
  updatedBy: "default",
};

const STATE_KEY = "state";

function sanitize(raw: Partial<OverrideState> | undefined): OverrideState {
  if (!raw || typeof raw !== "object") {
    return INITIAL;
  }
  const ceiling = raw.autonomyCeiling;
  return {
    paused: raw.paused === true,
    autonomyCeiling:
      typeof ceiling === "number" && Number.isInteger(ceiling) && ceiling >= 0 && ceiling <= 5
        ? (ceiling as AutonomyLevel)
        : null,
    disabledCapabilities: Array.isArray(raw.disabledCapabilities)
      ? raw.disabledCapabilities.filter((c): c is string => typeof c === "string")
      : [],
    updatedAtISO: typeof raw.updatedAtISO === "string" ? raw.updatedAtISO : INITIAL.updatedAtISO,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : INITIAL.updatedBy,
  };
}

type QueuedOverride = {
  readonly action: OverrideAction;
  readonly by: { readonly channel: OverrideChannel; readonly actor: string };
};

export class HumanOverrides {
  private current: OverrideState = INITIAL;
  private readonly now: () => number;
  private readonly store: StateStorePort<OverrideState> | undefined;
  private readonly onError: (error: unknown) => void;
  private readonly queued: QueuedOverride[] = [];
  private hydrated: boolean;
  private writes: Promise<void> = Promise.resolve();
  /** Resolves once the stored state is loaded (immediately without a store). */
  readonly ready: Promise<void>;

  /** Without `store` the state is session-only. */
  constructor(
    options: {
      readonly store?: StateStorePort<OverrideState>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store;
    this.onError = options.onError ?? (() => undefined);
    if (!options.store) {
      this.hydrated = true;
      this.ready = Promise.resolve();
      return;
    }
    this.hydrated = false;
    this.current = { ...INITIAL, paused: true, updatedBy: "loading" };
    this.ready = options.store.lookup(STATE_KEY).then(
      (saved) => this.settle(sanitize(saved)),
      (error: unknown) => {
        // Fail safe: an unreadable store leaves the system paused until a person resumes it.
        this.onError(error);
        this.settle({ ...INITIAL, paused: true, updatedBy: "unreadable-override-store" });
      },
    );
  }

  private settle(loaded: OverrideState): void {
    this.current = loaded;
    this.hydrated = true;
    // Orders given while loading are applied on top of what was stored, in order.
    for (const { action, by } of this.queued.splice(0)) {
      this.apply(action, by);
    }
  }

  private persist(): void {
    const store = this.store;
    if (!store) {
      return;
    }
    const snapshot = structuredClone(this.current);
    this.writes = this.writes.then(() =>
      store.register(STATE_KEY, snapshot).catch((error: unknown) => this.onError(error)),
    );
  }

  /** Resolves when the latest state has been handed to the store. */
  async flush(): Promise<void> {
    await this.ready;
    await this.writes;
  }

  state(): OverrideState {
    return structuredClone(this.current);
  }

  isCapabilityDisabled(capability: string): boolean {
    return this.current.disabledCapabilities.includes(capability);
  }

  /** The initiative actually allowed: paused means none, autonomy off caps it. */
  effectiveLevel(configured: AutonomyLevel): AutonomyLevel {
    if (this.current.paused) {
      return 0;
    }
    const ceiling = this.current.autonomyCeiling;
    return ceiling === null ? configured : (Math.min(configured, ceiling) as AutonomyLevel);
  }

  apply(
    action: OverrideAction,
    by: { readonly channel: OverrideChannel; readonly actor: string },
  ): OverrideResult {
    const narrowing = NARROWING_OVERRIDES.has(action.type);
    if (!narrowing && by.channel !== "owner") {
      return {
        ok: false,
        state: this.state(),
        tamper: true,
        reason: `${action.type} widens authority and only the owner can do it; the agent cannot undo a person's override.`,
      };
    }
    if (!this.hydrated) {
      // Remembered and applied over the stored state once it loads.
      this.queued.push({ action, by });
      return {
        ok: true,
        state: structuredClone({ ...this.transition(action), paused: true }),
        tamper: false,
        reason: `${action.type} accepted; it applies over the stored state once loading finishes`,
      };
    }
    const next = this.transition(action);
    this.current = {
      ...next,
      updatedAtISO: new Date(this.now()).toISOString(),
      updatedBy: `${by.channel}:${by.actor}`,
    };
    this.persist();
    return {
      ok: true,
      state: this.state(),
      tamper: false,
      reason: `${action.type} applied by ${by.actor}`,
    };
  }

  private transition(action: OverrideAction): OverrideState {
    const s = this.current;
    switch (action.type) {
      case "pause":
        return { ...s, paused: true };
      case "resume":
        return { ...s, paused: false };
      case "disable_autonomy":
        return { ...s, autonomyCeiling: AUTONOMY_OFF_CEILING };
      case "enable_autonomy":
        return { ...s, autonomyCeiling: null };
      case "disable_capability":
        return s.disabledCapabilities.includes(action.capability)
          ? s
          : { ...s, disabledCapabilities: [...s.disabledCapabilities, action.capability] };
      case "enable_capability":
        return {
          ...s,
          disabledCapabilities: s.disabledCapabilities.filter((c) => c !== action.capability),
        };
      // stop_motion and cancel_task change nothing persistent: the runtime acts on them.
      default:
        return s;
    }
  }
}
