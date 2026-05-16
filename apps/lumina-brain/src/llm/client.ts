/**
 * client.ts — Unified LLM client interface + factory
 *
 * Abstracts over Anthropic and OpenAI providers.
 * Supports both a singleton (server default) and per-request clients
 * so users can supply their own API key without affecting other sessions.
 */

import type { ToolDefinition } from "@lumina/protocol";
import { AnthropicProvider }  from "./providers/anthropic.js";
import { OpenAIProvider }     from "./providers/openai.js";

// ── Shared interface ───────────────────────────────────────────────────────

export interface LLMMessage {
  role:           "system" | "user" | "assistant" | "tool";
  content:        string;
  tool_call_id?:  string;
  name?:          string;
}

export interface LLMToolCall {
  id:        string;
  name:      string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content:       string | null;
  tool_calls:    LLMToolCall[] | null;
  finish_reason: "stop" | "tool_calls" | "length" | "error";
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?:   number;
}

export interface LLMClient {
  complete(
    messages: LLMMessage[],
    tools:    ToolDefinition[],
    options?: LLMOptions,
  ): Promise<LLMResponse>;
}

export interface LLMConfig {
  provider:  string;
  apiKey:    string;
  model:     string;
  baseUrl?:  string;
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createLLMClient(config: LLMConfig): LLMClient {
  const provider = config.provider.toLowerCase();

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(config.apiKey, config.model);

    case "openai":
    case "openai-compat":
      return new OpenAIProvider(config.apiKey, config.model, config.baseUrl);

    default:
      throw new Error(
        `Unknown LLM provider: "${config.provider}". Supported: anthropic | openai | openai-compat`,
      );
  }
}

// ── Default singleton (server credentials) ────────────────────────────────

function buildDefaultConfig(): LLMConfig {
  const apiKey = process.env.BRAIN_LLM_API_KEY;
  if (!apiKey) throw new Error("Missing required environment variable: BRAIN_LLM_API_KEY");

  return {
    provider: process.env.BRAIN_LLM_PROVIDER ?? "anthropic",
    apiKey,
    model:    process.env.BRAIN_LLM_MODEL    ?? "claude-opus-4-7",
    baseUrl:  process.env.BRAIN_LLM_BASE_URL,
  };
}

let _defaultClient: LLMClient | null = null;

export function getDefaultLLMClient(): LLMClient {
  if (!_defaultClient) {
    const config = buildDefaultConfig();
    console.log(`[llm] Default provider: ${config.provider} — model: ${config.model}`);
    _defaultClient = createLLMClient(config);
  }
  return _defaultClient;
}

/** @deprecated Use getDefaultLLMClient() or createLLMClient(config) directly */
export const getLLMClient = getDefaultLLMClient;
