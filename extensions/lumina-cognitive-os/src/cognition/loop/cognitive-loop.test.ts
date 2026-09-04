/**
 * Tests for the cognitive loop.
 */
import { describe, expect, it, vi } from "vitest";
import { AttentionFilter, type CognitiveEvent } from "../attention.js";
import {
  CognitiveLoop,
  type CycleRecord,
  type ProposedAction,
  type Reasoner,
} from "./cognitive-loop.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

const event = (kind: string, extra: Partial<CognitiveEvent> = {}): CognitiveEvent => ({
  source: "test",
  kind,
  atISO: new Date(NOW).toISOString(),
  importance: 0.9,
  urgency: 0.9,
  ...extra,
});

const action = (extra: Partial<ProposedAction> = {}): ProposedAction => ({
  summary: "free disk space",
  riskTier: "SAFE",
  reversible: true,
  ...extra,
});

const reasonerFor =
  (a: ProposedAction | undefined, confidence = 0.99): Reasoner =>
  () =>
    a ? { action: a, signals: [{ source: "test", value: confidence }] } : { signals: [] };

describe("CognitiveLoop", () => {
  it("drops an event that attention rejects, without reasoning", () => {
    const reason = vi.fn(reasonerFor(action()));
    const loop = new CognitiveLoop({
      level: 5,
      reason,
      attention: new AttentionFilter({ threshold: 0.99 }),
      now: () => NOW,
    });
    return loop.handle(event("cpu.high", { importance: 0.1, urgency: 0.1 })).then((r) => {
      expect(r.admitted).toBe(false);
      expect(r.executed).toBe(false);
      expect(reason).not.toHaveBeenCalled();
    });
  });

  it("executes a safe, confident, reversible action at L5", async () => {
    const run = vi.fn();
    const loop = new CognitiveLoop({
      level: 5,
      reason: reasonerFor(action({ run })),
      now: () => NOW,
    });
    const r = await loop.handle(event("disk.low"));
    expect(r.outcome).toBe("execute");
    expect(r.executed).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("never runs the action when the gate only proposes", async () => {
    const run = vi.fn();
    const loop = new CognitiveLoop({
      level: 3, // proactive: propose, never execute
      reason: reasonerFor(action({ run })),
      now: () => NOW,
    });
    const r = await loop.handle(event("disk.low"));
    expect(r.outcome).toBe("propose");
    expect(r.executed).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("never runs a CRITICAL action even at L5 with full confidence", async () => {
    const run = vi.fn();
    const loop = new CognitiveLoop({
      level: 5,
      reason: reasonerFor(action({ run, riskTier: "CRITICAL" })),
      now: () => NOW,
    });
    const r = await loop.handle(event("disk.low"));
    expect(r.executed).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("degrades to asking when confidence is low", async () => {
    const run = vi.fn();
    const loop = new CognitiveLoop({
      level: 5,
      reason: reasonerFor(action({ run }), 0.2),
      now: () => NOW,
    });
    const r = await loop.handle(event("disk.low"));
    expect(r.outcome).toBe("confirm");
    expect(run).not.toHaveBeenCalled();
  });

  it("records that nothing was proposed", async () => {
    const loop = new CognitiveLoop({ level: 5, reason: reasonerFor(undefined), now: () => NOW });
    const r = await loop.handle(event("disk.low"));
    expect(r.admitted).toBe(true);
    expect(r.executed).toBe(false);
    expect(r.reason).toContain("no action proposed");
  });

  it("survives a reasoner that throws", async () => {
    const loop = new CognitiveLoop({
      level: 5,
      reason: () => {
        throw new Error("model unavailable");
      },
      now: () => NOW,
    });
    const r = await loop.handle(event("disk.low"));
    expect(r.executed).toBe(false);
    expect(r.error).toBe("model unavailable");
  });

  it("captures an execution failure instead of throwing", async () => {
    const loop = new CognitiveLoop({
      level: 5,
      reason: reasonerFor(
        action({
          run: () => {
            throw new Error("disk busy");
          },
        }),
      ),
      now: () => NOW,
    });
    const r = await loop.handle(event("disk.low"));
    expect(r.executed).toBe(false);
    expect(r.error).toBe("disk busy");
    expect(r.reason).toContain("execution failed");
  });

  it("surfaces everything it did not execute", async () => {
    const surfaced: CycleRecord[] = [];
    const loop = new CognitiveLoop({
      level: 3,
      reason: reasonerFor(action()),
      onSurface: (r) => surfaced.push(r),
      now: () => NOW,
    });
    await loop.handle(event("disk.low"));
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0].outcome).toBe("propose");
  });

  it("keeps running when an observer throws", async () => {
    const loop = new CognitiveLoop({
      level: 5,
      reason: reasonerFor(action()),
      onCycle: () => {
        throw new Error("bad observer");
      },
      now: () => NOW,
    });
    const r = await loop.handle(event("disk.low"));
    expect(r.executed).toBe(true);
  });

  it("changes behaviour when the level is lowered at runtime", async () => {
    const run = vi.fn();
    const loop = new CognitiveLoop({
      level: 5,
      reason: reasonerFor(action({ run })),
      attention: new AttentionFilter({ threshold: 0 }),
      now: () => NOW,
    });
    expect((await loop.handle(event("disk.low"))).executed).toBe(true);
    loop.setLevel(0);
    expect(loop.getLevel()).toBe(0);
    const blocked = await loop.handle(event("disk.low"));
    expect(blocked.outcome).toBe("block");
    expect(run).toHaveBeenCalledOnce();
  });

  it("caps retained history", async () => {
    const loop = new CognitiveLoop({
      level: 5,
      reason: reasonerFor(action()),
      attention: new AttentionFilter({ threshold: 0 }),
      historyLimit: 3,
      now: () => NOW,
    });
    for (let i = 0; i < 10; i += 1) {
      await loop.handle(event(`kind.${i}`));
    }
    expect(loop.recent(100)).toHaveLength(3);
  });
});
