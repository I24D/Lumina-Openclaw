/**
 * Tests for the global workspace.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldModel } from "../../world/world-model.js";
import { AttentionFilter } from "../attention.js";
import { GoalManager } from "../goals/goal-manager.js";
import { LessonStore } from "../learning/lessons.js";
import { CognitiveLoop } from "../loop/cognitive-loop.js";
import { ThalamicRouter } from "../router/thalamic-router.js";
import { buildSelfModel } from "../self/self-model.js";
import { GlobalWorkspace } from "./global-workspace.js";

const NOW = Date.parse("2026-10-04T20:41:00.000Z");
const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-gw-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("GlobalWorkspace", () => {
  it("is usable with no sources at all", () => {
    const ws = new GlobalWorkspace({ now: () => NOW });
    const s = ws.snapshot();

    expect(s.currentGoal).toBeNull();
    expect(s.activePeople).toEqual([]);
    expect(s.attentionTarget).toBeNull();
    expect(s.robotState).toBeNull();
    expect(s.uncertainty).toEqual({ staleBeliefs: [], lastDecisionConfidence: null });
  });

  it("composes goal, people, place, events, memories and body from their owners", async () => {
    const goals = new GoalManager(tmp());
    goals.create({ title: "Preparar café", priority: 4 }, new Date(NOW).toISOString());
    const lessons = new LessonStore(tmp());
    lessons.learn({
      trigger: "battery.low",
      claim: "Dal prefiere que avise antes de apagar",
      confidence: 0.8,
    });

    const world = new WorldModel({ now: () => NOW });
    world.observe({ id: "kitchen", kind: "room", label: "cocina", confidence: 1, source: "user" });
    world.observe({
      id: "dal",
      kind: "person",
      label: "Dal",
      position: { placeId: "kitchen" },
      confidence: 0.98,
      source: "sensor",
    });
    world.observe({
      id: "keys",
      kind: "object",
      label: "llaves",
      confidence: 0.4,
      source: "inferred",
    });

    const router = new ThalamicRouter({
      attention: new AttentionFilter({ threshold: 0 }),
      now: () => NOW,
    });
    const loop = new CognitiveLoop({
      level: 3,
      now: () => NOW,
      reason: () => ({ signals: [{ source: "test", value: 0.8 }], note: "observed" }),
    });
    loop.consume(router);
    router.ingest({
      source: "awareness",
      kind: "battery.low",
      atISO: new Date(NOW).toISOString(),
      importance: 0.6,
      urgency: 0.55,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const self = buildSelfModel({
      name: "Lumina",
      atISO: new Date(NOW).toISOString(),
      body: { mode: "simulated", adapterId: "sim", placeId: "kitchen" },
      emergencyStop: false,
      sensors: [],
      capabilities: [],
      battery: null,
      autonomyLevel: 3,
      tasks: [],
      pendingEvents: 0,
    });
    const ws = new GlobalWorkspace({
      goals,
      world,
      router,
      loop,
      lessons,
      self: () => self,
      now: () => NOW,
    });
    const s = ws.snapshot();

    expect(s.currentGoal?.title).toBe("Preparar café");
    expect(s.activePeople.map((p) => p.label)).toEqual(["Dal"]);
    expect(s.currentLocation).toEqual({ id: "kitchen", label: "cocina" });
    expect(s.activeTask).toMatchObject({
      event: "battery.low",
      executed: false,
      interrupted: false,
    });
    expect(s.recentEvents[0]).toMatchObject({
      source: "awareness",
      kind: "battery.low",
      admitted: true,
    });
    expect(s.relevantMemories.map((m) => m.claim)).toEqual([
      "Dal prefiere que avise antes de apagar",
    ]);
    expect(s.uncertainty.staleBeliefs.map((b) => b.label)).toEqual(["llaves"]);
    expect(s.robotState).toEqual({ mode: "simulated", emergencyStop: false, placeId: "kitchen" });
  });

  it("drops people from the scene once the belief about them goes stale", () => {
    let now = NOW;
    const world = new WorldModel({ now: () => now });
    world.observe({ id: "dal", kind: "person", label: "Dal", confidence: 0.98, source: "sensor" });
    const ws = new GlobalWorkspace({ world, now: () => now });

    expect(ws.snapshot().activePeople).toHaveLength(1);
    now += 30 * 60_000;
    const later = ws.snapshot();
    expect(later.activePeople).toHaveLength(0);
    expect(later.uncertainty.staleBeliefs.map((b) => b.id)).toEqual(["dal"]);
  });

  it("returns the last snapshot from current() without rebuilding", () => {
    let now = NOW;
    const ws = new GlobalWorkspace({ now: () => now });
    const first = ws.snapshot();
    now += 1000;
    expect(ws.current()).toBe(first);
    expect(ws.snapshot().atISO).not.toBe(first.atISO);
  });
});
