import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type McpTarget = {
  agentId: string;
  sessionKey: string;
};

type DurableMcpJobStatus = "running" | "completed" | "failed" | "cancelled";

type DurableMcpJob = {
  version: 1;
  runId: string;
  agentId: string;
  sessionKey: string;
  status: DurableMcpJobStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  instructionPreview?: string;
  replyText?: string;
  error?: string;
  stopReason?: string;
};

const MCP_JOB_STORE_NAMESPACE = "durable-mcp-jobs";
const MCP_JOB_STORE_MAX_ENTRIES = 10_000;
const MCP_POLL_MAX_MS = 25_000;
const MCP_OBSERVER_WAIT_MS = 25_000;
const MCP_RETRY_AFTER_MS = 3_000;
const MCP_REPLY_MAX_CHARS = 500_000;
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveMcpTarget(pluginConfig: unknown): McpTarget {
  const source = isRecord(pluginConfig) ? pluginConfig : {};
  const agentId = readString(source, "mcpAgentId", "main");
  return {
    agentId,
    sessionKey: readString(source, "mcpSessionKey", `agent:${agentId}:chatgpt-voice`),
  };
}

function requiredString(
  params: Record<string, unknown>,
  key: string,
  maximum: number,
): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params[key];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function respondError(respond: GatewayRequestHandlerOptions["respond"], error: unknown): void {
  const message = formatErrorMessage(error);
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function terminalReplyText(value: unknown): string | undefined {
  const source = isRecord(value) ? value : {};
  const reply = isRecord(source.terminalReply) ? source.terminalReply : {};
  return optionalString(reply, "text");
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const finalParts: string[] = [];
  const visibleParts: string[] = [];
  for (const block of value) {
    if (typeof block === "string") {
      if (block.trim()) {
        visibleParts.push(block.trim());
      }
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }
    const type = optionalString(block, "type");
    if (type && !["text", "output_text"].includes(type)) {
      continue;
    }
    const text = optionalString(block, "text") ?? optionalString(block, "value");
    if (!text) {
      continue;
    }
    visibleParts.push(text);
    if (block.phase === "final_answer") {
      finalParts.push(text);
    }
  }
  const selected = finalParts.length > 0 ? finalParts : visibleParts;
  return selected.length > 0 ? selected.join("\n").trim() || undefined : undefined;
}

function latestAssistantReply(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    const message: Record<string, unknown> = isRecord(candidate) ? candidate : {};
    if (message.role !== "assistant") {
      continue;
    }
    const text = messageText(message.content);
    if (text) {
      return truncate(text, MCP_REPLY_MAX_CHARS);
    }
  }
  return undefined;
}

function isTerminalJob(job: DurableMcpJob): boolean {
  return job.status !== "running";
}

function isTerminalTimeout(value: Record<string, unknown>): boolean {
  return (
    typeof value.endedAt === "number" ||
    optionalString(value, "error") !== undefined ||
    optionalString(value, "stopReason") !== undefined ||
    value.providerStarted === true
  );
}

function publicJob(job: DurableMcpJob): Record<string, unknown> {
  const completed = job.status === "completed";
  const running = job.status === "running";
  return {
    runId: job.runId,
    status: running ? "pending" : completed ? "ok" : "error",
    jobStatus: job.status,
    complete: !running,
    durable: true,
    agentId: job.agentId,
    sessionKey: job.sessionKey,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.instructionPreview ? { instructionPreview: job.instructionPreview } : {}),
    ...(job.replyText ? { terminalReply: { disposition: "visible", text: job.replyText } } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.stopReason ? { stopReason: job.stopReason } : {}),
    ...(running ? { retryAfterMs: MCP_RETRY_AFTER_MS } : {}),
  };
}

function projectWaitResult(params: {
  current: DurableMcpJob;
  result: unknown;
  now?: number;
}): DurableMcpJob {
  const value = isRecord(params.result) ? params.result : {};
  const status = optionalString(value, "status") ?? "pending";
  const now = params.now ?? Date.now();
  const replyText = terminalReplyText(value);
  if (status === "ok") {
    return {
      ...params.current,
      status: "completed",
      updatedAt: now,
      completedAt: now,
      ...(replyText ? { replyText: truncate(replyText, MCP_REPLY_MAX_CHARS) } : {}),
    };
  }
  if (status === "error" || (status === "timeout" && isTerminalTimeout(value))) {
    const error = optionalString(value, "error");
    const stopReason = optionalString(value, "stopReason");
    return {
      ...params.current,
      status: "failed",
      updatedAt: now,
      completedAt: now,
      ...(replyText ? { replyText: truncate(replyText, MCP_REPLY_MAX_CHARS) } : {}),
      ...(error
        ? { error }
        : {
            error:
              status === "timeout"
                ? "Lumina agotó su tiempo interno de ejecución."
                : "La tarea de Lumina falló.",
          }),
      ...(stopReason ? { stopReason } : {}),
    };
  }
  return { ...params.current, status: "running", updatedAt: now };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Registers the narrow Gateway surface used by the local ChatGPT MCP server.
 *
 * Results are persisted in plugin state so a client timeout or disconnect
 * never loses Lumina's eventual answer.
 */
export function registerChatGptMcpGatewayMethods(api: OpenClawPluginApi): void {
  const target = resolveMcpTarget(api.pluginConfig);
  const jobs = api.runtime.state.openKeyedStore<DurableMcpJob>({
    namespace: MCP_JOB_STORE_NAMESPACE,
    maxEntries: MCP_JOB_STORE_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
  });
  const observers = new Set<string>();
  let stopping = false;

  const persistWaitResult = async (runId: string, result: unknown): Promise<DurableMcpJob> => {
    const now = Date.now();
    const current =
      (await jobs.lookup(runId)) ??
      ({
        version: 1,
        runId,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        status: "running",
        createdAt: now,
        updatedAt: now,
      } satisfies DurableMcpJob);
    if (isTerminalJob(current)) {
      return current;
    }
    const next = projectWaitResult({ current, result, now });
    const latest = await jobs.lookup(runId);
    if (latest && isTerminalJob(latest)) {
      return latest;
    }
    await jobs.register(runId, next);
    return next;
  };

  const observeRun = (runId: string): void => {
    if (stopping || observers.has(runId)) {
      return;
    }
    observers.add(runId);
    void (async () => {
      while (!stopping) {
        const current = await jobs.lookup(runId);
        if (!current || isTerminalJob(current)) {
          return;
        }
        try {
          const result = await api.runtime.gateway.request(
            "agent.wait",
            { runId, timeoutMs: MCP_OBSERVER_WAIT_MS },
            { timeoutMs: MCP_OBSERVER_WAIT_MS + 5_000 },
          );
          const next = await persistWaitResult(runId, result);
          if (isTerminalJob(next)) {
            return;
          }
        } catch (error) {
          if (stopping) {
            return;
          }
          api.logger.debug?.(
            `chatgpt-bridge: durable observer retry for ${runId}: ${formatErrorMessage(error)}`,
          );
        }
        await delay(MCP_RETRY_AFTER_MS);
      }
    })()
      .catch((error) => {
        api.logger.warn(
          `chatgpt-bridge: durable observer stopped for ${runId}: ${formatErrorMessage(error)}`,
        );
      })
      .finally(() => observers.delete(runId));
  };

  api.on("gateway_start", async () => {
    stopping = false;
    const stored = await jobs.entries();
    for (const entry of stored) {
      if (entry.value.status === "running") {
        observeRun(entry.value.runId);
      }
    }
  });

  api.on("gateway_stop", () => {
    stopping = true;
  });

  api.on("agent_end", async (event, context) => {
    const runId = event.runId ?? context.runId;
    if (!runId || context.sessionKey !== target.sessionKey) {
      return;
    }
    const now = Date.now();
    const current =
      (await jobs.lookup(runId)) ??
      ({
        version: 1,
        runId,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        status: "running",
        createdAt: now,
        updatedAt: now,
      } satisfies DurableMcpJob);
    if (isTerminalJob(current)) {
      return;
    }
    const replyText = latestAssistantReply(event.messages);
    const next: DurableMcpJob = {
      ...current,
      status: event.success ? "completed" : "failed",
      updatedAt: now,
      completedAt: now,
      ...(replyText ? { replyText } : {}),
      ...(!event.success
        ? { error: event.error?.trim() || "La tarea de Lumina terminó con error." }
        : {}),
    };
    await jobs.register(runId, next);
  });

  api.registerGatewayMethod(
    "chatgpt.mcp.send",
    async ({ params, respond }) => {
      const input = isRecord(params) ? params : {};
      const instruction = requiredString(input, "instruction", 8_000);
      if (!instruction) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "instruction must contain 1-8000 characters"),
        );
        return;
      }
      // Zero gives the run OpenClaw's timer-safe unlimited window. The
      // caller's MCP lifetime is deliberately decoupled from the run lifetime.
      const timeoutMs = optionalInteger(input, "timeoutMs", 0, MAX_TIMER_TIMEOUT_MS) ?? 0;
      try {
        const result = await api.runtime.gateway.request(
          "chat.send",
          {
            sessionKey: target.sessionKey,
            agentId: target.agentId,
            message: instruction,
            deliver: false,
            queueMode: "followup",
            timeoutMs,
            suppressCommandInterpretation: true,
            systemInputProvenance: { kind: "external_user", sourceChannel: "chatgpt-mcp" },
            idempotencyKey:
              requiredString(input, "idempotencyKey", 200) ?? `chatgpt-mcp:${randomUUID()}`,
          },
          { scopes: ["operator.admin"] },
        );
        const resultRecord = isRecord(result) ? result : {};
        const runId = optionalString(resultRecord, "runId");
        if (!runId) {
          throw new Error("chat.send accepted the task without returning runId");
        }
        const now = Date.now();
        await jobs.registerIfAbsent(runId, {
          version: 1,
          runId,
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          status: "running",
          createdAt: now,
          updatedAt: now,
          instructionPreview: truncate(instruction, 280),
        });
        observeRun(runId);
        respond(true, {
          ...resultRecord,
          runId,
          durable: true,
          status: optionalString(resultRecord, "status") ?? "started",
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "chatgpt.mcp.wait",
    async ({ params, respond }) => {
      const input = isRecord(params) ? params : {};
      const runId = requiredString(input, "runId", 200);
      if (!runId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "runId is required"));
        return;
      }
      const requestedMs = optionalInteger(input, "timeoutMs", 0, MAX_TIMER_TIMEOUT_MS) ?? 0;
      const timeoutMs = Math.min(requestedMs, MCP_POLL_MAX_MS);
      try {
        const persisted = await jobs.lookup(runId);
        if (persisted && isTerminalJob(persisted)) {
          respond(true, publicJob(persisted));
          return;
        }
        const result = await api.runtime.gateway.request(
          "agent.wait",
          { runId, timeoutMs },
          { timeoutMs: timeoutMs + 5_000 },
        );
        const job = await persistWaitResult(runId, result);
        if (!isTerminalJob(job)) {
          observeRun(runId);
        }
        respond(true, publicJob(job));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "chatgpt.mcp.list",
    async ({ params, respond }) => {
      const input = isRecord(params) ? params : {};
      const limit = optionalInteger(input, "limit", 1, 100) ?? 20;
      const status = optionalString(input, "status");
      if (status && !["running", "completed", "failed", "cancelled"].includes(status)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "status is not a valid durable job status"),
        );
        return;
      }
      try {
        const entries = await jobs.entries();
        const selected = entries
          .map((entry) => entry.value)
          .filter((job) => !status || job.status === status)
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, limit)
          .map(publicJob);
        respond(true, { jobs: selected, count: selected.length, durable: true });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "chatgpt.mcp.abort",
    async ({ params, respond }) => {
      const input = isRecord(params) ? params : {};
      const runId = requiredString(input, "runId", 200);
      try {
        const result = await api.runtime.gateway.request("chat.abort", {
          sessionKey: target.sessionKey,
          agentId: target.agentId,
          ...(runId ? { runId } : {}),
        });
        if (runId) {
          const current = await jobs.lookup(runId);
          if (current && !isTerminalJob(current)) {
            const now = Date.now();
            await jobs.register(runId, {
              ...current,
              status: "cancelled",
              updatedAt: now,
              completedAt: now,
              stopReason: "cancelled_by_user",
              error: "La tarea fue cancelada explícitamente por el usuario.",
            });
          }
        }
        respond(true, result);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );
}
