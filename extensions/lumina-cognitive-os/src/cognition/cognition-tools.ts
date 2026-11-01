/**
 * cognition-tools.ts — Voice-first access to the cognitive core.
 *
 *   lumina_workspace   "¿qué está pasando?"      the global workspace snapshot
 *   lumina_self_model  "¿qué puedes hacer?"      what Lumina knows about itself
 *   lumina_goal        "recuérdame que..."       goals that outlive a session
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { GoalManager, GoalStatus } from "./goals/goal-manager.js";
import type { SelfModel } from "./self/self-model.js";
import type { GlobalWorkspace } from "./workspace/global-workspace.js";

export function createWorkspaceTool(workspace: GlobalWorkspace): AnyAgentTool {
  return {
    name: "lumina_workspace",
    label: "Lumina Workspace",
    description:
      "Returns Lumina's global workspace: current goal, people present, location, attention target, " +
      "active task, recent events, relevant memories, user context, environment, stale beliefs and " +
      "body state. Call it when the user asks what is going on, or before planning anything that " +
      "depends on the current situation.",
    parameters: Type.Object({}),
    async execute() {
      return jsonResult({ ok: true, workspace: workspace.snapshot() });
    },
  };
}

export function createSelfModelTool(selfModel: () => SelfModel): AnyAgentTool {
  return {
    name: "lumina_self_model",
    label: "Lumina Self Model",
    description:
      "Returns what Lumina knows about itself: body, sensors, capabilities, energy, active model, " +
      "autonomy level, limitations and current tasks. Call it before promising the user something, " +
      "or when asked what Lumina can or cannot do. It states functional states only and never " +
      "claims consciousness or feelings.",
    parameters: Type.Object({}),
    async execute() {
      return jsonResult({ ok: true, self: selfModel() });
    },
  };
}

const GOAL_ACTIONS = ["create", "list", "next", "complete", "abandon"] as const;
type GoalAction = (typeof GOAL_ACTIONS)[number];

export function createGoalTool(goals: GoalManager): AnyAgentTool {
  return {
    name: "lumina_goal",
    label: "Lumina Goal",
    description:
      "Manages goals that persist across sessions. 'create' records a goal with priority 1-5, an " +
      "optional deadline and checkable success conditions; 'next' returns the goal to work on now; " +
      "'list' shows open goals; 'complete' and 'abandon' close one by id.",
    parameters: Type.Object({
      action: Type.Union(GOAL_ACTIONS.map((a) => Type.Literal(a))),
      id: Type.Optional(
        Type.String({ description: "Goal id, for complete/abandon.", maxLength: 64 }),
      ),
      title: Type.Optional(Type.String({ description: "Goal title, for create.", maxLength: 256 })),
      detail: Type.Optional(Type.String({ maxLength: 2048 })),
      priority: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      deadlineISO: Type.Optional(Type.String({ description: "ISO-8601 deadline.", maxLength: 40 })),
      successConditions: Type.Optional(
        Type.Array(Type.String({ maxLength: 512 }), { maxItems: 16 }),
      ),
      status: Type.Optional(
        Type.Union(
          ["active", "blocked", "done", "abandoned"].map((s) => Type.Literal(s)),
          {
            description: "Filter for list; defaults to open goals.",
          },
        ),
      ),
    }),
    async execute(_id, rawParams) {
      const params = rawParams as {
        action: GoalAction;
        id?: string;
        title?: string;
        detail?: string;
        priority?: number;
        deadlineISO?: string;
        successConditions?: string[];
        status?: GoalStatus;
      };
      switch (params.action) {
        case "create": {
          const title = params.title?.trim();
          if (!title) {
            throw new ToolInputError("title is required to create a goal");
          }
          const goal = goals.create({
            title,
            ...(params.detail ? { detail: params.detail } : {}),
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
            ...(params.deadlineISO ? { deadlineISO: params.deadlineISO } : {}),
            ...(params.successConditions ? { successConditions: params.successConditions } : {}),
          });
          return jsonResult({ ok: true, goal });
        }
        case "list":
          return jsonResult({
            ok: true,
            goals: params.status ? goals.list(params.status) : goals.open(),
          });
        case "next":
          return jsonResult({ ok: true, next: goals.next() ?? null });
        case "complete":
        case "abandon": {
          if (!params.id) {
            throw new ToolInputError(`id is required to ${params.action} a goal`);
          }
          const goal =
            params.action === "complete" ? goals.complete(params.id) : goals.abandon(params.id);
          return goal
            ? jsonResult({ ok: true, goal })
            : jsonResult({ ok: false, error: `No goal with id ${params.id}` });
        }
        default:
          throw new ToolInputError(`Unknown action: ${String(params.action)}`);
      }
    },
  };
}
