import { describe, expect, it } from "vitest";
import { BODY_CAPABILITIES } from "../embodiment/body.js";
import { reviewIntent, type SafetyContext } from "../embodiment/safety-supervisor.js";
import { affordancesOf, affords } from "./affordances.js";
import { WorldModel, type WorldEntity } from "./world-model.js";
import { createWorldQueryTool } from "./world-tools.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const thing = (
  label: string,
  kind: WorldEntity["kind"] = "object",
  properties: WorldEntity["properties"] = {},
) => ({ label, kind, properties });

describe("object affordances are knowledge, not permission", () => {
  it.each(["person", "animal", "room", "location"] as const)(
    "does not treat %s as an object because of its name or properties",
    (kind) => {
      expect(
        affordancesOf(thing("Cup", kind, { graspable: true, affordances: "grasp,cut" })).affords,
      ).toEqual([]);
    },
  );

  it("recognizes accents, plurals and whole words in Spanish and English", () => {
    expect(affords(thing("TÁZAS negras"), "contain")).toBe(true);
    expect(affords(thing("glasses"), "contain")).toBe(false);
    expect(affords(thing("glasses"), "grasp")).toBe(true);
    expect(affordancesOf(thing("cupboard")).category).toBe("storage");
    expect(affords(thing("Lámpara"), "toggle")).toBe(true);
  });

  it("honors an explicit prohibition and distinguishes unknown from impossible", () => {
    expect(affords(thing("taza", "object", { graspable: false }), "grasp")).toBe(false);
    expect(affords(thing("unclassified specimen"), "grasp")).toBeUndefined();
    expect(affords(thing("unknown", "object", { affordances: "read,read,teleport" }), "read")).toBe(
      true,
    );
  });

  it("answers through the world tool without granting or executing motion", async () => {
    const world = new WorldModel({ now: () => NOW });
    world.observe({ id: "cup", kind: "object", label: "taza", source: "sensor", confidence: 1 });
    const result = await createWorldQueryTool(world).execute("query", {
      action: "affordances",
      target: "cup",
    });
    expect(result.details).toMatchObject({
      ok: true,
      affords: ["grasp", "contain", "pour"],
      note: expect.stringContaining("not permission"),
    });
    const context: SafetyContext = {
      autonomyLevel: 5,
      bodyMode: "simulated",
      granted: new Set(),
      preAuthorized: new Set(),
      emergencyStop: false,
      world,
      canObserve: true,
      canAsk: true,
      nowMs: NOW,
    };
    expect(reviewIntent({ type: "grasp", objectId: "cup" }, context).verdict).toBe("deny");
    expect(
      reviewIntent(
        { type: "grasp", objectId: "cup" },
        { ...context, granted: new Set(BODY_CAPABILITIES) },
      ).verdict,
    ).toBe("confirm");
    world.observe({
      id: "table",
      kind: "furniture",
      label: "mesa",
      source: "sensor",
      confidence: 1,
    });
    expect(
      reviewIntent(
        { type: "grasp", objectId: "table" },
        { ...context, granted: new Set(BODY_CAPABILITIES) },
      ).verdict,
    ).toBe("deny");
  });
});
