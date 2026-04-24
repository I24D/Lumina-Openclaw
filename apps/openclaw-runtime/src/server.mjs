/**
 * server.mjs — Lumina OpenClaw Runtime HTTP server
 *
 * Exposes a single endpoint that drives the full agentic loop:
 *   POST /turn  { session_id?, message, context? }
 *     → streams brain turns + tool execution until the brain
 *       returns a final text response, then returns it.
 *
 * The server is stateless between requests; each POST is an independent
 * conversation turn driven by the brain's tool-calling protocol.
 */

import http from "node:http";
import {
  PROXY_PORT,
  MAX_TOOL_ITERATIONS,
} from "./config.mjs";
import { sendTurn, submitToolResults } from "./brain-client.mjs";
import { executeToolCalls } from "./tool-executor.mjs";
import { LUMINA_TOOL_SCHEMAS } from "./tool-schemas.mjs";

// ── Request helpers ────────────────────────────────────────────────────────

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
        resolve(JSON.parse(raw));
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

// ── Agentic turn loop ──────────────────────────────────────────────────────

async function runTurn(sessionId, message, context) {
  let response = await sendTurn({
    session_id:   sessionId,
    message,
    context:      context ?? [],
    tools:        LUMINA_TOOL_SCHEMAS,
  });

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    if (response.status === "done") {
      return { session_id: response.session_id, reply: response.reply };
    }

    if (response.status !== "tool_calls" || !response.tool_calls?.length) {
      break;
    }

    console.log(
      `[server] session=${response.session_id} — executing ${response.tool_calls.length} tool call(s) (iteration ${iteration + 1})`,
    );

    const toolResults = await executeToolCalls(response.tool_calls);
    response = await submitToolResults(response.session_id, toolResults);
  }

  return {
    session_id: response.session_id,
    reply:      response.reply ?? "(no reply from brain)",
  };
}

// ── HTTP server ────────────────────────────────────────────────────────────

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
    const context   = Array.isArray(body?.context) ? body.context : [];

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
  console.log(`[server] POST /turn to start a brain-driven agentic turn`);
});
