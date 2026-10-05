/**
 * body-tool.ts — Voice-first access to the body, through the safety supervisor.
 *
 *   lumina_body review   "¿podrías ir a la cocina?"   what safety would decide
 *   lumina_body request  "ve a la cocina"             ask the body to act
 *   lumina_body recent   "¿qué hiciste?"              the body's audit trail
 *
 * The tool only carries intents. It has no way to confirm on Dal's behalf,
 * grant a capability or raise the autonomy level: those live in the plugin
 * config, which the model cannot write.
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import { BODY_INTENT_TYPES, type BodyIntent, type BodyIntentType } from "./body.js";
import type { EmbodiedController } from "./embodied-controller.js";

type IntentParams = {
  type?: BodyIntentType;
  targetId?: string;
  personId?: string;
  objectId?: string;
  onId?: string;
  name?: string;
};

function required(value: string | undefined, field: string, type: string): string {
  const v = value?.trim();
  if (!v) {
    throw new ToolInputError(`${field} is required for ${type}`);
  }
  return v;
}

/** Build a typed intent from the flat tool parameters, or explain what is missing. */
export function intentFromParams(p: IntentParams): BodyIntent {
  switch (p.type) {
    case "stop":
      return { type: "stop" };
    case "look_at":
    case "point":
    case "navigate_to":
      return { type: p.type, targetId: required(p.targetId, "targetId", p.type) };
    case "gesture":
      return { type: "gesture", name: required(p.name, "name", "gesture") };
    case "follow":
      return { type: "follow", personId: required(p.personId, "personId", "follow") };
    case "grasp":
      return { type: "grasp", objectId: required(p.objectId, "objectId", "grasp") };
    case "place":
      return {
        type: "place",
        objectId: required(p.objectId, "objectId", "place"),
        onId: required(p.onId, "onId", "place"),
      };
    case "handover":
      return {
        type: "handover",
        objectId: required(p.objectId, "objectId", "handover"),
        personId: required(p.personId, "personId", "handover"),
      };
    default:
      throw new ToolInputError(`intent type must be one of: ${BODY_INTENT_TYPES.join(", ")}`);
  }
}

const ACTIONS = ["review", "request", "recent"] as const;

export function createBodyTool(controller: EmbodiedController): AnyAgentTool {
  return {
    name: "lumina_body",
    label: "Lumina Body",
    description:
      "Moves Lumina's body through the safety supervisor. 'review' says whether an intent would be " +
      "allowed, needs Dal's confirmation, or is refused, and why; 'request' carries it out if allowed; " +
      "'recent' lists what the body did. Intents: stop, look_at, gesture, point, navigate_to, follow, " +
      "grasp, place, handover. Targets are world-model ids. When there is no body, every intent " +
      "except stop is refused: say so plainly instead of pretending to move.",
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
      type: Type.Optional(Type.Union(BODY_INTENT_TYPES.map((t) => Type.Literal(t)))),
      targetId: Type.Optional(Type.String({ maxLength: 128 })),
      personId: Type.Optional(Type.String({ maxLength: 128 })),
      objectId: Type.Optional(Type.String({ maxLength: 128 })),
      onId: Type.Optional(Type.String({ maxLength: 128 })),
      name: Type.Optional(
        Type.String({ maxLength: 64, description: "Gesture name, e.g. 'wave'." }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 64, default: 16 })),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as IntentParams & { action: (typeof ACTIONS)[number]; limit?: number };
      if (p.action === "recent") {
        return jsonResult({
          ok: true,
          body: controller.body.id,
          recent: controller.recent(p.limit ?? 16),
        });
      }
      const intent = intentFromParams(p);
      if (p.action === "review") {
        return jsonResult({ ok: true, intent, review: controller.review(intent) });
      }
      const result = await controller.request(intent);
      return jsonResult({
        ok: result.review.verdict === "allow" && result.outcome?.ok === true,
        ...result,
      });
    },
  };
}
