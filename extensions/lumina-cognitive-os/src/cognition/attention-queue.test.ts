/**
 * Tests for the attention queue and interrupt manager.
 */
import { describe, expect, it } from "vitest";
import { AttentionQueue, type QueuedEvent } from "./attention-queue.js";
import type { AttentionVerdict, CognitiveEvent } from "./attention.js";

const event = (kind: string): CognitiveEvent => ({
  source: "test",
  kind,
  atISO: "2026-10-04T12:00:00.000Z",
});

const verdict = (
  salience: number,
  importance = salience,
  urgency = salience,
): AttentionVerdict => ({
  admitted: true,
  salience,
  importance,
  urgency,
  novelty: 1,
  reason: "test",
});

const kinds = (items: ReadonlyArray<QueuedEvent>) => items.map((i) => i.event.kind);

describe("AttentionQueue ordering", () => {
  it("hands out the most salient event first", () => {
    const q = new AttentionQueue();
    q.push(event("low"), verdict(0.4));
    q.push(event("high"), verdict(0.9));
    q.push(event("mid"), verdict(0.6));

    expect(kinds(q.list())).toEqual(["high", "mid", "low"]);
    expect(q.pop()?.event.kind).toBe("high");
    expect(q.size).toBe(2);
  });

  it("keeps arrival order among equally salient events", () => {
    const q = new AttentionQueue();
    q.push(event("first"), verdict(0.5));
    q.push(event("second"), verdict(0.5));

    expect(kinds(q.list())).toEqual(["first", "second"]);
  });
});

describe("AttentionQueue capacity", () => {
  it("evicts the least salient pending event when full", () => {
    const q = new AttentionQueue({ capacity: 2 });
    q.push(event("a"), verdict(0.5));
    q.push(event("b"), verdict(0.6));
    const result = q.push(event("c"), verdict(0.9));

    expect(result.accepted).toBe(true);
    expect(result.evicted?.event.kind).toBe("a");
    expect(kinds(q.list())).toEqual(["c", "b"]);
  });

  it("refuses a newcomer that would itself be the one evicted", () => {
    const q = new AttentionQueue({ capacity: 2 });
    q.push(event("a"), verdict(0.7));
    q.push(event("b"), verdict(0.8));
    const result = q.push(event("noise"), verdict(0.1));

    expect(result.accepted).toBe(false);
    expect(result.evicted).toBeUndefined();
    expect(kinds(q.list())).toEqual(["b", "a"]);
  });
});

describe("AttentionQueue interrupts", () => {
  const q = new AttentionQueue({ interruptMargin: 0.25, emergencyFloor: 0.9 });
  const item = (kind: string, v: AttentionVerdict): QueuedEvent => ({
    event: event(kind),
    verdict: v,
    seq: 0,
  });

  it("lets a clearly more salient event preempt", () => {
    const decision = q.shouldInterrupt(
      item("cpu.high", verdict(0.4)),
      item("door.opened", verdict(0.7)),
    );
    expect(decision.interrupt).toBe(true);
  });

  it("makes a slightly more salient event wait, so similar events cannot thrash", () => {
    const decision = q.shouldInterrupt(
      item("cpu.high", verdict(0.5)),
      item("ram.high", verdict(0.6)),
    );
    expect(decision.interrupt).toBe(false);
    expect(decision.reason).toContain("waits behind");
  });

  it("always lets an emergency preempt ordinary work", () => {
    const active = item("task", verdict(0.85, 0.7, 0.7));
    const emergency = item("fall.detected", verdict(0.9, 0.95, 0.95));
    expect(q.shouldInterrupt(active, emergency).interrupt).toBe(true);
  });

  it("does not let one emergency preempt another of equal standing", () => {
    const a = item("smoke", verdict(0.95, 0.95, 0.95));
    const b = item("gas", verdict(0.95, 0.95, 0.95));
    expect(q.shouldInterrupt(a, b).interrupt).toBe(false);
  });
});
