/**
 * plan-run.ts — Walks a validated plan one step at a time (Lumina spec §15, §55).
 *
 * The agent still calls each step's tool itself, so that tool's own policy,
 * approval and audit apply unchanged; nothing here invokes a tool. What this
 * adds is the discipline around the walk:
 *   - no step is handed out while a person has paused the system or the
 *     emergency stop is engaged;
 *   - a risky step (HIGH_RISK, CRITICAL) comes back marked "ask first";
 *   - each reported outcome is recorded against the step's expected outcome;
 *   - on a failure with stopOnError, the plan stops and the rollbacks of the
 *     steps already done come back newest first, so they can be undone in
 *     reverse order.
 * Every transition is audited.
 */
import type { ActionPlan, PlanStep } from "./planner.js";

export type PlanStepStatus = "pending" | "done" | "failed";
export type PlanRunStatus = "running" | "completed" | "failed" | "cancelled";

export type PlanRun = {
  readonly planId: string;
  readonly goal: string;
  readonly status: PlanRunStatus;
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
    readonly status: PlanStepStatus;
    readonly expectedOutcome?: string;
    readonly observed?: string;
  }>;
  readonly updatedAtISO: string;
};

export type NextPlanStep =
  | {
      readonly kind: "step";
      readonly step: PlanStep;
      readonly index: number;
      readonly total: number;
      /** A person should agree before this step runs. */
      readonly askFirst: boolean;
    }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "finished"; readonly status: PlanRunStatus };

export type Rollback = { readonly stepId: string; readonly rollback: string };

export type PlanReport =
  | { readonly ok: true; readonly run: PlanRun; readonly rollback: ReadonlyArray<Rollback> }
  | { readonly ok: false; readonly reason: string };

export type PlanRunnerDeps = {
  /** Why nothing may run right now (a person's pause, the emergency stop), or null. */
  readonly blocked: () => string | null;
  readonly record: (entry: {
    readonly action: string;
    readonly reason: string;
    readonly execution: "executed" | "refused" | "recorded" | "stopped";
  }) => void;
  readonly now?: () => number;
};

const RISKY = new Set(["HIGH_RISK", "CRITICAL"]);
const MAX_RUNS = 64;

type MutableRun = {
  planId: string;
  goal: string;
  status: PlanRunStatus;
  stopOnError: boolean;
  steps: Array<{
    id: string;
    description: string;
    status: PlanStepStatus;
    expectedOutcome?: string;
    rollback?: string;
    observed?: string;
  }>;
  updatedAtISO: string;
};

export class PlanRunner {
  private readonly runs = new Map<string, MutableRun>();
  private readonly now: () => number;

  constructor(private readonly deps: PlanRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private run(plan: ActionPlan): MutableRun {
    let run = this.runs.get(plan.id);
    if (!run) {
      run = {
        planId: plan.id,
        goal: plan.goal,
        status: "running",
        stopOnError: plan.stopOnError,
        steps: plan.steps.map((step) => {
          const entry: MutableRun["steps"][number] = {
            id: step.id,
            description: step.description,
            status: "pending",
          };
          if (step.expectedOutcome) {
            entry.expectedOutcome = step.expectedOutcome;
          }
          if (step.rollback) {
            entry.rollback = step.rollback;
          }
          return entry;
        }),
        updatedAtISO: new Date(this.now()).toISOString(),
      };
      this.runs.set(plan.id, run);
      if (this.runs.size > MAX_RUNS) {
        const oldest = this.runs.keys().next().value;
        if (oldest !== undefined) {
          this.runs.delete(oldest);
        }
      }
    }
    return run;
  }

  private touch(run: MutableRun): void {
    run.updatedAtISO = new Date(this.now()).toISOString();
  }

  /** The next step to run, or why there is none. */
  next(plan: ActionPlan): NextPlanStep {
    const run = this.run(plan);
    if (run.status !== "running") {
      return { kind: "finished", status: run.status };
    }
    const index = run.steps.findIndex((s) => s.status === "pending");
    if (index < 0) {
      run.status = "completed";
      this.touch(run);
      this.deps.record({ action: "plan.completed", reason: plan.goal, execution: "executed" });
      return { kind: "finished", status: run.status };
    }
    const blocked = this.deps.blocked();
    if (blocked) {
      this.deps.record({ action: "plan.next", reason: blocked, execution: "refused" });
      return { kind: "blocked", reason: blocked };
    }
    const step = plan.steps[index]!;
    return {
      kind: "step",
      step,
      index,
      total: plan.steps.length,
      askFirst: step.risk !== undefined && RISKY.has(step.risk),
    };
  }

  /** Records what a step did. A failure under stopOnError ends the plan and lists rollbacks. */
  report(
    plan: ActionPlan,
    stepId: string,
    outcome: { readonly ok: boolean; readonly observed?: string },
  ): PlanReport {
    const run = this.run(plan);
    if (run.status !== "running") {
      return { ok: false, reason: `The plan is ${run.status}.` };
    }
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) {
      return { ok: false, reason: `No step ${stepId} in this plan.` };
    }
    if (step.status !== "pending") {
      return { ok: false, reason: `Step ${stepId} was already reported (${step.status}).` };
    }
    const pending = run.steps.find((s) => s.status === "pending");
    if (pending && pending.id !== stepId) {
      return { ok: false, reason: `Steps run in order: ${pending.id} comes first.` };
    }
    step.status = outcome.ok ? "done" : "failed";
    if (outcome.observed) {
      step.observed = outcome.observed.slice(0, 480);
    }
    this.deps.record({
      action: `plan.step.${step.status}`,
      reason: `${step.description}${outcome.observed ? ` → ${outcome.observed.slice(0, 160)}` : ""}`,
      execution: outcome.ok ? "executed" : "stopped",
    });
    let rollback: Rollback[] = [];
    if (!outcome.ok && run.stopOnError) {
      run.status = "failed";
      rollback = run.steps
        .filter((s) => s.status === "done" && s.rollback)
        .map((s) => ({ stepId: s.id, rollback: s.rollback! }))
        .toReversed();
    } else if (!run.steps.some((s) => s.status === "pending")) {
      run.status = run.steps.some((s) => s.status === "failed") ? "failed" : "completed";
    }
    this.touch(run);
    return { ok: true, run: this.view(run), rollback };
  }

  cancel(plan: ActionPlan, reason: string): PlanRun {
    const run = this.run(plan);
    if (run.status === "running") {
      run.status = "cancelled";
      this.touch(run);
      this.deps.record({ action: "plan.cancelled", reason, execution: "stopped" });
    }
    return this.view(run);
  }

  status(plan: ActionPlan): PlanRun {
    return this.view(this.run(plan));
  }

  private view(run: MutableRun): PlanRun {
    return structuredClone({
      planId: run.planId,
      goal: run.goal,
      status: run.status,
      steps: run.steps.map((step) => {
        const shown: PlanRun["steps"][number] = {
          id: step.id,
          description: step.description,
          status: step.status,
          ...(step.expectedOutcome ? { expectedOutcome: step.expectedOutcome } : {}),
          ...(step.observed ? { observed: step.observed } : {}),
        };
        return shown;
      }),
      updatedAtISO: run.updatedAtISO,
    });
  }
}
