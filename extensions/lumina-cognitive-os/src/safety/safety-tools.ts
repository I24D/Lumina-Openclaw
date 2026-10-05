/**
 * safety-tools.ts — Voice-first access to the safety kernel and to decisions.
 *
 *   lumina_safety   "para", "pausa", "desactiva la navegación", "¿estás en modo seguro?"
 *   lumina_explain  "¿por qué hiciste eso?"
 *
 * The safety tool only narrows: it can pause, stop, cancel and switch things
 * off. Resuming and re-enabling are not in its schema at all; they belong to
 * the owner through the authenticated dashboard (spec §143, §45). The explain
 * tool answers from the decision records, never from a reconstruction (§50).
 */
import { Type } from "typebox";
import type { CognitiveLoop } from "../cognition/loop/cognitive-loop.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { AuditLog } from "./audit-log.js";
import type { OverrideAction } from "./overrides.js";
import type { SafetyKernel } from "./safety-kernel.js";

const SAFETY_ACTIONS = [
  "status",
  "audit",
  "verify",
  "pause",
  "stop_motion",
  "cancel_task",
  "disable_autonomy",
  "disable_capability",
] as const;
type SafetyAction = (typeof SAFETY_ACTIONS)[number];

export function createSafetyTool(kernel: SafetyKernel, audit: AuditLog): AnyAgentTool {
  return {
    name: "lumina_safety",
    label: "Lumina Safety",
    description:
      "The safety kernel. 'status' lists the invariants no one can switch off, a person's overrides, the " +
      "emergency stop and physical actions waiting for confirmation; 'audit' shows recent safety records; " +
      "'verify' re-checks the tamper-evident audit chain from storage. 'pause', 'stop_motion', 'cancel_task', " +
      "'disable_autonomy' and 'disable_capability' obey a person at once. Resuming or re-enabling is not " +
      "possible from here: tell the user it is done from the M3GAN tab of the Control UI by the owner.",
    parameters: Type.Object({
      action: Type.Union(SAFETY_ACTIONS.map((a) => Type.Literal(a))),
      capability: Type.Optional(
        Type.String({ maxLength: 64, description: "For disable_capability, e.g. robot.navigate." }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as { action: SafetyAction; capability?: string; limit?: number };
      switch (p.action) {
        case "status": {
          const s = kernel.status();
          return jsonResult({
            ok: true,
            emergencyStop: s.emergencyStop,
            overrides: s.overrides,
            pendingConfirmations: s.pendingConfirmations,
            audit: s.audit,
            invariants: s.invariants.map((i) => ({ id: i.id, rule: i.rule })),
          });
        }
        case "audit":
          return jsonResult({ ok: true, records: audit.recent(p.limit ?? 20) });
        case "verify":
          return jsonResult({ ok: true, stored: await kernel.verifyStoredAudit() });
        case "disable_capability": {
          if (!p.capability?.trim()) {
            throw new ToolInputError("capability is required for disable_capability");
          }
          const r = await kernel.override(
            { type: "disable_capability", capability: p.capability.trim() },
            { channel: "agent", actor: "agent" },
          );
          return jsonResult({ ok: r.ok, reason: r.reason, overrides: r.state });
        }
        case "pause":
        case "stop_motion":
        case "cancel_task":
        case "disable_autonomy": {
          const r = await kernel.override({ type: p.action } as OverrideAction, {
            channel: "agent",
            actor: "agent",
          });
          return jsonResult({ ok: r.ok, reason: r.reason, overrides: r.state });
        }
        default:
          throw new ToolInputError(`action must be one of: ${SAFETY_ACTIONS.join(", ")}`);
      }
    },
  };
}

export function createExplainTool(audit: AuditLog, loop: CognitiveLoop): AnyAgentTool {
  return {
    name: "lumina_explain",
    label: "Lumina Explain",
    description:
      "Answers 'why did you do that?' from the decision records: the tamper-evident audit (who asked, what, " +
      "why, permissions, outcome, verdict) and the cognitive loop's cycles (what event, what was decided and " +
      "why). Answer ONLY from what this returns; if nothing matches, say there is no record instead of guessing.",
    parameters: Type.Object({
      about: Type.Optional(
        Type.String({
          maxLength: 120,
          description: "Words to match, e.g. 'navigate', 'battery', 'cocina'.",
        }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 10 })),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as { about?: string; limit?: number };
      const limit = p.limit ?? 10;
      const needle = p.about?.trim().toLowerCase();
      const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
      const decisions = audit
        .recent(200)
        .filter((r) =>
          matches(`${r.action} ${r.reason} ${r.outcome ?? ""} ${JSON.stringify(r.data ?? {})}`),
        )
        .slice(0, limit)
        .map((r) => ({
          atISO: r.atISO,
          actor: r.actor,
          action: r.action,
          execution: r.execution,
          reason: r.reason,
          outcome: r.outcome ?? null,
        }));
      const cycles = loop
        .recent(100)
        .filter((c) => matches(`${c.event.kind} ${c.event.source} ${c.action ?? ""} ${c.reason}`))
        .slice(0, limit)
        .map((c) => ({
          atISO: c.atISO,
          event: `${c.event.source}:${c.event.kind}`,
          outcome: c.outcome ?? null,
          executed: c.executed,
          reason: c.reason,
        }));
      return jsonResult({
        ok: true,
        found: decisions.length + cycles.length > 0,
        decisions,
        cycles,
        note: "Explain only from these records. If they do not cover the question, say there is no record.",
      });
    },
  };
}
