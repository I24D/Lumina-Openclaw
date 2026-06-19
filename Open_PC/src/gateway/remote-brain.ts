import type { ClientToolDefinition } from "../agents/pi-embedded-runner/run/params.js";
import { runBeforeToolCallHook } from "../agents/pi-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "../agents/pi-tools.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { stringifyToolPayload } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const DEFAULT_REMOTE_BRAIN_TIMEOUT_MS = 45_000;
const DEFAULT_REMOTE_BRAIN_MAX_TURNS = 8;
const MAX_TOOL_RESULT_CHARS = 16_000;

type RemoteBrainMessageRole = "system" | "user" | "assistant" | "tool";

export type RemoteBrainToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type RemoteBrainMessage = {
  role: RemoteBrainMessageRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: RemoteBrainToolCall[];
};

export type RemoteBrainToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RemoteBrainAttachment = {
  type: "image" | "video" | "audio" | "document";
  url: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
};

type RemoteBrainRuntimeTool = {
  definition: RemoteBrainToolDefinition;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<unknown>;
};

type RemoteBrainTurnResponse = {
  ok: boolean;
  error?: string;
  reply: string;
  assistantMessage: RemoteBrainMessage;
  toolCalls: RemoteBrainToolCall[];
  finishReason: string;
  model?: string;
  usage?: unknown;
  speechText?: string;
  attachments: RemoteBrainAttachment[];
  traceId?: string;
};

type RemoteBrainConfig = {
  enabled: boolean;
  url?: string;
  secret?: string;
  timeoutMs: number;
  maxTurns: number;
};

type RemoteBrainDeps = {
  fetchImpl?: typeof fetch;
  localTools?: RemoteBrainRuntimeTool[];
  runtimeVersion?: string;
};

export type GatewayRemoteBrainLoopResult =
  | { enabled: false }
  | {
      enabled: true;
      ok: false;
      error: string;
    }
  | {
      enabled: true;
      ok: true;
      reply: string;
      assistantMessage: RemoteBrainMessage;
      toolCalls: RemoteBrainToolCall[];
      finishReason: string;
      model?: string;
      usage?: unknown;
      executedToolCalls: number;
      pendingToolCalls?: RemoteBrainToolCall[];
      speechText?: string;
      attachments?: RemoteBrainAttachment[];
      traceId?: string;
    };

export type GatewayRemoteBrainLoopParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  requestId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  messages: RemoteBrainMessage[];
  clientTools?: ClientToolDefinition[];
  userId?: string;
  messageProvider?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  runtimeContext?: Record<string, unknown>;
  signal?: AbortSignal;
  deps?: RemoteBrainDeps;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRemoteBrainAttachments(value: unknown): RemoteBrainAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): RemoteBrainAttachment | null => {
      if (!isRecord(item)) {
        return null;
      }
      const rawType = normalizeNonEmptyString(item.type)?.toLowerCase();
      const url = normalizeNonEmptyString(item.url);
      if (
        !url ||
        !rawType ||
        !["image", "video", "audio", "document", "file"].includes(rawType)
      ) {
        return null;
      }
      return {
        type: rawType === "file" ? "document" : (rawType as RemoteBrainAttachment["type"]),
        url,
        fileName:
          normalizeNonEmptyString(item.fileName) ?? normalizeNonEmptyString(item.filename),
        mimeType:
          normalizeNonEmptyString(item.mimeType) ?? normalizeNonEmptyString(item.mimetype),
        caption: normalizeNonEmptyString(item.caption),
      };
    })
    .filter((item): item is RemoteBrainAttachment => item !== null);
}

export function buildRemoteBrainAssistantContent(
  reply: string,
  attachments: RemoteBrainAttachment[] = [],
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (reply.trim()) {
    content.push({ type: "text", text: reply.trim() });
  }
  for (const attachment of attachments) {
    const label = attachment.caption || attachment.fileName || "Lumina artifact";
    if (attachment.type === "image") {
      content.push({
        type: "image",
        url: attachment.url,
        openUrl: attachment.url,
        alt: label,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      });
      continue;
    }
    content.push({
      type: attachment.type === "audio" ? "audio" : "file",
      url: attachment.url,
      title: label,
      fileName: attachment.fileName || undefined,
      mimeType:
        attachment.mimeType ||
        (attachment.type === "video"
          ? "video/*"
          : attachment.type === "audio"
            ? "audio/*"
            : "application/octet-stream"),
      artifactType: attachment.type,
    });
  }
  return content.length > 0 ? content : [{ type: "text", text: "" }];
}

function normalizeBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (!isRecord(part)) {
          return "";
        }
        const text = normalizeNonEmptyString(part.text) ?? normalizeNonEmptyString(part.input_text);
        if (text) {
          return text;
        }
        if (part.type === "image" || part.type === "input_image" || part.type === "image_url") {
          return "[image]";
        }
        if (part.type === "audio" || part.type === "input_audio") {
          return "[audio]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === undefined || content === null) {
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function normalizeRemoteBrainMessage(message: RemoteBrainMessage): RemoteBrainMessage | null {
  const role = message.role;
  if (!["system", "user", "assistant", "tool"].includes(role)) {
    return null;
  }
  const content = stringifyMessageContent(message.content);
  if (role === "tool") {
    const toolCallId = normalizeNonEmptyString(message.tool_call_id);
    if (!toolCallId) {
      return null;
    }
    return {
      role,
      content,
      tool_call_id: toolCallId,
    };
  }
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .map((toolCall) => {
          const id = normalizeNonEmptyString(toolCall?.id);
          const name = normalizeNonEmptyString(toolCall?.function?.name);
          const rawArguments = toolCall?.function?.arguments;
          if (!id || !name) {
            return null;
          }
          return {
            id,
            type: "function" as const,
            function: {
              name,
              arguments:
                typeof rawArguments === "string"
                  ? rawArguments
                  : JSON.stringify(rawArguments ?? {}),
            },
          };
        })
        .filter((value): value is RemoteBrainToolCall => value !== null)
    : undefined;

  return {
    role,
    content,
    ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function resolveRemoteBrainConfig(env: NodeJS.ProcessEnv): RemoteBrainConfig {
  const enabled = normalizeBooleanEnv(env.OPENCLAW_REMOTE_BRAIN_ENABLED) === true;
  return {
    enabled,
    url: normalizeNonEmptyString(env.OPENCLAW_REMOTE_BRAIN_URL),
    secret: normalizeNonEmptyString(env.OPENCLAW_REMOTE_BRAIN_SECRET),
    timeoutMs: normalizePositiveInt(
      env.OPENCLAW_REMOTE_BRAIN_TIMEOUT_MS,
      DEFAULT_REMOTE_BRAIN_TIMEOUT_MS,
    ),
    maxTurns: normalizePositiveInt(
      env.OPENCLAW_REMOTE_BRAIN_MAX_TURNS,
      DEFAULT_REMOTE_BRAIN_MAX_TURNS,
    ),
  };
}

function toRemoteBrainToolDefinition(
  tool: Pick<AnyAgentTool, "name" | "description" | "parameters">,
): RemoteBrainToolDefinition {
  return {
    name: tool.name,
    description: normalizeNonEmptyString(tool.description) ?? `${tool.name} runtime tool`,
    parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
  };
}

function toRemoteBrainClientToolDefinition(
  tool: ClientToolDefinition,
): RemoteBrainToolDefinition | null {
  const name = normalizeNonEmptyString(tool.function.name);
  if (!name) {
    return null;
  }
  return {
    name,
    description: normalizeNonEmptyString(tool.function.description) ?? `${name} client tool`,
    parameters: isRecord(tool.function.parameters)
      ? tool.function.parameters
      : { type: "object", properties: {} },
  };
}

function buildRuntimeContext(params: {
  declaredTools: RemoteBrainToolDefinition[];
  messageChannel: string;
  sessionKey: string;
  runtimeContext?: Record<string, unknown>;
  runtimeVersion?: string;
}): Record<string, unknown> {
  return {
    openclawVersion: params.runtimeVersion ?? resolveRuntimeServiceVersion(),
    nodeId:
      normalizeNonEmptyString(process.env.OPENCLAW_REMOTE_BRAIN_NODE_ID) ??
      process.env.COMPUTERNAME,
    sessionLabel: params.sessionKey,
    toolInventorySummary: params.declaredTools.map((tool) => tool.name).join(", "),
    channel: params.messageChannel,
    ...params.runtimeContext,
  };
}

function parseToolArguments(
  rawArguments: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawArguments);
    if (!isRecord(parsed)) {
      return { ok: false, error: "tool arguments must decode to a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      error: `invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function serializeToolResult(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const contentSummary = result.content
      .map((entry) => {
        if (!isRecord(entry)) {
          return "";
        }
        if (entry.type === "text") {
          return stringifyToolPayload(entry.text);
        }
        if (entry.type === "image") {
          return "[image result]";
        }
        if (entry.type === "audio") {
          return "[audio result]";
        }
        return normalizeNonEmptyString(entry.type) ?? "";
      })
      .filter(Boolean)
      .join("\n");
    const detailsSummary =
      "details" in result && result.details !== undefined
        ? stringifyToolPayload(result.details)
        : undefined;
    const combined = [contentSummary, detailsSummary].filter(Boolean).join("\n\n").trim();
    if (combined) {
      return clipText(combined, MAX_TOOL_RESULT_CHARS);
    }
  }
  return clipText(stringifyToolPayload(result), MAX_TOOL_RESULT_CHARS);
}

async function resolveLocalRuntimeTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  senderIsOwner: boolean;
  messageProvider?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  excludeToolNames: Set<string>;
}): Promise<RemoteBrainRuntimeTool[]> {
  const { agentId, tools } = resolveGatewayScopedTools({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    agentTo: params.agentTo,
    agentThreadId: params.agentThreadId !== undefined ? String(params.agentThreadId) : undefined,
    senderIsOwner: params.senderIsOwner,
    allowGatewaySubagentBinding: true,
    allowMediaInvokeCommands: true,
    excludeToolNames: params.excludeToolNames,
  });
  const loopDetection = resolveToolLoopDetectionConfig({ cfg: params.cfg, agentId });

  return tools
    .filter((tool): tool is AnyAgentTool & { execute: NonNullable<AnyAgentTool["execute"]> } => {
      return typeof tool.execute === "function" && !params.excludeToolNames.has(tool.name);
    })
    .map((tool) => ({
      definition: toRemoteBrainToolDefinition(tool),
      execute: async (toolCallId: string, args: Record<string, unknown>) => {
        const hookResult = await runBeforeToolCallHook({
          toolName: tool.name,
          params: args,
          toolCallId,
          ctx: {
            agentId,
            sessionKey: params.sessionKey,
            loopDetection,
          },
        });
        if (hookResult.blocked) {
          return {
            ok: false,
            error: {
              type: "tool_call_blocked",
              message: hookResult.reason,
            },
          };
        }
        return await tool.execute(toolCallId, hookResult.params);
      },
    }));
}

async function callRemoteBrainTurn(params: {
  config: RemoteBrainConfig;
  requestId: string;
  sessionKey: string;
  userId?: string;
  messageChannel: string;
  runtimeContext: Record<string, unknown>;
  messages: RemoteBrainMessage[];
  tools: RemoteBrainToolDefinition[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RemoteBrainTurnResponse> {
  if (!params.config.url) {
    return {
      ok: false,
      error: "OPENCLAW_REMOTE_BRAIN_URL is required when the remote brain is enabled.",
      reply: "",
      assistantMessage: { role: "assistant", content: "" },
      toolCalls: [],
      finishReason: "error",
      attachments: [],
    };
  }

  const timeoutSignal = AbortSignal.timeout(params.config.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(params.config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(params.config.secret ? { Authorization: `Bearer ${params.config.secret}` } : {}),
      },
      body: JSON.stringify({
        sessionId: params.sessionKey,
        userId: params.userId,
        channel: params.messageChannel,
        requestId: params.requestId,
        messages: params.messages,
        tools: params.tools,
        runtimeContext: params.runtimeContext,
      }),
      signal,
    });
  } catch (error) {
    return {
      ok: false,
      error: `remote brain request failed: ${error instanceof Error ? error.message : String(error)}`,
      reply: "",
      assistantMessage: { role: "assistant", content: "" },
      toolCalls: [],
      finishReason: "error",
      attachments: [],
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const errorMessage =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `remote brain responded with ${response.status}`;
    return {
      ok: false,
      error: errorMessage,
      reply: "",
      assistantMessage: { role: "assistant", content: "" },
      toolCalls: [],
      finishReason: "error",
      attachments: [],
    };
  }

  const responseRecord = isRecord(payload) ? payload : {};
  const rawToolCalls = Array.isArray(responseRecord.toolCalls)
    ? responseRecord.toolCalls
    : Array.isArray(responseRecord.tool_calls)
      ? responseRecord.tool_calls
      : [];
  const toolCalls = rawToolCalls
    .map((value) => {
      if (!isRecord(value) || !isRecord(value.function)) {
        return null;
      }
      const id = normalizeNonEmptyString(value.id);
      const name = normalizeNonEmptyString(value.function.name);
      const rawArguments = value.function.arguments;
      if (!id || !name) {
        return null;
      }
      return {
        id,
        type: "function" as const,
        function: {
          name,
          arguments:
            typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {}),
        },
      };
    })
    .filter((value): value is RemoteBrainToolCall => value !== null);
  const assistantMessage = normalizeRemoteBrainMessage({
    role: "assistant",
    content: stringifyMessageContent(responseRecord.reply),
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  });
  const attachments = normalizeRemoteBrainAttachments(responseRecord.attachments);

  return {
    ok: true,
    reply: stringifyMessageContent(responseRecord.reply),
    assistantMessage: assistantMessage ?? { role: "assistant", content: "" },
    toolCalls,
    finishReason:
      normalizeNonEmptyString(responseRecord.finishReason) ??
      (toolCalls.length > 0 ? "tool_calls" : "stop"),
    model: normalizeNonEmptyString(responseRecord.model),
    usage: responseRecord.usage,
    speechText:
      normalizeNonEmptyString(responseRecord.speechText) ??
      normalizeNonEmptyString(responseRecord.speech_text),
    attachments,
    traceId:
      normalizeNonEmptyString(responseRecord.traceId) ??
      normalizeNonEmptyString(responseRecord.trace_id),
  };
}

export async function runGatewayRemoteBrainLoop(
  params: GatewayRemoteBrainLoopParams,
): Promise<GatewayRemoteBrainLoopResult> {
  const env = params.env ?? process.env;
  const config = resolveRemoteBrainConfig(env);
  if (!config.enabled) {
    return { enabled: false };
  }

  const clientToolDefinitions = (params.clientTools ?? [])
    .map(toRemoteBrainClientToolDefinition)
    .filter((value): value is RemoteBrainToolDefinition => value !== null);
  const clientToolNames = new Set(clientToolDefinitions.map((tool) => tool.name));

  const localTools =
    params.deps?.localTools ??
    (await resolveLocalRuntimeTools({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      senderIsOwner: params.senderIsOwner,
      messageProvider: params.messageProvider,
      accountId: params.accountId,
      agentTo: params.agentTo,
      agentThreadId: params.agentThreadId,
      excludeToolNames: clientToolNames,
    }));
  const localToolMap = new Map(localTools.map((tool) => [tool.definition.name, tool]));
  const declaredTools = [...localTools.map((tool) => tool.definition), ...clientToolDefinitions];
  const runtimeContext = buildRuntimeContext({
    declaredTools,
    messageChannel: params.messageChannel,
    sessionKey: params.sessionKey,
    runtimeContext: params.runtimeContext,
    runtimeVersion: params.deps?.runtimeVersion,
  });
  const messages = params.messages
    .map(normalizeRemoteBrainMessage)
    .filter((value): value is RemoteBrainMessage => value !== null)
    .slice(-60);

  let executedToolCalls = 0;
  for (let turn = 0; turn < config.maxTurns; turn += 1) {
    const response = await callRemoteBrainTurn({
      config,
      requestId: params.requestId,
      sessionKey: params.sessionKey,
      userId: params.userId,
      messageChannel: params.messageChannel,
      runtimeContext,
      messages,
      tools: declaredTools,
      signal: params.signal,
      fetchImpl: params.deps?.fetchImpl,
    });
    if (!response.ok) {
      return {
        enabled: true,
        ok: false,
        error: response.error ?? "remote brain request failed",
      };
    }

    if (response.toolCalls.length === 0) {
      return {
        enabled: true,
        ok: true,
        reply: response.reply,
        assistantMessage: response.assistantMessage,
        toolCalls: [],
        finishReason: response.finishReason,
        model: response.model,
        usage: response.usage,
        executedToolCalls,
        speechText: response.speechText,
        attachments: response.attachments,
        traceId: response.traceId,
      };
    }

    messages.push(response.assistantMessage);
    const pendingClientToolCalls = response.toolCalls.filter((toolCall) =>
      clientToolNames.has(toolCall.function.name),
    );
    if (pendingClientToolCalls.length > 0) {
      return {
        enabled: true,
        ok: true,
        reply: response.reply,
        assistantMessage: response.assistantMessage,
        toolCalls: response.toolCalls,
        pendingToolCalls: pendingClientToolCalls,
        finishReason: "tool_calls",
        model: response.model,
        usage: response.usage,
        executedToolCalls,
        speechText: response.speechText,
        attachments: response.attachments,
        traceId: response.traceId,
      };
    }

    for (const toolCall of response.toolCalls) {
      const localTool = localToolMap.get(toolCall.function.name);
      let toolMessageContent: string;
      let toolFailed = false;
      emitAgentEvent({
        runId: params.requestId,
        sessionKey: params.sessionKey,
        stream: "tool",
        data: {
          phase: "start",
          name: toolCall.function.name,
          toolCallId: toolCall.id,
        },
      });
      if (!localTool) {
        toolFailed = true;
        toolMessageContent = JSON.stringify(
          {
            ok: false,
            error: {
              type: "tool_not_available",
              message: `Tool not available: ${toolCall.function.name}`,
            },
          },
          null,
          2,
        );
      } else {
        const parsedArgs = parseToolArguments(toolCall.function.arguments);
        if (!parsedArgs.ok) {
          toolFailed = true;
          toolMessageContent = JSON.stringify(
            {
              ok: false,
              error: {
                type: "invalid_tool_arguments",
                message: parsedArgs.error,
              },
            },
            null,
            2,
          );
        } else {
          try {
            const result = await localTool.execute(toolCall.id, parsedArgs.value);
            toolMessageContent = serializeToolResult(result);
          } catch (error) {
            toolFailed = true;
            toolMessageContent = JSON.stringify(
              {
                ok: false,
                error: {
                  type: "tool_execution_failed",
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              null,
              2,
            );
          }
        }
      }
      emitAgentEvent({
        runId: params.requestId,
        sessionKey: params.sessionKey,
        stream: "tool",
        data: {
          phase: "result",
          name: toolCall.function.name,
          toolCallId: toolCall.id,
          isError: toolFailed,
          result: {
            content: [{ type: "text", text: toolFailed ? "Failed." : "Completed." }],
          },
        },
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolMessageContent,
      });
      executedToolCalls += 1;
    }
  }

  return {
    enabled: true,
    ok: false,
    error: `remote brain exceeded max turns (${config.maxTurns})`,
  };
}

export const __testing = {
  resolveRemoteBrainConfig,
  serializeToolResult,
  normalizeRemoteBrainMessage,
};
