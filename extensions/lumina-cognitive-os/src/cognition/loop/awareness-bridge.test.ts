/**
 * Tests for the awareness -> cognitive loop bridge.
 */
import { describe, expect, it, vi } from "vitest";
import { AwarenessEventBus } from "../../awareness/event-bus.js";
import { AttentionFilter } from "../attention.js";
import { attachAwareness } from "./awareness-bridge.js";
import { CognitiveLoop, type CycleRecord } from "./cognitive-loop.js";

const makeLoop = (run?: () => void) =>
  new CognitiveLoop({
    level: 5,
    attention: new AttentionFilter({ threshold: 0 }),
    reason: () => ({
      action: { summary: "handle it", riskTier: "SAFE", reversible: true, run },
      signals: [{ source: "test", value: 0.99 }],
    }),
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("attachAwareness", () => {
  it("turns a bus event into a completed cycle", async () => {
    const bus = new AwarenessEventBus();
    const run = vi.fn();
    const cycles: CycleRecord[] = [];
    attachAwareness(bus, makeLoop(run), { onCycle: (r) => cycles.push(r) });

    bus.emit({ kind: "battery.critical", percent: 4 });
    await settle();

    expect(cycles).toHaveLength(1);
    expect(cycles[0].executed).toBe(true);
    expect(cycles[0].event.source).toBe("awareness");
    expect(run).toHaveBeenCalledOnce();
  });

  it("stops delivering once unsubscribed", async () => {
    const bus = new AwarenessEventBus();
    const cycles: CycleRecord[] = [];
    const off = attachAwareness(bus, makeLoop(), { onCycle: (r) => cycles.push(r) });

    bus.emit({ kind: "network.offline" });
    await settle();
    off();
    bus.emit({ kind: "network.offline" });
    await settle();

    expect(cycles).toHaveLength(1);
  });

  it("never lets a loop failure escape into the emitter", async () => {
    const bus = new AwarenessEventBus();
    const loop = makeLoop();
    vi.spyOn(loop, "handle").mockRejectedValue(new Error("loop exploded"));
    const onError = vi.fn();
    attachAwareness(bus, loop, { onError });

    expect(() => bus.emit({ kind: "disk.low", drive: "C:", freePct: 3 })).not.toThrow();
    await settle();

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as Error).message).toBe("loop exploded");
  });
});
