/**
 * Tests for behaviors and prediction.
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../world/world-model.js";
import { planBehavior, runBehavior } from "./behaviors.js";
import { BODY_CAPABILITIES, SimulatedBody } from "./body.js";
import { EmbodiedController } from "./embodied-controller.js";
import { predict } from "./predict.js";

const NOW = Date.parse("2026-10-05T02:00:00.000Z");

const house = () => {
  const world = new WorldModel({ now: () => NOW });
  world.observe({ id: "kitchen", kind: "room", label: "cocina", confidence: 1, source: "sensor" });
  world.observe({ id: "office", kind: "room", label: "oficina", confidence: 1, source: "sensor" });
  world.observe({
    id: "dock",
    kind: "device",
    label: "cargador",
    position: { placeId: "office" },
    properties: { charger: true },
    confidence: 0.99,
    source: "sensor",
  });
  world.observe({
    id: "cup",
    kind: "object",
    label: "taza",
    position: { placeId: "kitchen" },
    confidence: 0.99,
    source: "sensor",
  });
  world.observe({
    id: "dal",
    kind: "person",
    label: "Dal",
    position: { placeId: "office" },
    confidence: 0.99,
    source: "sensor",
  });
  return world;
};

const controllerFor = (
  world: WorldModel,
  preAuthorized: string[] = ["robot.navigate", "robot.look", "robot.gesture"],
) => {
  const body = new SimulatedBody((id) => {
    const e = world.get(id);
    return e?.kind === "room" ? e.id : e?.position?.placeId;
  });
  const controller = new EmbodiedController({
    body,
    now: () => NOW,
    emergencyStop: { isEngaged: () => false, onEngage: () => () => undefined },
    context: () => ({
      autonomyLevel: 4,
      granted: new Set(BODY_CAPABILITIES),
      preAuthorized: new Set(preAuthorized),
      world,
      canObserve: true,
      canAsk: true,
    }),
  });
  return { body, controller };
};

describe("planBehavior", () => {
  it("plans bring_object as approach, grasp and the handover protocol", () => {
    const r = planBehavior("bring_object", { objectId: "cup", personId: "dal" }, house());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.steps.map((s) => s.intent.type)).toEqual([
        "navigate_to",
        "grasp",
        "navigate_to",
        "handover",
      ]);
      expect(r.plan.steps[3]?.why).toContain("detect_grasp");
    }
  });

  it("finds the charger through the world model, or says none is known", () => {
    expect(planBehavior("charge", {}, house())).toMatchObject({ ok: true });
    expect(planBehavior("charge", {}, new WorldModel({ now: () => NOW }))).toMatchObject({
      ok: false,
      resolution: "ask",
    });
  });

  it("goes where an object was last seen when the belief is stale", () => {
    const world = new WorldModel({ now: () => NOW + 2 * 86_400_000 });
    world.observe({
      id: "kitchen",
      kind: "room",
      label: "cocina",
      confidence: 1,
      source: "sensor",
      atISO: new Date(NOW).toISOString(),
    });
    world.observe({
      id: "keys",
      kind: "object",
      label: "llaves",
      position: { placeId: "kitchen" },
      confidence: 0.9,
      source: "sensor",
      atISO: new Date(NOW).toISOString(),
    });
    const r = planBehavior("find_object", { label: "llaves" }, world);
    expect(r.ok && r.plan.steps.map((s) => s.intent.type)).toEqual(["navigate_to", "look_at"]);
  });

  it("explains what is missing instead of throwing", () => {
    expect(planBehavior("follow_person", {}, house())).toMatchObject({ ok: false });
  });
});

describe("runBehavior", () => {
  it("completes a behavior whose every step safety allows", async () => {
    const world = house();
    const { body, controller } = controllerFor(world);
    const r = planBehavior("charge", {}, world);
    if (!r.ok) {
      throw new Error("setup");
    }
    const run = await runBehavior(r.plan, controller);
    expect(run.completed).toBe(true);
    expect(body.placeId()).toBe("office");
  });

  it("stops at the grasp and waits for a person: a behavior cannot push past confirmation", async () => {
    const world = house();
    const { body, controller } = controllerFor(world, ["robot.navigate", "robot.grasp"]);
    const r = planBehavior("bring_object", { objectId: "cup", personId: "dal" }, world);
    if (!r.ok) {
      throw new Error("setup");
    }
    const run = await runBehavior(r.plan, controller);
    expect(run).toMatchObject({ completed: false, stoppedAt: 1 });
    expect(run.pendingId).toMatch(/^confirm_/u);
    expect(body.held()).toBeUndefined();
  });
});

describe("predict", () => {
  it("lists failures, uncertainty and the verdict safety would give now", () => {
    const world = house();
    const { controller } = controllerFor(world);
    const intent = { type: "grasp", objectId: "cup" } as const;
    const p = predict(intent, { review: controller.review(intent), world, nowMs: NOW });
    expect(p.expectedOutcome).toBe("taza is held.");
    expect(p.verdict).toBe("confirm");
    expect(p.possibleFailures[0]).toMatch(/safety would confirm/u);
    expect(p.uncertainty).toBeCloseTo(0.01, 2);
    expect(p.simulated).toBe("symbolic");
  });

  it("flags a target the world model has never seen", () => {
    const world = house();
    const { controller } = controllerFor(world);
    const intent = { type: "navigate_to", targetId: "garage" } as const;
    const p = predict(intent, { review: controller.review(intent), world, nowMs: NOW });
    expect(p.uncertainty).toBe(1);
    expect(p.possibleFailures.some((f) => f.includes("not in the world model"))).toBe(true);
  });
});
