/**
 * attention.ts — Salience filter implementation for the cognitive loop.
 *
 * Stable event/attention contracts live in ../contracts/attention.ts so
 * producers outside cognition do not depend on this implementation layer.
 */
import type { AwarenessChange } from "../awareness/event-bus.js";
import type {
  AttentionOptions,
  AttentionVerdict,
  CognitiveEvent,
  SalienceWeights,
} from "../contracts/attention.js";

export {
  trustOf,
  UNTRUSTED_SOURCES,
  type AttentionOptions,
  type AttentionVerdict,
  type CognitiveEvent,
  type EventTrust,
  type SalienceWeights,
} from "../contracts/attention.js";

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  importance: 0.45,
  urgency: 0.35,
  novelty: 0.2,
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

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

  reset(): void {
    this.lastSeen.clear();
  }
}
