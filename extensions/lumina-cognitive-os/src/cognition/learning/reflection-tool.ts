/**
 * reflection-tool.ts — Tool: lumina_reflect.
 *
 * "¿Qué has aprendido de lo que pasó?" Runs reflection over the audit and the
 * loop's recent cycles and returns findings and proposed lessons. It learns
 * nothing by itself: a person accepts a lesson in the Lumina tab.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../../shared/tool-result.js";
import type { createReflection } from "./reflection.js";

export function createReflectTool(reflection: ReturnType<typeof createReflection>): AnyAgentTool {
  return {
    name: "lumina_reflect",
    label: "Lumina Reflect",
    description:
      "Look back at what happened: actions that keep being refused, failures that repeat, proposals that " +
      "keep coming back unanswered. 'run' reflects now; 'latest' returns the last report. Proposed lessons " +
      "are not learned until the owner accepts them in the Lumina tab; tell the person what you would learn.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("run"), Type.Literal("latest")], { default: "latest" }),
    }),
    async execute(_id, rawParams) {
      const { action } = rawParams as { action?: "run" | "latest" };
      const report =
        action === "run" ? reflection.run() : (reflection.latest() ?? reflection.run());
      return jsonResult({ ok: true, report });
    },
  };
}
