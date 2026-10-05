/**
 * Tests for the cognitive loop.
 */
import { describe, expect, it, vi } from "vitest";
import { AttentionFilter, type CognitiveEvent } from "../attention.js";
import { ThalamicRouter } from "../router/thalamic-router.js";
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
    expect(surfaced[0]?.outcome).toBe("propose");
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

describe("CognitiveLoop.consume", () => {
  const settle = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

  const routerAt = () =>
    new ThalamicRouter({ attention: new AttentionFilter({ threshold: 0 }), now: () => NOW });

  it("drains pending events in salience order, one cycle at a time", async () => {
    const router = routerAt();
    const order: string[] = [];
    const loop = new CognitiveLoop({
      level: 5,
      now: () => NOW,
      reason: (e) => ({
        action: action({ summary: e.kind, run: () => void order.push(e.kind) }),
        signals: [{ source: "test", value: 0.99 }],
      }),
    });
    router.ingest(event("cpu.high", { importance: 0.4, urgency: 0.4 }));
    router.ingest(event("battery.critical", { importance: 0.95, urgency: 0.95 }));

    loop.consume(router);
    await settle();

    expect(order).toEqual(["battery.critical", "cpu.high"]);
    expect(router.pending).toBe(0);
  });

  it("aborts a running action when an emergency arrives, then handles the emergency", async () => {
    const router = routerAt();
    const cycles: CycleRecord[] = [];
    const interrupts: string[] = [];
    const loop = new CognitiveLoop({
      level: 5,
      now: () => NOW,
      onCycle: (r) => cycles.push(r),
      reason: (e) => ({
        action: action({
          summary: e.kind,
          // The long task only ends when it is told to stop.
          run:
            e.kind === "long.task"
              ? (signal) =>
                  new Promise<void>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason));
                  })
              : () => undefined,
        }),
        signals: [{ source: "test", value: 0.99 }],
      }),
    });
    loop.consume(router, { onInterrupt: (_a, incoming) => interrupts.push(incoming.event.kind) });

    router.ingest(event("long.task", { importance: 0.5, urgency: 0.5 }));
    expect(loop.activeEvent()?.event.kind).toBe("long.task");
    router.ingest(event("fall.detected", { importance: 0.95, urgency: 0.95 }));
    await settle();

    expect(interrupts).toEqual(["fall.detected"]);
    expect(cycles.map((c) => [c.event.kind, c.executed, c.interrupted ?? false])).toEqual([
      ["long.task", false, true],
      ["fall.detected", true, false],
    ]);
    expect(loop.activeEvent()).toBeUndefined();
  });

  it("lets a similar event wait instead of interrupting", async () => {
    const router = routerAt();
    const interrupts = vi.fn();
    let finish: () => void = () => undefined;
    const loop = new CognitiveLoop({
      level: 5,
      now: () => NOW,
      reason: (e) => ({
        action: action({
          summary: e.kind,
          run:
            e.kind === "first"
              ? () =>
                  new Promise<void>((resolve) => {
                    finish = resolve;
                  })
              : () => undefined,
        }),
        signals: [{ source: "test", value: 0.99 }],
      }),
    });
    loop.consume(router, { onInterrupt: interrupts });

    router.ingest(event("first", { importance: 0.5, urgency: 0.5 }));
    router.ingest(event("second", { importance: 0.55, urgency: 0.55 }));
    expect(router.pending).toBe(1);
    finish();
    await settle();

    expect(interrupts).not.toHaveBeenCalled();
    expect(router.pending).toBe(0);
  });

  it("leaves pending events queued when detached mid-cycle instead of dropping them", async () => {
    const router = routerAt();
    const loop = new CognitiveLoop({
      level: 5,
      now: () => NOW,
      reason: (e) => ({
        action: action({
          summary: e.kind,
          run:
            e.kind === "long.task"
              ? (signal) =>
                  new Promise<void>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason));
                  })
              : () => undefined,
        }),
        signals: [{ source: "test", value: 0.99 }],
      }),
    });
    const detach = loop.consume(router);
    router.ingest(event("long.task", { importance: 0.5, urgency: 0.5 }));
    router.ingest(event("later", { importance: 0.5, urgency: 0.5 }));

    detach();
    await settle();

    expect(router.pendingEvents().map((i) => i.event.kind)).toEqual(["later"]);
  });

  it("stops draining once detached", async () => {
    const router = routerAt();
    const reason = vi.fn(reasonerFor(action()));
    const loop = new CognitiveLoop({ level: 5, now: () => NOW, reason });
    const detach = loop.consume(router);
    detach();

    router.ingest(event("battery.critical"));
    await settle();

    expect(reason).not.toHaveBeenCalled();
    expect(router.pending).toBe(1);
  });
});
