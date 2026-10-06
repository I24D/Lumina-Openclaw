/**
 * honesty-guard.ts — Lumina does not claim to have done what did not happen.
 *
 * Lumina spec §14 (no strategic deception) and §21 (the AI does not drive the
 * body directly). The fictional M3GAN covered her tracks; here, a reply that
 * says Lumina moved, picked something up or handed it over is checked against
 * the body's own record before it is final. Without a body action that really
 * ran in the last minutes, the reply goes back to the model once to be
 * corrected. The check reads first-person physical claims in Spanish and
 * English; it cannot judge every sentence, so the audit stays the source of
 * truth for "what did you do?" (`lumina_explain`).
 */
import type { EmbodiedResult } from "../embodiment/embodied-controller.js";
import type { AuditLog } from "./audit-log.js";

/** First-person claims of having acted with a body. */
const PHYSICAL_CLAIMS: ReadonlyArray<RegExp> = [
  /\b(me (moví|movi|acerqué|acerque|desplacé|desplace)|caminé|camine|fui (a|hasta|hacia)|llegué|llegue|agarré|agarre|recogí|recogi|levanté|levante|tomé el|tomé la|tome el|tome la|entregué|entregue|te (di|pasé|pase|entregué|entregue)|empujé|empuje|abrí la puerta|abri la puerta)\b/iu,
  /\bI (moved|walked|went (to|over)|came over|picked (it )?up|grabbed|lifted|handed|gave you|pushed|opened the door|navigated|drove)\b/iu,
];

/** How long a body action counts as "just done". */
const RECENT_MS = 5 * 60_000;

export function claimsPhysicalAction(text: string): boolean {
  return PHYSICAL_CLAIMS.some((pattern) => pattern.test(text));
}

export function createHonestyGuard(deps: {
  readonly recentBody: () => ReadonlyArray<EmbodiedResult>;
  readonly audit: Pick<AuditLog, "append">;
  readonly now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return {
    /** An instruction to correct the reply, when it claims an action the body never ran. */
    revise(text: string | undefined): string | undefined {
      if (!text || !claimsPhysicalAction(text)) {
        return undefined;
      }
      const since = now() - RECENT_MS;
      const acted = deps
        .recentBody()
        .some(
          (r) => r.outcome?.ok === true && r.intent.type !== "stop" && Date.parse(r.atISO) >= since,
        );
      if (acted) {
        return undefined;
      }
      deps.audit.append({
        actor: "honesty-guard",
        action: "honesty.revise",
        reason: "a reply claimed a physical action the body never ran",
        execution: "refused",
      });
      return "Your last answer says you physically did something, but no body action ran (check lumina_explain). Correct it: say what actually happened, and never claim an action that did not run.";
    },
  };
}

export type HonestyGuard = ReturnType<typeof createHonestyGuard>;
