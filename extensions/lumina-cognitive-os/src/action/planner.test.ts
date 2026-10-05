/**
 * Tests for the Action Planner validator (Nivel 4).
 */
import { describe, expect, it } from "vitest";
import { validatePlan } from "./planner.js";

describe("validatePlan", () => {
  it("rejects plans without a goal", () => {
    const r = validatePlan({ steps: [{ toolName: "lumina_clipboard", description: "x" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects empty step lists", () => {
    const r = validatePlan({ goal: "x", steps: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown tool names", () => {
    const r = validatePlan({
      goal: "test",
      steps: [{ toolName: "lumina_does_not_exist", description: "boom" }],
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a well-formed plan", () => {
    const r = validatePlan({
      goal: "open clipboard",
      steps: [{ toolName: "lumina_clipboard", description: "read", params: { action: "get" } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.steps).toHaveLength(1);
      expect(r.plan.steps[0]?.id).toBe("step-1");
      expect(r.plan.stopOnError).toBe(true);
    }
  });

  it("respects stopOnError=false", () => {
    const r = validatePlan({
      goal: "best-effort sequence",
      stopOnError: false,
      steps: [{ toolName: "lumina_clipboard", description: "read" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.stopOnError).toBe(false);
    }
  });
});

describe("validatePlan spec §15 fields", () => {
  it("keeps preconditions, expected outcome, confidence and rollback", () => {
    const v = validatePlan({
      goal: "preparar café",
      steps: [
        {
          toolName: "lumina_workspace",
          description: "ver la situación",
          subgoal: "localizar taza",
          preconditions: ["la cocina está mapeada"],
          expectedOutcome: "se sabe dónde está la taza",
          confidence: 0.9,
          rollback: "nada que deshacer",
        },
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.plan.steps[0]).toMatchObject({
        subgoal: "localizar taza",
        confidence: 0.9,
        rollback: "nada que deshacer",
      });
      expect(v.warnings).toEqual([]);
    }
  });

  it("warns when a risky step has no rollback or a step cannot be checked", () => {
    const v = validatePlan({
      goal: "limpiar",
      steps: [{ toolName: "lumina_workspace", description: "algo arriesgado", risk: "HIGH_RISK" }],
    });
    expect(v.ok && v.warnings).toEqual([
      "step #0 has no expectedOutcome: success cannot be checked",
      "step #0 is HIGH_RISK and has no rollback",
    ]);
  });

  it("rejects a confidence outside [0,1]", () => {
    const v = validatePlan({
      goal: "x y z",
      steps: [{ toolName: "lumina_workspace", description: "d", confidence: 2 }],
    });
    expect(v).toMatchObject({ ok: false });
  });
});
