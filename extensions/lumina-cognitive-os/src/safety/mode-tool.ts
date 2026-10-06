/**
 * mode-tool.ts — Tool: lumina_mode.
 *
 * "Está aquí una niña" / "voy a revisar el robot": the agent can put Lumina in
 * child or maintenance mode, which only narrows what it does. Going back to
 * normal and companion mode are the owner's call in the Lumina tab.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { MODE_GUIDANCE, type InteractionModes } from "./interaction-mode.js";

const MODE_ACTIONS = ["status", "child", "maintenance"] as const;

export function createModeTool(modes: InteractionModes): AnyAgentTool {
  return {
    name: "lumina_mode",
    label: "Lumina Mode",
    description:
      "How Lumina behaves with whom. 'status' says the current interaction mode and what it means. " +
      "'child' when a child is with you: simple, kind language, no grasping or handing objects, a summary " +
      "for the guardian afterwards. 'maintenance' when someone works on Lumina: autonomy paused, motion off " +
      "except looking and gestures. Leaving either, and companion mode, only the owner can, in the Lumina tab.",
    parameters: Type.Object({
      action: Type.Union(
        MODE_ACTIONS.map((a) => Type.Literal(a)),
        { default: "status" },
      ),
    }),
    async execute(_id, rawParams) {
      const { action = "status" } = rawParams as { action?: (typeof MODE_ACTIONS)[number] };
      if (action === "status") {
        await modes.ready;
        const state = modes.state();
        return jsonResult({ ok: true, ...state, guidance: MODE_GUIDANCE[state.mode] });
      }
      const result = await modes.set(action, { channel: "agent", actor: "agent" });
      return result.ok
        ? jsonResult({ ok: true, ...result.state, guidance: MODE_GUIDANCE[result.state.mode] })
        : jsonResult({ ok: false, error: result.reason });
    },
  };
}
