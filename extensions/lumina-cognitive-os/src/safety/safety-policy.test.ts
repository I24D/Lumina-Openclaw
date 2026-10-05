import { describe, expect, it } from "vitest";
import { AuditLog } from "./audit-log.js";
import { checkRoleAssignment, resolveConflict, type Request } from "./authority.js";
import { planDangerResponse } from "./danger-protocol.js";
import { HumanOverrides } from "./overrides.js";

describe("session-only safety state", () => {
  it("allows narrowing, refuses self-escalation, and requires the host owner channel to resume", () => {
    const overrides = new HumanOverrides({ now: () => 0 });
    const agent = { channel: "agent", actor: "model" } as const;
    expect(overrides.apply({ type: "pause" }, agent).ok).toBe(true);
    expect(overrides.effectiveLevel(5)).toBe(0);
    expect(overrides.apply({ type: "resume" }, agent)).toMatchObject({ ok: false, tamper: true });
    expect(overrides.state().paused).toBe(true);
    overrides.apply({ type: "resume" }, { channel: "owner", actor: "test-owner" });
    overrides.apply({ type: "disable_autonomy" }, agent);
    expect(overrides.effectiveLevel(5)).toBe(2);
  });

  it("returns detached override snapshots", () => {
    const overrides = new HumanOverrides({ now: () => 0 });
    overrides.apply(
      { type: "disable_capability", capability: "robot.navigate" },
      { channel: "agent", actor: "model" },
    );
    const copy = overrides.state();
    (copy.disabledCapabilities as string[]).length = 0;
    expect(overrides.isCapabilityDisabled("robot.navigate")).toBe(true);
  });

  it("preserves its audit chain despite caller and reader mutation", () => {
    const audit = new AuditLog({ now: () => 0, recentLimit: 2 });
    const data = { value: "original" };
    const record = audit.append({
      actor: "test",
      action: "observe",
      reason: "test",
      execution: "recorded",
      data,
    });
    data.value = "changed";
    (record.data as { value: string }).value = "changed";
    audit.recent(1, (entry) => {
      (entry.data as { value: string }).value = "changed";
      return true;
    });
    expect(audit.recent()[0]?.data).toEqual({ value: "original" });
    audit.append({ actor: "test", action: "observe", reason: "second", execution: "recorded" });
    audit.append({ actor: "test", action: "observe", reason: "third", execution: "recorded" });
    expect(audit.recent()).toHaveLength(2);
    expect(audit.verify()).toEqual({ ok: true, entries: 3 });
  });
});

describe("authority policy, not authentication", () => {
  it("does not assign ownership to the model", () => {
    expect(
      checkRoleAssignment({ personId: "person_LUMINA", role: "owner", channel: "owner" }),
    ).toMatchObject({ ok: false, tamper: true });
    expect(
      checkRoleAssignment({ personId: "test-person", role: "owner", channel: "agent" }),
    ).toMatchObject({ ok: false, tamper: true });
  });

  it("puts human safety above task completion even for an owner", () => {
    const task: Request = {
      principal: { id: "a", role: "owner" },
      objective: "task_completion",
      summary: "continue",
    };
    const safety: Request = {
      principal: { id: "b", role: "guest" },
      objective: "human_safety",
      summary: "stop",
    };
    expect(resolveConflict(task, safety).winner).toBe(safety);
    expect(
      resolveConflict(task, { ...task, principal: { id: "c", role: "owner" } }).winner,
    ).toBeUndefined();
  });
});

describe("danger plans, without execution", () => {
  it("does not propose motion for an uncertain critical report", () => {
    const response = planDangerResponse(
      {
        hazard: "synthetic hazard",
        severity: "critical",
        confidence: 0.2,
        personId: "person",
        safePlaceId: "room",
      },
      { hasBody: true },
    );
    expect(response.steps.map((step) => step.step)).toEqual([
      "observe_more",
      "alert_guardian",
      "log_incident",
      "request_review",
    ]);
  });

  it("proposes guiding, not grasping a person, and does not call services itself", () => {
    const response = planDangerResponse(
      {
        hazard: "synthetic hazard",
        severity: "critical",
        confidence: 0.99,
        personId: "person",
        safePlaceId: "room",
      },
      { hasBody: true },
    );
    expect(response.steps.find((step) => step.step === "move_person_away")).toMatchObject({
      intent: { type: "navigate_to", targetId: "room" },
    });
    expect(response.steps.find((step) => step.step === "call_help")?.detail).toContain(
      "a person decides",
    );
  });
});
