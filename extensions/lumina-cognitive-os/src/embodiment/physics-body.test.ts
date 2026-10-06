/**
 * Tests for the physics-simulator body adapter, against a fake sidecar.
 */
import { describe, expect, it, vi } from "vitest";
import type { SidecarExit } from "../shared/ndjson-sidecar.js";
import { PhysicsBody, type PhysicsEvent, type PhysicsPort } from "./physics-body.js";

class FakeSim implements PhysicsPort {
  sent: Array<Readonly<Record<string, unknown>>> = [];
  private listener: ((event: PhysicsEvent | SidecarExit) => void) | undefined;
  private isRunning = false;
  start() {
    this.isRunning = true;
    return { ok: true };
  }
  stop() {
    this.isRunning = false;
  }
  running() {
    return this.isRunning;
  }
  send(command: Readonly<Record<string, unknown>>) {
    this.sent.push(command);
    return this.isRunning;
  }
  on(listener: (event: PhysicsEvent | SidecarExit) => void) {
    this.listener = listener;
    return () => undefined;
  }
  emit(event: PhysicsEvent | SidecarExit) {
    this.listener?.(event);
  }
}

const LIMITS = { maxSpeedMps: 0.5, maxForceN: 20 };
const STATE = { x: 1, y: 2, yaw: 0, place: "kitchen", holding: null };

describe("PhysicsBody", () => {
  it("seeds the world with what the simulated sensors see", () => {
    const sim = new FakeSim();
    const observe = vi.fn();
    const body = new PhysicsBody(sim, () => undefined, observe);
    sim.emit({ kind: "start", places: ["kitchen"], objects: { cup: "kitchen" }, people: ["Dal"] });
    expect(observe).toHaveBeenCalledWith({ id: "kitchen", kind: "room", label: "kitchen" });
    expect(observe).toHaveBeenCalledWith({
      id: "cup",
      kind: "object",
      label: "cup",
      placeId: "kitchen",
    });
    expect(body.describe()).toMatchObject({ engine: "mujoco", known: ["kitchen", "cup", "Dal"] });
  });

  it("sends supervised intents with the simulator's names and returns its outcome", async () => {
    const sim = new FakeSim();
    const body = new PhysicsBody(sim, (id) => (id === "per_1" ? "Dal" : undefined));
    sim.start();
    sim.emit({ kind: "start", places: ["kitchen"], objects: { book: "kitchen" }, people: ["Dal"] });

    const done = body.execute(
      { type: "handover", objectId: "book", personId: "per_1" },
      LIMITS,
      new AbortController().signal,
    );
    const command = sim.sent.at(-1) as { id: string; intent: Record<string, unknown> };
    expect(command.intent).toMatchObject({ objectId: "book", personId: "Dal" });
    sim.emit({
      kind: "result",
      id: command.id,
      ok: true,
      detail: "Handed book to Dal.",
      simSeconds: 3.2,
      state: STATE,
    });
    expect(await done).toEqual({ ok: true, detail: "Handed book to Dal. (3.2 s simulated)" });
    expect(body.placeId()).toBe("kitchen");
  });

  it("stops the simulator when the cycle is interrupted", async () => {
    const sim = new FakeSim();
    const body = new PhysicsBody(sim);
    sim.start();
    const controller = new AbortController();
    const done = body.execute(
      { type: "navigate_to", targetId: "kitchen" },
      LIMITS,
      controller.signal,
    );
    controller.abort();
    expect(sim.sent.at(-1)).toEqual({ cmd: "stop" });
    sim.emit({ kind: "exit", code: 0 });
    expect(await done).toEqual({ ok: false, detail: "The simulator stopped." });
  });
});
