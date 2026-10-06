/**
 * causal-tool.ts — Tool: lumina_causal.
 *
 * "¿Qué pasa cuando hago X?", "¿eso causa aquello?": what Lumina's own actions
 * reliably cause, and which events merely tend to come together. The answer
 * keeps the two apart, as the causal model does.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../../shared/tool-result.js";
import type { CausalModel } from "./causal-model.js";

export function createCausalTool(model: CausalModel): AnyAgentTool {
  return {
    name: "lumina_causal",
    label: "Lumina Causal",
    description:
      "What Lumina's actions cause versus what only happens together. 'effects' lists each action Lumina " +
      "took (body intents, tool calls) with how often it ran and how reliably it did what was expected: that " +
      "is causal evidence, because Lumina intervened. 'correlations' lists events that tend to follow each " +
      "other with their lift: never present those as causes.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("effects"), Type.Literal("correlations")], {
        default: "effects",
      }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 15 })),
    }),
    async execute(_id, rawParams) {
      const { action = "effects", limit = 15 } = rawParams as {
        action?: "effects" | "correlations";
        limit?: number;
      };
      await model.ready;
      return action === "effects"
        ? jsonResult({ ok: true, effects: model.interventions().slice(0, limit) })
        : jsonResult({
            ok: true,
            correlations: model.correlations().slice(0, limit),
            note: "Correlation, not causation: Lumina did not cause these.",
          });
    },
  };
}
