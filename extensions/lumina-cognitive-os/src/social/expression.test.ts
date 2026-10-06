/**
 * Tests for the face Lumina shows.
 */
import { describe, expect, it } from "vitest";
import { expressionOf } from "./expression.js";
import type { PresenceState } from "./presence.js";

const NOW = Date.parse("2026-10-05T20:00:00.000Z");
const nobody: PresenceState = { atISO: "", present: [], arrivals: [], departures: [] };
const dal = {
  worldId: "person:per_1",
  personId: "per_1",
  name: "Dal",
  role: "owner",
  confidence: 0.9,
  speaking: false,
} as const;

const base = {
  emergencyStop: false,
  paused: false,
  pendingEvents: 0,
  presence: nobody,
  nowMs: NOW,
};

describe("expressionOf", () => {
  it("shows stopped before anything else", () => {
    expect(expressionOf({ ...base, emergencyStop: true, pendingEvents: 3 }).expression).toBe(
      "sleepy",
    );
    expect(expressionOf({ ...base, paused: true }).expression).toBe("sleepy");
  });

  it("works right after an action, listens to a speaker, thinks with events waiting", () => {
    const recent = new Date(NOW - 2_000).toISOString();
    expect(expressionOf({ ...base, lastExecutedAtISO: recent }).expression).toBe("working");
    expect(
      expressionOf({ ...base, presence: { ...nobody, present: [{ ...dal, speaking: true }] } }),
    ).toEqual({ expression: "attentive", reason: "Listening to Dal." });
    expect(expressionOf({ ...base, pendingEvents: 2 }).expression).toBe("thinking");
  });

  it("is happy when the owner is here and curious about someone unknown", () => {
    expect(
      expressionOf({ ...base, ownerId: "per_1", presence: { ...nobody, present: [dal] } })
        .expression,
    ).toBe("happy");
    expect(
      expressionOf({
        ...base,
        presence: { ...nobody, arrivals: ["unknown person"] },
      }).expression,
    ).toBe("curious");
    expect(expressionOf(base).expression).toBe("idle");
  });
});
