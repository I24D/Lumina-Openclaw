/**
 * forget-session.ts — "Olvida esta sesión" (Lumina spec §97, §99).
 *
 * Removes what this session added to the local stores that remember
 * observations: the world model, episodic memory and theory-of-mind beliefs,
 * and records that it did. Shared Supabase memory is a separate continuity
 * store with its own policy and is not touched.
 */
import type { AuditLog } from "../safety/audit-log.js";

type ForgetsSince = { forgetSince(sinceISO: string): number };

export function createForgetSession(deps: {
  readonly world: ForgetsSince;
  readonly episodicMemory?: ForgetsSince;
  readonly mind: ForgetsSince;
  readonly audit: Pick<AuditLog, "append">;
}) {
  return (sinceISO: string) => {
    const worldForgotten = deps.world.forgetSince(sinceISO);
    const episodicForgotten = deps.episodicMemory?.forgetSince(sinceISO) ?? 0;
    const beliefsForgotten = deps.mind.forgetSince(sinceISO);
    const forgotten = worldForgotten + episodicForgotten + beliefsForgotten;
    deps.audit.append({
      actor: "agent",
      action: "privacy.forget_session",
      reason: `session-local world observations, episodes and mind beliefs since ${sinceISO}`,
      execution: "executed",
      outcome: `${forgotten} removed (world=${worldForgotten}, episodic=${episodicForgotten}, beliefs=${beliefsForgotten})`,
    });
    return {
      forgotten,
      worldForgotten,
      episodicForgotten,
      beliefsForgotten,
      note:
        "World observations, episodic memories and theory-of-mind beliefs from this session were removed. " +
        "Shared Supabase memory is a separate continuity store and was not changed.",
    };
  };
}
