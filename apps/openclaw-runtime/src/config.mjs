/**
 * config.mjs — Runtime configuration loader
 *
 * Resolution order for each value: env var > proxy-config.json > openclaw.json > hardcoded default
 * This mirrors the original tool-proxy behavior so no startup changes are needed.
 */

import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Load config files
const proxyCfg    = loadJson(join(__dir, "..", "proxy-config.json")) ?? {};
const openclawCfg = loadJson(join(os.homedir(), ".openclaw", "openclaw.json")) ?? {};

// ── Brain connection ───────────────────────────────────────────────────────
export const BRAIN_URL = (
  process.env.BRAIN_URL ?? proxyCfg.brain?.url ?? "https://lumina-brain.onrender.com"
).replace(/\/$/, "");

export const BRAIN_API_KEY = (
  process.env.BRAIN_API_KEY ?? proxyCfg.brain?.apiKey ?? ""
);

export const BRAIN_TIMEOUT_MS = parseInt(
  process.env.BRAIN_TIMEOUT_MS ?? String(proxyCfg.brain?.timeoutMs ?? "60000"),
  10,
);

// ── OpenClaw gateway ───────────────────────────────────────────────────────
export const OPENCLAW_PORT = parseInt(
  process.env.OPENCLAW_PORT
    ?? String(openclawCfg.gateway?.port ?? proxyCfg.openclaw?.port ?? "18789"),
  10,
);

export const OPENCLAW_TOKEN = (
  process.env.OPENCLAW_TOKEN
    ?? openclawCfg.gateway?.auth?.token
    ?? proxyCfg.openclaw?.token
    ?? ""
);

// ── Proxy server ───────────────────────────────────────────────────────────
export const PROXY_PORT = parseInt(
  process.env.PROXY_PORT ?? String(proxyCfg.proxy?.port ?? "4321"),
  10,
);

// ── Operational limits ─────────────────────────────────────────────────────
/** Maximum tool-calling loop iterations per turn */
export const MAX_TOOL_ITERATIONS = parseInt(
  process.env.MAX_TOOL_ITERATIONS ?? "20",
  10,
);

export const TOOL_ITERATION_LIMIT_MESSAGE = "l\u00edmite alcanzado, dime c\u00f3mo continuar";

/** How often to refresh host state cache (ms) */
export const HOST_STATE_REFRESH_MS = parseInt(
  process.env.HOST_STATE_REFRESH_MS ?? "15000",
  10,
);

// ── Validate required values ───────────────────────────────────────────────
if (!BRAIN_API_KEY) {
  console.warn(
    "[config] WARNING: BRAIN_API_KEY is not set. " +
    "Set it in proxy-config.json (brain.apiKey) or as env var.",
  );
}

export const config = {
  BRAIN_URL,
  BRAIN_API_KEY,
  BRAIN_TIMEOUT_MS,
  OPENCLAW_PORT,
  OPENCLAW_TOKEN,
  PROXY_PORT,
  MAX_TOOL_ITERATIONS,
  TOOL_ITERATION_LIMIT_MESSAGE,
  HOST_STATE_REFRESH_MS,
};
