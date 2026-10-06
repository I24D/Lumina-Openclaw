/**
 * health-http.ts — /health, /ready and /version for Lumina's cognitive core (spec §112).
 *
 * Plain HTTP so supervisors and scripts can probe the core without a gateway
 * session client; served behind gateway authentication like every plugin
 * route. Everything a person sees or decides goes through the Control UI's
 * Lumina tab and the gateway methods in gateway-methods.ts instead.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CognitiveRuntime } from "../cognition/cognitive-runtime.js";

export const CORE_HEALTH_PATH = "/plugins/lumina-cognitive-os/core";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

export function createCoreHealthHandler(params: {
  readonly runtime: CognitiveRuntime;
  readonly version: string;
}) {
  const { runtime, version } = params;
  let ready = false;
  void runtime.ready.then(() => {
    ready = true;
  });

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(CORE_HEALTH_PATH)) {
      return false;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    switch (url.pathname.slice(CORE_HEALTH_PATH.length)) {
      case "/health": {
        const health = runtime.brainstem.status();
        sendJson(res, health.overall === "down" ? 503 : 200, {
          status: health.overall,
          beats: health.beats,
          atISO: health.atISO,
        });
        return true;
      }
      case "/ready":
        sendJson(res, ready ? 200 : 503, { ready });
        return true;
      case "/version":
        sendJson(res, 200, { plugin: "lumina-cognitive-os", version });
        return true;
      default:
        sendJson(res, 404, { error: "not found" });
        return true;
    }
  };
}
