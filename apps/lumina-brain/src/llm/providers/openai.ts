/**
 * openai.ts — OpenAI-compatible LLM provider
 *
 * Works with OpenAI API and any OpenAI-compatible endpoint (local models,
 * proxies, etc.) by setting BRAIN_LLM_BASE_URL.
 * Uses native fetch — no SDK dependency.
 */

import type { LLMClient, LLMMessage, LLMResponse, LLMOptions } from "../client.js";
import type { ToolDefinition } from "@lumina/protocol";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  error?: { message: string; code?: string };
}

export class OpenAIProvider implements LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.apiKey  = apiKey;
    this.model   = model;
    this.baseUrl = (baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async complete(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    options: LLMOptions = {},
  ): Promise<LLMResponse> {
    // Convert tool definitions to OpenAI format
    const openAITools = tools.map((t) => ({
      type: "function" as const,
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.parameters,
      },
    }));

    const body: Record<string, unknown> = {
      model:      this.model,
      messages:   messages.map((m) => ({
        role:         m.role,
        content:      m.content,
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
        ...(m.name        && { name: m.name }),
      })),
      max_tokens: options.maxTokens ?? 4096,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
    };

    if (openAITools.length > 0) {
      body.tools       = openAITools;
      body.tool_choice = "auto";
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as OpenAIResponse;

    if (data.error) {
      throw new Error(`OpenAI error: ${data.error.message}`);
    }

    const choice = data.choices[0];
    if (!choice) throw new Error("OpenAI returned no choices");

    const msg = choice.message;

    // Tool calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        content:    null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id:        tc.id,
          name:      tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        })),
        finish_reason: "tool_calls",
      };
    }

    return {
      content:     msg.content ?? "",
      tool_calls:  null,
      finish_reason: choice.finish_reason === "length" ? "length" : "stop",
    };
  }
}
