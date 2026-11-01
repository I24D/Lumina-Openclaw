/**
 * behavior-tool.ts — "Tráeme la taza", "ven aquí", "ve a cargarte".
 *
 * 'plan' shows the intents a behavior would use and what each would likely do
 * (prediction, spec §16) without moving; 'run' carries it out through the
 * safety supervisor, stopping at the first step that is refused or that waits
 * for a person; 'predict' looks at a single intent.
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { WorldModel } from "../world/world-model.js";
import {
  BEHAVIOR_NAMES,
  planBehavior,
  runBehavior,
  type BehaviorArgs,
  type BehaviorName,
} from "./behaviors.js";
import { intentFromParams } from "./body-tool.js";
import { BODY_INTENT_TYPES, type BodyIntentType } from "./body.js";
import type { EmbodiedController } from "./embodied-controller.js";
import { predict } from "./predict.js";

const ACTIONS = ["plan", "run", "predict"] as const;

export function createBehaviorTool(
  controller: EmbodiedController,
  world: WorldModel,
  now: () => number,
): AnyAgentTool {
  return {
    name: "lumina_behavior",
    label: "Lumina Behavior",
    description:
      "Body behaviors: look_at, come_here, follow_person, find_object, bring_object, greet_person, charge, wait, " +
      "stop. 'plan' lists the steps and predicts each one without moving; 'run' carries them out through the " +
      "safety supervisor and stops at the first refusal or confirmation; 'predict' examines one intent (give " +
      "type and its target fields). A behavior never gets past a 'no'.",
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
      behavior: Type.Optional(Type.Union(BEHAVIOR_NAMES.map((b) => Type.Literal(b)))),
      targetId: Type.Optional(Type.String({ maxLength: 128 })),
      personId: Type.Optional(Type.String({ maxLength: 128 })),
      objectId: Type.Optional(Type.String({ maxLength: 128 })),
      onId: Type.Optional(Type.String({ maxLength: 128 })),
      label: Type.Optional(Type.String({ maxLength: 128 })),
      name: Type.Optional(Type.String({ maxLength: 64 })),
      type: Type.Optional(Type.Union(BODY_INTENT_TYPES.map((t) => Type.Literal(t)))),
    }),
    async execute(_id, rawParams, signal) {
      const p = rawParams as BehaviorArgs & {
        action: (typeof ACTIONS)[number];
        behavior?: BehaviorName;
        onId?: string;
        name?: string;
        type?: BodyIntentType;
      };
      if (p.action === "predict") {
        const intent = intentFromParams(p);
        return jsonResult({
          ok: true,
          prediction: predict(intent, { review: controller.review(intent), world, nowMs: now() }),
        });
      }
      if (!p.behavior) {
        throw new ToolInputError("behavior is required for plan and run");
      }
      const planned = planBehavior(p.behavior, p, world);
      if (!planned.ok) {
        return jsonResult({
          ok: false,
          reason: planned.reason,
          ...(planned.resolution ? { resolution: planned.resolution } : {}),
        });
      }
      if (p.action === "plan") {
        return jsonResult({
          ok: true,
          plan: planned.plan,
          predictions: planned.plan.steps.map((s) =>
            predict(s.intent, { review: controller.review(s.intent), world, nowMs: now() }),
          ),
        });
      }
      const run = await runBehavior(planned.plan, controller, signal ? { signal } : {});
      return jsonResult({ ok: run.completed, ...run });
    },
  };
}
