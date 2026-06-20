/**
 * Lumina_PC — Tool-Calling Proxy for I24D
 * ═══════════════════════════════════════════════════════════════════════
 * Bridges OpenClaw (local) ↔ I24D (Render) by adding real PC awareness.
 *
 *  ARCHITECTURE
 *    OpenClaw :OPENCLAW_PORT  →  Proxy :PROXY_PORT  →  I24D (Render HTTPS)
 *         ↑                           ↓
 *     lumina tools  ←────  /tools/invoke (local OpenClaw)
 *
 *  MECHANISMS
 *    1. Intent detection  — scans the user message for keywords and auto-fetches
 *       live PC data (RAM, CPU, processes, screen, clipboard, windows, files)
 *       BEFORE sending to I24D. Results are injected as context so I24D can
 *       answer accurately without needing native function-calling support.
 *
 *    2. Slash commands    — direct tool execution with explicit paths/commands:
 *         /metrics          system metrics
 *         /ps               running processes
 *         /screen           screenshot
 *         /clip             clipboard content
 *         /windows          list open windows
 *         /file read  <p>   read file
 *         /file list  <p>   list directory
 *         /file stat  <p>   file info
 *         /file write <p> <content>   (APPROVAL)
 *         /file delete <p>            (APPROVAL)
 *         /shell <cmd>                (APPROVAL)
 *         /notify <msg>               send Windows toast
 *
 *    3. Approval flow     — sensitive tools (shell, file write/delete) ask
 *       the user to reply "approve" before executing.
 *
 *  PORTABILITY
 *    Config is loaded at startup from two sources (env vars override both):
 *      ~/.openclaw/openclaw.json  → gateway port + token
 *      ./proxy-config.json        → I24D URL + token + proxy port
 *
 *  SPEED
 *    Tool results are cached with per-tool TTLs to avoid redundant calls.
 *    Multiple intents are fetched in parallel via Promise.all().
 *    A request timeout prevents Render cold-start hangs.
 * ═══════════════════════════════════════════════════════════════════════
 */

import http from "node:http";
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { requestsLuminaCodeDevelopment as shouldRouteToLuminaCode } from "./lumina-code-routing.mjs";
import {
  MODEL_CATALOG,
  CATALOG_TOTAL,
  buildOpenAIModelsResponse,
  lookupModel,
} from "./lumina-model-catalog.mjs";

// ── Voice sidecar (lumina-voice.exe) ──────────────────────────────────
// Spawned on proxy startup if the binary is reachable. The sidecar exposes
// HTTP on 127.0.0.1:4322; we mirror it under /lumina/voice/* so the UI never
// has to know about a second port.
const VOICE_PORT = parseInt(process.env.LUMINA_VOICE_PORT ?? "4322", 10);
// VOICE_LANG se resuelve lazy adentro de startVoiceSidecar() porque
// luminaCfg se define más abajo en el archivo. process.env tiene prioridad.
let voiceChild = null;

function normalizeVoiceSidecarMode(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (["1", "true", "yes", "on", "force"].includes(normalized)) return "on";
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return "off";
  return "auto";
}

function resolveVoiceBinary() {
  const candidates = [
    process.env.LUMINA_VOICE_BIN,
    join(__dir, "..", "runtime-tools", "lumina-voice.exe"),
    join(os.homedir(), ".lumina", "runtime-manager", "current", "runtime-tools", "lumina-voice.exe"),
    join(__dir, "..", "apps", "lumina-desktop", "build", "runtime-tools", "lumina-voice.exe"),
    join(os.homedir(), ".lumina", "bin", "lumina-voice.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function startVoiceSidecar() {
  const mode = normalizeVoiceSidecarMode(process.env.LUMINA_VOICE_SIDECAR);
  if (mode === "off") {
    console.log("[proxy] voice sidecar disabled by LUMINA_VOICE_SIDECAR");
    return;
  }
  const bin = resolveVoiceBinary();
  if (!bin) {
    console.log("[proxy] voice sidecar: binary not found, skipping spawn");
    return;
  }
  try {
    voiceChild = spawn(bin, [], {
      env: {
        ...process.env,
        LUMINA_VOICE_PORT: String(VOICE_PORT),
        LUMINA_VOICE_LANG: process.env.LUMINA_VOICE_LANG ?? luminaCfg.voiceLang ?? "en-US",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    voiceChild.stdout?.on("data", (chunk) => {
      process.stdout.write(`[voice] ${chunk.toString()}`);
    });
    voiceChild.stderr?.on("data", (chunk) => {
      process.stderr.write(`[voice] ${chunk.toString()}`);
    });
    voiceChild.on("exit", (code) => {
      console.log(`[proxy] voice sidecar exited code=${code}`);
      voiceChild = null;
    });
    console.log(`[proxy] voice sidecar spawned: ${bin} on port ${VOICE_PORT}`);
  } catch (err) {
    console.warn(`[proxy] voice sidecar spawn failed: ${err.message}`);
  }
}

async function proxyToVoice(clientReq, reqPath, method, body, res) {
  // Strip the `/lumina` prefix so the sidecar sees its real `/voice/...`
  // paths. The sidecar also exposes `/health` (no `/voice` prefix); rewrite
  // that one case so the UI can use `/lumina/voice/health` uniformly.
  let upstreamPath = reqPath.replace(/^\/lumina/, "");
  if (upstreamPath === "/voice/health" || upstreamPath === "/voice" || upstreamPath === "") {
    upstreamPath = "/health";
  }
  return new Promise((resolve) => {
    const bodyStr = body && typeof body === "object" ? JSON.stringify(body) : body ?? "";
    const opts = {
      hostname: "127.0.0.1",
      port: VOICE_PORT,
      path: upstreamPath,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const upstreamReq = http.request(opts, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, {
        ...upstreamRes.headers,
        ...luminaCorsHeaders(clientReq),
      });
      upstreamRes.pipe(res);
      upstreamRes.on("end", resolve);
    });
    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, {
          "Content-Type": "application/json",
          ...luminaCorsHeaders(clientReq),
        });
        res.end(JSON.stringify({
          ok: false,
          error: "voice_sidecar_unavailable",
          message: err.message,
          hint: "Verifica que lumina-voice.exe esté en runtime-tools/ y reinicia Lumina.",
        }));
      }
      resolve();
    });
    if (bodyStr) upstreamReq.write(bodyStr);
    upstreamReq.end();
  });
}

// ── Config loading ────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const luminaHomeDir = join(os.homedir(), ".lumina");
const luminaConfigPath = join(luminaHomeDir, "config.json");
const luminaInstallationPath = join(luminaHomeDir, "installation.json");
const fallbackOpenclawConfigPath = join(os.homedir(), ".openclaw", "openclaw.json");

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseDotEnvValue(rawValue) {
  let value = String(rawValue ?? "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

function loadDotEnv(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] === undefined) {
        process.env[key] = parseDotEnvValue(rawValue);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function loadKnownDotEnvFiles() {
  const candidates = new Set();
  if (process.env.LUMINA_ENV_FILE) {
    candidates.add(resolve(process.env.LUMINA_ENV_FILE));
  }
  candidates.add(join(os.homedir(), ".lumina", ".env"));
  candidates.add(join(process.cwd(), ".env"));
  candidates.add(join(__dir, ".env"));
  if (process.platform === "win32") {
    candidates.add("C:\\I24D_WhatsApp\\.env");
  }

  let cursor = __dir;
  for (let i = 0; i < 8; i += 1) {
    candidates.add(join(cursor, ".env"));
    const next = resolve(cursor, "..");
    if (next === cursor) break;
    cursor = next;
  }

  for (const candidate of candidates) {
    loadDotEnv(candidate);
  }
}

loadKnownDotEnvFiles();

const luminaCfg = loadJson(luminaConfigPath) ?? {};
const proxyCfg = loadJson(join(__dir, "proxy-config.json")) ?? {};
const openclawCfg =
  loadJson(process.env.OPENCLAW_CONFIG_PATH ?? fallbackOpenclawConfigPath) ?? {};

const LUMINA_WORKSPACE_PATH = resolve(
  process.env.LUMINA_WORKSPACE
    ?? process.env.LUMINA_CODE_WORKSPACE
    ?? openclawCfg.agents?.defaults?.workspace
    ?? luminaCfg.workspace
    ?? join(os.homedir(), ".lumina", "workspace"),
);

// Resolution order: env var > ~/.lumina/config.json > proxy-config.json > openclaw.json > fallback
const I24D_URL         = process.env.I24D_URL
  ?? luminaCfg.i24dChatUrl
  ?? proxyCfg.i24d?.url
  ?? "https://i24d-whatsapp-ai.onrender.com/v1/chat/completions";

const I24D_MODELS_BASE = process.env.I24D_MODELS_BASE
  ?? luminaCfg.i24dModelsBaseUrl
  ?? proxyCfg.i24d?.modelsBase
  ?? "https://i24d-whatsapp-ai.onrender.com";

const I24D_STATIC_TOKEN = process.env.I24D_TOKEN
  ?? proxyCfg.i24d?.token
  ?? "";

const I24D_DESKTOP_SESSION_URL = process.env.LUMINA_DESKTOP_SESSION_URL
  ?? luminaCfg.desktopSessionUrl
  ?? proxyCfg.i24d?.desktopSessionUrl
  ?? resolveI24DPath("/api/desktop/session");

const I24D_DESKTOP_ACTIVATION_KEY = process.env.LUMINA_DESKTOP_ACTIVATION_KEY
  ?? proxyCfg.i24d?.desktopActivationKey
  ?? "";

const PROXY_PORT       = parseInt(
  process.env.PROXY_PORT ?? luminaCfg.proxyPort ?? proxyCfg.proxy?.port ?? "4321",
  10,
);

const OPENCLAW_PORT    = parseInt(
  process.env.OPENCLAW_PORT ?? luminaCfg.gatewayPort ?? openclawCfg.gateway?.port ?? "18789",
  10
);

const OPENCLAW_TOKEN   = process.env.OPENCLAW_TOKEN
  ?? luminaCfg.gatewayToken
  ?? openclawCfg.gateway?.auth?.token
  ?? "";

const I24D_TIMEOUT_MS  = parseInt(process.env.I24D_TIMEOUT_MS ?? "45000", 10);
const I24D_WARMUP_TIMEOUT_MS = parseInt(process.env.I24D_WARMUP_TIMEOUT_MS ?? "8000", 10);
const I24D_RETRY_COUNT = Math.max(0, parseInt(process.env.I24D_RETRY_COUNT ?? "1", 10));
const LUMINA_PROGRESS_STREAMING_ENABLED =
  (process.env.LUMINA_PROGRESS_STREAMING_ENABLED ?? "1") !== "0";
const LUMINA_CODE_FAILOVER_ON_PROVIDER_ERROR =
  (process.env.LUMINA_CODE_FAILOVER_ON_PROVIDER_ERROR ?? "1") !== "0";
const I24D_KEEPWARM_INTERVAL_MS = Math.max(
  0,
  parseInt(process.env.I24D_KEEPWARM_INTERVAL_MS ?? "240000", 10),
);
const I24D_DEFAULT_MAX_TOKENS = Math.max(
  128,
  parseInt(process.env.I24D_DEFAULT_MAX_TOKENS ?? "1024", 10),
);
const I24D_WARMUP_ENABLED = (process.env.I24D_WARMUP_ENABLED ?? "1") !== "0";

const TOOL_RESULT_MODEL_CHAR_LIMIT = Math.max(
  1024,
  parseInt(process.env.LUMINA_TOOL_RESULT_MODEL_CHARS ?? String(5 * 1024), 10),
);
const TOOL_RESULT_STORAGE_CHAR_LIMIT = Math.max(
  TOOL_RESULT_MODEL_CHAR_LIMIT,
  parseInt(process.env.LUMINA_TOOL_RESULT_STORAGE_CHARS ?? String(20 * 1024), 10),
);
const TERMINAL_CAPTURE_CHAR_LIMIT = Math.max(
  1024,
  parseInt(process.env.LUMINA_TERMINAL_CAPTURE_CHARS ?? String(20 * 1024), 10),
);
const AGENT_TOOL_ITERATION_LIMIT_MESSAGE = "l\u00edmite alcanzado, dime c\u00f3mo continuar";

function stringifyForBudget(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactTextForBudget(text, { toolName, maxChars = TOOL_RESULT_MODEL_CHAR_LIMIT } = {}) {
  const source = String(text ?? "");
  const cap = Math.max(200, Number(maxChars) || TOOL_RESULT_MODEL_CHAR_LIMIT);
  if (source.length <= cap) return source;

  const noticeBudget = 220;
  const bodyBudget = Math.max(80, cap - noticeBudget);
  const headChars = Math.ceil(bodyBudget * 0.6);
  const tailChars = Math.max(40, bodyBudget - headChars);
  const omitted = Math.max(0, source.length - headChars - tailChars);
  const label = toolName ? ` for ${toolName}` : "";

  return [
    source.slice(0, headChars).trimEnd(),
    "",
    `[Lumina output guard${label}: compacted output for model; omitted ${omitted} chars from the middle.]`,
    "",
    source.slice(-tailChars).trimStart(),
  ].join("\n");
}

function compactToolResultForModel(value, { toolName, maxChars = TOOL_RESULT_MODEL_CHAR_LIMIT } = {}) {
  const text = stringifyForBudget(value);
  if (text.length <= maxChars) return value;
  return {
    ok: true,
    _compacted: true,
    tool: toolName,
    content: compactTextForBudget(text, { toolName, maxChars }),
  };
}

function compactContextItemsForStorage(value, { toolName, maxChars = TOOL_RESULT_STORAGE_CHAR_LIMIT } = {}) {
  const text = stringifyForBudget(value);
  if (text.length <= maxChars) return value;
  return {
    ok: true,
    _compacted: true,
    tool: toolName,
    content: compactTextForBudget(text, { toolName, maxChars }),
  };
}

function appendCappedTerminalOutput(current, chunk, maxChars = TERMINAL_CAPTURE_CHAR_LIMIT) {
  const next = `${current ?? ""}${chunk ?? ""}`;
  if (next.length <= maxChars) return next;
  const omitted = next.length - maxChars;
  const notice = `[Lumina output guard: kept last ${maxChars} chars; omitted ${omitted} earlier chars]\n`;
  const keptBudget = Math.max(0, maxChars - notice.length);
  return notice + next.slice(-keptBudget);
}

function capTerminalFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next = { ...value };
  if (typeof next.stdout === "string") next.stdout = appendCappedTerminalOutput("", next.stdout);
  if (typeof next.stderr === "string") next.stderr = appendCappedTerminalOutput("", next.stderr);
  return next;
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

const proxyHealth = {
  startedAt: new Date().toISOString(),
  i24dAuthMode: String(I24D_STATIC_TOKEN).trim() ? "static" : "desktop-session",
  i24dConfigured: Boolean(String(I24D_STATIC_TOKEN).trim() || I24D_DESKTOP_SESSION_URL),
  desktopSession: {
    url: I24D_DESKTOP_SESSION_URL,
    expiresAt: null,
    lastRefreshAt: null,
    lastError: null,
  },
  lastWarmup: null,
  keepWarmIntervalMs: I24D_KEEPWARM_INTERVAL_MS,
  lastChat: null,
  lastError: null,
};

// ── Tool result cache ─────────────────────────────────────────────────

/**
 * TTL in ms per tool. Entries expire after this duration.
 * Keeps responses fast by reusing recent results for repeated questions.
 */
const CACHE_TTL = {
  lumina_system_metrics:  15_000,   // 15 s — CPU/RAM change slowly
  lumina_process_list:    10_000,   // 10 s
  lumina_window_control:   5_000,   //  5 s — windows open/close fast
  lumina_clipboard:        5_000,   //  5 s — clipboard changes fast
  lumina_screen_capture:       0,   //  never cache screenshots
  lumina_file_ops:        30_000,   // 30 s for listings/reads
  lumina_code_write_file:      0,   //  never cache file writes
  lumina_code_run_command:     0,   //  never cache command runs
  lumina_code_open_path:       0,   //  never cache VS Code opens
  lumina_code_create_project:  0,   //  never cache project creation
};

// cache key → { result, expiresAt }
const toolCache = new Map();

function cacheKey(toolName, args) {
  return `${toolName}::${JSON.stringify(args ?? {})}`;
}

function getCached(toolName, args) {
  const ttl = CACHE_TTL[toolName] ?? 0;
  if (ttl === 0) return null;
  const entry = toolCache.get(cacheKey(toolName, args));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    toolCache.delete(cacheKey(toolName, args));
    return null;
  }
  return entry.result;
}

function setCache(toolName, args, result) {
  const ttl = CACHE_TTL[toolName] ?? 0;
  if (ttl === 0) return;
  toolCache.set(cacheKey(toolName, args), {
    result: compactContextItemsForStorage(result, { toolName }),
    expiresAt: Date.now() + ttl,
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBody(data) {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function authHeaders(token) {
  const trimmed = String(token ?? "").trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

function requestUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method ?? "GET";
    const body = options.body;
    const bodyStr = body === undefined || body === null
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const parsed  = new URL(url);
    const lib     = parsed.protocol === "https:" ? https : http;
    const started = Date.now();

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method,
        agent:    parsed.protocol === "https:" ? httpsAgent : httpAgent,
        headers:  {
          ...(bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {}),
          ...(options.headers ?? {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parseBody(data),
            durationMs: Date.now() - started,
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * POST to a full URL (http or https). Respects the supplied timeout.
 */
function postUrl(url, headers, body, timeoutMs = 15_000) {
  return requestUrl(url, { method: "POST", headers, body, timeoutMs });
}

function getUrl(url, headers = {}, timeoutMs = 15_000) {
  return requestUrl(url, { method: "GET", headers, timeoutMs });
}

function readOrCreateInstallationId() {
  try {
    const current = loadJson(luminaInstallationPath);
    if (typeof current?.installationId === "string" && current.installationId.trim()) {
      return current.installationId.trim();
    }
  } catch {
    // fall through and create a new non-secret installation id
  }

  const installationId = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(luminaHomeDir, { recursive: true });
    fs.writeFileSync(
      luminaInstallationPath,
      `${JSON.stringify({ installationId, createdAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // The id is not secret; if persistence fails, the in-memory id is still safe.
  }
  return installationId;
}

const DESKTOP_INSTALLATION_ID = readOrCreateInstallationId();
const DESKTOP_DEVICE_HASH = crypto
  .createHash("sha256")
  .update([os.hostname(), os.userInfo().username, os.platform(), os.arch()].join("|"))
  .digest("hex");
const DESKTOP_APP_VERSION = String(luminaCfg.version ?? proxyCfg.version ?? "1.0.9");
const SESSION_REFRESH_SKEW_MS = 90_000;
let desktopSession = {
  token: "",
  expiresAtMs: 0,
  inFlight: null,
};

function extractBearer(headers = {}) {
  const auth = String(headers.authorization ?? headers.Authorization ?? "");
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

function isPlaceholderProviderKey(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !normalized ||
    normalized === "dummy" ||
    normalized === "placeholder" ||
    normalized === "set-in-settings" ||
    normalized === "lumina-local-proxy";
}

async function refreshDesktopSessionToken() {
  if (!I24D_DESKTOP_SESSION_URL) {
    throw new Error("Lumina desktop session endpoint is not configured");
  }

  const headers = I24D_DESKTOP_ACTIVATION_KEY
    ? { "x-lumina-desktop-key": I24D_DESKTOP_ACTIVATION_KEY }
    : {};
  const response = await postUrl(
    I24D_DESKTOP_SESSION_URL,
    headers,
    {
      installationId: DESKTOP_INSTALLATION_ID,
      deviceHash: DESKTOP_DEVICE_HASH,
      appVersion: DESKTOP_APP_VERSION,
    },
    15_000,
  );

  if (response.status !== 200 || !response.body?.token) {
    const message =
      typeof response.body === "string"
        ? response.body.slice(0, 240)
        : response.body?.error ?? response.body?.message ?? "desktop session request failed";
    throw new Error(`HTTP ${response.status}: ${message}`);
  }

  let expiresAtMs = response.body.expiresAt
    ? Date.parse(response.body.expiresAt)
    : Date.now() + Math.max(300, Number(response.body.expiresInSeconds ?? 3600)) * 1000;
  if (!Number.isFinite(expiresAtMs)) {
    expiresAtMs = Date.now() + 3600 * 1000;
  }
  desktopSession = {
    token: String(response.body.token),
    expiresAtMs,
    inFlight: null,
  };
  proxyHealth.desktopSession.expiresAt = new Date(expiresAtMs).toISOString();
  proxyHealth.desktopSession.lastRefreshAt = new Date().toISOString();
  proxyHealth.desktopSession.lastError = null;
  return desktopSession.token;
}

async function getDesktopSessionToken() {
  if (desktopSession.token && Date.now() + SESSION_REFRESH_SKEW_MS < desktopSession.expiresAtMs) {
    return desktopSession.token;
  }
  if (!desktopSession.inFlight) {
    desktopSession.inFlight = refreshDesktopSessionToken()
      .catch((err) => {
        proxyHealth.desktopSession.lastError = {
          at: new Date().toISOString(),
          message: err instanceof Error ? err.message : String(err),
        };
        throw err;
      })
      .finally(() => {
        desktopSession.inFlight = null;
      });
  }
  return desktopSession.inFlight;
}

async function getI24DAuthorizationHeaders() {
  if (String(I24D_STATIC_TOKEN).trim()) {
    return authHeaders(I24D_STATIC_TOKEN);
  }
  const token = await getDesktopSessionToken();
  return authHeaders(token);
}

// ── Local code-development tools (executed in proxy, no OpenClaw call) ──

function invokeLocalCodeTool(toolName, args) {
  switch (toolName) {
    case "lumina_code_write_file": {
      const { path: filePath, content = "", openInVscode = true } = args;
      if (!filePath) return { ok: false, error: "path is required" };
      try {
        const dir = join(filePath, "..");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
        if (openInVscode) {
          const vscodePath = resolveVsCodeExecutable();
          if (vscodePath) spawnVsCodeGuiDetached(vscodePath, ["--reuse-window", filePath]);
        }
        return { ok: true, path: filePath, size: Buffer.byteLength(content), message: `Archivo guardado: ${filePath}` };
      } catch (err) {
        return { ok: false, error: err.message, path: filePath };
      }
    }

    case "lumina_code_run_command": {
      const { command, cwd, timeout = 30_000 } = args;
      if (!command) return { ok: false, error: "command is required" };
      try {
        const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "sh";
        const shellFlag = process.platform === "win32" ? "/c" : "-c";
        const result = spawnSync(shell, [shellFlag, command], {
          encoding: "utf8",
          timeout,
          cwd: cwd || os.homedir(),
          windowsHide: true,
        });
        return {
          ok: (result.status ?? 1) === 0,
          exitCode: result.status ?? 1,
          stdout: String(result.stdout ?? "").trim().slice(0, 4000),
          stderr: String(result.stderr ?? "").trim().slice(0, 1000),
          command,
          timedOut: result.signal === "SIGTERM",
        };
      } catch (err) {
        return { ok: false, error: err.message, command };
      }
    }

    case "lumina_code_open_path": {
      const { path: targetPath } = args;
      if (!targetPath) return { ok: false, error: "path is required" };
      try {
        const vscodePath = resolveVsCodeExecutable();
        if (!vscodePath) return { ok: false, error: "VS Code no encontrado. Instala VS Code 1.85 o superior." };
        spawnVsCodeGuiDetached(vscodePath, ["--reuse-window", targetPath]);
        return { ok: true, path: targetPath, message: `Abriendo en VS Code: ${targetPath}` };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "lumina_code_create_project": {
      const { path: projectPath, type = "generic", name = "mi-proyecto" } = args;
      const basePath = projectPath || join(os.homedir(), ".lumina", "workspace", name);
      try {
        fs.mkdirSync(basePath, { recursive: true });
        const files = buildProjectScaffold(type, name, basePath);
        for (const [filePath, content] of Object.entries(files)) {
          const dir = join(filePath, "..");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, content, "utf8");
        }
        const vscodePath = resolveVsCodeExecutable();
        if (vscodePath) {
          installLuminaCodeExtension(vscodePath, resolveLuminaCodeVsixPath() ?? "");
          spawnVsCodeGuiDetached(vscodePath, ["--reuse-window", basePath]);
        }
        return { ok: true, path: basePath, type, files: Object.keys(files), message: `Proyecto "${name}" creado en ${basePath}` };
      } catch (err) {
        return { ok: false, error: err.message, path: basePath };
      }
    }

    default:
      return null; // not a local tool — fall through to OpenClaw
  }
}

function buildProjectScaffold(type, name, basePath) {
  const files = {};
  switch (type) {
    case "python":
      files[join(basePath, "main.py")] = `# ${name}\n\ndef main():\n    print("Hola desde ${name}")\n\nif __name__ == "__main__":\n    main()\n`;
      files[join(basePath, "requirements.txt")] = "";
      files[join(basePath, "README.md")] = `# ${name}\n\nProyecto Python creado con Lumina.\n`;
      break;
    case "node":
      files[join(basePath, "index.js")] = `// ${name}\n\nconsole.log("Hola desde ${name}");\n`;
      files[join(basePath, "package.json")] = JSON.stringify({ name, version: "1.0.0", main: "index.js", scripts: { start: "node index.js" } }, null, 2) + "\n";
      files[join(basePath, "README.md")] = `# ${name}\n\nProyecto Node.js creado con Lumina.\n`;
      break;
    case "web":
      files[join(basePath, "index.html")] = `<!DOCTYPE html>\n<html lang="es">\n<head><meta charset="UTF-8"><title>${name}</title><link rel="stylesheet" href="style.css"></head>\n<body>\n  <h1>${name}</h1>\n  <script src="app.js"></script>\n</body>\n</html>\n`;
      files[join(basePath, "style.css")] = `body { font-family: sans-serif; margin: 2rem; }\n`;
      files[join(basePath, "app.js")] = `// ${name}\nconsole.log("${name} cargado");\n`;
      break;
    default:
      files[join(basePath, "README.md")] = `# ${name}\n\nProyecto creado con Lumina OpenClaw.\n`;
  }
  return files;
}

// ── Invoke a lumina tool via OpenClaw /tools/invoke ───────────────────

async function invokeTool(toolName, args) {
  // Local code-dev tools — executed directly without calling OpenClaw
  const localResult = invokeLocalCodeTool(toolName, args);
  if (localResult !== null) {
    console.log(`[proxy] local tool: ${toolName}`);
    return compactContextItemsForStorage(capTerminalFields(localResult), { toolName });
  }

  const normalizedArgs = normalizeToolArgs(toolName, args);

  // Return cached result if fresh
  const cached = getCached(toolName, normalizedArgs);
  if (cached) {
    console.log(`[proxy] cache hit: ${toolName}`);
    return cached;
  }

  try {
    const r = await postUrl(
      `http://127.0.0.1:${OPENCLAW_PORT}/tools/invoke`,
      { Authorization: `Bearer ${OPENCLAW_TOKEN}` },
      { tool: toolName, args: normalizedArgs ?? {} },
      15_000
    );

    const body = r.body;
    let result;

    // Unwrap OpenClaw envelope: { ok, result: { details, content } }
    if (body?.ok && body?.result?.details) {
      result = body.result.details;
    } else if (body?.result?.content?.[0]?.text) {
      try {
        result = JSON.parse(body.result.content[0].text);
      } catch {
        result = { _text: body.result.content[0].text };
      }
    } else {
      result = body;
    }

    result = compactContextItemsForStorage(capTerminalFields(result), { toolName });
    setCache(toolName, normalizedArgs, result);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function normalizeToolArgs(toolName, args = {}) {
  if (toolName !== "lumina_file_ops" || !args || typeof args !== "object") {
    return args ?? {};
  }
  const next = { ...args };
  if (typeof next.path === "string") {
    next.path = resolveLuminaFilePath(next.path);
  }
  if (typeof next.destination === "string") {
    next.destination = resolveLuminaFilePath(next.destination);
  }
  if (String(next.action ?? "").toLowerCase() === "list") {
    const rawLimit = Number.parseInt(String(next.limit ?? "200"), 10);
    const rawOffset = Number.parseInt(String(next.offset ?? "0"), 10);
    next.limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 200, 1), 500);
    next.offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
  }
  return next;
}

function resolveLuminaFilePath(filePath) {
  const value = String(filePath ?? "").trim();
  if (!value) return value;
  if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
    return value;
  }
  return resolve(LUMINA_WORKSPACE_PATH, value);
}

// ── Call I24D on Render ───────────────────────────────────────────────

const LUMINA_PC_CAPABILITY_MARKER = "LUMINA_OPENCLAW_LOCAL_TOOLS_V1";

function luminaPcCapabilityPrompt() {
  return [
    `[${LUMINA_PC_CAPABILITY_MARKER}]`,
    "You are Lumina running inside Lumina OpenClaw on Dal's Windows PC.",
    "You DO have local PC tools through the Lumina proxy. Do not claim that file tools, shell tools, screen tools, clipboard tools, or window tools are unavailable.",
    "",
    "Local tools available through the proxy:",
    "- lumina_file_ops: read, write, append, list, delete, move, copy, exists, stat files and folders.",
    "- lumina_system_metrics: inspect RAM, CPU, disk/system status.",
    "- lumina_process_list: list running processes.",
    "- lumina_window_control: list/focus windows.",
    "- lumina_clipboard: get/set clipboard text.",
    "- lumina_screen_capture: capture the primary screen.",
    "- lumina_shell_run: execute PowerShell/CMD when needed.",
    "",
    `Relative file paths resolve to Lumina's workspace: ${LUMINA_WORKSPACE_PATH}`,
    "If you need a local tool to complete the user's request, respond ONLY with this exact XML block and valid JSON:",
    "<LUMINA_TOOL_CALLS>",
    `[{"tool":"lumina_file_ops","args":{"action":"write","path":"IDENTITY.md","content":"..."}}]`,
    "</LUMINA_TOOL_CALLS>",
    "",
    "After tool results are returned, answer the user normally in Spanish.",
    "Use Lumina Code only for real software development/coding/project tasks. For normal OpenClaw operations, documents, PC control, research, security checks, files, screen, clipboard, and assistant identity, use OpenClaw/local tools.",
  ].join("\n");
}

function withLuminaPcCapabilityPrompt(messages = []) {
  const hasPrompt = messages.some(
    (message) =>
      (message?.role === "system" || message?.role === "developer") &&
      String(message?.content ?? "").includes(LUMINA_PC_CAPABILITY_MARKER),
  );
  if (hasPrompt) {
    return messages;
  }
  return [{ role: "system", content: luminaPcCapabilityPrompt() }, ...messages];
}

async function callI24D(messages, original, options = {}) {
  const payload = {
    model:      original.model ?? "I24D",
    messages:   withLuminaPcCapabilityPrompt(messages),
    max_tokens: original.max_tokens ?? I24D_DEFAULT_MAX_TOKENS,
    stream:     false,
  };
  if (original.temperature !== undefined) payload.temperature = original.temperature;

  let lastError = null;
  let lastResponse = null;
  for (let attempt = 0; attempt <= I24D_RETRY_COUNT; attempt += 1) {
    try {
      options.onStatus?.(
        `Consultando el modelo principal (${attempt + 1}/${I24D_RETRY_COUNT + 1}). Timeout: ${Math.round(I24D_TIMEOUT_MS / 1000)}s.`,
      );
      const response = await postUrl(I24D_URL, await getI24DAuthorizationHeaders(), payload, I24D_TIMEOUT_MS);
      proxyHealth.lastChat = {
        at: new Date().toISOString(),
        status: response.status ?? null,
        durationMs: response.durationMs ?? null,
        attempt: attempt + 1,
      };
      lastResponse = response;
      if (!shouldRetryI24D(response.status) || attempt >= I24D_RETRY_COUNT) {
        if (response.status !== 200) {
          proxyHealth.lastError = describeI24DError(response);
          options.onStatus?.(`El modelo principal respondio HTTP ${response.status}.`);
        }
        return response;
      }
      options.onStatus?.(`El modelo principal respondio HTTP ${response.status}. Reintentando.`);
    } catch (err) {
      lastError = err;
      proxyHealth.lastChat = {
        at: new Date().toISOString(),
        status: 0,
        durationMs: null,
        attempt: attempt + 1,
      };
      proxyHealth.lastError = {
        at: new Date().toISOString(),
        status: 0,
        message: err instanceof Error ? err.message : String(err),
      };
      options.onStatus?.(
        `El modelo principal no respondio: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
    await sleep(300 * (attempt + 1));
  }

  if (lastResponse) return lastResponse;
  const message = lastError instanceof Error ? lastError.message : "I24D request failed";
  return { status: 0, body: { error: "network_error", message } };
}

function shouldRetryI24D(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504, 522, 523, 524].includes(Number(status));
}

function describeI24DError(response) {
  const body = response?.body;
  const message =
    typeof body === "string"
      ? body.slice(0, 300)
      : body?.error?.message ?? body?.message ?? body?.error ?? "upstream error";
  return {
    at: new Date().toISOString(),
    status: response?.status ?? null,
    durationMs: response?.durationMs ?? null,
    message: String(message),
  };
}

// ── Provider keys (loaded from ~/.lumina/config.json or env) ─────────

const PROVIDER_KEYS = {
  openai:       process.env.OPENAI_API_KEY        ?? luminaCfg.openaiApiKey       ?? "",
  anthropic:    process.env.ANTHROPIC_API_KEY     ?? luminaCfg.anthropicApiKey    ?? "",
  gemini:       process.env.GEMINI_API_KEY        ?? luminaCfg.geminiApiKey       ?? "",
  deepseek:     process.env.DEEPSEEK_API_KEY      ?? luminaCfg.deepseekApiKey     ?? "",
  ollamaCloud:  process.env.OLLAMA_CLOUD_API_KEY  ?? luminaCfg.ollamaCloudApiKey  ?? "",
};

const FALLBACK_PROVIDER = (
  process.env.LUMINA_FALLBACK_PROVIDER
  ?? luminaCfg.fallbackProvider
  ?? "auto"
).toString().trim().toLowerCase();
const OPENAI_FALLBACK_MODEL = (
  process.env.LUMINA_OPENAI_MODEL
  ?? process.env.OPENAI_MODEL
  ?? luminaCfg.openaiModel
  ?? proxyCfg.openai?.model
  ?? "gpt-5.2"
).toString().trim();
const ANTHROPIC_FALLBACK_MODEL = (
  process.env.LUMINA_ANTHROPIC_MODEL
  ?? process.env.ANTHROPIC_MODEL
  ?? luminaCfg.anthropicModel
  ?? "claude-haiku-4-5-20251001"
).toString().trim();

const LUMINA_LEARN_URL = process.env.LUMINA_LEARN_URL
  ?? luminaCfg.luminaLearnUrl
  ?? "https://i24d-whatsapp-ai.onrender.com/lumina/learn";

function resolveI24DPath(pathname) {
  const base = I24D_MODELS_BASE.endsWith("/") ? I24D_MODELS_BASE : `${I24D_MODELS_BASE}/`;
  return new URL(pathname.replace(/^\/+/, ""), base).toString();
}

async function warmI24D(reason = "startup") {
  const started = Date.now();
  let headers = {};
  try {
    headers = await getI24DAuthorizationHeaders();
  } catch (err) {
    proxyHealth.lastError = {
      at: new Date().toISOString(),
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const checks = await Promise.allSettled([
    getUrl(resolveI24DPath("/health"), headers, I24D_WARMUP_TIMEOUT_MS),
    getUrl(resolveI24DPath("/v1/models"), headers, I24D_WARMUP_TIMEOUT_MS),
  ]);
  const normalized = checks.map((entry) => {
    if (entry.status === "fulfilled") {
      return {
        ok: Number(entry.value.status) >= 200 && Number(entry.value.status) < 500,
        status: entry.value.status ?? null,
        durationMs: entry.value.durationMs ?? null,
      };
    }
    return {
      ok: false,
      status: 0,
      durationMs: null,
      error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
    };
  });
  const ok = normalized.some((entry) => entry.ok);
  proxyHealth.lastWarmup = {
    at: new Date().toISOString(),
    reason,
    ok,
    durationMs: Date.now() - started,
    checks: normalized,
  };
  if (!ok) {
    proxyHealth.lastError = {
      at: new Date().toISOString(),
      status: 0,
      message: "I24D warmup failed",
    };
  }
  return proxyHealth.lastWarmup;
}

function startI24DKeepWarm() {
  if (!I24D_WARMUP_ENABLED || I24D_KEEPWARM_INTERVAL_MS <= 0) {
    return;
  }
  setInterval(() => {
    void warmI24D("keepwarm")
      .then((result) => {
        if (!result.ok) {
          console.warn(`[proxy] I24D keepwarm failed in ${result.durationMs}ms`);
        }
      })
      .catch((err) => {
        console.warn(`[proxy] I24D keepwarm error: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, I24D_KEEPWARM_INTERVAL_MS).unref?.();
}

function healthPayload() {
  return {
    ok: true,
    proxy: {
      port: PROXY_PORT,
      startedAt: proxyHealth.startedAt,
    },
    openclaw: {
      port: OPENCLAW_PORT,
      tokenConfigured: Boolean(String(OPENCLAW_TOKEN).trim()),
    },
    i24d: {
      url: I24D_URL,
      modelsBase: I24D_MODELS_BASE,
      desktopSessionUrl: I24D_DESKTOP_SESSION_URL,
      authMode: proxyHealth.i24dAuthMode,
      tokenConfigured: proxyHealth.i24dConfigured,
      session: {
        active: Boolean(desktopSession.token && Date.now() < desktopSession.expiresAtMs),
        expiresAt: proxyHealth.desktopSession.expiresAt,
        lastRefreshAt: proxyHealth.desktopSession.lastRefreshAt,
        lastError: proxyHealth.desktopSession.lastError,
      },
      timeoutMs: I24D_TIMEOUT_MS,
      retryCount: I24D_RETRY_COUNT,
      lastWarmup: proxyHealth.lastWarmup,
      lastChat: proxyHealth.lastChat,
      lastError: proxyHealth.lastError,
    },
    providers: {
      openaiConfigured: Boolean(PROVIDER_KEYS.openai),
      anthropicConfigured: Boolean(PROVIDER_KEYS.anthropic),
      geminiConfigured: Boolean(PROVIDER_KEYS.gemini),
      deepseekConfigured: Boolean(PROVIDER_KEYS.deepseek),
      fallbackProvider: FALLBACK_PROVIDER,
      openaiFallbackModel: OPENAI_FALLBACK_MODEL,
      anthropicFallbackModel: ANTHROPIC_FALLBACK_MODEL,
      progressStreaming: LUMINA_PROGRESS_STREAMING_ENABLED,
      luminaCodeFailover: LUMINA_CODE_FAILOVER_ON_PROVIDER_ERROR,
    },
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const TRUSTED_LUMINA_LOCAL_HOSTS = new Set([
  "",
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "lumina.localhost",
  "tauri.localhost",
]);

function isTrustedLuminaLocalHost(host) {
  const normalized = String(host ?? "").trim().toLowerCase();
  return TRUSTED_LUMINA_LOCAL_HOSTS.has(normalized) || normalized.endsWith(".localhost");
}

function isTrustedLuminaOrigin(origin) {
  if (!origin) {
    return true;
  }
  if (origin === "null") {
    // Some desktop WebViews/file-backed previews send the literal null origin.
    return true;
  }
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === "lumina:" || parsed.protocol === "tauri:") {
      return isTrustedLuminaLocalHost(host);
    }
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isTrustedLuminaLocalHost(host)
    );
  } catch {
    return false;
  }
}

function luminaCorsHeaders(req) {
  const origin = String(req.headers.origin ?? "");
  if (!origin || !isTrustedLuminaOrigin(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function sendLuminaJson(req, res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...luminaCorsHeaders(req),
  });
  res.end(JSON.stringify(body));
}

function rejectUntrustedLuminaOrigin(req, res) {
  const origin = String(req.headers.origin ?? "");
  if (isTrustedLuminaOrigin(origin)) {
    return false;
  }
  sendLuminaJson(req, res, 403, {
    ok: false,
    error: "origin_not_allowed",
    message: "Lumina Code can only be launched from the local Lumina desktop UI.",
  });
  return true;
}

const LUMINA_CODE_EXTENSION_ID = "i24d.lumina-code";
const LUMINA_CODE_EXTENSION_NAME = "Lumina Code";

function existingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveWhereCandidates(commandName) {
  if (process.platform !== "win32") {
    return [];
  }
  const result = spawnSync("where.exe", [commandName], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if ((result.status ?? 1) !== 0) {
    return [];
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeWindowsExecutableCandidates(candidates) {
  if (process.platform !== "win32") {
    return candidates;
  }
  const normalized = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    normalized.push(candidate);
    if (/\.[a-z0-9]+$/i.test(candidate)) continue;
    normalized.push(`${candidate}.cmd`, `${candidate}.exe`, `${candidate}.bat`);
  }
  return normalized;
}

function resolveVsCodeExecutable() {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "";
  const knownInstallCandidates = [
    process.env.LUMINA_VSCODE_PATH,
    process.env.VSCODE_PATH,
    localAppData && join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
    localAppData && join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
    programFiles && join(programFiles, "Microsoft VS Code", "Code.exe"),
    programFiles && join(programFiles, "Microsoft VS Code", "bin", "code.cmd"),
    programFilesX86 && join(programFilesX86, "Microsoft VS Code", "Code.exe"),
    programFilesX86 && join(programFilesX86, "Microsoft VS Code", "bin", "code.cmd"),
  ];
  return existingPath([
    ...normalizeWindowsExecutableCandidates(knownInstallCandidates),
    ...normalizeWindowsExecutableCandidates(resolveWhereCandidates("code")),
    ...normalizeWindowsExecutableCandidates(resolveWhereCandidates("code-insiders")),
  ]);
}

function resolveLuminaCodeVsixPath() {
  const explicitPath = existingPath([process.env.LUMINA_CODE_VSIX_PATH]);
  if (explicitPath) {
    return explicitPath;
  }
  const latestCandidate = [
    join(__dir, "..", "lumina-code"),
    join(__dir, "..", "..", "src", "lumina-code", "official", "extensions", "vscode", "build"),
    join(os.homedir(), ".lumina"),
  ]
    .map(findLatestLuminaCodeVsix)
    .filter(Boolean)
    .sort((left, right) =>
      compareLuminaCodeVersions(inferLuminaCodeVersion(right), inferLuminaCodeVersion(left)),
    )[0];
  return latestCandidate ?? existingPath([
    join(__dir, "..", "lumina-code", "lumina-code-0.1.0.vsix"),
    join(__dir, "..", "..", "src", "lumina-code", "extension", "lumina-code-0.1.0.vsix"),
    join(__dir, "..", "..", "src", "lumina-code", "official", "lumina-code-0.1.0.vsix"),
    join(__dir, "..", "..", "src", "lumina-code", "lumina-code-0.1.0.vsix"),
    join(os.homedir(), ".lumina", "lumina-code-0.1.0.vsix"),
  ]);
}

function compareLuminaCodeVersions(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function findLatestLuminaCodeVsix(directoryPath) {
  try {
    const candidates = fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^lumina-code-.+\.vsix$/i.test(entry.name))
      .map((entry) => join(directoryPath, entry.name))
      .sort((left, right) =>
        compareLuminaCodeVersions(inferLuminaCodeVersion(right), inferLuminaCodeVersion(left)),
      );
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

function resolveInstalledLuminaCodeExtension() {
  const candidates = [];
  for (const extensionsDir of [
    join(os.homedir(), ".vscode", "extensions"),
    join(os.homedir(), ".vscode-insiders", "extensions"),
  ]) {
    try {
      for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(/^i24d\.lumina-code-(.+)$/i);
        if (!match) continue;
        const extensionPath = join(extensionsDir, entry.name);
        const manifest = loadJson(join(extensionPath, "package.json"));
        const version =
          typeof manifest?.version === "string" && manifest.version.trim()
            ? manifest.version.trim()
            : match[1];
        candidates.push({ path: extensionPath, version });
      }
    } catch {
      // This VS Code channel has no installed extensions yet.
    }
  }
  return (
    candidates.sort((left, right) => compareLuminaCodeVersions(right.version, left.version))[0] ??
    null
  );
}

function resolveVsCodeRoot(vscodePath) {
  const normalized = String(vscodePath ?? "");
  if (!normalized) return null;
  if (/[\\/]bin[\\/]code(?:\.cmd)?$/i.test(normalized)) {
    return dirname(dirname(normalized));
  }
  if (/[\\/]Code\.exe$/i.test(normalized)) {
    return dirname(normalized);
  }
  return dirname(normalized);
}

function resolveVsCodeGuiExecutable(vscodePath) {
  const normalized = String(vscodePath ?? "");
  if (/[\\/]Code\.exe$/i.test(normalized) && fs.existsSync(normalized)) {
    return normalized;
  }
  const root = resolveVsCodeRoot(vscodePath);
  return root ? existingPath([join(root, "Code.exe")]) : null;
}

function resolveVsCodeCliPath(vscodePath) {
  const root = resolveVsCodeRoot(vscodePath);
  if (!root) return null;
  const direct = join(root, "resources", "app", "out", "cli.js");
  const versioned = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      versioned.push(join(root, entry.name, "resources", "app", "out", "cli.js"));
    }
  } catch {
    // Fall back to direct path only.
  }
  return existingPath([direct, ...versioned]);
}

function inferLuminaCodeVersion(vsixPath) {
  const fileName = vsixPath ? vsixPath.split(/[\\/]/).pop() ?? "" : "";
  const match = fileName.match(/^lumina-code-(.+)\.vsix$/i);
  return match?.[1] ?? null;
}

function resolveLuminaCodeWorkspace(body) {
  const requested =
    body && typeof body.workspacePath === "string" ? body.workspacePath.trim() : "";
  return requested || process.env.LUMINA_CODE_WORKSPACE || join(os.homedir(), ".lumina", "workspace");
}

function luminaCodeStatus(body = null) {
  const vscodePath = resolveVsCodeExecutable();
  const vsixPath = resolveLuminaCodeVsixPath();
  const installedExtension = resolveInstalledLuminaCodeExtension();
  const availableVersion = inferLuminaCodeVersion(vsixPath);
  const updateAvailable =
    Boolean(installedExtension && availableVersion) &&
    compareLuminaCodeVersions(availableVersion, installedExtension.version) > 0;
  const workspacePath = resolveLuminaCodeWorkspace(body);
  const ready = Boolean(vscodePath) && (Boolean(installedExtension) || Boolean(vsixPath));
  let message = "Lumina Code esta listo para abrirse en VS Code.";
  if (!vscodePath) {
    message = "No encontre VS Code. Instala VS Code 1.85 o superior y vuelve a intentar.";
  } else if (!installedExtension && !vsixPath) {
    message = "No encontre el paquete VSIX de Lumina Code dentro del runtime.";
  } else if (updateAvailable) {
    message = `Lumina Code ${availableVersion} se actualizara automaticamente al abrirse.`;
  }
  return {
    ok: ready,
    platform: process.platform,
    vscode: {
      available: Boolean(vscodePath),
      executablePath: vscodePath,
      displayName: "VS Code",
    },
    extension: {
      id: LUMINA_CODE_EXTENSION_ID,
      version: installedExtension?.version ?? availableVersion ?? "unknown",
      installedVersion: installedExtension?.version ?? null,
      installedPath: installedExtension?.path ?? null,
      availableVersion,
      vsixAvailable: Boolean(vsixPath),
      vsixPath,
      installed: Boolean(installedExtension),
      updateAvailable,
    },
    workspace: {
      path: workspacePath,
      exists: fs.existsSync(workspacePath),
    },
    message,
  };
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[ \t"&|<>^]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&")}"`;
}

function runCommandSync(command, args, options = {}) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command, ...args], {
      ...options,
      windowsHide: true,
    });
  }
  return spawnSync(command, args, { ...options, windowsHide: true });
}

function spawnCommandDetached(command, args) {
  let child;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  }
  child.unref();
}

function spawnVsCodeGuiDetached(vscodePath, args) {
  const executablePath = resolveVsCodeGuiExecutable(vscodePath) ?? vscodePath;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executablePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
}

function delegateToLuminaCodeWindow(
  vscodePath,
  workspacePath,
  delegationUri,
  installedExtensionPath,
) {
  const userDataDir = join(luminaHomeDir, "vscode-profile");
  const extensionsDir = installedExtensionPath
    ? dirname(installedExtensionPath)
    : join(os.homedir(), ".vscode", "extensions");
  fs.mkdirSync(userDataDir, { recursive: true });
  const profileArgs = [
    "--user-data-dir",
    userDataDir,
    "--extensions-dir",
    extensionsDir,
  ];

  spawnVsCodeGuiDetached(vscodePath, [
    ...profileArgs,
    "--new-window",
    workspacePath,
  ]);

  const deliveryTimer = setTimeout(() => {
    spawnVsCodeGuiDetached(vscodePath, [
      ...profileArgs,
      "--open-url",
      delegationUri,
    ]);
  }, 1200);
  deliveryTimer.unref();
}

function runVsCodeCli(vscodePath, args, options = {}) {
  const guiExecutable = resolveVsCodeGuiExecutable(vscodePath);
  const cliPath = resolveVsCodeCliPath(vscodePath);
  if (guiExecutable && cliPath) {
    return spawnSync(guiExecutable, [cliPath, ...args], {
      ...options,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        ELECTRON_RUN_AS_NODE: "1",
      },
      windowsHide: true,
    });
  }
  return runCommandSync(vscodePath, args, options);
}

function installLuminaCodeExtension(vscodePath, vsixPath) {
  const result = runVsCodeCli(vscodePath, ["--install-extension", vsixPath, "--force"], {
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.error) {
    throw new Error(`No pude iniciar VS Code para instalar Lumina Code: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    const details = [result.stderr, result.stdout]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `VS Code no pudo instalar Lumina Code (exit ${result.status ?? 1}).${details ? ` ${details}` : ""}`,
    );
  }
}

function openLuminaCode(body = null) {
  const status = luminaCodeStatus(body);
  if (!status.vscode.available || !status.vscode.executablePath) {
    return { statusCode: 404, body: status };
  }
  if (!status.ok) {
    // Extension not installed and no VSIX to install from
    return { statusCode: 404, body: status };
  }
  fs.mkdirSync(status.workspace.path, { recursive: true });
  if (
    (!status.extension.installed || status.extension.updateAvailable) &&
    status.extension.vsixAvailable &&
    status.extension.vsixPath
  ) {
    installLuminaCodeExtension(status.vscode.executablePath, status.extension.vsixPath);
  }
  spawnVsCodeGuiDetached(status.vscode.executablePath, ["--reuse-window", status.workspace.path]);
  const refreshedStatus = luminaCodeStatus(body);
  return {
    statusCode: 200,
    body: {
      ok: true,
      status: refreshedStatus,
      message: `${LUMINA_CODE_EXTENSION_NAME} fue instalado/verificado y VS Code se esta abriendo.`,
    },
  };
}

function delegateToLuminaCode(body = null) {
  const instruction =
    body && typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "instruction_required",
        message: "La instruccion de desarrollo para Lumina Code es obligatoria.",
      },
    };
  }
  if (instruction.length > 100_000) {
    return {
      statusCode: 413,
      body: {
        ok: false,
        error: "instruction_too_long",
        message: "La instruccion de desarrollo supera el limite permitido.",
      },
    };
  }

  const status = luminaCodeStatus(body);
  if (!status.vscode.available || !status.vscode.executablePath || !status.ok) {
    return { statusCode: 404, body: status };
  }

  fs.mkdirSync(status.workspace.path, { recursive: true });
  const opensAfterExtensionUpdate =
    (!status.extension.installed || status.extension.updateAvailable) &&
    status.extension.vsixAvailable &&
    status.extension.vsixPath;
  if (
    opensAfterExtensionUpdate
  ) {
    installLuminaCodeExtension(status.vscode.executablePath, status.extension.vsixPath);
  }
  const refreshedStatus = luminaCodeStatus(body);

  const delegationId = crypto.randomUUID();
  const delegationDir = join(luminaHomeDir, "delegations");
  const handoffPath = join(delegationDir, `${delegationId}.json`);
  fs.mkdirSync(delegationDir, { recursive: true });
  fs.writeFileSync(
    handoffPath,
    JSON.stringify(
      {
        id: delegationId,
        source: "Lumina OpenClaw",
        instruction,
        workspacePath: status.workspace.path,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const delegationUri =
    `vscode://${LUMINA_CODE_EXTENSION_ID}/lumina-delegate?handoff=` +
    encodeURIComponent(handoffPath);
  // Keep delegated work in Lumina's VS Code profile so a previously open
  // extension host cannot keep an older integration loaded.
  delegateToLuminaCodeWindow(
    status.vscode.executablePath,
    status.workspace.path,
    delegationUri,
    refreshedStatus.extension.installedPath,
  );

  return {
    statusCode: 200,
    body: {
      ok: true,
      delegated: true,
      delegationId,
      workspace: status.workspace,
      extension: {
        id: refreshedStatus.extension.id,
        installedVersion:
          refreshedStatus.extension.installedVersion ?? refreshedStatus.extension.availableVersion,
      },
      message: "La tarea fue enviada a Lumina Code en VS Code.",
    },
  };
}

async function delegateFromLuminaCodeToOpenClaw(body = null) {
  const instruction =
    body && typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "instruction_required",
        message: "La instruccion para Lumina OpenClaw es obligatoria.",
      },
    };
  }
  if (instruction.length > 100_000) {
    return {
      statusCode: 413,
      body: {
        ok: false,
        error: "instruction_too_long",
        message: "La instruccion supera el limite permitido.",
      },
    };
  }

  const context =
    body && typeof body.context === "string" ? body.context.trim() : "";
  const workspace =
    body && typeof body.workspace === "object" ? body.workspace : null;
  const userContent = [
    "Tarea delegada por Lumina Code.",
    "",
    "Instruction:",
    instruction,
    context ? `\nContext:\n${context}` : "",
    workspace ? `\nVS Code workspace:\n${JSON.stringify(workspace, null, 2)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const messages = [
    {
      role: "system",
      content: [
        "You are Lumina OpenClaw receiving a delegated operational task from Lumina Code.",
        "Treat this as a normal local OpenClaw user instruction.",
        "Use OpenClaw/local PC tools for apps, browser, Gmail, windows, files, documents, device control, research, and general assistant workflows.",
        "Do not route this back to Lumina Code unless the task is explicitly software development, coding, build, test, or repository work.",
        "Answer in the user's language and report clearly what was done or what blocked execution.",
      ].join("\n"),
    },
    { role: "user", content: userContent },
  ];

  const requestBody = {
    model: body?.model ?? "I24D",
    messages,
    stream: false,
    max_tokens: body?.max_tokens ?? I24D_DEFAULT_MAX_TOKENS,
    luminaCodeDelegation: true,
  };
  const completion = await resolvePrimaryCompletion(messages, requestBody);
  const response = completion?.choices?.[0]?.message?.content ?? "";

  return {
    statusCode: 200,
    body: {
      ok: true,
      delegated: true,
      endpoint: "/__lumina/openclaw/delegate",
      response,
      completion,
      message: "La tarea fue recibida por Lumina OpenClaw.",
    },
  };
}

// ── Fire learning signal to Lumina (best-effort, non-blocking) ────────

function fireLearningSignal(provider, messages, response) {
  const body = JSON.stringify({ provider, messages, response });
  const target = new URL(LUMINA_LEARN_URL);
  const lib = target.protocol === "https:" ? https : http;

  const req = lib.request({
    hostname: target.hostname,
    port:     target.port || (target.protocol === "https:" ? 443 : 80),
    path:     target.pathname,
    method:   "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 8_000,
  });
  req.on("error", () => {});  // silence — learning is best-effort
  req.write(body);
  req.end();
}

// ── Generic provider proxy (forward + intercept) ──────────────────────

/**
 * Forward a chat-completions request to an external provider, then
 * fire a non-blocking learning signal to Lumina with the exchange.
 */
async function proxyExternalProvider(providerName, targetUrl, apiKey, body, res) {
  const isStreaming = body.stream === true;

  // Always request non-streaming from the upstream — simplifies interception.
  // We re-stream back to the client ourselves after capturing the response.
  const upstreamBody = { ...body, stream: false };

  let upstreamResponse;
  try {
    upstreamResponse = await postUrl(
      targetUrl,
      authHeaders(apiKey),
      upstreamBody,
      60_000
    );
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_error", message: err.message }));
    }
    return;
  }

  if (upstreamResponse.status !== 200) {
    if (!res.headersSent) {
      res.writeHead(upstreamResponse.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamResponse.body));
    }
    return;
  }

  const upstreamBody2 = upstreamResponse.body;

  // Fire learning signal asynchronously — do not await
  fireLearningSignal(providerName, body.messages ?? [], upstreamBody2);
  console.log(`[proxy] ✦ learning signal fired for provider: ${providerName}`);

  // Return to client (re-streaming if needed)
  sendResponse(res, upstreamBody2, isStreaming);
}

// ── Intent detection ──────────────────────────────────────────────────

/**
 * Each intent maps a regex to one or more tool calls.
 * Patterns are tested against the full user message (case-insensitive).
 * More specific patterns are listed first to avoid false positives.
 */
const INTENTS = [
  // ── System metrics (RAM / CPU / disk / uptime / specs) ────────────
  {
    re: /\b(ram|memory|memoria|cpu|processor|procesador|disk\s*space|espacio\s*en\s*disco|uptime|battery|bater[ií]a|specs?|especificaciones|hardware|rendimiento del sistema|system\s*info|info\s*del\s*sistema)\b/i,
    tools: [{ name: "lumina_system_metrics", args: {} }],
    label: "system metrics",
  },

  // ── Process list (running apps / task manager) ────────────────────
  {
    re: /\b(qu[eé]\s+(programas?|aplicaciones?|procesos?|apps?)\s+(est[aá]n?\s+)?(corriendo|abiertos?|ejecut[aá]ndose|running)|(programas?|aplicaciones?|procesos?|apps?)\s+(est[aá]n?\s+)?(corriendo|ejecut[aá]ndose|abiertos?)|procesos?\s+(activos?|en\s+ejecuci[oó]n)|(running|open|active)\s+(processes?|apps?|programs?|applications?)|(processes?|apps?|programs?|applications?)\s+(are\s+)?(currently\s+)?running|task\s*manager|administrador\s*de\s*tareas|what\s+(programs?|apps?|processes?|applications?)|which\s+(apps?|programs?|processes?)\s+(are\s+)?running)\b/i,
    tools: [{ name: "lumina_process_list", args: {} }],
    label: "process list",
  },

  // ── Open windows (what windows are visible) ───────────────────────
  {
    re: /\b(ventanas?\s+abiertas?|open\s+windows?|qu[eé]\s+ventanas?|what\s+windows?|which\s+windows?|windows?\s+list|windows?\s+(do\s+i\s+have\s+)?open|lista\s+de\s+ventanas?|focused\s+window|ventana\s+activa|active\s+window|show\s+(me\s+)?(the\s+)?windows?)\b/i,
    tools: [{ name: "lumina_window_control", args: { action: "list" } }],
    label: "window list",
  },

  // ── Clipboard ─────────────────────────────────────────────────────
  {
    re: /\b(portapapeles|clipboard|qu[eé]\s+(cop[ié]|tengo\s+copiado)|what\s+(did\s+i\s+copy|is\s+in\s+(my\s+)?clipboard)|show\s+(me\s+)?clipboard|contenido\s+copiado)\b/i,
    tools: [{ name: "lumina_clipboard", args: { action: "get" } }],
    label: "clipboard",
  },

  // ── Screenshot ────────────────────────────────────────────────────
  {
    re: /\b(screenshot|toma\s+(una\s+)?captura|captura\s+de\s+pantalla|take\s+a\s+screenshot|capture\s+(my\s+)?screen|foto\s+de\s+la\s+pantalla|qu[eé]\s+se\s+ve\s+en\s+pantalla|what[''s]*\s+on\s+(my\s+)?screen)\b/i,
    tools: [{ name: "lumina_screen_capture", args: { return_image: false } }],
    label: "screen capture",
  },

  // ── File read — extract path from message ─────────────────────────
  {
    re: /\b(lee\s+el\s+archivo|read\s+(the\s+)?file|open\s+(the\s+)?file|muéstrame\s+el\s+archivo|show\s+(me\s+)?(?:the\s+)?file|contenido\s+de[l]?\s+archivo|what[''s]*\s+in\s+(?:the\s+)?file)\b.*?([a-zA-Z]:\\[\w\\.\- ]+\.\w+|\/[\w\/.\- ]+\.\w+)/i,
    extractPath: (msg) => {
      const m = msg.match(/([a-zA-Z]:\\[\w\\.\- ]+\.\w+|\/[\w\/.\- ]+\.\w+)/);
      return m ? m[1] : null;
    },
    tools: (path) => [{ name: "lumina_file_ops", args: { action: "read", path } }],
    label: "file read",
  },

  // ── Directory list — extract path from message ────────────────────
  {
    re: /\b(lista\s+(el\s+)?directorio|list\s+(the\s+)?(directory|folder|contents?\s+of)|listar\s+carpeta|qu[eé]\s+hay\s+en\s+la\s+carpeta|contenido\s+de\s+la\s+carpeta|show\s+(me\s+)?(the\s+)?folder)\b.*?([a-zA-Z]:\\[\w\\ .\-]*|\/[\w\/ .\-]+)/i,
    extractPath: (msg) => {
      const m = msg.match(/([a-zA-Z]:\\[\w\\ .\-]*|\/[\w\/ .\-]+)/);
      return m ? m[1] : null;
    },
    tools: (path) => [{ name: "lumina_file_ops", args: { action: "list", path } }],
    label: "dir list",
  },

  // ── Open VS Code — extract path from message ──────────────────────
  {
    re: /\b(abr[ei]r?\s+(en\s+)?vscode|open\s+(in\s+)?vscode|abre\s+(en\s+)?vs\s*code|open\s+(in\s+)?vs\s*code)\b.*?([a-zA-Z]:\\[\w\\ .\-]*|\/[\w\/ .\-]+)/i,
    extractPath: (msg) => {
      const m = msg.match(/([a-zA-Z]:\\[\w\\ .\-]*|\/[\w\/ .\-]+)/);
      return m ? m[1] : null;
    },
    tools: (path) => [{ name: "lumina_code_open_path", args: { path } }],
    label: "open vscode",
  },
];

/**
 * Returns an array of { label, toolCalls[] } for all matched intents.
 * Path-based intents are skipped if no valid path can be extracted.
 */
function detectIntents(message) {
  const matched = [];
  for (const intent of INTENTS) {
    if (!intent.re.test(message)) continue;

    if (intent.extractPath) {
      const p = intent.extractPath(message);
      if (!p) continue;
      matched.push({
        label: intent.label,
        toolCalls: intent.tools(p),
      });
    } else {
      matched.push({
        label: intent.label,
        toolCalls: intent.tools,
      });
    }
  }
  return matched;
}

const AUTO_DELEGATION_DEDUPE_MS = 15_000;
const recentAutoDelegations = new Map();

function autoDelegateDevelopmentRequest(instruction) {
  const now = Date.now();
  const key = crypto.createHash("sha256").update(instruction).digest("hex");
  for (const [existingKey, entry] of recentAutoDelegations) {
    if (now - entry.createdAt > AUTO_DELEGATION_DEDUPE_MS) {
      recentAutoDelegations.delete(existingKey);
    }
  }
  const existing = recentAutoDelegations.get(key);
  if (existing) {
    return existing.result;
  }

  const result = delegateToLuminaCode({ instruction });
  if (result.statusCode === 200) {
    recentAutoDelegations.set(key, { createdAt: now, result });
  }
  return result;
}

function respondWithAutomaticLuminaCodeDelegation(res, body, liveStream = null) {
  const instruction = lastUserMessage(body.messages ?? []);
  if (!shouldRouteToLuminaCode(instruction)) {
    return false;
  }

  console.log("[proxy] routing development request to Lumina Code");
  liveStream?.status("La orden es de desarrollo. Delegando a Lumina Code en VS Code.");
  const delegation = autoDelegateDevelopmentRequest(instruction);
  const message =
    delegation.statusCode === 200
      ? `He enviado tu solicitud a Lumina Code en VS Code. Ya esta trabajando en ${
          delegation.body?.workspace?.path ?? "el workspace configurado"
        }.`
      : delegation.body?.message ??
        "No pude abrir Lumina Code para ejecutar esta solicitud de desarrollo.";

  sendFinalResponse(res, makeResponse(message, body), body.stream === true, liveStream);
  return true;
}

// ── Format tool results as readable context ───────────────────────────

function formatResult(toolName, result) {
  if (!result) return `[${toolName}: no result]`;

  if (result._compacted && typeof result.content === "string") {
    return `[${toolName} compacted]\n${result.content}`;
  }

  // Surface any error message cleanly
  if (result.ok === false) {
    const msg = typeof result.error === "object"
      ? (result.error?.message ?? JSON.stringify(result.error))
      : String(result.error ?? "unknown error");
    return `[${toolName} error: ${msg}]`;
  }

  switch (toolName) {
    case "lumina_system_metrics": {
      const m = result.memory ?? {};
      const c = result.cpu    ?? {};
      const s = result.system ?? {};
      return [
        `[System metrics — ${result.timestamp ?? new Date().toISOString()}]`,
        `RAM   : ${m.total ?? "?"} total | ${m.used ?? "?"} used (${m.usage_pct ?? "?"}%) | ${m.free ?? "?"} free`,
        `CPU   : ${c.model?.trim() ?? "?"} | ${c.cores ?? "?"} cores | ${c.usage_pct ?? "?"}% usage`,
        `Uptime: ${s.uptime_human ?? "?"} | Host: ${s.hostname ?? "?"} | ${s.platform ?? "?"} ${s.arch ?? ""}`,
      ].join("\n");
    }

    case "lumina_process_list": {
      const procs = Array.isArray(result) ? result : (result.processes ?? []);
      if (procs.length === 0) return "[No processes found]";
      const lines = procs.slice(0, 20).map((p) => {
        const name = p.name ?? p.ProcessName ?? "?";
        const pid  = p.pid  ?? p.Id          ?? "?";
        const cpu  = p.cpu  ?? p.CPU         ?? "";
        const mem  = p.memory ?? p.WorkingSet ?? "";
        return `  ${name} (PID ${pid})${cpu ? ` CPU:${cpu}%` : ""}${mem ? ` MEM:${mem}` : ""}`;
      });
      return `[Running processes — top ${Math.min(20, procs.length)} of ${procs.length}]\n${lines.join("\n")}`;
    }

    case "lumina_window_control": {
      const wins = result.windows ?? result.list ?? (Array.isArray(result) ? result : []);
      if (wins.length === 0) return "[No open windows found]";
      const lines = wins.slice(0, 15).map((w) => {
        const title   = w.title ?? w.name ?? "Untitled";
        const process = w.process ?? w.ProcessName ?? "";
        const pid     = w.pid ?? w.handle ?? "";
        return `  ${title}${process ? ` [${process}]` : ""}${pid ? ` PID:${pid}` : ""}`;
      });
      return `[Open windows — ${wins.length} found]\n${lines.join("\n")}`;
    }

    case "lumina_clipboard": {
      const text = result.text ?? result.content ?? result._text ?? JSON.stringify(result);
      return `[Clipboard content]\n${compactTextForBudget(text, { toolName, maxChars: TOOL_RESULT_MODEL_CHAR_LIMIT })}`;
    }

    case "lumina_screen_capture": {
      if (result.ok === false) return `[Screenshot failed: ${result.error ?? "unknown error"}]`;
      const loc  = result.path ?? result.file ?? result.savedTo ?? "unknown";
      const res  = result.resolution ? ` (${result.resolution})` : "";
      const ts   = result.timestamp ? ` at ${result.timestamp}` : "";
      return `[Screenshot captured${res}${ts} → ${loc}]\nThe screenshot was saved. I cannot view image files directly, but the screenshot was successfully taken.`;
    }

    case "lumina_file_ops": {
      // Directory listing
      if (result.entries !== undefined) {
        const items = (result.entries ?? []).map((e) =>
          `  [${(e.type ?? "?").padEnd(6)}] ${e.name}`
        );
        return `[Directory: ${result.path ?? ""} — ${result.count ?? 0} items]\n${items.join("\n")}`;
      }
      // File read
      if (result.content !== undefined) {
        const preview   = String(result.content).slice(0, 3000);
        const truncated = String(result.content).length > 3000 ? "\n[...truncated — file is larger]" : "";
        return `[File: ${result.path ?? ""}]\n${preview}${truncated}`;
      }
      // stat / exists / other
      return `[File op result]\n${JSON.stringify(result, null, 2)}`;
    }

    case "lumina_shell_run": {
      const exitCode = result.exit_code ?? "?";
      const parts = [`[Shell — exit ${exitCode}]`];
      if (result.stdout) parts.push(`STDOUT:\n${appendCappedTerminalOutput("", result.stdout)}`);
      if (result.stderr) parts.push(`STDERR:\n${appendCappedTerminalOutput("", result.stderr)}`);
      return parts.join("\n");
    }

    case "lumina_notify_toast": {
      return `[Toast notification sent: "${result.message ?? result.title ?? ""}"]`;
    }

    case "lumina_code_write_file": {
      const path = result.path ?? "?";
      const opened = result.openedInVscode ? " — opened in VS Code" : "";
      return `[File written: ${path}${opened}]`;
    }

    case "lumina_code_run_command": {
      const exitCode = result.exit_code ?? result.exitCode ?? "?";
      const parts = [`[Command — exit ${exitCode}]`];
      if (result.stdout) parts.push(`STDOUT:\n${appendCappedTerminalOutput("", result.stdout)}`);
      if (result.stderr) parts.push(`STDERR:\n${appendCappedTerminalOutput("", result.stderr)}`);
      return parts.join("\n");
    }

    case "lumina_code_open_path": {
      const path = result.path ?? "?";
      return `[VS Code opened: ${path}]`;
    }

    case "lumina_code_create_project": {
      const name = result.name ?? "?";
      const dir  = result.dir  ?? "?";
      const files = Array.isArray(result.files) ? result.files : [];
      const fileList = files.length > 0 ? `\n  ${files.join("\n  ")}` : "";
      return `[Project created: ${name} → ${dir}${fileList}]`;
    }

    default:
      return `[${toolName}]\n${compactTextForBudget(JSON.stringify(result, null, 2), { toolName })}`;
  }
}

// ── Slash command parser ──────────────────────────────────────────────

function parseSlashCommand(message) {
  const m = message.trim();

  if (/^\/metrics?\b/i.test(m) || /^\/sysinfo\b/i.test(m))
    return { type: "auto", tool: "lumina_system_metrics", args: {} };

  if (/^\/ps\b/i.test(m) || /^\/processes?\b/i.test(m))
    return { type: "auto", tool: "lumina_process_list", args: {} };

  if (/^\/windows?\b/i.test(m))
    return { type: "auto", tool: "lumina_window_control", args: { action: "list" } };

  if (/^\/screen(shot)?\b/i.test(m))
    return { type: "auto", tool: "lumina_screen_capture", args: { return_image: false } };

  if (/^\/clip(board)?\b/i.test(m))
    return { type: "auto", tool: "lumina_clipboard", args: { action: "get" } };

  const fileRead = m.match(/^\/file\s+read\s+(.+)/i);
  if (fileRead)
    return { type: "auto", tool: "lumina_file_ops", args: { action: "read",   path: fileRead[1].trim() } };

  const fileList = m.match(/^\/file\s+list\s+(.+)/i);
  if (fileList)
    return { type: "auto", tool: "lumina_file_ops", args: { action: "list",   path: fileList[1].trim() } };

  const fileStat = m.match(/^\/file\s+stat\s+(.+)/i);
  if (fileStat)
    return { type: "auto", tool: "lumina_file_ops", args: { action: "stat",   path: fileStat[1].trim() } };

  const fileWrite = m.match(/^\/file\s+write\s+(\S+)\s+([\s\S]+)/i);
  if (fileWrite)
    return { type: "approval", tool: "lumina_file_ops",
             args: { action: "write", path: fileWrite[1].trim(), content: fileWrite[2] },
             description: `Write to: ${fileWrite[1].trim()}` };

  const fileDel = m.match(/^\/file\s+delete\s+(.+)/i);
  if (fileDel)
    return { type: "approval", tool: "lumina_file_ops",
             args: { action: "delete", path: fileDel[1].trim() },
             description: `Delete: ${fileDel[1].trim()}` };

  const fileMove = m.match(/^\/file\s+move\s+(\S+)\s+(\S+)/i);
  if (fileMove)
    return { type: "approval", tool: "lumina_file_ops",
             args: { action: "move", path: fileMove[1].trim(), destination: fileMove[2].trim() },
             description: `Move: ${fileMove[1].trim()} → ${fileMove[2].trim()}` };

  const shellCmd = m.match(/^\/(?:shell|run|powershell)\s+([\s\S]+)/i);
  if (shellCmd)
    return { type: "approval", tool: "lumina_shell_run",
             args: { command: shellCmd[1].trim() },
             description: `Run: ${shellCmd[1].trim()}` };

  const notifyCmd = m.match(/^\/notify\s+([\s\S]+)/i);
  if (notifyCmd)
    return { type: "auto", tool: "lumina_notify_toast",
             args: { title: "Lumina", message: notifyCmd[1].trim() } };

  // ── Lumina Code dev tools ──────────────────────────────────────────────
  const codeWrite = m.match(/^\/(?:code\s+write|write|guardar)\s+(\S+)\s+([\s\S]+)/i);
  if (codeWrite)
    return { type: "auto", tool: "lumina_code_write_file",
             args: { path: codeWrite[1].trim(), content: codeWrite[2], openInVscode: true } };

  const codeOpen = m.match(/^\/(?:open|abrir|vscode)\s+(.+)/i);
  if (codeOpen)
    return { type: "auto", tool: "lumina_code_open_path",
             args: { path: codeOpen[1].trim() } };

  const codeRun = m.match(/^\/(?:code\s+run|run|ejecutar)\s+([\s\S]+)/i);
  if (codeRun)
    return { type: "approval", tool: "lumina_code_run_command",
             args: { command: codeRun[1].trim() },
             description: `Ejecutar: ${codeRun[1].trim()}` };

  const projectCreate = m.match(/^\/project\s+(?:create|crear|new|nuevo)\s*(?:(python|node|web)\s*)?(.+)?/i);
  if (projectCreate) {
    const type = (projectCreate[1] ?? "generic").toLowerCase();
    const name = (projectCreate[2] ?? "mi-proyecto").trim().replace(/\s+/g, "-");
    return { type: "auto", tool: "lumina_code_create_project",
             args: { type, name } };
  }

  return null;
}

// ── Approval helpers ──────────────────────────────────────────────────

const APPROVAL_SENTINEL_RE = /\[LUMINA_PENDING:([A-Za-z0-9_-]+|\{[\s\S]*\})\]/;
const APPROVE_RE = /^\s*(approve|yes|s[i\u00ed]|autorizo|ok|confirm|adelante|go\s+ahead|ejecuta|run\s+it)\s*$/i;
const DENY_RE    = /^\s*(no|cancel|deny|nope|cancelar|abort)\s*$/i;

function encodePendingApproval(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePendingApproval(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    return JSON.parse(text);
  }
  return JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
}

function extractPendingApproval(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const match = String(messages[i].content ?? "").match(APPROVAL_SENTINEL_RE);
    if (match) {
      try { return decodePendingApproval(match[1]); } catch { /* ignore */ }
    }
  }
  return null;
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "user") return String(messages[i].content ?? "");
  return "";
}

// ── Compose response helpers ──────────────────────────────────────────

function makeResponse(content, original) {
  return {
    id:      `chatcmpl-proxy-${Date.now()}`,
    object:  "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model:   original.model ?? "I24D",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage:   { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function createLiveChatStream(res, original) {
  if (!LUMINA_PROGRESS_STREAMING_ENABLED || res.headersSent) {
    return null;
  }

  const id = `chatcmpl-proxy-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = original.model ?? "I24D";
  const base = { id, object: "chat.completion.chunk", created, model };
  let closed = false;
  let emittedContent = false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (obj) => {
    if (!closed) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  const emitContent = (content) => {
    const text = String(content ?? "");
    if (!text) return;
    emittedContent = true;
    const chunkSize = 80;
    for (let i = 0; i < text.length; i += chunkSize) {
      emit({
        ...base,
        choices: [{ index: 0, delta: { content: text.slice(i, i + chunkSize) }, finish_reason: null }],
      });
    }
  };

  emit({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  return {
    status(message) {
      emitContent(`[Lumina] ${message}\n`);
    },
    finish(body) {
      const content = body?.choices?.[0]?.message?.content ?? "";
      emitContent(`${emittedContent ? "\n" : ""}${content}`);
      emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: body?.usage });
      res.write("data: [DONE]\n\n");
      closed = true;
      res.end();
    },
  };
}

function sendFinalResponse(res, body, isStreaming, liveStream) {
  if (liveStream) {
    liveStream.finish(body);
    return;
  }
  sendResponse(res, body, isStreaming);
}

function makeI24DDiagnosticResponse(i24d, original) {
  const status = Number(i24d?.status ?? 0);
  const body = i24d?.body;
  const upstreamMessage =
    typeof body === "string"
      ? body.slice(0, 240)
      : body?.error?.message ?? body?.message ?? body?.error ?? "";

  if (status === 401 || status === 403) {
    return makeResponse(
      [
        "Lumina OpenClaw esta abierto y el gateway local esta funcionando.",
        "",
        "Lumina IA no pudo iniciar la sesion segura con el cerebro central.",
        "Revisa tu conexion a internet o reinicia Lumina. No necesitas instalar ni configurar tokens manualmente.",
        "",
        `Detalle tecnico: HTTP ${status}${upstreamMessage ? ` - ${upstreamMessage}` : ""}`,
      ].join("\n"),
      original,
    );
  }

  return makeResponse(
    [
      "Lumina OpenClaw esta funcionando, pero el cerebro I24D no respondio correctamente.",
      "El proxy local ya intento reconectar y calentar el backend.",
      "",
      `Detalle tecnico: ${status ? `HTTP ${status}` : "sin respuesta de red"}${upstreamMessage ? ` - ${upstreamMessage}` : ""}`,
    ].join("\n"),
    original,
  );
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

function normalizeMessagesForAnthropic(messages) {
  const system = [];
  const out = [];
  for (const message of messages ?? []) {
    const role = message?.role;
    if (role === "system" || role === "developer") {
      const text = messageContentToText(message?.content).trim();
      if (text) system.push(text);
      continue;
    }
    // Tool result desde OpenAI: role:"tool", tool_call_id:"...", content:"..."
    if (role === "tool") {
      const tool_use_id = message.tool_call_id;
      const text = messageContentToText(message?.content);
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id, content: text }],
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    // Assistant con tool_calls — convertir cada tool_call en bloque tool_use.
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks = [];
      const txt = messageContentToText(message?.content).trim();
      if (txt) blocks.push({ type: "text", text: txt });
      for (const tc of message.tool_calls) {
        let input = {};
        try {
          input = typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments || "{}")
            : tc.function?.arguments || {};
        } catch { input = {}; }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name || "unknown",
          input,
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    const text = messageContentToText(message?.content).trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last?.role === role && typeof last.content === "string") {
      last.content += `\n\n${text}`;
    } else {
      out.push({ role, content: text });
    }
  }
  if (out.length === 0 || out[0].role !== "user") {
    out.unshift({ role: "user", content: "Continue." });
  }
  return { system: system.join("\n\n"), messages: out };
}

async function callOpenAIFallback(messages, original, options = {}) {
  if (!PROVIDER_KEYS.openai || !OPENAI_FALLBACK_MODEL) {
    return null;
  }

  options.onStatus?.(`Activando fallback directo con OpenAI (${OPENAI_FALLBACK_MODEL}).`);
  const payload = {
    model: OPENAI_FALLBACK_MODEL,
    messages: withLuminaPcCapabilityPrompt(messages),
    max_tokens: Math.max(128, Math.min(original.max_tokens ?? I24D_DEFAULT_MAX_TOKENS, 4096)),
    stream: false,
  };
  if (original.temperature !== undefined) payload.temperature = original.temperature;

  const response = await postUrl(
    "https://api.openai.com/v1/chat/completions",
    authHeaders(PROVIDER_KEYS.openai),
    payload,
    Math.max(45_000, Math.min(90_000, I24D_TIMEOUT_MS + 15_000)),
  );
  if (response.status !== 200) {
    console.warn(`[proxy] OpenAI fallback failed with status ${response.status}`);
    proxyHealth.lastError = describeI24DError({
      ...response,
      body: {
        error: "openai_fallback_failed",
        message:
          typeof response.body === "string"
            ? response.body
            : response.body?.error?.message ?? response.body?.message ?? "OpenAI fallback failed",
      },
    });
    return null;
  }

  const body = response.body;
  if (!body?.choices?.[0]) return null;
  fireLearningSignal("openai-fallback", messages, body);
  console.log("[proxy] fallback answered via OpenAI");
  return body;
}

async function callAnthropicFallback(messages, original, options = {}) {
  if (!["anthropic", "auto"].includes(FALLBACK_PROVIDER) || !PROVIDER_KEYS.anthropic || !ANTHROPIC_FALLBACK_MODEL) {
    return null;
  }

  options.onStatus?.(`Activando fallback directo con Anthropic (${ANTHROPIC_FALLBACK_MODEL}).`);
  const normalized = normalizeMessagesForAnthropic(withLuminaPcCapabilityPrompt(messages));
  const payload = {
    model: ANTHROPIC_FALLBACK_MODEL,
    max_tokens: Math.max(128, Math.min(original.max_tokens ?? I24D_DEFAULT_MAX_TOKENS, 4096)),
    messages: normalized.messages,
  };
  if (normalized.system) payload.system = normalized.system;
  if (original.temperature !== undefined) payload.temperature = original.temperature;

  const response = await postUrl(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": PROVIDER_KEYS.anthropic, "anthropic-version": "2023-06-01" },
    payload,
    Math.max(60_000, I24D_TIMEOUT_MS),
  );
  if (response.status !== 200) {
    console.warn(`[proxy] Anthropic fallback failed with status ${response.status}`);
    proxyHealth.lastError = describeI24DError({
      ...response,
      body: {
        error: "anthropic_fallback_failed",
        message:
          typeof response.body === "string"
            ? response.body
            : response.body?.error?.message ?? response.body?.message ?? "Anthropic fallback failed",
      },
    });
    return null;
  }

  const text = Array.isArray(response.body?.content)
    ? response.body.content
        .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
    : "";
  if (!text.trim()) return null;

  const body = makeResponse(text, {
    ...original,
    model: `anthropic/${ANTHROPIC_FALLBACK_MODEL}`,
  });
  fireLearningSignal("anthropic-fallback", messages, body);
  console.log("[proxy] fallback answered via Anthropic");
  return body;
}

const LUMINA_TOOL_CALLS_RE = /<LUMINA_TOOL_CALLS>\s*([\s\S]*?)\s*<\/LUMINA_TOOL_CALLS>/i;
const TOOL_BRIDGE_MAX_ITERATIONS = 20;
const TOOL_BRIDGE_ALLOWED_TOOLS = new Set([
  "lumina_file_ops",
  "lumina_system_metrics",
  "lumina_process_list",
  "lumina_window_control",
  "lumina_clipboard",
  "lumina_screen_capture",
  "lumina_shell_run",
  "lumina_notify_toast",
]);
const FILE_ACTIONS_REQUIRING_APPROVAL = new Set(["write", "append", "delete", "move", "copy"]);

function parseLuminaToolCalls(content) {
  const match = String(content ?? "").match(LUMINA_TOOL_CALLS_RE);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].trim());
    const rawCalls = Array.isArray(parsed) ? parsed : parsed?.calls;
    return (Array.isArray(rawCalls) ? rawCalls : [])
      .map(normalizeLuminaToolCall)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeLuminaToolCall(call, index) {
  const tool = String(call?.tool ?? call?.name ?? call?.tool_name ?? "").trim();
  if (!TOOL_BRIDGE_ALLOWED_TOOLS.has(tool)) {
    return null;
  }
  const args = call?.args ?? call?.arguments ?? {};
  return {
    id: String(call?.id ?? `bridge_${index + 1}`),
    tool,
    args: args && typeof args === "object" ? args : {},
  };
}

function stripLuminaToolCalls(content) {
  return String(content ?? "").replace(LUMINA_TOOL_CALLS_RE, "").trim();
}

function isInsideLuminaWorkspace(filePath) {
  const root = resolve(LUMINA_WORKSPACE_PATH).replace(/[\\/]+$/, "").toLowerCase();
  const target = resolve(filePath).toLowerCase();
  return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`);
}

function bridgeCallRequiresApproval(call) {
  if (call.tool === "lumina_shell_run") {
    return true;
  }

  if (call.tool !== "lumina_file_ops") {
    return false;
  }

  const normalizedArgs = normalizeToolArgs(call.tool, call.args);
  const action = String(normalizedArgs.action ?? "").toLowerCase();
  if (!FILE_ACTIONS_REQUIRING_APPROVAL.has(action)) {
    return false;
  }

  const paths = [normalizedArgs.path, normalizedArgs.destination].filter(Boolean);
  return paths.some((filePath) => !isInsideLuminaWorkspace(filePath));
}

async function executeToolBridgeCalls(calls) {
  return Promise.all(
    calls.map(async (call) => {
      const result = compactContextItemsForStorage(await invokeTool(call.tool, call.args), {
        toolName: call.tool,
      });
      return {
        id: call.id,
        tool: call.tool,
        args: normalizeToolArgs(call.tool, call.args),
        result,
      };
    }),
  );
}

function formatToolBridgeResults(results) {
  return results
    .map((entry) => {
      const payload = {
        args: entry.args,
        result: compactToolResultForModel(entry.result, { toolName: entry.tool }),
      };
      return [
        `[${entry.tool} result id=${entry.id}]`,
        compactTextForBudget(JSON.stringify(payload, null, 2), { toolName: entry.tool }),
      ].join("\n");
    })
    .join("\n\n");
}

function makeToolBridgeApprovalResponse(calls, body) {
  const sentinel = encodePendingApproval({ calls });
  const descriptions = calls
    .map((call) => `- ${call.tool}: ${JSON.stringify(normalizeToolArgs(call.tool, call.args))}`)
    .join("\n");
  return makeResponse(
    [
      "Necesito tu autorizacion antes de ejecutar esta accion local.",
      "",
      descriptions,
      "",
      "Responde **approve** para autorizar o **no** para cancelar.",
      `[LUMINA_PENDING:${sentinel}]`,
    ].join("\n"),
    body,
  );
}

function providerFailureCanUseFailover(status) {
  return [0, 408, 409, 425, 429, 500, 502, 503, 504, 522, 523, 524].includes(Number(status ?? 0));
}

function makeLuminaCodeProviderFailover(messages, body, i24d, options = {}) {
  if (body?.luminaCodeDelegation === true) {
    return null;
  }
  if (!LUMINA_CODE_FAILOVER_ON_PROVIDER_ERROR || !providerFailureCanUseFailover(i24d?.status)) {
    return null;
  }

  const instruction = lastUserMessage(messages);
  const technicalDetail = describeI24DError(i24d);
  const isDevelopmentTask = shouldRouteToLuminaCode(instruction);
  const delegatedInstruction = isDevelopmentTask
    ? instruction
    : [
        "OpenClaw tuvo un bloqueo tecnico antes de completar una orden del usuario.",
        "Analiza y corrige el runtime/proxy/configuracion de Lumina OpenClaw para evitar este fallo.",
        "",
        `Orden original del usuario: ${instruction}`,
        `Fallo detectado: ${technicalDetail.message}`,
        `Estado: ${technicalDetail.status ?? "sin respuesta"}`,
        "",
        "No ejecutes acciones de cuenta del usuario desde Lumina Code; enfocate en resolver la causa tecnica del bloqueo.",
      ].join("\n");

  options.onStatus?.("El modelo principal y los fallbacks no respondieron establemente. Delegando diagnostico a Lumina Code.");
  const delegation = autoDelegateDevelopmentRequest(delegatedInstruction);
  if (delegation.statusCode !== 200) {
    return null;
  }

  const workspace = delegation.body?.workspace?.path ?? "el workspace configurado";
  return makeResponse(
    [
      "Lumina OpenClaw no pudo completar esta orden porque el provider del modelo quedo sin respuesta estable.",
      "",
      isDevelopmentTask
        ? `Delegue la tarea a Lumina Code en VS Code para que la resuelva en ${workspace}.`
        : `Delegue a Lumina Code un diagnostico tecnico para corregir el bloqueo de OpenClaw en ${workspace}.`,
      "",
      "La accion original no se debe considerar completada hasta que Lumina Code reporte el resultado.",
      `Detalle tecnico: ${technicalDetail.status ? `HTTP ${technicalDetail.status}` : "sin respuesta de red"} - ${technicalDetail.message}`,
    ].join("\n"),
    body,
  );
}

async function resolvePrimaryCompletionOnce(messages, body, options = {}) {
  const i24d = await callI24D(messages, body, options);
  if (i24d.status === 200 && i24d.body?.choices?.[0]) {
    return i24d.body;
  }

  const canFallback = providerFailureCanUseFailover(i24d.status);
  if (canFallback) {
    if (["openai", "auto"].includes(FALLBACK_PROVIDER)) {
      const fallback = await callOpenAIFallback(messages, body, options);
      if (fallback?.choices?.[0]) {
        return fallback;
      }
    }

    if (["anthropic", "auto"].includes(FALLBACK_PROVIDER)) {
      const fallback = await callAnthropicFallback(messages, body, options);
      if (fallback?.choices?.[0]) {
        return fallback;
      }
    }
  }

  const luminaCodeFailover = makeLuminaCodeProviderFailover(messages, body, i24d, options);
  if (luminaCodeFailover?.choices?.[0]) {
    return luminaCodeFailover;
  }

  return makeI24DDiagnosticResponse(i24d, body);
}

async function resolvePrimaryCompletion(messages, body, options = {}) {
  let workingMessages = withLuminaPcCapabilityPrompt(messages);

  for (let iteration = 0; iteration < TOOL_BRIDGE_MAX_ITERATIONS; iteration += 1) {
    if (iteration === 0) {
      options.onStatus?.("Preparando respuesta con herramientas locales disponibles.");
    } else {
      options.onStatus?.(`Revisando resultados de herramientas locales (${iteration + 1}/${TOOL_BRIDGE_MAX_ITERATIONS}).`);
    }
    const completion = await resolvePrimaryCompletionOnce(workingMessages, body, options);
    const content = completion?.choices?.[0]?.message?.content ?? "";
    const calls = parseLuminaToolCalls(content);
    if (calls.length === 0) {
      return completion;
    }

    const approvalCalls = calls.filter(bridgeCallRequiresApproval);
    if (approvalCalls.length > 0) {
      return makeToolBridgeApprovalResponse(approvalCalls, body);
    }

    console.log(`[proxy] bridge tool calls: ${calls.map((call) => call.tool).join(", ")}`);
    options.onStatus?.(`Ejecutando herramientas locales: ${calls.map((call) => call.tool).join(", ")}.`);
    const results = await executeToolBridgeCalls(calls);
    workingMessages = [
      ...workingMessages,
      {
        role: "assistant",
        content: stripLuminaToolCalls(content) || "Solicitando herramientas locales de Lumina.",
      },
      {
        role: "system",
        content:
          "[LUMINA LOCAL TOOL RESULTS]\n" +
          formatToolBridgeResults(results) +
          "\n[/LUMINA LOCAL TOOL RESULTS]\n\nResponde ahora al usuario en espanol con el resultado.",
      },
    ];
  }

  return makeResponse(
    AGENT_TOOL_ITERATION_LIMIT_MESSAGE,
    body,
  );
}

function sendResponse(res, body, isStreaming) {
  if (!isStreaming) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  const content = body.choices?.[0]?.message?.content ?? "";
  const id      = body.id      ?? `chatcmpl-proxy-${Date.now()}`;
  const created = body.created ?? Math.floor(Date.now() / 1000);
  const model   = body.model   ?? "I24D";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const base = { id, object: "chat.completion.chunk", created, model };

  emit({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  const CHUNK = 40;
  for (let i = 0; i < content.length; i += CHUNK)
    emit({ ...base, choices: [{ index: 0, delta: { content: content.slice(i, i + CHUNK) }, finish_reason: null }] });

  emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: body.usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ── Augment messages with tool context then call I24D ────────────────

async function askI24DWithContext(contextBlock, messages, body, options = {}) {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const cappedContextBlock = compactTextForBudget(contextBlock, {
    toolName: "lumina_context",
    maxChars: TOOL_RESULT_MODEL_CHAR_LIMIT,
  });
  const augmented   = messages.map((m, i) => {
    if (i !== lastUserIdx) return m;
    return {
      ...m,
      content:
        `[REAL-TIME PC DATA]\n${cappedContextBlock}\n[/REAL-TIME PC DATA]\n\n` +
        `User question: ${m.content}`,
    };
  });
  return callI24D(augmented, body, options);
}

// ── Main chat completion handler ──────────────────────────────────────

// ── Catalog-driven dispatch ───────────────────────────────────────────
//
// Hits an OpenAI-compatible upstream (Ollama Cloud or OpenAI itself), then
// fires the learning signal exactly like proxyExternalProvider does for the
// /openai/* path. Returns true when handled — caller exits early.
async function dispatchOpenAICompatible(providerLabel, baseUrl, apiKey, body, res, headers = {}) {
  const isStreaming = body.stream === true;

  // Cuando el cliente pide stream:true, abrimos un stream directo al
  // upstream (que también es OpenAI-compat) y bombeamos cada chunk
  // tal cual al cliente — token-por-token verdadero.
  if (isStreaming) {
    return await streamPassthroughOpenAI(providerLabel, baseUrl, apiKey, body, res, headers);
  }

  // Path no-streaming: una sola request bloqueante.
  let upstreamResponse;
  try {
    upstreamResponse = await postUrl(
      `${baseUrl}/chat/completions`,
      { Authorization: `Bearer ${apiKey}`, ...headers },
      { ...body, stream: false },
      Math.max(60_000, I24D_TIMEOUT_MS),
    );
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_error", message: err.message, provider: providerLabel }));
    }
    return;
  }
  if (upstreamResponse.status !== 200) {
    if (!res.headersSent) {
      res.writeHead(upstreamResponse.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamResponse.body ?? { error: "upstream_error", provider: providerLabel }));
    }
    return;
  }
  fireLearningSignal(providerLabel, body.messages ?? [], upstreamResponse.body);
  console.log(`[proxy] dispatched chat to ${providerLabel} (model=${body.model})`);
  sendResponse(res, normalizeReasoningToContent(upstreamResponse.body), false);
}

/**
 * Streaming verdadero hacia un upstream OpenAI-compatible. Abrimos un
 * request HTTPS, recibimos los SSE del upstream y los reenviamos por
 * el res del cliente sin transformación — el cliente ve cada delta tal
 * como sale del modelo.
 *
 * Bonus: para modelos "thinking" (qwen3.5, kimi, etc.) que emiten en
 * `delta.reasoning` y no en `delta.content`, copiamos reasoning→content
 * en cada chunk para que la UI vea texto en lugar de un campo vacío.
 */
function streamPassthroughOpenAI(providerLabel, baseUrl, apiKey, body, res, headers = {}) {
  return new Promise((resolve) => {
    const upstreamBody = JSON.stringify({ ...body, stream: true });
    const url = new URL(`${baseUrl}/chat/completions`);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        agent: url.protocol === "https:" ? httpsAgent : httpAgent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(upstreamBody),
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
          ...headers,
        },
        timeout: Math.max(120_000, I24D_TIMEOUT_MS),
      },
      (upRes) => {
        if (upRes.statusCode !== 200) {
          // Error upstream: leemos el body y lo reportamos al cliente.
          let errBody = "";
          upRes.setEncoding("utf8");
          upRes.on("data", (c) => (errBody += c));
          upRes.on("end", () => {
            if (!res.headersSent) {
              res.writeHead(upRes.statusCode || 502, { "Content-Type": "application/json" });
            }
            res.end(errBody || JSON.stringify({ error: "upstream_error", provider: providerLabel }));
            resolve();
          });
          return;
        }
        if (!res.headersSent) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
        }
        console.log(`[proxy] streaming chat from ${providerLabel} (model=${body.model})`);
        // Procesamos chunk-por-chunk para poder hacer la copia
        // reasoning→content si hace falta. Si no, pasamos el byte raw.
        let pending = "";
        let aggregateContent = "";
        let aggregateReasoning = "";
        upRes.setEncoding("utf8");
        upRes.on("data", (chunk) => {
          pending += chunk;
          let nl;
          // SSE delimita eventos por \n\n; entre tanto, líneas individuales.
          while ((nl = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) {
              res.write(line + "\n");
              continue;
            }
            if (trimmed.startsWith("data:")) {
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === "[DONE]") {
                res.write(line + "\n");
                continue;
              }
              try {
                const obj = JSON.parse(dataStr);
                const delta = obj?.choices?.[0]?.delta;
                if (delta) {
                  if (typeof delta.content === "string") aggregateContent += delta.content;
                  if (typeof delta.reasoning === "string") aggregateReasoning += delta.reasoning;
                  // Si hay reasoning pero no content en este delta, copia
                  if ((!delta.content || delta.content === "") && typeof delta.reasoning === "string" && delta.reasoning) {
                    delta.content = delta.reasoning;
                  }
                }
                res.write(`data: ${JSON.stringify(obj)}\n`);
              } catch {
                res.write(line + "\n");
              }
              continue;
            }
            res.write(line + "\n");
          }
        });
        upRes.on("end", () => {
          if (pending) res.write(pending);
          res.end();
          // Learning signal en background con el texto agregado.
          const wrapped = makeResponse(aggregateContent || aggregateReasoning, { ...body });
          fireLearningSignal(providerLabel, body.messages ?? [], wrapped);
          resolve();
        });
        upRes.on("error", (err) => {
          console.error(`[proxy] ${providerLabel} stream err:`, err.message);
          if (!res.writableEnded) res.end();
          resolve();
        });
      },
    );
    req.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error", message: err.message, provider: providerLabel }));
      } else if (!res.writableEnded) {
        res.end();
      }
      resolve();
    });
    req.on("timeout", () => {
      req.destroy(new Error(`upstream timeout`));
    });
    req.write(upstreamBody);
    req.end();
  });
}

/**
 * Some Ollama Cloud models (Qwen3.5, Kimi K2, GPT-OSS, GLM-5, etc.) put their
 * actual reply in `message.reasoning` and leave `message.content` empty. The
 * OpenClaw embedded agent counts `content` chunks as payloads — if it sees 0
 * payloads it surfaces "incomplete terminal response" to the user. Coalesce
 * non-empty reasoning into content here so the downstream consumer always
 * sees at least one payload.
 */
function normalizeReasoningToContent(body) {
  if (!body || !Array.isArray(body.choices)) return body;
  for (const choice of body.choices) {
    const msg = choice?.message;
    if (!msg) continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
    if (!content.trim() && reasoning.trim()) {
      msg.content = reasoning;
    }
  }
  return body;
}

// Translate OpenAI function tools → Anthropic tools format.
// Source pattern: Lumina-Code/official/packages/openai-adapters/src/apis/Anthropic.ts
function openaiToolToAnthropicTool(tool) {
  if (!tool || tool.type !== "function" || !tool.function) return null;
  return {
    name: tool.function.name,
    description: tool.function.description || "",
    input_schema: tool.function.parameters || { type: "object", properties: {} },
  };
}
function translateOpenAIToolsToAnthropic(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = tools.map(openaiToolToAnthropicTool).filter(Boolean);
  return out.length ? out : undefined;
}

async function dispatchAnthropic(apiKey, body, res) {
  const isStreaming = body.stream === true;
  const normalized = normalizeMessagesForAnthropic(body.messages ?? []);
  const payload = {
    model: body.model,
    max_tokens: Math.max(128, Math.min(body.max_tokens ?? I24D_DEFAULT_MAX_TOKENS, 8192)),
    messages: normalized.messages,
  };
  if (normalized.system) payload.system = normalized.system;
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  // Forward tools — sin esto el modelo no sabe que hay tools nativas y
  // termina emitiendo <tool_call> como texto.
  const anthTools = translateOpenAIToolsToAnthropic(body.tools);
  if (anthTools) payload.tools = anthTools;
  if (body.tool_choice && body.tool_choice !== "auto") {
    if (typeof body.tool_choice === "object" && body.tool_choice.type === "function") {
      payload.tool_choice = { type: "tool", name: body.tool_choice.function?.name };
    } else if (body.tool_choice === "required") {
      payload.tool_choice = { type: "any" };
    }
  }

  if (isStreaming) {
    return await streamPassthroughAnthropic(apiKey, body, payload, res);
  }

  // Path no-streaming
  let upstream;
  try {
    upstream = await postUrl(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      payload,
      Math.max(60_000, I24D_TIMEOUT_MS),
    );
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_error", message: err.message, provider: "anthropic" }));
    }
    return;
  }
  if (upstream.status !== 200) {
    if (!res.headersSent) {
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstream.body ?? { error: "anthropic_error" }));
    }
    return;
  }

  const text = Array.isArray(upstream.body?.content)
    ? upstream.body.content
        .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
    : "";
  const wrapped = makeResponse(text, { ...body, model: body.model });
  fireLearningSignal("anthropic", body.messages ?? [], wrapped);
  console.log(`[proxy] dispatched chat to anthropic (model=${body.model})`);
  sendResponse(res, wrapped, false);
}

/**
 * Streaming verdadero hacia Anthropic: pedimos stream:true, recibimos
 * los eventos SSE de Anthropic (content_block_delta, etc.) y los
 * traducimos a chunks OpenAI-format que la UI de OpenClaw entiende.
 *
 * Cada `content_block_delta` con `text_delta` produce un OpenAI delta
 * con `delta.content`. El `message_stop` cierra con finish_reason="stop".
 */
function streamPassthroughAnthropic(apiKey, body, payload, res) {
  return new Promise((resolve) => {
    const upBody = JSON.stringify({ ...payload, stream: true });
    const url = new URL("https://api.anthropic.com/v1/messages");
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: "POST",
        agent: httpsAgent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(upBody),
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          Accept: "text/event-stream",
        },
        timeout: Math.max(120_000, I24D_TIMEOUT_MS),
      },
      (upRes) => {
        if (upRes.statusCode !== 200) {
          let errBody = "";
          upRes.setEncoding("utf8");
          upRes.on("data", (c) => (errBody += c));
          upRes.on("end", () => {
            if (!res.headersSent) {
              res.writeHead(upRes.statusCode || 502, { "Content-Type": "application/json" });
            }
            res.end(errBody || JSON.stringify({ error: "anthropic_error" }));
            resolve();
          });
          return;
        }
        if (!res.headersSent) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
        }
        console.log(`[proxy] streaming chat from anthropic (model=${body.model})`);

        const chunkId = `chatcmpl-anthropic-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const baseChunk = (delta, finish_reason = null) => ({
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        });
        const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

        // Emit role chunk inicial
        emit(baseChunk({ role: "assistant" }));

        let pending = "";
        let aggregateText = "";
        let stopReason = null;
        // Estado para emitir tool_calls — igual que Continue / Lumina-Code
        let currentToolUseId = null;
        let currentToolUseName = null;
        let currentToolIndex = -1;

        upRes.setEncoding("utf8");
        upRes.on("data", (chunk) => {
          pending += chunk;
          let nl;
          while ((nl = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("event:")) continue; // ignorado, tipo va en el data
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            try {
              const ev = JSON.parse(dataStr);
              switch (ev.type) {
                case "content_block_start": {
                  if (ev.content_block?.type === "tool_use") {
                    currentToolUseId = ev.content_block.id;
                    currentToolUseName = ev.content_block.name;
                    currentToolIndex += 1;
                    // Anuncia el inicio del tool_call con args vacíos.
                    emit(baseChunk({
                      tool_calls: [{
                        index: currentToolIndex,
                        id: currentToolUseId,
                        type: "function",
                        function: { name: currentToolUseName, arguments: "" },
                      }],
                    }));
                  }
                  break;
                }
                case "content_block_delta": {
                  if (ev.delta?.type === "text_delta") {
                    const txt = ev.delta.text || "";
                    if (txt) {
                      aggregateText += txt;
                      emit(baseChunk({ content: txt }));
                    }
                  } else if (ev.delta?.type === "input_json_delta" && currentToolUseId) {
                    // Stream del JSON de argumentos token por token.
                    emit(baseChunk({
                      tool_calls: [{
                        index: currentToolIndex,
                        function: { arguments: ev.delta.partial_json || "" },
                      }],
                    }));
                  }
                  break;
                }
                case "content_block_stop": {
                  currentToolUseId = null;
                  currentToolUseName = null;
                  break;
                }
                case "message_delta": {
                  if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
                  break;
                }
                case "message_stop": {
                  // Mapeo Anthropic→OpenAI finish_reason
                  const finish =
                    stopReason === "tool_use" ? "tool_calls" :
                    stopReason === "end_turn" ? "stop" :
                    stopReason === "max_tokens" ? "length" :
                    "stop";
                  emit(baseChunk({}, finish));
                  break;
                }
                case "error": {
                  emit(baseChunk({ content: `\n[error: ${ev.error?.message || "anthropic error"}]` }));
                  break;
                }
              }
            } catch {
              // bad JSON, skip
            }
          }
        });
        upRes.on("end", () => {
          res.write("data: [DONE]\n\n");
          res.end();
          const wrapped = makeResponse(aggregateText, { ...body });
          fireLearningSignal("anthropic", body.messages ?? [], wrapped);
          resolve();
        });
        upRes.on("error", (err) => {
          console.error(`[proxy] anthropic stream err:`, err.message);
          if (!res.writableEnded) res.end();
          resolve();
        });
      },
    );
    req.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error", message: err.message, provider: "anthropic" }));
      } else if (!res.writableEnded) {
        res.end();
      }
      resolve();
    });
    req.on("timeout", () => req.destroy(new Error("anthropic stream timeout")));
    req.write(upBody);
    req.end();
  });
}

async function dispatchGemini(apiKey, body, res) {
  const isStreaming = body.stream === true;
  // Translate OpenAI-style messages -> Gemini generateContent payload.
  const systemTexts = [];
  const contents = [];
  for (const message of body.messages ?? []) {
    const text = messageContentToText(message?.content).trim();
    if (!text) continue;
    if (message.role === "system" || message.role === "developer") {
      systemTexts.push(text);
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text }],
    });
  }
  const payload = { contents };
  if (systemTexts.length) {
    payload.systemInstruction = { parts: [{ text: systemTexts.join("\n\n") }] };
  }
  if (body.temperature !== undefined || body.max_tokens !== undefined) {
    payload.generationConfig = {
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
    };
  }

  let upstream;
  try {
    upstream = await postUrl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(body.model)}:generateContent?key=${apiKey}`,
      {},
      payload,
      Math.max(60_000, I24D_TIMEOUT_MS),
    );
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_error", message: err.message, provider: "gemini" }));
    }
    return;
  }
  if (upstream.status !== 200) {
    if (!res.headersSent) {
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstream.body ?? { error: "gemini_error" }));
    }
    return;
  }

  const text = (upstream.body?.candidates ?? [])
    .flatMap((c) => (Array.isArray(c?.content?.parts) ? c.content.parts : []))
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  const wrapped = makeResponse(text, { ...body, model: body.model });
  fireLearningSignal("gemini", body.messages ?? [], wrapped);
  console.log(`[proxy] dispatched chat to gemini (model=${body.model})`);
  sendResponse(res, wrapped, isStreaming);
}

/**
 * Inspect body.model and route to the matching upstream provider when the
 * model belongs to the static catalog. Returns true when the request was
 * handled (caller must NOT continue with the default I24D flow).
 *
 * Models tagged `lumina-brain` (and unknown ids) fall through — they keep
 * the existing I24D + intent/tool-bridge behavior.
 */
// ── Identidad Lumina inyectada en TODO chat ─────────────────────────────
// Lee IDENTITY/SOUL/USER/TOOLS/AGENTS.md de ~/.lumina/workspace/ y los
// inyecta como system prompt antes de mandar al provider. Resultado: no
// importa qué modelo elija el usuario (Claude, GPT, Qwen…), siempre
// responde como Lumina, sabiendo dónde vive y qué puede hacer.
let _luminaIdentityCache = null;
let _luminaIdentityCacheAt = 0;
function loadLuminaIdentity() {
  const now = Date.now();
  if (_luminaIdentityCache && now - _luminaIdentityCacheAt < 60_000) {
    return _luminaIdentityCache;
  }
  const ws = join(os.homedir(), ".lumina", "workspace");
  const files = ["IDENTITY.md", "SOUL.md", "USER.md", "TOOLS.md", "AGENTS.md"];
  const parts = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(join(ws, f), "utf8").trim();
      if (content) parts.push(`## ${f}\n\n${content}`);
    } catch {
      // archivo opcional — si no existe, se omite
    }
  }
  const header =
    "Eres Lumina, asistente personal IA de Dal. Vives DENTRO de la aplicación " +
    "Lumina OpenClaw (Tauri + OpenClaw runtime) instalada en " +
    "C:\\Program Files\\Lumina OpenClaw\\. NO eres Claude, ni GPT, ni Qwen, ni " +
    "Gemini — usas esos modelos como cerebro intercambiable. Tienes acceso " +
    "real a 127.0.0.1 para llamar a tu sidecar de voz (4322), Lumina Code " +
    "(0.2.7 en VS Code), MCP tools y al proxy local (4321). NUNCA digas que " +
    "no tienes acceso a la PC del usuario — sí lo tienes a través de tus " +
    "herramientas. Estos son tus archivos de identidad y capacidades:";
  _luminaIdentityCache = `${header}\n\n${parts.join("\n\n---\n\n")}`;
  _luminaIdentityCacheAt = now;
  return _luminaIdentityCache;
}

function injectLuminaSystemPrompt(messages) {
  const identity = loadLuminaIdentity();
  const out = Array.isArray(messages) ? [...messages] : [];
  // Si ya existe un mensaje system, le prependemos la identidad para que
  // no se pierda lo que OpenClaw inyecta por su lado.
  const sysIdx = out.findIndex((m) => m && m.role === "system");
  if (sysIdx >= 0) {
    const existing = messageContentToText(out[sysIdx].content || "").trim();
    out[sysIdx] = {
      role: "system",
      content: existing
        ? `${identity}\n\n---\n\n${existing}`
        : identity,
    };
  } else {
    out.unshift({ role: "system", content: identity });
  }
  return out;
}

async function dispatchByCatalog(req, res, body) {
  const entry = lookupModel(body?.model);
  if (!entry || entry.provider === "lumina-brain") {
    return false;
  }
  // Inyectamos identidad ANTES de armar el upstreamBody.
  const upstreamBody = {
    ...body,
    model: entry.id,
    messages: injectLuminaSystemPrompt(body.messages),
  };

  switch (entry.provider) {
    case "ollama-cloud": {
      const apiKey = PROVIDER_KEYS.ollamaCloud;
      if (!apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ollama_cloud_key_missing", message: "Configure ollamaCloudApiKey en ~/.lumina/config.json." }));
        return true;
      }
      await dispatchOpenAICompatible("ollama-cloud", "https://ollama.com/v1", apiKey, upstreamBody, res);
      return true;
    }
    case "openai": {
      const apiKey = PROVIDER_KEYS.openai;
      if (!apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "openai_key_missing", message: "Configure openaiApiKey en ~/.lumina/config.json." }));
        return true;
      }
      await dispatchOpenAICompatible("openai", "https://api.openai.com/v1", apiKey, upstreamBody, res);
      return true;
    }
    case "anthropic": {
      const apiKey = PROVIDER_KEYS.anthropic;
      if (!apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "anthropic_key_missing", message: "Configure anthropicApiKey en ~/.lumina/config.json." }));
        return true;
      }
      await dispatchAnthropic(apiKey, upstreamBody, res);
      return true;
    }
    case "gemini": {
      const apiKey = PROVIDER_KEYS.gemini;
      if (!apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gemini_key_missing", message: "Configure geminiApiKey en ~/.lumina/config.json." }));
        return true;
      }
      await dispatchGemini(apiKey, upstreamBody, res);
      return true;
    }
    case "deepseek": {
      const apiKey = PROVIDER_KEYS.deepseek;
      if (!apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "deepseek_key_missing", message: "Configure deepseekApiKey en ~/.lumina/config.json." }));
        return true;
      }
      await dispatchOpenAICompatible("deepseek", "https://api.deepseek.com/v1", apiKey, upstreamBody, res);
      return true;
    }
    default:
      return false;
  }
}

async function handleChatCompletion(req, res, body) {
  // Catalog-driven dispatch: when the UI sent a model that maps to OpenAI,
  // Anthropic, Gemini, DeepSeek, or Ollama Cloud, hit that upstream directly.
  if (await dispatchByCatalog(req, res, body)) {
    return;
  }

  const isStreaming = body.stream === true;
  const messages    = body.messages ?? [];
  const userText    = lastUserMessage(messages);
  const liveStream   = isStreaming ? createLiveChatStream(res, body) : null;
  const runOptions   = {
    onStatus: (message) => liveStream?.status(message),
  };
  liveStream?.status("Orden recibida. Preparando ruta de ejecucion.");

  console.log(`[proxy] ← "${userText.slice(0, 80)}"`);

  // ── 1. Approval check ───────────────────────────────────────────────
  const pending = extractPendingApproval(messages);
  if (pending) {
    if (APPROVE_RE.test(userText)) {
      const calls = Array.isArray(pending.calls)
        ? pending.calls
        : [{ tool: pending.tool, args: pending.args ?? {} }];
      console.log(`[proxy] approved: ${calls.map((call) => call.tool).join(", ")}`);
      const results = await executeToolBridgeCalls(
        calls.map((call, index) => ({
          id: String(call.id ?? `approved_${index + 1}`),
          tool: String(call.tool ?? ""),
          args: call.args ?? {},
        })),
      );
      const formatted = formatToolBridgeResults(results);
      console.log("[proxy] executed approved tool calls");

      const completion = await resolvePrimaryCompletion(
        [
          ...messages,
          {
            role:    "system",
            content: `The user approved the action. Result:\n\n${formatted}\n\nReport clearly and concisely.`,
          },
        ],
        body,
        runOptions,
      );
      return sendFinalResponse(
        res,
        completion?.choices?.[0] ? completion : makeResponse(formatted, body),
        isStreaming,
        liveStream,
      );
    }

    if (DENY_RE.test(userText)) {
      console.log(`[proxy] ✗ denied: ${pending.tool}`);
      return sendFinalResponse(
        res,
        makeResponse("Cancelled. Let me know if you need anything else.", body),
        isStreaming,
        liveStream,
      );
    }
  }

  // ── 2. Slash commands ───────────────────────────────────────────────
  const slash = parseSlashCommand(userText);
  if (slash) {
    if (slash.type === "auto") {
      console.log(`[proxy] /cmd: ${slash.tool}`);
      liveStream?.status(`Ejecutando herramienta local: ${slash.tool}.`);
      const result    = await invokeTool(slash.tool, slash.args);
      const formatted = compactTextForBudget(formatResult(slash.tool, result), {
        toolName: slash.tool,
        maxChars: TOOL_RESULT_MODEL_CHAR_LIMIT,
      });

      const lastIdx  = messages.map((m) => m.role).lastIndexOf("user");
      const augmented = messages.map((m, i) =>
        i === lastIdx
          ? { ...m, content: `${userText}\n\n[PC Data]\n${formatted}\n[/PC Data]\n\nRespond based on the data above.` }
          : m
      );
      const i24d = await callI24D(augmented, body, runOptions);
      if (i24d.status === 200 && i24d.body?.choices?.[0])
        return sendFinalResponse(res, i24d.body, isStreaming, liveStream);
      return sendFinalResponse(res, makeResponse(formatted, body), isStreaming, liveStream);
    }

    if (slash.type === "approval") {
      console.log(`[proxy] /cmd needs approval: ${slash.tool}`);
      const sentinel = encodePendingApproval({ tool: slash.tool, args: slash.args });
      const msg =
        `I need your authorization before I can proceed.\n\n` +
        `**Action:** \`${slash.tool}\`\n` +
        `**Details:** ${slash.description ?? JSON.stringify(slash.args)}\n\n` +
        `Reply **approve** to authorize or **no** to cancel.\n` +
        `[LUMINA_PENDING:${sentinel}]`;
      return sendFinalResponse(res, makeResponse(msg, body), isStreaming, liveStream);
    }
  }

  // ── 3. Intent detection — fetch tools in parallel ───────────────────
  if (respondWithAutomaticLuminaCodeDelegation(res, body, liveStream)) {
    return;
  }

  const intents = detectIntents(userText);
  if (intents.length > 0) {
    console.log(`[proxy] intents: ${intents.map((i) => i.label).join(", ")}`);
    liveStream?.status(`Detecte herramientas locales necesarias: ${intents.map((i) => i.label).join(", ")}.`);

    // Collect all unique tool calls across matched intents
    const allCalls = intents.flatMap((i) => i.toolCalls);

    // Deduplicate by tool+args key
    const seen    = new Set();
    const unique  = allCalls.filter((c) => {
      const k = cacheKey(c.name, c.args);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Fetch all in parallel
    const results = await Promise.all(
      unique.map((c) => invokeTool(c.name, c.args).then((r) => ({ name: c.name, result: r })))
    );

    const contextBlock = compactTextForBudget(
      results.map(({ name, result }) => formatResult(name, result)).join("\n\n"),
      { toolName: "lumina_intent_context", maxChars: TOOL_RESULT_MODEL_CHAR_LIMIT },
    );

    let i24d;
    try {
      i24d = await askI24DWithContext(contextBlock, messages, body, runOptions);
    } catch (err) {
      console.error(`[proxy] I24D error (falling back to raw data): ${err.message}`);
      i24d = null;
    }

    if (i24d?.status === 200 && i24d.body?.choices?.[0]) {
      console.log(`[proxy] → I24D answered with context (${unique.length} tool(s))`);
      return sendFinalResponse(res, i24d.body, isStreaming, liveStream);
    }

    // I24D unavailable or returned non-200 — return the raw tool data directly
    console.log(`[proxy] → I24D fallback: returning raw tool data`);
    return sendFinalResponse(res, makeResponse(contextBlock, body), isStreaming, liveStream);
  }

  // ── 4. Pass through to I24D unchanged ───────────────────────────────
  console.log(`[proxy] → pass-through`);
  const completion = await resolvePrimaryCompletion(messages, body, runOptions);
  return sendFinalResponse(res, completion, isStreaming, liveStream);
}

// ── Pass-through proxy for non-chat routes (e.g. /v1/models) ─────────

async function proxyToI24D(reqPath, method, body, res) {
  const authorizationHeaders = await getI24DAuthorizationHeaders();
  return new Promise((resolve, reject) => {
    const bodyStr = body && typeof body === "object" ? JSON.stringify(body) : body ?? "";
    const target  = new URL(reqPath, I24D_MODELS_BASE);
    const lib = target.protocol === "https:" ? https : http;

    const opts = {
      hostname: target.hostname,
      port:     target.port || (target.protocol === "https:" ? 443 : 80),
      path:     target.pathname + target.search,
      method,
      agent:    target.protocol === "https:" ? httpsAgent : httpAgent,
      headers:  {
        "Content-Type":  "application/json",
        ...authorizationHeaders,
      },
    };
    if (bodyStr) opts.headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const pr = lib.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on("end", resolve);
    });
    pr.on("error", reject);
    if (bodyStr) pr.write(bodyStr);
    pr.end();
  });
}

// ── HTTP server ───────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PROXY_PORT}`);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  let body = null;
  if (rawBody) {
    try { body = JSON.parse(rawBody); } catch { /* not JSON */ }
  }

  if ((url.pathname === "/health" || url.pathname === "/__lumina/health") && req.method === "GET") {
    return sendJson(res, 200, healthPayload());
  }

  if (url.pathname === "/__lumina/warmup" && (req.method === "GET" || req.method === "POST")) {
    const warmup = await warmI24D("manual");
    return sendJson(res, warmup.ok ? 200 : 502, healthPayload());
  }

  if (url.pathname.startsWith("/__lumina/") && req.method === "OPTIONS") {
    if (rejectUntrustedLuminaOrigin(req, res)) {
      return;
    }
    res.writeHead(204, luminaCorsHeaders(req));
    res.end();
    return;
  }

  if (url.pathname === "/__lumina/code/status" && req.method === "GET") {
    if (rejectUntrustedLuminaOrigin(req, res)) {
      return;
    }
    return sendLuminaJson(req, res, 200, luminaCodeStatus());
  }

  if (url.pathname === "/__lumina/code/open" && req.method === "POST") {
    if (rejectUntrustedLuminaOrigin(req, res)) {
      return;
    }
    try {
      const result = openLuminaCode(body);
      return sendLuminaJson(req, res, result.statusCode, result.body);
    } catch (err) {
      return sendLuminaJson(req, res, 502, {
        ok: false,
        error: "lumina_code_open_failed",
        message: err instanceof Error ? err.message : String(err),
        status: luminaCodeStatus(body),
      });
    }
  }

  if (url.pathname === "/__lumina/code/delegate" && req.method === "POST") {
    if (rejectUntrustedLuminaOrigin(req, res)) {
      return;
    }
    try {
      const result = delegateToLuminaCode(body);
      return sendLuminaJson(req, res, result.statusCode, result.body);
    } catch (err) {
      return sendLuminaJson(req, res, 502, {
        ok: false,
        error: "lumina_code_delegate_failed",
        message: err instanceof Error ? err.message : String(err),
        status: luminaCodeStatus(body),
      });
    }
  }

  // ── I24D (primary) ───────────────────────────────────────────────────
  if (url.pathname === "/__lumina/openclaw/delegate" && req.method === "POST") {
    if (rejectUntrustedLuminaOrigin(req, res)) {
      return;
    }
    try {
      const result = await delegateFromLuminaCodeToOpenClaw(body);
      return sendLuminaJson(req, res, result.statusCode, result.body);
    } catch (err) {
      return sendLuminaJson(req, res, 502, {
        ok: false,
        error: "lumina_openclaw_delegate_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── /v1/models — static catalog of the 82 verified models ────────────
  // OpenClaw UI selector reads this; serving it locally means the picker
  // shows every provider without depending on an I24D round-trip.
  if (url.pathname === "/v1/models" && req.method === "GET") {
    return sendJson(res, 200, buildOpenAIModelsResponse());
  }

  // ── /lumina/voice/* — pass-through to lumina-voice.exe sidecar ───────
  if (url.pathname.startsWith("/lumina/voice")) {
    if (rejectUntrustedLuminaOrigin(req, res)) {
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, luminaCorsHeaders(req));
      res.end();
      return;
    }
    await proxyToVoice(req, url.pathname, req.method, body, res);
    return;
  }

  if (url.pathname === "/__lumina/tools/invoke" && req.method === "POST" && body) {
    const tool = String(body.tool ?? "").trim();
    if (!tool) {
      return sendJson(res, 400, { ok: false, error: "tool_required" });
    }
    const result = await invokeTool(tool, body.args ?? {});
    return sendJson(res, result?.ok === false ? 502 : 200, { ok: result?.ok !== false, result });
  }

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    if (!body || typeof body !== "object") {
      return sendJson(res, 400, {
        error: "invalid_json",
        message: "Expected a JSON chat completion body.",
      });
    }
    try {
      await handleChatCompletion(req, res, body);
      return;
    } catch (err) {
      console.error("[proxy] error:", err);
      if (res.headersSent && body?.stream === true && !res.writableEnded) {
        const id = `chatcmpl-proxy-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const model = body.model ?? "I24D";
        const base = { id, object: "chat.completion.chunk", created, model };
        const message = `\n[Lumina] Error recuperado: ${err instanceof Error ? err.message : String(err)}`;
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: message }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else if (!res.headersSent) {
        sendResponse(
          res,
          makeResponse(
            `Lumina proxy error: ${err instanceof Error ? err.message : String(err)}`,
            body,
          ),
          body?.stream === true,
        );
      }
      return;
    }

  // ── OpenAI pass-through + learning intercept ──────────────────────
  } else if (url.pathname.startsWith("/openai/v1/") && req.method === "POST" && body) {
    if (
      url.pathname.endsWith("/chat/completions") &&
      respondWithAutomaticLuminaCodeDelegation(res, body)
    ) {
      return;
    }
    const upstreamPath = url.pathname.replace("/openai/v1/", "/v1/");
    const inboundKey = extractBearer(req.headers);
    const apiKey = PROVIDER_KEYS.openai || (isPlaceholderProviderKey(inboundKey) ? "" : inboundKey);
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "openai_key_missing", message: "Configure tu API key de OpenAI en los ajustes del proveedor." }));
      return;
    }
    try {
      await proxyExternalProvider(
        "openai",
        `https://api.openai.com${upstreamPath}`,
        apiKey,
        body,
        res
      );
    } catch (err) {
      console.error("[proxy] openai error:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error", message: err.message }));
      }
    }

  // ── Anthropic pass-through + learning intercept ───────────────────
  } else if (url.pathname.startsWith("/anthropic/") && req.method === "POST" && body) {
    const upstreamPath = url.pathname.replace("/anthropic/", "/");
    const inboundKey = String(req.headers["x-api-key"] ?? "").trim() || extractBearer(req.headers);
    const apiKey = PROVIDER_KEYS.anthropic || (isPlaceholderProviderKey(inboundKey) ? "" : inboundKey);
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "anthropic_key_missing", message: "Configure tu API key de Anthropic en los ajustes del proveedor." }));
      return;
    }
    // Anthropic uses x-api-key, not Authorization Bearer
    const upstreamBody = { ...body, stream: false };
    let anthropicRes;
    try {
      anthropicRes = await postUrl(
        `https://api.anthropic.com${upstreamPath}`,
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        upstreamBody,
        60_000
      );
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error", message: err.message }));
      }
      return;
    }
    if (anthropicRes.status !== 200) {
      if (!res.headersSent) {
        res.writeHead(anthropicRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(anthropicRes.body));
      }
      return;
    }
    fireLearningSignal("anthropic", body.messages ?? [], anthropicRes.body);
    console.log("[proxy] ✦ learning signal fired for provider: anthropic");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(anthropicRes.body));

  // ── Gemini pass-through + learning intercept ──────────────────────
  } else if (url.pathname.startsWith("/gemini/") && req.method === "POST" && body) {
    const upstreamPath = url.pathname.replace("/gemini/", "/");
    const inboundKey = String(req.headers["x-goog-api-key"] ?? "").trim() || extractBearer(req.headers);
    const apiKey = PROVIDER_KEYS.gemini || (isPlaceholderProviderKey(inboundKey) ? "" : inboundKey);
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gemini_key_missing", message: "Configure tu API key de Gemini en los ajustes del proveedor." }));
      return;
    }
    // Gemini uses ?key= query param
    const geminiUrl = `https://generativelanguage.googleapis.com${upstreamPath}?key=${apiKey}`;
    try {
      await proxyExternalProvider("gemini", geminiUrl, "", body, res);
    } catch (err) {
      console.error("[proxy] gemini error:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error", message: err.message }));
      }
    }

  // ── Fallback: pass through to I24D ────────────────────────────────
  } else if (url.pathname.startsWith("/deepseek/v1/") && req.method === "POST" && body) {
    if (
      url.pathname.endsWith("/chat/completions") &&
      respondWithAutomaticLuminaCodeDelegation(res, body)
    ) {
      return;
    }
    const upstreamPath = url.pathname.replace("/deepseek/v1/", "/v1/");
    const inboundKey = extractBearer(req.headers);
    const apiKey = PROVIDER_KEYS.deepseek || (isPlaceholderProviderKey(inboundKey) ? "" : inboundKey);
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "deepseek_key_missing", message: "Configure tu API key de DeepSeek en los ajustes del proveedor." }));
      return;
    }
    try {
      await proxyExternalProvider(
        "deepseek",
        `https://api.deepseek.com${upstreamPath}`,
        apiKey,
        body,
        res,
      );
    } catch (err) {
      console.error("[proxy] deepseek error:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error", message: err.message }));
      }
    }

  } else {
    try {
      await proxyToI24D(req.url, req.method, body ?? rawBody, res);
    } catch (err) {
      console.error("[proxy] forward error:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error", message: err.message }));
      }
    }
  }
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   Lumina_PC Tool-Calling Proxy  —  RUNNING                  ║");
  console.log(`║   Proxy  :${PROXY_PORT}  →  I24D (Render)  →  OpenClaw :${OPENCLAW_PORT}           ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log("I24D   :", I24D_URL);
  console.log("Config : ~/.lumina/config.json + proxy-config.json + $OPENCLAW_CONFIG_PATH");
  console.log();
  console.log(`MODEL CATALOG: ${CATALOG_TOTAL} models exposed on /v1/models`);
  startVoiceSidecar();
  console.log("PROVIDER INTERCEPTION (all learn → Lumina):");
  console.log(`  /v1/models               → static catalog (${CATALOG_TOTAL} entries)`);
  console.log(`  /v1/chat/completions     → dispatch by body.model (catalog) | fallback I24D`);
  console.log(`  /openai/v1/*             → OpenAI API   ${PROVIDER_KEYS.openai ? "✓ key set" : "✗ key missing"}`);
  console.log(`  /anthropic/*             → Anthropic    ${PROVIDER_KEYS.anthropic ? "✓ key set" : "✗ key missing"}`);
  console.log(`  /gemini/*                → Gemini       ${PROVIDER_KEYS.gemini ? "✓ key set" : "✗ key missing"}`);
  console.log(`  /deepseek/v1/*           → DeepSeek     ${PROVIDER_KEYS.deepseek ? "✓ key set" : "✗ key missing"}`);
  console.log(`  ollama-cloud dispatch    → ollama.com   ${PROVIDER_KEYS.ollamaCloud ? "✓ key set" : "✗ key missing"}`);
  console.log(`  fallback                 -> ${FALLBACK_PROVIDER} (OpenAI model: ${OPENAI_FALLBACK_MODEL || "not set"})`);
  console.log(`  progress streaming       -> ${LUMINA_PROGRESS_STREAMING_ENABLED ? "on" : "off"}`);
  console.log();
  console.log("INTENTS (auto-fetch):");
  console.log("  system metrics, process list, open windows, clipboard,");
  console.log("  screenshot, file read (with path), dir list (with path)");
  console.log();
  console.log("SLASH COMMANDS:");
  console.log("  /metrics  /ps  /windows  /screen  /clip  /notify <msg>");
  console.log("  /file read|list|stat <path>");
  console.log("  /file write|delete|move <path> [dest]   ← needs approve");
  console.log("  /shell <cmd>                             ← needs approve");
  console.log();
  console.log("CACHE TTLs (seconds):");
  for (const [k, v] of Object.entries(CACHE_TTL))
    if (v > 0) console.log(`  ${k}: ${v / 1000}s`);
  console.log();

  if (I24D_WARMUP_ENABLED) {
    void warmI24D("startup")
      .then((result) => {
        console.log(`[proxy] I24D warmup ${result.ok ? "ok" : "failed"} in ${result.durationMs}ms`);
      })
      .catch((err) => {
        console.warn(`[proxy] I24D warmup error: ${err instanceof Error ? err.message : String(err)}`);
      });
    startI24DKeepWarm();
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[proxy] Port ${PROXY_PORT} already in use — another proxy may be running.`);
  } else {
    console.error("[proxy] Server error:", err.message);
  }
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[proxy] Uncaught exception:", err?.message ?? err);
  console.error(err?.stack ?? "");
  // Keep running — most uncaught errors are per-request, not fatal
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[proxy] Unhandled rejection:", msg);
  // Keep running
});
