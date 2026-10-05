/**
 * Tests for the world model and its perception hook.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttentionFilter } from "../cognition/attention.js";
import { ThalamicRouter } from "../cognition/router/thalamic-router.js";
import { effectiveConfidence, HALF_LIFE_MS, UNSENSED_CEILING, WorldModel } from "./world-model.js";
import { attachWorldModel, observationFrom, observedEvent } from "./world-perception.js";

const T0 = Date.parse("2026-10-04T20:41:00.000Z");
const MINUTE = 60_000;

const clock = (start = T0) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};

/** A kitchen with a table and a black cup on it. */
const furnish = (world: WorldModel) => {
  world.observe({ id: "kitchen", kind: "room", label: "cocina", confidence: 1, source: "sensor" });
  world.observe({
    id: "table",
    kind: "furniture",
    label: "mesa",
    position: { placeId: "kitchen" },
    confidence: 0.95,
    source: "sensor",
  });
  world.observe({
    id: "cup_24",
    kind: "object",
    label: "Taza",
    position: { placeId: "table" },
    properties: { color: "black", owner: "Dal" },
    relations: [{ predicate: "on_top_of", targetId: "table" }],
    confidence: 0.94,
    source: "sensor",
  });
};

describe("WorldModel beliefs", () => {
  it("answers where something is, through the chain of places", () => {
    const c = clock();
    const world = new WorldModel({ now: c.now });
    furnish(world);

    const where = world.whereIs("taza");
    expect(where?.entity.id).toBe("cup_24");
    expect(where?.chain).toEqual(["Taza", "mesa", "cocina"]);
    expect(where?.stale).toBe(false);
    expect(where?.entity.properties).toEqual({ color: "black", owner: "Dal" });
    expect(where?.entity.relations[0]?.predicate).toBe("on_top_of");
  });

  it("matches labels regardless of accents and case", () => {
    const world = new WorldModel({ now: () => T0 });
    world.observe({ kind: "room", label: "Habitación", confidence: 1, source: "user" });
    expect(world.find("habitacion")?.label).toBe("Habitación");
  });

  it("lets beliefs about people go stale in minutes and rooms never", () => {
    const c = clock();
    const world = new WorldModel({ now: c.now });
    furnish(world);
    world.observe({
      id: "dal",
      kind: "person",
      label: "Dal",
      position: { placeId: "kitchen", distanceM: 2 },
      confidence: 0.98,
      source: "sensor",
    });

    c.advance(HALF_LIFE_MS.person);
    const dal = world.whereIs("dal");
    expect(dal?.confidence).toBeCloseTo(0.49, 2);
    expect(dal?.stale).toBe(true);
    expect(world.whereIs("cocina")?.confidence).toBe(1);
  });

  it("accumulates confidence when the same thing is seen in the same place", () => {
    const c = clock();
    const world = new WorldModel({ now: c.now });
    furnish(world);
    c.advance(MINUTE);
    const result = world.observe({
      id: "cup_24",
      kind: "object",
      label: "Taza",
      position: { placeId: "table" },
      confidence: 0.6,
      source: "sensor",
    });

    expect(result.created).toBe(false);
    expect(result.movedFrom).toBeUndefined();
    expect(result.entity.confidence).toBeGreaterThan(0.94);
    expect(result.entity.observations).toBe(2);
  });

  it("replaces the belief and reports the move when seen elsewhere", () => {
    const world = new WorldModel({ now: () => T0 });
    furnish(world);
    world.observe({
      id: "sink",
      kind: "furniture",
      label: "fregadero",
      position: { placeId: "kitchen" },
      confidence: 0.9,
      source: "sensor",
    });
    const result = world.observe({
      id: "cup_24",
      kind: "object",
      label: "Taza",
      position: { placeId: "sink" },
      confidence: 0.7,
      source: "sensor",
    });

    expect(result.movedFrom).toBe("table");
    expect(result.entity.confidence).toBe(0.7);
    // The earlier properties survive a move.
    expect(result.entity.properties.owner).toBe("Dal");
    expect(world.whereIs("taza")?.chain).toEqual(["Taza", "fregadero", "cocina"]);
  });

  it("filters by kind, place, property and confidence floor", () => {
    const c = clock();
    const world = new WorldModel({ now: c.now });
    furnish(world);
    world.observe({
      kind: "object",
      label: "llaves",
      position: { placeId: "table" },
      confidence: 0.3,
      source: "inferred",
    });

    expect(world.contents("table").map((e) => e.entity.label)).toEqual(["Taza", "llaves"]);
    expect(
      world.query({ placeId: "table", minConfidence: 0.5 }).map((e) => e.entity.label),
    ).toEqual(["Taza"]);
    expect(world.query({ property: { key: "owner", value: "Dal" } })).toHaveLength(1);
    expect(world.query({ kind: "room" }).map((e) => e.entity.id)).toEqual(["kitchen"]);
  });

  it("refuses observations without a label or with an unknown kind", () => {
    const world = new WorldModel({ now: () => T0 });
    expect(() =>
      world.observe({ kind: "object", label: " ", confidence: 1, source: "user" }),
    ).toThrow();
    expect(() =>
      world.observe({ kind: "spaceship" as never, label: "x", confidence: 1, source: "user" }),
    ).toThrow(/Unknown entity kind/);
  });

  it("survives a cycle in the place graph", () => {
    const world = new WorldModel({ now: () => T0 });
    world.observe({
      id: "a",
      kind: "container",
      label: "caja A",
      position: { placeId: "b" },
      confidence: 1,
      source: "user",
    });
    world.observe({
      id: "b",
      kind: "container",
      label: "caja B",
      position: { placeId: "a" },
      confidence: 1,
      source: "user",
    });
    expect(world.whereIs("a")?.chain).toEqual(["caja A", "caja B"]);
  });
});

describe("WorldModel provenance", () => {
  it("never lets a claim alone exceed the unsensed ceiling", () => {
    const world = new WorldModel({ now: () => T0 });
    const once = world.observe({
      id: "keys",
      kind: "object",
      label: "llaves",
      confidence: 1,
      source: "agent",
    });
    expect(once.entity.confidence).toBe(UNSENSED_CEILING);

    // Repeating the claim is not new evidence.
    const again = world.observe({
      id: "keys",
      kind: "object",
      label: "llaves",
      confidence: 1,
      source: "agent",
    });
    expect(again.entity.confidence).toBe(UNSENSED_CEILING);
  });

  it("lets a sensor confirm a claim above the ceiling", () => {
    const world = new WorldModel({ now: () => T0 });
    world.observe({
      id: "keys",
      kind: "object",
      label: "llaves",
      confidence: 0.8,
      source: "agent",
    });
    const seen = world.observe({
      id: "keys",
      kind: "object",
      label: "llaves",
      confidence: 0.9,
      source: "sensor",
    });
    expect(seen.entity.confidence).toBeGreaterThan(UNSENSED_CEILING);
  });

  it("never lets a claim lower a belief a sensor backs", () => {
    const world = new WorldModel({ now: () => T0 });
    world.observe({ id: "cup", kind: "object", label: "taza", confidence: 0.98, source: "sensor" });
    const claim = world.observe({
      id: "cup",
      kind: "object",
      label: "taza",
      confidence: 0.5,
      source: "inferred",
    });
    expect(claim.entity.confidence).toBe(0.98);
    expect(claim.entity.source).toBe("inferred");
  });
});

describe("WorldModel persistence", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays the observation log into the same beliefs after a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-world-"));
    dirs.push(dir);
    const first = new WorldModel({ dir, now: () => T0 });
    furnish(first);
    first.observe({
      kind: "object",
      label: "llaves",
      position: { placeId: "table" },
      confidence: 0.8,
      source: "user",
    });

    const second = new WorldModel({ dir, now: () => T0 });
    expect(second.size).toBe(first.size);
    expect(second.whereIs("llaves")?.chain).toEqual(["llaves", "mesa", "cocina"]);
    expect(second.get("cup_24")?.confidence).toBe(first.get("cup_24")?.confidence);
  });
});

describe("world perception", () => {
  it("folds observations from any producer into the model, even ignored ones", () => {
    const world = new WorldModel({ now: () => T0 });
    const router = new ThalamicRouter({
      attention: new AttentionFilter({ threshold: 0.99 }),
      now: () => T0,
    });
    attachWorldModel(router, world);

    const result = router.ingest(
      observedEvent("vision", {
        kind: "door",
        label: "puerta principal",
        state: { open: false },
        confidence: 0.9,
        source: "sensor",
      }),
    );

    expect(result.verdict.admitted).toBe(false);
    expect(world.find("puerta principal")?.state).toEqual({ open: false });
  });

  it("ignores events without a well-formed observation", () => {
    const base = { source: "s", kind: "k", atISO: new Date(T0).toISOString() };
    expect(observationFrom(base)).toBeUndefined();
    expect(
      observationFrom({
        ...base,
        payload: { observation: { kind: "nope", label: "x", confidence: 1 } },
      }),
    ).toBeUndefined();
    expect(
      observationFrom({
        ...base,
        payload: { observation: { kind: "object", label: "x", confidence: 1 } },
      })?.source,
    ).toBe("sensor");
  });

  it("decays nothing for kinds with an infinite half-life", () => {
    const world = new WorldModel({ now: () => T0 });
    const room = world.observe({
      kind: "room",
      label: "sala",
      confidence: 0.8,
      source: "user",
    }).entity;
    expect(effectiveConfidence(room, T0 + 365 * 24 * 60 * MINUTE)).toBe(0.8);
  });
});
