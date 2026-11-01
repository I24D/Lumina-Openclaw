/**
 * Tests for the self model.
 */
import { describe, expect, it } from "vitest";
import { buildSelfModel, canUse, SELF_NATURE, type SelfModelInput } from "./self-model.js";

const base: SelfModelInput = {
  name: "Lumina",
  atISO: "2026-10-04T20:00:00.000Z",
  body: { mode: "none", adapterId: "none" },
  emergencyStop: false,
  sensors: [
    { id: "screen", kind: "screen", available: true },
    { id: "cam0", kind: "camera", available: false, detail: "no camera attached" },
  ],
  capabilities: ["lumina_workspace", "lumina_world_query", "lumina_workspace"],
  battery: { percent: 80, charging: false },
  activeModel: "ollama-cloud/glm-5.2",
  autonomyLevel: 3,
  tasks: [{ id: "g1", title: "Organizar el día", score: 0.6 }],
  attentionTarget: "battery.low",
  pendingEvents: 2,
};

describe("buildSelfModel", () => {
  it("states its nature without claiming consciousness or feelings", () => {
    const self = buildSelfModel(base);
    expect(self.nature).toBe(SELF_NATURE);
    expect(self.nature).toContain("no claim to consciousness or feelings");
  });

  it("reports facts from its inputs and deduplicates capabilities", () => {
    const self = buildSelfModel(base);
    expect(self.capabilities).toEqual(["lumina_workspace", "lumina_world_query"]);
    expect(self.energy).toEqual({ batteryPercent: 80, charging: false });
    expect(self.functionalState).toEqual({
      attentionTarget: "battery.low",
      pendingEvents: 2,
      openTasks: 1,
    });
    expect(self.activeModel).toBe("ollama-cloud/glm-5.2");
  });

  it("knows it has no body and which sensors are missing", () => {
    const self = buildSelfModel(base);
    expect(self.limitations.some((l) => l.startsWith("No physical body"))).toBe(true);
    expect(self.limitations).toContain("Unavailable sensors: camera.");
  });

  it("flags a simulated body as predictions, not real effects", () => {
    const self = buildSelfModel({ ...base, body: { mode: "simulated", adapterId: "sim" } });
    expect(self.limitations.some((l) => l.includes("simulated"))).toBe(true);
  });

  it("flags low battery only while not charging", () => {
    const low = buildSelfModel({ ...base, battery: { percent: 12, charging: false } });
    const charging = buildSelfModel({ ...base, battery: { percent: 12, charging: true } });
    expect(low.limitations).toContain("Battery at 12% and not charging.");
    expect(charging.limitations.some((l) => l.startsWith("Battery"))).toBe(false);
  });

  it("reports null energy when no battery is present", () => {
    expect(buildSelfModel({ ...base, battery: null }).energy).toEqual({
      batteryPercent: null,
      charging: null,
    });
  });

  it("puts the emergency stop first and blocks every capability while engaged", () => {
    const self = buildSelfModel({ ...base, emergencyStop: true });
    expect(self.limitations[0]).toContain("Emergency stop engaged");
    expect(canUse(self, "lumina_workspace")).toBe(false);
    expect(canUse(buildSelfModel(base), "lumina_workspace")).toBe(true);
    expect(canUse(buildSelfModel(base), "robot.grasp")).toBe(false);
  });
});
