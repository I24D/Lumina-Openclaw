/**
 * Tests for consolidation, temporal facts and routine detection.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldModel } from "../world/world-model.js";
import { consolidate, detectRoutines, temporalFacts } from "./consolidation.js";
import { LessonStore } from "./learning/lessons.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T08:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const seed = () => {
  const world = new WorldModel({ now: () => T0 + 10 * DAY });
  world.observe({
    id: "kitchen",
    kind: "room",
    label: "cocina",
    confidence: 1,
    source: "sensor",
    atISO: new Date(T0).toISOString(),
  });
  world.observe({
    id: "office",
    kind: "room",
    label: "oficina",
    confidence: 1,
    source: "sensor",
    atISO: new Date(T0).toISOString(),
  });
  // The cup is in the kitchen four mornings out of five.
  for (const [day, place] of [
    [0, "kitchen"],
    [1, "kitchen"],
    [2, "office"],
    [3, "kitchen"],
    [4, "kitchen"],
  ] as const) {
    world.observe({
      id: "cup",
      kind: "object",
      label: "taza",
      position: { placeId: place },
      confidence: 0.95,
      source: "sensor",
      atISO: new Date(T0 + day * DAY).toISOString(),
    });
  }
  return world;
};

describe("temporalFacts", () => {
  it("answers first and last time, how often and where most often", () => {
    const t = temporalFacts(seed(), "cup");
    expect(t.sightings).toBe(5);
    expect(t.firstSeenISO).toBe(new Date(T0).toISOString());
    expect(t.lastSeenISO).toBe(new Date(T0 + 4 * DAY).toISOString());
    expect(t.usualPlaceId).toBe("kitchen");
    expect(t.byPlace).toEqual({ kitchen: 4, office: 1 });
  });
});

describe("consolidate", () => {
  it("learns where a movable thing usually is, without touching rooms", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-consolidate-"));
    dirs.push(dir);
    const lessons = new LessonStore(dir);
    const facts = consolidate({ world: seed(), lessons });

    expect(facts.map((f) => f.claim)).toEqual(["taza suele estar en cocina"]);
    expect(facts[0]?.confidence).toBeLessThan(0.85);
    expect(lessons.applicable("entity:cup", 0).map((l) => l.claim)).toEqual([
      "taza suele estar en cocina",
    ]);

    // Consolidating again confirms instead of duplicating.
    consolidate({ world: seed(), lessons });
    expect(lessons.list("entity:cup")).toHaveLength(1);
  });

  it("learns nothing from too few sightings", () => {
    const world = new WorldModel({ now: () => T0 });
    world.observe({ id: "k", kind: "room", label: "cocina", confidence: 1, source: "sensor" });
    world.observe({
      id: "keys",
      kind: "object",
      label: "llaves",
      position: { placeId: "k" },
      confidence: 0.9,
      source: "sensor",
    });
    expect(consolidate({ world })).toEqual([]);
  });
});

describe("detectRoutines", () => {
  it("finds an hour-of-day pattern across days and never proposes automating it", () => {
    const routines = detectRoutines(seed(), "cup");
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({ placeId: "kitchen", hour: 8, days: 4, automate: false });
    expect(routines[0]?.claim).toBe("taza suele estar en cocina hacia las 08:00");
  });
});
