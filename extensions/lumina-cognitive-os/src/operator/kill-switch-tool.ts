/**
 * kill-switch-tool.ts — Agent/voice control over the global emergency stop (§9).
 *
 * `lumina_kill_switch` with action:
 *   - status : report whether the operator is frozen + hotkey process state.
 *   - engage : trip it now from software (same effect as the panic hotkey).
 *
 * Re-arming is deliberately not here. Lumina spec §45: the system can never
 * hand itself back authority over its own stop mechanisms, so a person re-arms
 * it from the Lumina tab of the Control UI (the authenticated owner channel). The agent can
 * always stop; it can never un-stop.
 *
 * The physical hotkey (kill_switch.py via KillSwitchProcess) trips the same
 * switch; this tool is the software-side twin so "para todo" by voice works
 * even if a keyboard is out of reach.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import type { KillSwitchProcess } from "./kill-switch-process.js";
import { killSwitch } from "./kill-switch.js";

export type KillSwitchToolDeps = {
  /** Optional: the hotkey sidecar manager, to surface its status. */
  readonly process?: KillSwitchProcess;
};

export function createKillSwitchTool(deps: KillSwitchToolDeps = {}): AnyAgentTool {
  return {
    name: "lumina_kill_switch",
    label: "Lumina Kill Switch",
    description:
      "Parada de emergencia global del operador de PC. action='status' informa si está congelado " +
      "(y el estado del hotkey). action='engage' congela YA: el loop se aborta y ningún click/tecleo " +
      "llega al Bridge. Re-armar no se hace desde aquí: lo hace una persona en la pestaña Lumina del Control UI. " +
      "El hotkey físico por defecto es Ctrl+Alt+K.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("engage")], {
        default: "status",
        description: "status | engage",
      }),
      reason: Type.Optional(Type.String({ description: "Motivo al hacer engage (auditoría)." })),
    }),
    async execute(_id, rawParams) {
      // Narrowed once against this tool's schema; the tool runtime
      // validates the payload before execute() is ever called.
      const params = rawParams as { action?: "status" | "engage"; reason?: string };
      const action = params.action ?? "status";
      const state =
        action === "engage"
          ? killSwitch.engage(params.reason?.trim() || "tool")
          : killSwitch.getState();
      return jsonResult({
        ok: true,
        action,
        state,
        hotkey: deps.process?.getStatus() ?? null,
        ...(state.engaged
          ? { rearm: "A person re-arms it from the Lumina tab of the Control UI." }
          : {}),
      });
    },
  };
}
