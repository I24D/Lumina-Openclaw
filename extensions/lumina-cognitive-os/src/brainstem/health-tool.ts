/**
 * health-tool.ts — "¿Cómo estás?", in the sense of a machine: subsystems,
 * heartbeat, energy and what to do about anything that is off.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import type { Brainstem } from "./brainstem.js";
import type { EnergyAdvice } from "./energy.js";

export function createHealthTool(brainstem: Brainstem, energy: () => EnergyAdvice): AnyAgentTool {
  return {
    name: "lumina_health",
    label: "Lumina Health",
    description:
      "Self-diagnostics from the brainstem, which works even when the language model does not: each subsystem " +
      "(awareness, network, energy, stores, audit, body, privacy, model) with status, detail and what to do; " +
      "the overall state; and the energy advice. 'absent' means not present by design, not broken.",
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({ description: "Run every check now instead of reading the last beat." }),
      ),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as { refresh?: boolean };
      const health = p.refresh ? await brainstem.tick() : brainstem.status();
      return jsonResult({ ok: true, health, energy: energy() });
    },
  };
}
