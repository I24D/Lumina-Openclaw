/**
 * attention-queue.ts — What to think about next, and when to drop everything.
 *
 * `attention.ts` answers "is this worth a cognitive cycle?". It does not say
 * which admitted event goes first, nor whether a new one should cut short the
 * cycle already running. This module owns both (Lumina spec §3.2):
 *
 *   attention_queue    admitted events ordered by salience, first-come within
 *                      a tie, bounded so a sensor flood evicts the least
 *                      salient work instead of growing without limit
 *   interrupt_manager  a newcomer preempts the active cycle only when it is
 *                      clearly more salient, or when it is an emergency
 *
 * Cognition is serial on purpose: one attention target at a time is what lets
 * gaze, speech and action stay coherent. Preemption is the escape hatch, and
 * it has a margin so two similar events cannot thrash each other.
 *
 * Pure data structure: no clock, no I/O, no bus.
 */
import type { AttentionVerdict, CognitiveEvent } from "./attention.js";

export type QueuedEvent = {
  readonly event: CognitiveEvent;
  readonly verdict: AttentionVerdict;
  /** Arrival order; breaks salience ties first-come, first-served. */
  readonly seq: number;
};

export type AttentionQueueOptions = {
  /** Maximum pending events. Default 64. */
  readonly capacity?: number;
  /** How much more salient a newcomer must be to preempt. Default 0.25. */
  readonly interruptMargin?: number;
  /** Importance and urgency both at or above this make an emergency. Default 0.9. */
  readonly emergencyFloor?: number;
};

export type PushResult = {
  /** False when the newcomer itself was the least salient item over capacity. */
  readonly accepted: boolean;
  readonly item: QueuedEvent;
  /** The item dropped to make room, when the queue was full. */
  readonly evicted?: QueuedEvent;
};

export type InterruptDecision = {
  readonly interrupt: boolean;
  readonly reason: string;
};

/** Higher salience first; earlier arrival first among equals. */
function compare(a: QueuedEvent, b: QueuedEvent): number {
  return b.verdict.salience - a.verdict.salience || a.seq - b.seq;
}

export class AttentionQueue {
  private items: QueuedEvent[] = [];
  private nextSeq = 0;
  private readonly capacity: number;
  private readonly interruptMargin: number;
  private readonly emergencyFloor: number;

  constructor(options: AttentionQueueOptions = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 64));
    this.interruptMargin = Math.max(0, options.interruptMargin ?? 0.25);
    this.emergencyFloor = Math.min(1, Math.max(0, options.emergencyFloor ?? 0.9));
  }

  get size(): number {
    return this.items.length;
  }

  push(event: CognitiveEvent, verdict: AttentionVerdict): PushResult {
    const item: QueuedEvent = { event, verdict, seq: this.nextSeq++ };
    this.items.push(item);
    this.items.sort(compare);
    if (this.items.length <= this.capacity) {
      return { accepted: true, item };
    }
    const evicted = this.items.pop() as QueuedEvent;
    return evicted === item ? { accepted: false, item } : { accepted: true, item, evicted };
  }

  /** Remove and return the most salient pending event. */
  pop(): QueuedEvent | undefined {
    return this.items.shift();
  }

  peek(): QueuedEvent | undefined {
    return this.items[0];
  }

  /** Pending events in the order they will be handled. */
  list(limit = this.capacity): ReadonlyArray<QueuedEvent> {
    return this.items.slice(0, Math.max(0, limit));
  }

  clear(): void {
    this.items = [];
  }

  isEmergency(item: QueuedEvent): boolean {
    const { importance, urgency } = item.verdict;
    return importance >= this.emergencyFloor && urgency >= this.emergencyFloor;
  }

  /** Should `incoming` cut short the cycle currently working on `active`? */
  shouldInterrupt(active: QueuedEvent, incoming: QueuedEvent): InterruptDecision {
    const a = active.verdict.salience;
    const b = incoming.verdict.salience;
    if (this.isEmergency(incoming) && !this.isEmergency(active)) {
      return {
        interrupt: true,
        reason: `emergency ${incoming.event.kind} preempts ${active.event.kind}`,
      };
    }
    if (b >= a + this.interruptMargin) {
      return {
        interrupt: true,
        reason: `${incoming.event.kind} (${b.toFixed(2)}) outranks ${active.event.kind} (${a.toFixed(2)}) by the margin`,
      };
    }
    return {
      interrupt: false,
      reason: `${incoming.event.kind} (${b.toFixed(2)}) waits behind ${active.event.kind} (${a.toFixed(2)})`,
    };
  }
}
