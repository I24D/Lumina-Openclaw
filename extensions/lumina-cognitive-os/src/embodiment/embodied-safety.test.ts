import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../safety/audit-log.js";
import { WorldModel } from "../world/world-model.js";
import { BODY_CAPABILITIES, SimulatedBody, type BodyAdapter } from "./body.js";
import { EmbodiedController } from "./embodied-controller.js";

const NOW = Date.parse("2026-10-05T04:00:00Z");

function fixture(adapter?: BodyAdapter) {
  let time = NOW;
  let engaged = false;
  const listeners = new Set<(reason: string) => void>();
  const world = new WorldModel({ now: () => time });
  world.observe({ id: "room", kind: "room", label: "Room", source: "sensor", confidence: 1 });
  world.observe({ id: "cup", kind: "object", label: "Cup", source: "sensor", confidence: 0.99 });
  const body = adapter ?? new SimulatedBody((id) => id);
  const audit = new AuditLog({ now: () => time });
  const controller = new EmbodiedController({
    body,
    audit,
    now: () => time,
    emergencyStop: {
      isEngaged: () => engaged,
      onEngage: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    context: () => ({
      autonomyLevel: 4,
      world,
      canObserve: true,
      canAsk: true,
      granted: new Set(BODY_CAPABILITIES),
      preAuthorized: new Set(["robot.navigate"]),
    }),
  });
  return {
    world,
    body,
    audit,
    controller,
    advance: (ms: number) => {
      time += ms;
    },
    engage: () => {
      engaged = true;
      listeners.forEach((listener) => listener("test"));
    },
  };
}

describe("body confirmation and execution boundaries", () => {
  it("requires fresh evidence even when the owner approves", async () => {
    const f = fixture();
    f.world.observe({
      id: "box",
      kind: "container",
      label: "Box",
      source: "sensor",
      confidence: 0.9,
    });
    const pending = await f.controller.request({ type: "grasp", objectId: "box" });
    const result = await f.controller.approve(pending.pendingId!, {
      channel: "owner",
      actor: "test-owner",
    });
    expect(result).toMatchObject({ ok: false, tamper: false });
    expect((f.body as SimulatedBody).held()).toBeUndefined();
  });

  it("executes a human-approved request once and rejects replay", async () => {
    const f = fixture();
    const pending = await f.controller.request({ type: "grasp", objectId: "cup" });
    const result = await f.controller.approve(pending.pendingId!, {
      channel: "owner",
      actor: "test-owner",
    });
    expect(result).toMatchObject({ ok: true, result: { outcome: { ok: true } } });
    expect((f.body as SimulatedBody).held()).toBe("cup");
    expect(
      await f.controller.approve(pending.pendingId!, { channel: "owner", actor: "test-owner" }),
    ).toMatchObject({ ok: false });
  });

  it("refuses agent approval and expired human approval", async () => {
    const f = fixture();
    const pending = await f.controller.request({ type: "grasp", objectId: "cup" });
    expect(
      await f.controller.approve(pending.pendingId!, { channel: "agent", actor: "model" }),
    ).toMatchObject({ ok: false, tamper: true });
    f.advance(5 * 60_000);
    expect(
      await f.controller.approve(pending.pendingId!, { channel: "owner", actor: "test-owner" }),
    ).toMatchObject({ ok: false, tamper: false });
  });

  it("revalidates confidence after waiting for approval", async () => {
    const f = fixture();
    const pending = await f.controller.request({ type: "grasp", objectId: "cup" });
    f.world.observe({
      id: "cup",
      kind: "object",
      label: "Cup",
      source: "sensor",
      position: { placeId: "a" },
      confidence: 0.99,
    });
    f.world.observe({
      id: "cup",
      kind: "object",
      label: "Cup",
      source: "sensor",
      position: { placeId: "b" },
      confidence: 0.1,
    });
    expect(
      await f.controller.approve(pending.pendingId!, { channel: "owner", actor: "test-owner" }),
    ).toMatchObject({ ok: true, result: { review: { verdict: "deny" } } });
    expect((f.body as SimulatedBody).held()).toBeUndefined();
  });

  it("does not let caller mutation change an already queued action", async () => {
    const f = fixture();
    const intent = { type: "grasp" as const, objectId: "cup" };
    const result = await f.controller.request(intent);
    intent.objectId = "room";
    await f.controller.approve(result.pendingId!, { channel: "owner", actor: "test-owner" });
    expect((f.body as SimulatedBody).held()).toBe("cup");
  });

  it("refuses to grasp people regardless of confidence and grants", async () => {
    const f = fixture();
    f.world.observe({
      id: "person",
      kind: "person",
      label: "Person",
      source: "sensor",
      confidence: 1,
    });
    expect((await f.controller.request({ type: "grasp", objectId: "person" })).review.verdict).toBe(
      "deny",
    );
  });

  it("does not reach the adapter for an already cancelled request", async () => {
    const execute = vi.fn(async () => ({ ok: true, detail: "Unexpected" }));
    const f = fixture({
      id: "test",
      mode: "simulated",
      execute,
      stop: async () => {},
      placeId: () => undefined,
    });
    const signal = AbortSignal.abort();
    expect(
      (await f.controller.request({ type: "navigate_to", targetId: "room" }, { signal })).outcome
        ?.ok,
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts in-flight work and refuses concurrent motion", async () => {
    let actionSignal: AbortSignal | undefined;
    const stop = vi.fn(async () => {});
    const f = fixture({
      id: "test",
      mode: "simulated",
      stop,
      placeId: () => undefined,
      execute: async (_intent, _limits, signal) => {
        actionSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ok: true, detail: "Adapter returned after abort" };
      },
    });
    const running = f.controller.request({ type: "navigate_to", targetId: "room" });
    expect(
      (await f.controller.request({ type: "navigate_to", targetId: "room" })).review.verdict,
    ).toBe("deny");
    f.engage();
    expect(actionSignal?.aborted).toBe(true);
    expect((await running).outcome?.ok).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reports failed stops honestly and blocks subsequent motion", async () => {
    const f = fixture({
      id: "test",
      mode: "simulated",
      placeId: () => undefined,
      execute: async () => ({ ok: true, detail: "Moved" }),
      stop: async () => {
        throw new Error("offline");
      },
    });
    expect((await f.controller.request({ type: "stop" })).outcome).toMatchObject({
      ok: false,
      detail: "Stop failed: offline",
    });
    expect(f.audit.recent().some((entry) => entry.execution === "stopped")).toBe(false);
    expect(
      (await f.controller.request({ type: "navigate_to", targetId: "room" })).review.verdict,
    ).toBe("deny");
  });

  it("keeps retained tool references inert after disposal but accepts stop", async () => {
    const f = fixture();
    f.controller.dispose();
    expect(
      (await f.controller.request({ type: "navigate_to", targetId: "room" })).review.verdict,
    ).toBe("deny");
    expect((await f.controller.request({ type: "stop" })).outcome?.ok).toBe(true);
  });
});
