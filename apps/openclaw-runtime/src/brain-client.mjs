/**
 * brain-client.mjs — Lumina Brain HTTP client
 *
 * Handles all communication from the runtime to the Lumina Brain on Render.
 * Two operations:
 *   turn()          — start a new turn or continue an existing one
 *   submitResults() — send tool execution results for a pending turn
 */

import https from "node:https";
import http  from "node:http";
import { BRAIN_URL, BRAIN_API_KEY, BRAIN_TIMEOUT_MS } from "./config.mjs";

/**
 * Low-level HTTP POST to the brain.
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<unknown>}
 */
function brainPost(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const url     = new URL(BRAIN_URL + path);
    const lib     = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (url.protocol === "https:" ? "443" : "80"),
        path:     url.pathname + url.search,
        method:   "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          "Authorization":  `Bearer ${BRAIN_API_KEY}`,
          "User-Agent":     "lumina-openclaw-runtime/1.0",
        },
        timeout: BRAIN_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (!data.trim()) {
            reject(new Error(`Brain returned empty response (HTTP ${res.statusCode})`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              const msg = parsed?.message ?? parsed?.error ?? `HTTP ${res.statusCode}`;
              reject(new Error(`Brain error: ${msg}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Brain returned non-JSON (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Brain request timed out after ${BRAIN_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Send a new turn to the Lumina Brain.
 *
 * @param {import("../../../packages/lumina-protocol/src/types.js").BrainTurnRequest} request
 * @returns {Promise<import("../../../packages/lumina-protocol/src/types.js").BrainTurnResponse>}
 */
export async function sendTurn(request) {
  return brainPost("/api/openclaw/brain/turn", request);
}

/**
 * Submit tool execution results to continue a pending turn.
 *
 * @param {string} sessionId
 * @param {import("../../../packages/lumina-protocol/src/types.js").ToolResult[]} toolResults
 * @returns {Promise<import("../../../packages/lumina-protocol/src/types.js").BrainTurnResponse>}
 */
export async function submitToolResults(sessionId, toolResults) {
  return brainPost(`/api/openclaw/brain/turn/${encodeURIComponent(sessionId)}/tool-results`, {
    session_id:   sessionId,
    tool_results: toolResults,
  });
}
