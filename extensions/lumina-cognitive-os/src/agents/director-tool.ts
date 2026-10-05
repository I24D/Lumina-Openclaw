/**
 * director-tool.ts — Tool: lumina_director_route
 *
 * Voice-first router. The main agent calls this at the start of every
 * non-trivial turn:
 *   1. Pass the user's utterance as `intent`.
 *   2. Receive top-1 agent + a list of allowed tools.
 *   3. Adopt the agent's persona, restrict tool calls to its toolset,
 *      and proceed.
 *
 * If `ambiguous` is true, the agent asks the user out loud which of the
 * top candidates they meant.
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import { SPECIALISED_AGENTS } from "./catalog.js";
import { delegationResult, newDelegationTask } from "./delegation.js";
import { routeIntent } from "./director.js";

export function createDirectorRouteTool(): AnyAgentTool {
  return {
    name: "lumina_director_route",
    label: "Lumina Director",
    description:
      "Routes a user intent to the most suitable specialised agent (Atlas/Mira/Postino/Horus/Nimbus/" +
      "Vidrio/Soren/Bit/Vault/Iris/Vox/Forge). Returns the top candidate with its mission, persona, tool " +
      "allowlist and confidence. Call this on EVERY voice turn before deciding which tools to use.",
    parameters: Type.Object({
      intent: Type.String({ minLength: 1, maxLength: 2000 }),
      topK: Type.Optional(Type.Number({ minimum: 1, maximum: 6, default: 3 })),
    }),
    async execute(_id, rawParams) {
      // Narrowed once against this tool's schema; the tool runtime
      // validates the payload before execute() is ever called.
      const params = rawParams as { intent: string; topK?: number };
      const intent = params.intent?.trim();
      if (!intent) {
        throw new ToolInputError("intent is required");
      }
      const routed = routeIntent(intent, params.topK ?? 3);
      const top =
        routed.top === null
          ? null
          : {
              id: routed.top.agent.id,
              displayName: routed.top.agent.displayName,
              mission: routed.top.agent.mission,
              tools: routed.top.agent.tools,
              personality: routed.top.agent.personality,
              score: routed.top.score,
              hits: routed.top.hits,
            };
      const task = newDelegationTask(intent, top?.id);
      return jsonResult({
        ok: true,
        ...delegationResult({
          task,
          status: top ? "routed" : "blocked",
          evidence: [
            {
              kind: "director.route",
              summary: top
                ? `Routed to ${top.displayName} with score ${top.score.toFixed(3)}.`
                : "No specialised agent matched the intent.",
              data: {
                ambiguous: routed.ambiguous,
                candidates: routed.candidates.map((c) => ({
                  id: c.agent.id,
                  displayName: c.agent.displayName,
                  mission: c.agent.mission,
                  score: c.score,
                  hits: c.hits,
                })),
              },
            },
          ],
          errors: top
            ? []
            : [{ code: "no_route", message: "No specialised agent matched.", retryable: false }],
          result: {
            intent: routed.intent,
            ambiguous: routed.ambiguous,
            top,
            roster: SPECIALISED_AGENTS.map((a) => ({
              id: a.id,
              displayName: a.displayName,
              mission: a.mission,
            })),
          },
        }),
      });
    },
  };
}
