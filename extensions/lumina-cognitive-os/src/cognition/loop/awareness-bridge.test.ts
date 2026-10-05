/**
 * Tests for the awareness -> router -> cognitive loop path.
 */
import { describe, expect, it, vi } from "vitest";
import { AwarenessEventBus } from "../../awareness/event-bus.js";
import { AttentionFilter } from "../attention.js";
import { ThalamicRouter } from "../router/thalamic-router.js";
import { attachAwareness } from "./awareness-bridge.js";
import { CognitiveLoop, type CycleRecord } from "./cognitive-loop.js";

const makeLoop = (onCycle: (r: CycleRecord) => void, run?: () => void) =>
  new CognitiveLoop({
    level: 5,
    onCycle,
    reason: () => ({
      action: { summary: "handle it", riskTier: "SAFE", reversible: true, run },
      signals: [{ source: "test", value: 0.99 }],
    }),
  });

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("attachAwareness", () => {
  it("turns a bus event into a completed cycle through the router", async () => {
    const bus = new AwarenessEventBus();
    const router = new ThalamicRouter({ attention: new AttentionFilter({ threshold: 0 }) });
    const run = vi.fn();
    const cycles: CycleRecord[] = [];
    makeLoop((r) => cycles.push(r), run).consume(router);
    attachAwareness(bus, router);

    bus.emit({ kind: "battery.critical", percent: 4 });
    await settle();

    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.executed).toBe(true);
    expect(cycles[0]?.event.source).toBe("awareness");
    expect(run).toHaveBeenCalledOnce();
  });

  it("stops delivering once unsubscribed", () => {
    const bus = new AwarenessEventBus();
    const ingest = vi.fn();
    const off = attachAwareness(bus, { ingest });

    bus.emit({ kind: "network.offline" });
    off();
    bus.emit({ kind: "network.offline" });

    expect(ingest).toHaveBeenCalledOnce();
  });

  it("never lets a router failure escape into the emitter", () => {
    const bus = new AwarenessEventBus();
    const onError = vi.fn();
    attachAwareness(
      bus,
      {
        ingest: () => {
          throw new Error("router exploded");
        },
      },
      { onError },
    );

    expect(() => bus.emit({ kind: "disk.low", drive: "C:", freePct: 3 })).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "router exploded" });
  });
});
