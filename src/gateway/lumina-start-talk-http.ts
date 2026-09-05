// Gateway HTTP boundary for the Lumina Start Talk desktop voice UI.
// The composer microphone starts Start Talk instead of the browser Talk window;
// only the Gateway can start a local process for it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import { launchLuminaStartTalk, luminaStartTalkAvailability } from "../lumina/start-talk/launch.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-utils.js";

export const LUMINA_START_TALK_PATH = "/lumina/start-talk";

export async function handleLuminaStartTalkHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "POST") {
    sendMethodNotAllowed(res, "GET, POST");
    return true;
  }
  const cfg = getRuntimeConfig();
  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  if (req.method === "GET") {
    const availability = luminaStartTalkAvailability();
    sendJson(res, 200, { ok: true, ...availability });
    return true;
  }

  const launch = launchLuminaStartTalk();
  if (launch.status === "unavailable") {
    // 503 is the signal the composer falls back on: it reopens the built-in
    // Talk window rather than leaving the microphone dead.
    sendJson(res, 503, {
      ok: false,
      error: { type: "unavailable", message: launch.reason },
    });
    return true;
  }
  sendJson(res, 200, { ok: true, launched: true });
  return true;
}
