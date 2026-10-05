/**
 * Tests for walking a plan step by step under the safety gate.
 */
import { describe, expect, it, vi } from "vitest";
import { PlanRunner } from "./plan-run.js";
import { validatePlan, type ActionPlan } from "./planner.js";

const plan = (stopOnError = true): ActionPlan => {
  const v = validatePlan({
    goal: "send the report",
    stopOnError,
    steps: [
      {
        toolName: "lumina_browser_drive",
        description: "open the report",
        expectedOutcome: "report open",
        rollback: "close the tab",
      },
      {
        toolName: "lumina_gmail",
        description: "send it",
        risk: "HIGH_RISK",
        expectedOutcome: "mail sent",
      },
    ],
  });
  if (!v.ok) {
    throw new Error(v.error);
  }
  return v.plan;
};

const runner = (blocked: string | null = null) => {
  const record = vi.fn();
  return { record, runner: new PlanRunner({ blocked: () => blocked, record }) };
};

describe("PlanRunner", () => {
  it("hands out steps in order and marks risky ones ask-first", () => {
    const p = plan();
    const { runner: r } = runner();
    const first = r.next(p);
    expect(first).toMatchObject({ kind: "step", index: 0, askFirst: false });
    if (first.kind !== "step") {
      throw new Error("expected a step");
    }
    expect(r.report(p, first.step.id, { ok: true, observed: "report open" }).ok).toBe(true);
    expect(r.next(p)).toMatchObject({ kind: "step", index: 1, askFirst: true });
  });

  it("refuses to hand out a step while a person has paused the system", () => {
    const { runner: r, record } = runner("A person paused autonomy.");
    expect(r.next(plan())).toEqual({ kind: "blocked", reason: "A person paused autonomy." });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ execution: "refused" }));
  });

  it("stops on failure and returns the rollbacks of done steps, newest first", () => {
    const p = plan();
    const { runner: r } = runner();
    const [open, send] = p.steps;
    r.report(p, open!.id, { ok: true });
    const failed = r.report(p, send!.id, { ok: false, observed: "SMTP refused" });
    expect(failed).toMatchObject({
      ok: true,
      run: { status: "failed" },
      rollback: [{ stepId: open!.id, rollback: "close the tab" }],
    });
    expect(r.next(p)).toEqual({ kind: "finished", status: "failed" });
  });

  it("keeps steps in order and each reported once", () => {
    const p = plan();
    const { runner: r } = runner();
    const [open, send] = p.steps;
    expect(r.report(p, send!.id, { ok: true })).toMatchObject({ ok: false });
    r.report(p, open!.id, { ok: true });
    expect(r.report(p, open!.id, { ok: true })).toMatchObject({ ok: false });
  });

  it("completes when every step is done, and cancel stops a running plan", () => {
    const p = plan();
    const { runner: r } = runner();
    for (const step of p.steps) {
      r.report(p, step.id, { ok: true });
    }
    expect(r.status(p).status).toBe("completed");

    const other = plan(false);
    expect(r.cancel(other, "Dal changed plans").status).toBe("cancelled");
    expect(r.next(other)).toEqual({ kind: "finished", status: "cancelled" });
  });
});
