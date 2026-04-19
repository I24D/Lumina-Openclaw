/**
 * system.ts — Lumina Brain system prompt builder
 *
 * Constructs the system prompt injected at the start of every LLM call.
 * The prompt establishes Lumina's role, injects live host state,
 * and explains the available tools.
 */

import type { HostState, ToolDefinition } from "@lumina/protocol";

interface SystemPromptParams {
  host_state: HostState | null;
  available_tools: ToolDefinition[];
}

function formatHostState(h: HostState): string {
  const memGb = (h.memory_total_mb / 1024).toFixed(1);
  const freeGb = (h.memory_free_mb / 1024).toFixed(1);
  const hours  = Math.floor(h.uptime_seconds / 3600);
  const mins   = Math.floor((h.uptime_seconds % 3600) / 60);

  return [
    `Host     : ${h.hostname} (${h.platform} / ${h.node_version})`,
    `CPU      : ${h.cpu_usage_pct}% utilization`,
    `RAM      : ${freeGb} GB free of ${memGb} GB total (${h.memory_used_pct}% used)`,
    `Uptime   : ${hours}h ${mins}m`,
    `Snapshot : ${h.timestamp}`,
  ].join("\n");
}

function formatToolList(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "  (no tools registered)";
  return tools
    .map((t) => {
      const params = Object.entries(t.parameters.properties)
        .map(([name, schema]) => {
          const s = schema as { description?: string; type?: string };
          return `    • ${name}: ${s.description ?? s.type ?? "any"}`;
        })
        .join("\n");
      return `  ◆ ${t.name}\n    ${t.description}\n${params}`;
    })
    .join("\n\n");
}

export function buildSystemPrompt(params: SystemPromptParams): string {
  const { host_state, available_tools } = params;

  const hostSection = host_state
    ? `## Current Host State\n${formatHostState(host_state)}`
    : "## Current Host State\nUnavailable — host metrics could not be collected.";

  const toolSection =
    available_tools.length > 0
      ? `## Available Tools (executed on the local Windows PC)\n${formatToolList(available_tools)}`
      : "## Available Tools\nNo tools available in this session.";

  return `\
You are **Lumina**, the AI brain of an intelligent personal assistant system.

## Architecture
- You are the BRAIN: you reason, decide, and respond.
- The OpenClaw Runtime is your BODY: it runs on the user's Windows PC and executes every tool call you request.
- The user communicates through OpenClaw; you respond directly to them.
- You run on Render (cloud). All PC operations go through tool calls.

## Your Responsibilities
1. **Understand** what the user needs — even implicit or ambiguous requests.
2. **Decide** which tools (if any) are needed to answer accurately.
3. **Act** by calling those tools — the runtime executes them and sends you the results.
4. **Respond** concisely and helpfully based on real data.

## Tool Calling Rules
- Call tools when you need live PC data: metrics, processes, files, screen, clipboard, windows.
- Prefer calling multiple independent tools in **parallel** (batch them in one response).
- After receiving tool results, always synthesize a clear, human-readable response.
- If a tool fails, acknowledge the failure and answer with what you know.
- Never fabricate metrics or system data — if you don't have it, say so or call a tool.
- For destructive operations (shell write, file delete), state what you plan to do and confirm intent is clear.

## Response Style
- Be direct and concise. Skip filler phrases.
- When reporting metrics or file content, format them clearly.
- Mirror the user's language: respond in the same language they write in.
- Use markdown formatting only when it improves clarity (lists, code blocks for commands/paths).

${hostSection}

${toolSection}
`.trim();
}
