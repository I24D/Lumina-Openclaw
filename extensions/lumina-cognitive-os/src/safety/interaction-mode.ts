/**
 * interaction-mode.ts — How Lumina behaves with whom: normal, child, companion, maintenance.
 *
 * M3GAN spec §41 (child interaction mode), §96 (companion mode) and §125
 * (maintenance mode):
 *   - child: grasping and handing objects over are off; the agent keeps
 *     language simple and kind and involves a guardian; leaving the mode
 *     leaves an activity summary for the guardian, built from the audit;
 *   - maintenance: autonomy paused and motion off except looking and gestures,
 *     for a technician or the owner to work on the system;
 *   - companion: more social initiative (check-ins), nothing physical;
 *   - normal: none of the above.
 *
 * A mode is a restriction layer of its own, added on top of a person's
 * overrides and never written into them. Leaving a mode therefore lifts only
 * what the mode imposed: a capability or pause a person ordered stays exactly
 * as they left it. Entering child or maintenance only narrows, so the agent may
 * do it; leaving them and entering companion widen, so only the owner channel
 * (the authenticated M3GAN tab) can.
 */
import type { StateStorePort } from "../shared/state-store.js";
import type { AuditRecord } from "./audit-log.js";
import type { OverrideChannel } from "./overrides.js";
import type { SafetyKernel } from "./safety-kernel.js";

export const INTERACTION_MODES = ["normal", "child", "companion", "maintenance"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export type ModeState = {
  readonly mode: InteractionMode;
  readonly sinceISO: string;
  readonly by: string;
  /** What happened during the last child-mode session, for the guardian. */
  readonly lastSummary?: string;
};

export type ModeResult =
  | { readonly ok: true; readonly state: ModeState }
  | { readonly ok: false; readonly reason: string };

/** What a mode adds to a person's overrides while it lasts. */
export type ModeRestrictions = {
  readonly paused: boolean;
  readonly disabledCapabilities: ReadonlyArray<string>;
};

const RESTRICTIVE: ReadonlySet<InteractionMode> = new Set(["child", "maintenance"]);

const RESTRICTIONS: Readonly<Record<InteractionMode, ModeRestrictions>> = {
  normal: { paused: false, disabledCapabilities: [] },
  companion: { paused: false, disabledCapabilities: [] },
  child: { paused: false, disabledCapabilities: ["robot.grasp", "robot.handover"] },
  maintenance: {
    paused: true,
    disabledCapabilities: ["robot.navigate", "robot.grasp", "robot.handover"],
  },
};

/** What the agent should know about the mode it is in. */
export const MODE_GUIDANCE: Readonly<Record<InteractionMode, string>> = {
  normal: "Normal mode.",
  child:
    "Child mode: use simple, kind, age-appropriate language; no adult content; never pretend to be a parent; teach and explain rather than do it for them; involve a guardian for anything that matters; no grasping or handing objects.",
  companion:
    "Companion mode: check in now and then and remember what matters to the person; no emotional manipulation, no pressure or guilt, never present yourself as their only company; encourage their own plans and other people.",
  maintenance:
    "Maintenance mode: autonomy paused and motion off except looking and gestures; answer diagnostics questions; do not start tasks.",
};

const STATE_KEY = "mode";

const isMode = (value: unknown): value is InteractionMode =>
  typeof value === "string" && (INTERACTION_MODES as ReadonlyArray<string>).includes(value);

/** A guardian's view of a session: what was recorded, by kind, and what was refused. */
export function summarizeActivity(
  records: ReadonlyArray<AuditRecord>,
  fromISO: string,
  toISO: string,
): string {
  const minutes = Math.max(0, Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 60_000));
  const within = records.filter((r) => r.atISO >= fromISO && r.atISO <= toISO);
  if (within.length === 0) {
    return `Child mode lasted ${minutes} min; nothing was recorded.`;
  }
  const byKind = new Map<string, { count: number; refused: number }>();
  for (const record of within) {
    const kind = record.action.split(".")[0] ?? record.action;
    const entry = byKind.get(kind) ?? { count: 0, refused: 0 };
    entry.count += 1;
    entry.refused += record.execution === "refused" ? 1 : 0;
    byKind.set(kind, entry);
  }
  const parts = [...byKind.entries()]
    .toSorted((a, b) => b[1].count - a[1].count)
    .map(([kind, e]) => `${kind} ${e.count}${e.refused > 0 ? ` (${e.refused} refused)` : ""}`);
  return `Child mode lasted ${minutes} min with ${within.length} recorded actions: ${parts.join(", ")}.`;
}

export class InteractionModes {
  private current: ModeState;
  private loaded = false;
  private readonly now: () => number;
  private writes: Promise<void>;
  readonly ready: Promise<void>;

  constructor(
    private readonly options: {
      /** Entering maintenance stops motion and the running task (narrowing only). */
      readonly safety?: Pick<SafetyKernel, "override">;
      readonly store?: StateStorePort<ModeState>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
      /** After every change: re-apply levels, tell the agent, audit. */
      readonly onChange?: (state: ModeState) => void;
      /** The audit, for the activity summary when child mode ends. */
      readonly activity?: () => ReadonlyArray<AuditRecord>;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.current = { mode: "normal", sinceISO: new Date(this.now()).toISOString(), by: "default" };
    // Without a store the mode is session-only and known at once.
    this.loaded = !options.store;
    this.ready = (async () => {
      try {
        const stored = await options.store?.lookup(STATE_KEY);
        if (stored && isMode(stored.mode)) {
          this.current = stored;
        }
      } catch (error) {
        options.onError?.(error);
      }
      this.loaded = true;
    })();
    this.writes = this.ready;
  }

  state(): ModeState {
    return structuredClone(this.current);
  }

  /** Until the stored mode is known, the strictest one applies (fail safe). */
  restrictions(): ModeRestrictions {
    return RESTRICTIONS[this.loaded ? this.current.mode : "maintenance"];
  }

  async set(
    mode: InteractionMode,
    by: { readonly channel: OverrideChannel; readonly actor: string },
  ): Promise<ModeResult> {
    if (!isMode(mode)) {
      return { ok: false, reason: `Unknown interaction mode ${String(mode)}.` };
    }
    await this.ready;
    const from = this.current.mode;
    if (mode === from) {
      return { ok: true, state: this.state() };
    }
    if ((RESTRICTIVE.has(from) || mode === "companion") && by.channel !== "owner") {
      return {
        ok: false,
        reason: `Leaving ${from} mode or entering companion mode widens what Lumina does; only the owner can, in the M3GAN tab.`,
      };
    }
    const atISO = new Date(this.now()).toISOString();
    const lastSummary =
      from === "child" && this.options.activity
        ? summarizeActivity(this.options.activity(), this.current.sinceISO, atISO)
        : this.current.lastSummary;
    this.current = {
      mode,
      sinceISO: atISO,
      by: `${by.channel}:${by.actor}`,
      ...(lastSummary ? { lastSummary } : {}),
    };
    const store = this.options.store;
    if (store) {
      const snapshot = this.state();
      this.writes = this.writes.then(() =>
        store
          .register(STATE_KEY, snapshot)
          .catch((error: unknown) => this.options.onError?.(error)),
      );
    }
    this.options.onChange?.(this.state());
    if (mode === "maintenance") {
      await this.options.safety?.override({ type: "stop_motion" }, by);
      await this.options.safety?.override({ type: "cancel_task" }, by);
    }
    return { ok: true, state: this.state() };
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
