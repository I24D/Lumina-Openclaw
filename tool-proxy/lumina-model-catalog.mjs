/**
 * Lumina_PC — Static catalog of 82 verified models
 * ═══════════════════════════════════════════════════════════════════════
 * Source: c:/I24D_WhatsApp/Lumina-Code/Lumina_List.md (verified 2026-06-11
 * by hitting /v1/models on each provider with the keys in .env).
 *
 * Each entry maps a model id → its upstream provider and capabilities.
 * The proxy uses this to:
 *   1. Expose all 82 models on local /v1/models (for the UI selector).
 *   2. Dispatch /v1/chat/completions to the right upstream by model id.
 *
 * Providers:
 *   - lumina-brain : the I24D Render brain (default — current behavior)
 *   - ollama-cloud : https://ollama.com/v1 (Bearer OLLAMA_CLOUD_API_KEY)
 *   - openai       : https://api.openai.com/v1 (Bearer OPENAI_API_KEY)
 *   - anthropic    : https://api.anthropic.com (x-api-key ANTHROPIC_API_KEY)
 *   - gemini       : https://generativelanguage.googleapis.com (?key=GEMINI_API_KEY)
 * ═══════════════════════════════════════════════════════════════════════
 */

export const MODEL_CATALOG = [
  // ── Lumina (default brain — keeps current /v1/chat/completions → I24D flow) ──
  { id: "I24D", provider: "lumina-brain", family: "Lumina", capabilities: ["chat", "tools"] },
  { id: "lumina/gpt-5.5", provider: "lumina-brain", family: "Lumina", capabilities: ["chat", "tools"] },

  // ── Ollama Cloud — 41 models ──────────────────────────────────────────────
  { id: "minimax-m3", provider: "ollama-cloud", family: "MiniMax", capabilities: ["vision", "tools", "thinking"] },
  { id: "minimax-m2.7", provider: "ollama-cloud", family: "MiniMax", capabilities: ["tools", "thinking"] },
  { id: "minimax-m2.5", provider: "ollama-cloud", family: "MiniMax", capabilities: ["tools", "thinking"] },
  { id: "minimax-m2.1", provider: "ollama-cloud", family: "MiniMax", capabilities: ["tools"] },
  { id: "minimax-m2", provider: "ollama-cloud", family: "MiniMax", capabilities: ["tools", "thinking"] },
  { id: "nemotron-3-ultra", provider: "ollama-cloud", family: "NVIDIA", capabilities: ["tools", "thinking"] },
  { id: "nemotron-3-super", provider: "ollama-cloud", family: "NVIDIA", capabilities: ["tools", "thinking"] },
  { id: "nemotron-3-nano:30b", provider: "ollama-cloud", family: "NVIDIA", capabilities: ["tools", "thinking"] },
  { id: "gemma4:31b", provider: "ollama-cloud", family: "Google", capabilities: ["vision", "tools", "thinking", "audio"] },
  { id: "gemma3:27b", provider: "ollama-cloud", family: "Google", capabilities: ["vision"] },
  { id: "gemma3:12b", provider: "ollama-cloud", family: "Google", capabilities: ["vision"] },
  { id: "gemma3:4b", provider: "ollama-cloud", family: "Google", capabilities: ["vision"] },
  { id: "qwen3.5:397b", provider: "ollama-cloud", family: "Alibaba", capabilities: ["vision", "tools", "thinking"] },
  { id: "qwen3-coder-next", provider: "ollama-cloud", family: "Alibaba", capabilities: ["tools", "coding"] },
  { id: "qwen3-coder:480b", provider: "ollama-cloud", family: "Alibaba", capabilities: ["tools", "coding"] },
  { id: "qwen3-vl:235b-instruct", provider: "ollama-cloud", family: "Alibaba", capabilities: ["vision", "tools", "thinking"] },
  { id: "qwen3-vl:235b", provider: "ollama-cloud", family: "Alibaba", capabilities: ["vision", "tools", "thinking"] },
  { id: "qwen3-next:80b", provider: "ollama-cloud", family: "Alibaba", capabilities: ["tools", "thinking"] },
  { id: "glm-5.1", provider: "ollama-cloud", family: "Z.ai", capabilities: ["tools", "thinking"] },
  { id: "glm-5", provider: "ollama-cloud", family: "Z.ai", capabilities: ["tools", "thinking"] },
  { id: "glm-4.7", provider: "ollama-cloud", family: "Z.ai", capabilities: ["tools", "thinking"] },
  { id: "glm-4.6", provider: "ollama-cloud", family: "Z.ai", capabilities: ["tools", "thinking"] },
  { id: "deepseek-v4-pro", provider: "ollama-cloud", family: "DeepSeek", capabilities: ["tools", "thinking"] },
  { id: "deepseek-v4-flash", provider: "ollama-cloud", family: "DeepSeek", capabilities: ["tools", "thinking"] },
  { id: "deepseek-v3.2", provider: "ollama-cloud", family: "DeepSeek", capabilities: ["tools", "thinking"] },
  { id: "deepseek-v3.1:671b", provider: "ollama-cloud", family: "DeepSeek", capabilities: ["tools", "thinking"] },
  { id: "kimi-k2.6", provider: "ollama-cloud", family: "Moonshot", capabilities: ["vision", "tools", "thinking"] },
  { id: "kimi-k2.5", provider: "ollama-cloud", family: "Moonshot", capabilities: ["vision", "tools", "thinking"] },
  { id: "kimi-k2-thinking", provider: "ollama-cloud", family: "Moonshot", capabilities: ["tools", "thinking"] },
  { id: "kimi-k2:1t", provider: "ollama-cloud", family: "Moonshot", capabilities: ["tools"] },
  { id: "gpt-oss:120b", provider: "ollama-cloud", family: "OpenAI OSS", capabilities: ["tools", "thinking"] },
  { id: "gpt-oss:20b", provider: "ollama-cloud", family: "OpenAI OSS", capabilities: ["tools", "thinking"] },
  { id: "gemini-3-flash-preview", provider: "ollama-cloud", family: "Google", capabilities: ["vision", "tools", "thinking"] },
  { id: "ministral-3:14b", provider: "ollama-cloud", family: "Mistral", capabilities: ["vision", "tools"] },
  { id: "ministral-3:8b", provider: "ollama-cloud", family: "Mistral", capabilities: ["vision", "tools"] },
  { id: "ministral-3:3b", provider: "ollama-cloud", family: "Mistral", capabilities: ["vision", "tools"] },
  { id: "mistral-large-3:675b", provider: "ollama-cloud", family: "Mistral", capabilities: ["vision", "tools"] },
  { id: "devstral-2:123b", provider: "ollama-cloud", family: "Mistral", capabilities: ["tools", "coding"] },
  { id: "devstral-small-2:24b", provider: "ollama-cloud", family: "Mistral", capabilities: ["vision", "tools", "coding"] },
  { id: "cogito-2.1:671b", provider: "ollama-cloud", family: "Essential", capabilities: ["reasoning"] },
  { id: "rnj-1:8b", provider: "ollama-cloud", family: "Essential", capabilities: ["tools"] },

  // ── OpenAI — 21 models ────────────────────────────────────────────────────
  { id: "gpt-5.5", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "reasoning"] },
  { id: "gpt-5.5-pro", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "reasoning"] },
  { id: "gpt-5.4", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools"] },
  { id: "gpt-5.4-mini", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools"] },
  { id: "gpt-5.4-nano", provider: "openai", family: "OpenAI", capabilities: ["chat"] },
  { id: "gpt-5.4-pro", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "reasoning"] },
  { id: "gpt-5.2", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "reasoning"] },
  { id: "gpt-5.2-codex", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "coding"] },
  { id: "gpt-5.3-codex", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "coding"] },
  { id: "gpt-5", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "reasoning"] },
  { id: "gpt-5-codex", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "coding"] },
  { id: "gpt-5-mini", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools"] },
  { id: "gpt-5-nano", provider: "openai", family: "OpenAI", capabilities: ["chat"] },
  { id: "gpt-5-pro", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "reasoning"] },
  { id: "gpt-4.1", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools"] },
  { id: "gpt-4.1-mini", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools"] },
  { id: "gpt-4.1-nano", provider: "openai", family: "OpenAI", capabilities: ["chat"] },
  { id: "gpt-4o", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools", "vision"] },
  { id: "gpt-4o-mini", provider: "openai", family: "OpenAI", capabilities: ["chat", "tools"] },
  { id: "o1", provider: "openai", family: "OpenAI", capabilities: ["reasoning"] },
  { id: "o3", provider: "openai", family: "OpenAI", capabilities: ["reasoning"] },
  { id: "o3-mini", provider: "openai", family: "OpenAI", capabilities: ["reasoning"] },
  { id: "o4-mini", provider: "openai", family: "OpenAI", capabilities: ["reasoning"] },

  // ── Anthropic — 6 models ──────────────────────────────────────────────────
  { id: "claude-opus-4-8", provider: "anthropic", family: "Anthropic", capabilities: ["chat", "tools", "reasoning", "vision"] },
  { id: "claude-opus-4-7", provider: "anthropic", family: "Anthropic", capabilities: ["chat", "tools", "reasoning", "vision"] },
  { id: "claude-opus-4-6", provider: "anthropic", family: "Anthropic", capabilities: ["chat", "tools", "reasoning", "vision"] },
  { id: "claude-sonnet-4-5-20250929", provider: "anthropic", family: "Anthropic", capabilities: ["chat", "tools", "vision"] },
  { id: "claude-sonnet-4-6", provider: "anthropic", family: "Anthropic", capabilities: ["chat", "tools", "vision"] },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", family: "Anthropic", capabilities: ["chat", "tools"] },
  { id: "claude-fable-5", provider: "anthropic", family: "Anthropic", capabilities: ["chat", "tools"] },

  // ── Gemini — 12 models ────────────────────────────────────────────────────
  { id: "gemini-2.5-pro-preview-06-05", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision", "reasoning"] },
  { id: "gemini-3.5-flash", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-3.1-pro-preview", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision", "reasoning"] },
  { id: "gemini-3.1-flash-lite", provider: "gemini", family: "Google", capabilities: ["chat"] },
  { id: "gemini-3-pro-preview", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision", "reasoning"] },
  { id: "gemini-3-flash-preview", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-2.5-pro", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision", "reasoning"] },
  { id: "gemini-2.5-flash", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-2.5-flash-lite", provider: "gemini", family: "Google", capabilities: ["chat"] },
  { id: "gemini-2.5-flash-image", provider: "gemini", family: "Google", capabilities: ["chat", "vision"] },
  { id: "gemini-2.0-flash", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-pro-latest", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision", "reasoning"] },
  { id: "gemini-flash-latest", provider: "gemini", family: "Google", capabilities: ["chat", "tools", "vision"] },

  // DeepSeek managed direct models.
  { id: "deepseek-chat", provider: "deepseek", family: "DeepSeek", capabilities: ["chat", "tools"] },
  { id: "deepseek-reasoner", provider: "deepseek", family: "DeepSeek", capabilities: ["chat", "reasoning"] },
  { id: "deepseek-v3.1", provider: "deepseek", family: "DeepSeek", capabilities: ["chat", "tools", "reasoning"] },
  { id: "deepseek-r1-0528", provider: "deepseek", family: "DeepSeek", capabilities: ["chat", "reasoning"] },
];

const CATALOG_BY_ID = new Map(MODEL_CATALOG.map((entry) => [entry.id.toLowerCase(), entry]));
const CATALOG_BY_PROVIDER_AND_ID = new Map(
  MODEL_CATALOG.map((entry) => [`${entry.provider.toLowerCase()}/${entry.id.toLowerCase()}`, entry]),
);

/**
 * Look up the provider routing for a given model id.
 * Returns null when the id is unknown (caller falls back to default I24D path).
 *
 * Accepts both bare ids ("gpt-5.5") and namespaced refs ("openai/gpt-5.5",
 * "lumina/gpt-5.5") — the namespace prefix is stripped before lookup so the
 * UI can pass either form.
 */
export function lookupModel(modelId) {
  if (!modelId) return null;
  const raw = String(modelId).trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  const exact = CATALOG_BY_ID.get(normalized);
  if (exact) return exact;
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    const provider = raw.slice(0, slash).trim().toLowerCase();
    const bare = raw.slice(slash + 1).trim().toLowerCase();
    const providerMatch = CATALOG_BY_PROVIDER_AND_ID.get(`${provider}/${bare}`);
    if (providerMatch) return providerMatch;
    if (provider === "lumina") {
      const luminaMatch = CATALOG_BY_PROVIDER_AND_ID.get(`lumina-brain/${bare}`);
      if (luminaMatch) return luminaMatch;
    }
    return CATALOG_BY_ID.get(bare) ?? null;
  }
  return CATALOG_BY_ID.get(normalized) ?? null;
}

/**
 * Serialize the catalog as an OpenAI-compatible /v1/models payload so the
 * OpenClaw UI selector renders all 82 entries without any custom client code.
 */
export function buildOpenAIModelsResponse() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: MODEL_CATALOG.map((entry) => ({
      id: entry.id,
      object: "model",
      created,
      owned_by: entry.provider,
      lumina_family: entry.family,
      lumina_capabilities: entry.capabilities,
    })),
  };
}

export const CATALOG_TOTAL = MODEL_CATALOG.length;
