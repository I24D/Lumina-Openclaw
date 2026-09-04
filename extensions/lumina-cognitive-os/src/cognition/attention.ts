/**
 * attention.ts — Salience filter for the cognitive loop.
 *
 * The plugin already has a pub/sub bus (`awareness/event-bus.ts`) that fires on
 * every environment change. Firing is cheap; *thinking* about an event is not.
 * Attention sits between them and answers one question: "is this worth a
 * cognitive cycle?"
 *
 * Salience is a weighted blend of three axes, each in [0,1]:
 *   - importance: how much this matters if true (mostly intrinsic to the kind)
 *   - urgency:    how much worse it gets by waiting
 *   - novelty:    how different this is from what we just saw
 *
 * Novelty is stateful and decays: the tenth "cpu.high" in a row is noise, but
 * the same event after an hour of quiet is information. That decay is what
 * stops a flapping sensor from monopolising the loop.
 */

import type { AwarenessChange } from "../awareness/event-bus.js";

/** A normalized event from any source, not just environment awareness. */
export type CognitiveEvent = {
  /** Origin, e.g. "awareness", "whatsapp", "calendar", "user". */
  readonly source: string;
  /** Stable event type used for novelty tracking, e.g. "battery.low". */
  readonly kind: string;
  readonly atISO: string;
  /** Intrinsic weight in [0,1]; defaults applied when omitted. */
  readonly importance?: number;
  readonly urgency?: number;
  readonly payload?: unknown;
};

export type SalienceWeights = {
  readonly importance: number;
  readonly urgency: number;
  readonly novelty: number;
};

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  importance: 0.45,
  urgency: 0.35,
  novelty: 0.2,
};

export type AttentionVerdict = {
  readonly admitted: boolean;
  readonly salience: number;
  readonly importance: number;
  readonly urgency: number;
  readonly novelty: number;
  readonly reason: string;
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Baseline importance/urgency per awareness event kind.
 *
 * These are the "if I know nothing else" priors. A caller with better
 * information can always override them on the CognitiveEvent.
 */
const AWARENESS_PRIORS: Record<string, { importance: number; urgency: number }> = {
  "battery.critical": { importance: 0.95, urgency: 0.95 },
  "battery.low": { importance: 0.6, urgency: 0.55 },
  "battery.charging.changed": { importance: 0.2, urgency: 0.1 },
  "network.offline": { importance: 0.85, urgency: 0.9 },
  "network.online": { importance: 0.4, urgency: 0.3 },
  "disk.low": { importance: 0.75, urgency: 0.5 },
  "cpu.high": { importance: 0.45, urgency: 0.4 },
  "ram.high": { importance: 0.5, urgency: 0.45 },
  "monitor.added": { importance: 0.25, urgency: 0.15 },
  "monitor.removed": { importance: 0.3, urgency: 0.2 },
  "gpu.changed": { importance: 0.3, urgency: 0.15 },
  "device.added": { importance: 0.25, urgency: 0.15 },
  "device.removed": { importance: 0.3, urgency: 0.2 },
};

/** Adapt an environment event onto the generic cognitive event shape. */
export function fromAwareness(change: AwarenessChange, atISO?: string): CognitiveEvent {
  const prior = AWARENESS_PRIORS[change.kind] ?? { importance: 0.4, urgency: 0.3 };
  return {
    source: "awareness",
    kind: change.kind,
    atISO: atISO ?? new Date().toISOString(),
    importance: prior.importance,
    urgency: prior.urgency,
    payload: change,
  };
}

export type AttentionOptions = {
  /** Salience at or above this is admitted. Default 0.35. */
  readonly threshold?: number;
  readonly weights?: Partial<SalienceWeights>;
  /** How long until a repeated event is fully novel again. Default 15 min. */
  readonly noveltyWindowMs?: number;
};

export class AttentionFilter {
  private readonly lastSeen = new Map<string, number>();
  private readonly threshold: number;
  private readonly weights: SalienceWeights;
  private readonly noveltyWindowMs: number;

  constructor(options: AttentionOptions = {}) {
    this.threshold = clamp01(options.threshold ?? 0.35);
    this.weights = {
      importance: options.weights?.importance ?? DEFAULT_SALIENCE_WEIGHTS.importance,
      urgency: options.weights?.urgency ?? DEFAULT_SALIENCE_WEIGHTS.urgency,
      novelty: options.weights?.novelty ?? DEFAULT_SALIENCE_WEIGHTS.novelty,
    };
    this.noveltyWindowMs = Math.max(1, options.noveltyWindowMs ?? 15 * 60 * 1000);
  }

  /**
   * Novelty for a kind: 0 right after it was seen, rising linearly back to 1
   * across the novelty window. Unseen kinds are fully novel.
   */
  noveltyFor(kind: string, nowMs: number): number {
    const last = this.lastSeen.get(kind);
    if (last === undefined) {
      return 1;
    }
    const elapsed = nowMs - last;
    if (elapsed <= 0) {
      return 0;
    }
    return clamp01(elapsed / this.noveltyWindowMs);
  }

  /**
   * Score an event and decide whether it deserves a cognitive cycle.
   * Recording the sighting is a side effect, so a flood of identical events
   * decays on its own.
   */
  consider(event: CognitiveEvent, nowMs: number = Date.now()): AttentionVerdict {
    const importance = clamp01(event.importance ?? 0.4);
    const urgency = clamp01(event.urgency ?? 0.3);
    const novelty = this.noveltyFor(event.kind, nowMs);
    const w = this.weights;
    const totalWeight = w.importance + w.urgency + w.novelty;
    const salience =
      totalWeight > 0
        ? clamp01(
            (importance * w.importance + urgency * w.urgency + novelty * w.novelty) / totalWeight,
          )
        : 0;
    this.lastSeen.set(event.kind, nowMs);
    const admitted = salience >= this.threshold;
    const reason = admitted
      ? `admitted: salience ${salience.toFixed(2)} >= ${this.threshold.toFixed(2)}`
      : `ignored: salience ${salience.toFixed(2)} < ${this.threshold.toFixed(2)} (novelty ${novelty.toFixed(2)})`;
    return { admitted, salience, importance, urgency, novelty, reason };
  }

  /** Drop novelty history (used by tests and by a loop restart). */
  reset(): void {
    this.lastSeen.clear();
  }
}
