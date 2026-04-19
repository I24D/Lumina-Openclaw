/**
 * anthropic.ts — Anthropic Claude LLM provider
 *
 * Implements LLMClient using @anthropic-ai/sdk.
 * Supports native tool calling via Claude's tool_use blocks.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMMessage, LLMResponse, LLMOptions } from "../client.js";
import type { ToolDefinition } from "@lumina/protocol";

export class AnthropicProvider implements LLMClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model  = model;
  }

  async complete(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    options: LLMOptions = {},
  ): Promise<LLMResponse> {
    // Anthropic: system message is a top-level field, not in messages array
    const systemMsg = messages.find((m) => m.role === "system");
    const chatMsgs  = messages.filter((m) => m.role !== "system");

    // Convert our generic messages to Anthropic MessageParam format
    const anthropicMessages: Anthropic.MessageParam[] = chatMsgs.map((m) => {
      if (m.role === "tool") {
        return {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: m.tool_call_id ?? "unknown",
              content: m.content,
            },
          ],
        };
      }
      return {
        role: m.role as "user" | "assistant",
        content: m.content,
      };
    });

    // Convert tool definitions to Anthropic format
    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name:        t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool["input_schema"],
    }));

    const response = await this.client.messages.create({
      model:      this.model,
      max_tokens: options.maxTokens ?? 4096,
      system:     systemMsg?.content,
      messages:   anthropicMessages,
      tools:      anthropicTools.length > 0 ? anthropicTools : undefined,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
    });

    // Extract tool calls from tool_use blocks
    const toolUseBlocks = response.content.filter(
      (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUseBlocks.length > 0) {
      return {
        content: null,
        tool_calls: toolUseBlocks.map((b: Anthropic.ToolUseBlock) => ({
          id:        b.id,
          name:      b.name,
          arguments: b.input as Record<string, unknown>,
        })),
        finish_reason: "tool_calls",
      };
    }

    // Plain text response
    const textBlock = response.content.find(
      (b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text",
    );

    return {
      content:     textBlock?.text ?? "",
      tool_calls:  null,
      finish_reason: response.stop_reason === "max_tokens" ? "length" : "stop",
    };
  }
}
