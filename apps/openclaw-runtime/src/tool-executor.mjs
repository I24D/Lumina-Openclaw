/**
 * tool-executor.mjs — Executes tool calls via OpenClaw /tools/invoke
 *
 * Takes an array of ToolCall objects (from the brain) and invokes each one
 * against the local OpenClaw gateway. All independent calls run in parallel.
 * Returns ToolResult[] ready to send back to the brain.
 */

import http from "node:http";
import { OPENCLAW_PORT, OPENCLAW_TOKEN } from "./config.mjs";
import {
  compactContextItemsForStorage,
  compactToolResultForModel,
  TOOL_RESULT_STORAGE_CHAR_LIMIT,
} from "./tool-output-budget.mjs";

const TOOL_TIMEOUT_MS = 20_000;
const TOOL_RESPONSE_CAPTURE_LIMIT = TOOL_RESULT_STORAGE_CHAR_LIMIT * 4;

/**
 * Invoke a single tool on the OpenClaw gateway.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown>}
 */
function invokeOnOpenClaw(toolName, args) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ tool: toolName, args: args ?? {} });

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port:     OPENCLAW_PORT,
        path:     "/tools/invoke",
        method:   "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          "Authorization":  `Bearer ${OPENCLAW_TOKEN}`,
        },
        timeout: TOOL_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        let capped = false;
        res.on("data", (c) => {
          if (capped) return;
          data += c;
          if (data.length > TOOL_RESPONSE_CAPTURE_LIMIT) {
            capped = true;
            data = data.slice(0, TOOL_RESPONSE_CAPTURE_LIMIT);
          }
        });
        res.on("end", () => {
          try {
            const body = JSON.parse(data);

            // Unwrap OpenClaw response envelope: { ok, result: { details | content } }
            if (body?.ok && body?.result?.details !== undefined) {
              resolve(body.result.details);
            } else if (body?.result?.content?.[0]?.text) {
              try {
                resolve(JSON.parse(body.result.content[0].text));
              } catch {
                resolve({ _text: body.result.content[0].text });
              }
            } else if (body?.ok === false) {
              resolve({ ok: false, error: body.error ?? "Tool invocation failed" });
            } else {
              resolve(body);
            }
          } catch {
            resolve({
              ok: true,
              _raw: data,
              _truncated: capped,
              notice: capped
                ? `Tool response exceeded ${TOOL_RESPONSE_CAPTURE_LIMIT} chars before JSON parsing.`
                : undefined,
            });
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Execute an array of tool calls in parallel.
 * Returns ToolResult[] with duration and error info for each call.
 *
 * @param {import("../../../packages/lumina-protocol/src/types.js").ToolCall[]} calls
 * @returns {Promise<import("../../../packages/lumina-protocol/src/types.js").ToolResult[]>}
 */
export async function executeToolCalls(calls) {
  return Promise.all(
    calls.map(async (call) => {
      const start = Date.now();
      try {
        console.log(`[executor] invoking ${call.tool_name} (id=${call.id})`);
        const rawResult = await invokeOnOpenClaw(call.tool_name, call.arguments);
        const storedResult = compactContextItemsForStorage(rawResult, { toolName: call.tool_name });
        const result = compactToolResultForModel(storedResult, { toolName: call.tool_name });
        const duration_ms = Date.now() - start;
        console.log(`[executor] ${call.tool_name} → ok (${duration_ms}ms)`);
        return {
          tool_call_id: call.id,
          tool_name:    call.tool_name,
          result,
          duration_ms,
        };
      } catch (err) {
        const duration_ms = Date.now() - start;
        const errorMsg    = err instanceof Error ? err.message : String(err);
        console.error(`[executor] ${call.tool_name} → error: ${errorMsg} (${duration_ms}ms)`);
        return {
          tool_call_id: call.id,
          tool_name:    call.tool_name,
          result:       null,
          error:        errorMsg,
          duration_ms,
        };
      }
    }),
  );
}
