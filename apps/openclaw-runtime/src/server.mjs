/**
 * server.mjs - Lumina OpenClaw Runtime HTTP server.
 *
 * POST /turn drives one brain-aware agent turn:
 * 1. Send the user message plus available PC tools to Lumina Brain.
 * 2. Execute requested tool calls locally through OpenClaw.
 * 3. Submit tool results back to the brain until it returns final text.
 */

import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import {
  PROXY_PORT,
  MAX_TOOL_ITERATIONS,
  TOOL_ITERATION_LIMIT_MESSAGE,
} from "./config.mjs";
import { sendTurn, submitToolResults } from "./brain-client.mjs";
import { executeToolCalls } from "./tool-executor.mjs";
import { LUMINA_TOOL_SCHEMAS } from "./tool-schemas.mjs";

function getStableLuminaUserId() {
  if (process.env.LUMINA_USER_ID) {
    return process.env.LUMINA_USER_ID;
  }
  const seed = `${os.hostname()}|${os.userInfo().username || "user"}`;
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 18);
  return `lumina-user:${digest}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_048_576) {
        reject(new Error("Request body too large (max 1 MiB)"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function runTurn(sessionId, message, context) {
  const resolvedSessionId = resolveSessionId(sessionId, message);
  let response = await sendTurn({
    session_id: resolvedSessionId,
    message,
    history: normalizeHistory(context),
    available_tools: LUMINA_TOOL_SCHEMAS,
    host_state: null,
    metadata: {
      channel: "lumina_pc",
      user_id: getStableLuminaUserId(),
      timestamp: new Date().toISOString(),
    },
  });

  let exhaustedToolBudget = true;
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const turn = normalizeBrainTurn(response, resolvedSessionId);
    if (turn.type === "response") {
      return { session_id: turn.session_id, reply: turn.content };
    }

    if (turn.type !== "tool_calls" || !turn.calls.length) {
      exhaustedToolBudget = false;
      break;
    }

    console.log(
      `[server] session=${turn.session_id} - executing ${turn.calls.length} tool call(s) (iteration ${iteration + 1})`,
    );

    const toolResults = await executeToolCalls(turn.calls);
    response = await submitToolResults(turn.session_id, toolResults);
  }

  if (!exhaustedToolBudget) {
    const finalTurn = normalizeBrainTurn(response, resolvedSessionId);
    return {
      session_id: finalTurn.session_id,
      reply: finalTurn.type === "response" ? finalTurn.content : "(no reply from brain)",
    };
  }

  return {
    session_id: resolvedSessionId,
    reply: TOOL_ITERATION_LIMIT_MESSAGE,
  };
}

function resolveSessionId(sessionId, message) {
  if (typeof sessionId === "string" && sessionId.trim()) {
    return sessionId.trim();
  }
  const hash = crypto.createHash("sha256").update(String(message || "")).digest("hex").slice(0, 16);
  return `lumina-pc-${hash}`;
}

function normalizeHistory(context) {
  if (!Array.isArray(context)) {
    return [];
  }
  return context
    .filter((entry) => entry && typeof entry.role === "string")
    .map((entry) => ({
      role: entry.role,
      content: typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content ?? ""),
      ...(entry.tool_call_id ? { tool_call_id: String(entry.tool_call_id) } : {}),
      ...(entry.name ? { name: String(entry.name) } : {}),
    }))
    .slice(-60);
}

function normalizeBrainTurn(response, fallbackSessionId) {
  if (response?.type === "response") {
    return {
      type: "response",
      content: String(response.content ?? ""),
      session_id: String(response.session_id || fallbackSessionId),
    };
  }

  if (response?.type === "tool_calls") {
    return {
      type: "tool_calls",
      calls: normalizeToolCalls(response.calls),
      session_id: String(response.session_id || fallbackSessionId),
    };
  }

  if (response?.type === "error") {
    throw new Error(response.message || response.code || "Brain returned an error.");
  }

  // Backward compatibility with older remote-brain envelopes.
  if (response?.ok === true && Array.isArray(response.toolCalls) && response.toolCalls.length > 0) {
    return {
      type: "tool_calls",
      calls: normalizeToolCalls(response.toolCalls),
      session_id: String(response.sessionId || response.session_id || fallbackSessionId),
    };
  }

  if (response?.ok === true) {
    return {
      type: "response",
      content: String(response.reply ?? response.content ?? ""),
      session_id: String(response.sessionId || response.session_id || fallbackSessionId),
    };
  }

  if (response?.status === "done") {
    return {
      type: "response",
      content: String(response.reply ?? ""),
      session_id: String(response.session_id || fallbackSessionId),
    };
  }

  if (response?.status === "tool_calls") {
    return {
      type: "tool_calls",
      calls: normalizeToolCalls(response.tool_calls),
      session_id: String(response.session_id || fallbackSessionId),
    };
  }

  return {
    type: "response",
    content: String(response?.reply ?? response?.content ?? ""),
    session_id: String(response?.session_id || fallbackSessionId),
  };
}

function normalizeToolCalls(calls) {
  return (Array.isArray(calls) ? calls : [])
    .map((call, index) => {
      const fn = call?.function ?? {};
      const toolName = call?.tool_name ?? fn.name ?? call?.name;
      if (!toolName) return null;
      return {
        id: String(call?.id || `tool_${index + 1}`),
        tool_name: String(toolName),
        arguments: parseToolArguments(call?.arguments ?? fn.arguments),
      };
    })
    .filter(Boolean);
}

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PROXY_PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "lumina-openclaw-runtime" });
  }

  if (req.method === "POST" && url.pathname === "/turn") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }

    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) {
      return sendJson(res, 400, { ok: false, error: "Field 'message' is required and must be a non-empty string" });
    }

    const sessionId = typeof body?.session_id === "string" ? body.session_id : undefined;
    const context = Array.isArray(body?.context) ? body.context : [];

    try {
      const result = await runTurn(sessionId, message, context);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[server] turn error: ${errorMsg}`);
      return sendJson(res, 502, { ok: false, error: errorMsg });
    }
  }

  return sendJson(res, 404, { ok: false, error: "Not found" });
});

server.on("error", (err) => {
  console.error(`[server] fatal: ${err.message}`);
  process.exit(1);
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`[server] Lumina OpenClaw Runtime listening on http://127.0.0.1:${PROXY_PORT}`);
  console.log("[server] POST /turn to start a brain-driven agentic turn");
});
