/**
 * privacy-tool.ts — "Deja de escuchar", "apaga la cámara", "modo privado",
 * "olvida esta sesión".
 *
 * Every action here makes the system more private, so the agent may carry it
 * out the moment a person asks. Turning a sensor or memory back on is not in
 * the schema: the owner does it from the dashboard (spec §97, §98).
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { PrivacyControls, PrivacyChange, PrivacyState } from "./privacy-state.js";

const ACTIONS = [
  "status",
  "stop_listening",
  "stop_camera",
  "private_mode",
  "stop_recording",
  "forget_session",
] as const;
type PrivacyAction = (typeof ACTIONS)[number];

const CHANGES: Readonly<
  Record<Exclude<PrivacyAction, "status" | "forget_session">, PrivacyChange>
> = {
  stop_listening: { microphone: false },
  stop_camera: { camera: false },
  private_mode: { privateMode: true },
  stop_recording: { recording: false },
};

export function createPrivacyTool(
  privacy: PrivacyControls,
  forgetSession: (sinceISO: string) => { readonly forgotten: number; readonly note: string },
): AnyAgentTool {
  return {
    name: "lumina_privacy",
    label: "Lumina Privacy",
    description:
      "Privacy a person controls. 'stop_listening' and 'stop_camera' drop those sensors at the source; " +
      "'private_mode' and 'stop_recording' stop remembering; 'forget_session' erases what was observed since " +
      "this session began; 'status' shows the current state. Use them as soon as someone asks. Turning a sensor " +
      "or memory back on is done by the owner from the M3GAN tab of the Control UI, not from here.",
    parameters: Type.Object({ action: Type.Union(ACTIONS.map((a) => Type.Literal(a))) }),
    async execute(_id, rawParams) {
      const { action } = rawParams as { action: PrivacyAction };
      if (action === "status") {
        return jsonResult({ ok: true, privacy: privacy.state() });
      }
      if (action === "forget_session") {
        const state: PrivacyState = privacy.state();
        return jsonResult({ ok: true, ...forgetSession(state.sessionStartISO) });
      }
      const change = CHANGES[action];
      if (!change) {
        throw new ToolInputError(`action must be one of: ${ACTIONS.join(", ")}`);
      }
      const r = privacy.set(change, { channel: "agent", actor: "agent" });
      return jsonResult({ ok: r.ok, reason: r.reason, privacy: r.state });
    },
  };
}
