import { describe, expect, it } from "vitest";
import type { EmbodiedResult } from "../../embodiment/embodied-controller.js";
import { coreEvent } from "../../events/catalog.js";
import { MemoryStateStore } from "../../shared/state-store.js";
import { CausalModel, type CausalStats } from "./causal-model.js";

const START = Date.parse("2026-10-06T08:00:00.000Z");
const at = (seconds: number) => ({ atISO: new Date(START + seconds * 1_000).toISOString() });

const body = (ok: boolean): EmbodiedResult =>
  ({
    atISO: new Date(START).toISOString(),
    intent: { type: "navigate_to", targetId: "kitchen" },
    review: { verdict: "allow", capability: "robot.navigate", reasons: [], limits: {} },
    outcome: { ok, detail: ok ? "Arrived." : "Path blocked." },
    requestedBy: "agent",
  }) as unknown as EmbodiedResult;

describe("causal model", () => {
  it("measures what Lumina's own actions do, apart from what happens around her", async () => {
    const store = new MemoryStateStore<CausalStats>();
    const model = new CausalModel({ store, now: () => START });
    model.recordBody(body(true));
    model.recordBody(body(true));
    model.recordBody(body(false));
    model.observe(coreEvent("agent", "tool.completed", { tool: "lumina_world_query", ok: true }));
    const effects = model.interventions();
    expect(effects.find((e) => e.subject === "body.navigate_to")).toMatchObject({
      count: 3,
      held: 2,
      reliability: 0.67,
      lastDetail: "Path blocked.",
    });
    expect(effects.find((e) => e.subject === "tool.lumina_world_query")?.reliability).toBe(1);
    await model.flush();
    const restarted = new CausalModel({ store });
    await restarted.ready;
    expect(restarted.interventions()).toHaveLength(2);
  });

  it("reports events that follow each other only as correlation", () => {
    const model = new CausalModel({ now: () => START });
    for (let day = 0; day < 4; day++) {
      const base = day * 3_600;
      model.observe(
        coreEvent("camera", "person.detected", { label: "Dal", confidence: 0.9 }, at(base)),
      );
      model.observe(coreEvent("awareness", "battery.low", { percent: 15 }, at(base + 30)));
    }
    model.observe(coreEvent("screen", "screen.changed", { changedRatio: 0.5 }, at(99_999)));
    const [top] = model.correlations();
    expect(top).toMatchObject({
      subject: "person.detected -> battery.low",
      count: 4,
      note: "correlation, not causation",
    });
    expect(model.interventions()).toHaveLength(0);
    expect(model.correlations().some((c) => c.subject.includes("screen.changed"))).toBe(false);
  });
});
