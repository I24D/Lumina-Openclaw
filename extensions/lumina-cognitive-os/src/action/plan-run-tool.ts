/**
 * plan-run-tool.ts — Tool: lumina_plan_run, the step-by-step walk of a plan
 * registered with lumina_action_plan (see plan-run.ts).
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { PlanStore } from "./action-tools.js";
import type { PlanRunner } from "./plan-run.js";

const ACTIONS = ["next", "report", "status", "cancel"] as const;
type PlanRunAction = (typeof ACTIONS)[number];

export function createPlanRunTool(plans: PlanStore, runner: PlanRunner): AnyAgentTool {
  return {
    name: "lumina_plan_run",
    label: "Lumina Plan Run",
    description:
      "Walks a plan registered with lumina_action_plan, one step at a time. 'next' returns the step to " +
      "run, or why none may run now (a person paused autonomy, the emergency stop is engaged). Call that " +
      "step's tool yourself, then 'report' with ok and what you observed against its expectedOutcome. " +
      "Steps marked askFirst need the person's yes before they run. When a step fails, the plan stops and " +
      "returns the rollbacks of the steps already done, newest first: undo them in that order. 'status' " +
      "shows progress; 'cancel' stops the plan.",
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
      planId: Type.String({ minLength: 1, maxLength: 120 }),
      stepId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      ok: Type.Optional(Type.Boolean()),
      observed: Type.Optional(Type.String({ maxLength: 480 })),
      reason: Type.Optional(Type.String({ maxLength: 240 })),
    }),
    async execute(_id, rawParams) {
      // Narrowed once against this tool's schema; the tool runtime
      // validates the payload before execute() is ever called.
      const params = rawParams as {
        action: PlanRunAction;
        planId: string;
        stepId?: string;
        ok?: boolean;
        observed?: string;
        reason?: string;
      };
      const plan = plans.get(params.planId);
      if (!plan) {
        throw new ToolInputError(`No plan ${params.planId}; register it with lumina_action_plan.`);
      }
      switch (params.action) {
        case "next":
          return jsonResult({ ok: true, ...runner.next(plan) });
        case "report": {
          if (!params.stepId || params.ok === undefined) {
            throw new ToolInputError("report needs stepId and ok.");
          }
          return jsonResult(
            runner.report(plan, params.stepId, {
              ok: params.ok,
              ...(params.observed ? { observed: params.observed } : {}),
            }),
          );
        }
        case "cancel":
          return jsonResult({
            ok: true,
            run: runner.cancel(plan, params.reason?.trim() || "cancelled by the agent"),
          });
        case "status":
          return jsonResult({ ok: true, run: runner.status(plan) });
      }
    },
  };
}
