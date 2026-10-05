/**
 * Tests for the body contract, the safety supervisor and the embodied controller.
 */
import { describe, expect, it, vi } from "vitest";
import { WorldModel } from "../world/world-model.js";
import {
  BODY_CAPABILITIES,
  NullBody,
  SimulatedBody,
  type BodyAdapter,
  type BodyIntent,
} from "./body.js";
import { EmbodiedController, type EmergencyStop } from "./embodied-controller.js";
import { reviewIntent, type SafetyContext } from "./safety-supervisor.js";

const NOW = Date.parse("2026-10-04T20:41:00.000Z");

const furnishedWorld = (now = () => NOW) => {
  const world = new WorldModel({ now });
  world.observe({ id: "kitchen", kind: "room", label: "cocina", confidence: 1, source: "sensor" });
  world.observe({
    id: "table",
    kind: "furniture",
    label: "mesa",
    position: { placeId: "kitchen" },
    confidence: 0.99,
    source: "sensor",
  });
  world.observe({
    id: "cup",
    kind: "object",
    label: "taza",
    position: { placeId: "table" },
    confidence: 0.99,
    source: "sensor",
  });
  world.observe({
    id: "dal",
    kind: "person",
    label: "Dal",
    position: { placeId: "kitchen" },
    confidence: 0.99,
    source: "sensor",
  });
  return world;
};

const ctx = (extra: Partial<SafetyContext> = {}): SafetyContext => ({
  autonomyLevel: 4,
  bodyMode: "simulated",
  granted: new Set(BODY_CAPABILITIES),
  preAuthorized: new Set<string>(),
  emergencyStop: false,
  world: furnishedWorld(),
  canObserve: true,
  canAsk: true,
  nowMs: NOW,
  ...extra,
});

describe("reviewIntent hard limits", () => {
  it("always allows stop, even with the e-stop engaged, no body and no grants", () => {
    const review = reviewIntent(
      { type: "stop" },
      ctx({ emergencyStop: true, bodyMode: "none", granted: new Set() }),
    );
    expect(review.verdict).toBe("allow");
  });

  it("refuses everything else while the emergency stop is engaged", () => {
    const review = reviewIntent({ type: "look_at", targetId: "dal" }, ctx({ emergencyStop: true }));
    expect(review.verdict).toBe("deny");
    expect(review.reasons[0]).toContain("Emergency stop");
  });

  it("refuses motion when there is no body", () => {
    expect(
      reviewIntent({ type: "navigate_to", targetId: "kitchen" }, ctx({ bodyMode: "none" })).verdict,
    ).toBe("deny");
  });

  it("refuses a capability Dal has not granted", () => {
    const review = reviewIntent(
      { type: "grasp", objectId: "cup" },
      ctx({ granted: new Set(["robot.look"]) }),
    );
    expect(review.verdict).toBe("deny");
    expect(review.reasons[0]).toContain("robot.grasp has not been granted");
  });
});

describe("reviewIntent and uncertainty", () => {
  it("refuses a target the world model has never seen, and says how to fix it", () => {
    expect(reviewIntent({ type: "grasp", objectId: "ghost" }, ctx()).resolution).toBe(
      "observe_more",
    );
    expect(
      reviewIntent({ type: "grasp", objectId: "ghost" }, ctx({ canObserve: false })).resolution,
    ).toBe("ask");
    expect(
      reviewIntent({ type: "grasp", objectId: "ghost" }, ctx({ canObserve: false, canAsk: false }))
        .resolution,
    ).toBe("abstain");
  });

  it("refuses to follow a person the belief about has gone stale", () => {
    const review = reviewIntent(
      { type: "follow", personId: "dal" },
      ctx({ nowMs: NOW + 10 * 60_000 }),
    );
    expect(review.verdict).toBe("deny");
    expect(review.resolution).toBe("observe_more");
  });

  it("asks for confirmation when the target is only borderline certain", () => {
    const world = furnishedWorld();
    world.observe({
      id: "box",
      kind: "container",
      label: "caja",
      position: { placeId: "kitchen" },
      confidence: 0.9,
      source: "sensor",
    });
    const review = reviewIntent(
      { type: "point", targetId: "box" },
      ctx({ world, preAuthorized: new Set(["robot.gesture"]) }),
    );
    expect(review.verdict).toBe("confirm");
    expect(review.resolution).toBe("verify");
  });

  it("lets it look at something uncertain, since looking is how certainty is gained", () => {
    const review = reviewIntent(
      { type: "look_at", targetId: "dal" },
      ctx({ nowMs: NOW + 10 * 60_000 }),
    );
    expect(review.verdict).toBe("allow");
  });
});

describe("reviewIntent and autonomy", () => {
  it("asks before moving at L3", () => {
    expect(
      reviewIntent({ type: "navigate_to", targetId: "kitchen" }, ctx({ autonomyLevel: 3 })).verdict,
    ).toBe("confirm");
  });

  it("moves without asking at L4 when Dal pre-authorized navigation", () => {
    const review = reviewIntent(
      { type: "navigate_to", targetId: "kitchen" },
      ctx({ preAuthorized: new Set(["robot.navigate"]) }),
    );
    expect(review.verdict).toBe("allow");
    expect(review.limits.maxSpeedMps).toBeGreaterThan(0);
  });

  it("never grasps unattended, even pre-authorized at L5", () => {
    const review = reviewIntent(
      { type: "grasp", objectId: "cup" },
      ctx({ autonomyLevel: 5, preAuthorized: new Set(["robot.grasp"]) }),
    );
    expect(review.verdict).toBe("confirm");
  });

  it("never hands an object to a person unattended", () => {
    const review = reviewIntent(
      { type: "handover", objectId: "cup", personId: "dal" },
      ctx({ autonomyLevel: 5, preAuthorized: new Set(["robot.handover"]) }),
    );
    expect(review.verdict).toBe("confirm");
    expect(review.limits.maxSpeedMps).toBeLessThan(0.5);
  });

  it("refuses all motion at L0", () => {
    expect(reviewIntent({ type: "gesture", name: "wave" }, ctx({ autonomyLevel: 0 })).verdict).toBe(
      "deny",
    );
  });
});

const fakeEStop = () => {
  let engaged = false;
  const listeners = new Set<(reason: string) => void>();
  const estop: EmergencyStop & { engage(): void } = {
    isEngaged: () => engaged,
    onEngage: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    engage: () => {
      engaged = true;
      for (const l of listeners) {
        l("test");
      }
    },
  };
  return estop;
};

const controllerWith = (body: BodyAdapter, estop = fakeEStop(), world = furnishedWorld()) =>
  new EmbodiedController({
    body,
    emergencyStop: estop,
    now: () => NOW,
    context: () => ({
      autonomyLevel: 4,
      granted: new Set(BODY_CAPABILITIES),
      preAuthorized: new Set(["robot.navigate", "robot.look"]),
      world,
      canObserve: true,
      canAsk: true,
    }),
  });

describe("EmbodiedController", () => {
  it("carries out an allowed intent on the simulated body and audits it", async () => {
    const world = furnishedWorld();
    const body = new SimulatedBody((id) =>
      world.get(id)?.kind === "room" ? id : world.get(id)?.position?.placeId,
    );
    const controller = controllerWith(body, fakeEStop(), world);

    const result = await controller.request({ type: "navigate_to", targetId: "kitchen" });

    expect(result.review.verdict).toBe("allow");
    expect(result.outcome).toEqual({ ok: true, detail: "Now at kitchen." });
    expect(body.placeId()).toBe("kitchen");
    expect(controller.recent()).toHaveLength(1);
  });

  it("never reaches the body when the supervisor does not allow", async () => {
    const body: BodyAdapter = {
      id: "spy",
      mode: "simulated",
      execute: vi.fn(),
      stop: vi.fn(),
      placeId: () => undefined,
    };
    const controller = controllerWith(body);

    const result = await controller.request({ type: "grasp", objectId: "cup" });

    expect(result.review.verdict).toBe("confirm");
    expect(result.outcome).toBeUndefined();
    expect(body.execute).not.toHaveBeenCalled();
  });

  it("halts the body the moment the emergency stop engages", async () => {
    const estop = fakeEStop();
    const body = new SimulatedBody(() => undefined);
    const controller = controllerWith(body, estop);

    estop.engage();
    await Promise.resolve();
    const after = await controller.request({ type: "look_at", targetId: "dal" });

    expect(body.stopCount()).toBe(1);
    expect(after.review.verdict).toBe("deny");
  });

  it("stops the body when it fails mid-motion", async () => {
    const stop = vi.fn(async () => undefined);
    const body: BodyAdapter = {
      id: "broken",
      mode: "simulated",
      execute: async () => {
        throw new Error("motor fault");
      },
      stop,
      placeId: () => undefined,
    };
    const result = await controllerWith(body).request({ type: "navigate_to", targetId: "kitchen" });

    expect(result.outcome).toEqual({ ok: false, detail: "Body error: motor fault" });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("refuses everything on a desktop, where the honest answer is no body", async () => {
    const result = await controllerWith(new NullBody()).request({
      type: "look_at",
      targetId: "dal",
    });
    expect(result.review.verdict).toBe("deny");
    expect(result.review.reasons[0]).toContain("no body");
  });
});

describe("SimulatedBody", () => {
  it("tracks what it holds across grasp and place", async () => {
    const body = new SimulatedBody(() => undefined);
    const limits = { maxSpeedMps: 0.5, maxForceN: 10 };
    const signal = new AbortController().signal;
    const intents: BodyIntent[] = [
      { type: "grasp", objectId: "cup" },
      { type: "grasp", objectId: "plate" },
      { type: "place", objectId: "cup", onId: "table" },
    ];
    const outcomes = [];
    for (const intent of intents) {
      outcomes.push(await body.execute(intent, limits, signal));
    }

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(body.held()).toBeUndefined();
  });

  it("does not move once interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const body = new SimulatedBody(() => "kitchen");
    const outcome = await body.execute(
      { type: "navigate_to", targetId: "kitchen" },
      { maxSpeedMps: 1, maxForceN: 1 },
      controller.signal,
    );
    expect(outcome.ok).toBe(false);
    expect(body.placeId()).toBeUndefined();
  });
});
