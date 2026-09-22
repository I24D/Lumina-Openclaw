// Lumina Context Engine plugin entrypoint.
//
// It deliberately keeps the legacy message pipeline: `assemble` returns the
// host's messages untouched, so a bug here cannot drop or reorder a
// conversation, and compaction stays with the runtime. What it adds is the one
// thing the legacy engine cannot do — per-run system prompt guidance — so
// Lumina is told, on every turn, where her curated knowledge lives and that
// saying "no lo sé" beats inventing an answer.
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildLuminaSystemPromptAddition, normalizeLuminaContextEngineConfig } from "./prompt.js";

export default definePluginEntry({
  id: "lumina-context-engine",
  name: "Lumina Context Engine",
  description: "Legacy assembly plus Lumina recall routing and abstention",
  register(api) {
    // The SDK is imported at module scope on purpose: importing it inside the
    // factory runs while the host holds the plugin registry, and that deadlocks
    // the first turn that selects this engine.
    api.registerContextEngine("lumina-context-engine", async (ctx) => {
      const config = normalizeLuminaContextEngineConfig(ctx?.config);
      return {
        info: {
          id: "lumina-context-engine",
          name: "Lumina Context Engine",
          version: "1.0.0",
          acceptedHostParams: ["sessionKey", "runtimeContext", "sessionTarget", "abortSignal"],
        },
        async ingest() {
          // The session manager still owns persistence, exactly as in legacy.
          return { ingested: false };
        },
        async assemble(params) {
          const memoryAddition = buildMemorySystemPromptAddition({
            availableTools: params.availableTools ?? new Set<string>(),
            ...(params.citationsMode ? { citationsMode: params.citationsMode } : {}),
            ...(params.sessionKey ? { agentSessionKey: params.sessionKey } : {}),
          });
          const lumina = buildLuminaSystemPromptAddition(config, params.availableTools);
          const systemPromptAddition = [memoryAddition, lumina].filter(Boolean).join("\n\n");
          return {
            // Pass-through: the runtime's sanitize/validate/limit pipeline stays in charge.
            messages: params.messages,
            estimatedTokens: 0,
            ...(systemPromptAddition ? { systemPromptAddition } : {}),
          };
        },
        compact: delegateCompactionToRuntime,
      };
    });
  },
});
