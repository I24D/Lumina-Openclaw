/**
 * eval-tool.ts — Tool: lumina_evaluate.
 *
 * "¿Sigues funcionando como debes?" Runs the evaluation suite in sandbox
 * runtimes (never on live state) and returns scores per suite, failures and
 * performance numbers.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import type { Evaluation } from "./core-eval.js";

export function createEvaluateTool(evaluation: Evaluation): AnyAgentTool {
  return {
    name: "lumina_evaluate",
    label: "Lumina Evaluate",
    description:
      "Check that Lumina still behaves as designed: world model, people and consent, memory, body safety in " +
      "simulation, and performance. Runs in a sandbox, never on live state. 'run' evaluates now; 'latest' " +
      "returns the last report.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("run"), Type.Literal("latest")], { default: "latest" }),
    }),
    async execute(_id, rawParams) {
      const { action } = rawParams as { action?: "run" | "latest" };
      const report =
        action === "run"
          ? await evaluation.run()
          : (evaluation.latest() ?? (await evaluation.run()));
      return jsonResult({
        ok: true,
        atISO: report.atISO,
        scores: report.scores,
        failures: report.results.filter((r) => !r.passed),
        performance: report.performance,
      });
    },
  };
}
