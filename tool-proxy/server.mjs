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
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Config loading ────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const luminaConfigPath = join(os.homedir(), ".lumina", "config.json");
const fallbackOpenclawConfigPath = join(os.homedir(), ".openclaw", "openclaw.json");

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const luminaCfg = loadJson(luminaConfigPath) ?? {};
const proxyCfg = loadJson(join(__dir, "proxy-config.json")) ?? {};
const openclawCfg =
  loadJson(process.env.OPENCLAW_CONFIG_PATH ?? fallbackOpenclawConfigPath) ?? {};

// Resolution order: env var > ~/.lumina/config.json > proxy-config.json > openclaw.json > fallback
const I24D_URL         = process.env.I24D_URL
  ?? luminaCfg.i24dChatUrl
  ?? proxyCfg.i24d?.url
  ?? "https://i24d-whatsapp-ai.onrender.com/v1/chat/completions";

const I24D_MODELS_BASE = process.env.I24D_MODELS_BASE
  ?? luminaCfg.i24dModelsBaseUrl
  ?? proxyCfg.i24d?.modelsBase
  ?? "https://i24d-whatsapp-ai.onrender.com";

const I24D_TOKEN       = process.env.I24D_TOKEN
  ?? luminaCfg.i24dToken
  ?? proxyCfg.i24d?.token
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
    result,
    expiresAt: Date.now() + ttl,
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────

/**
 * POST to a full URL (http or https). Respects I24D_TIMEOUT_MS for I24D calls.
 */
function postUrl(url, headers, body, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const parsed  = new URL(url);
    const lib     = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Invoke a lumina tool via OpenClaw /tools/invoke ───────────────────

async function invokeTool(toolName, args) {
  // Return cached result if fresh
  const cached = getCached(toolName, args);
  if (cached) {
    console.log(`[proxy] cache hit: ${toolName}`);
    return cached;
  }

  try {
    const r = await postUrl(
      `http://127.0.0.1:${OPENCLAW_PORT}/tools/invoke`,
      { Authorization: `Bearer ${OPENCLAW_TOKEN}` },
      { tool: toolName, args: args ?? {} },
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

    setCache(toolName, args, result);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Call I24D on Render ───────────────────────────────────────────────

async function callI24D(messages, original) {
  const payload = {
    model:      original.model ?? "I24D",
    messages,
    max_tokens: original.max_tokens ?? 2048,
    stream:     false,
  };
  if (original.temperature !== undefined) payload.temperature = original.temperature;

  return postUrl(
    I24D_URL,
    { Authorization: `Bearer ${I24D_TOKEN}` },
    payload,
    I24D_TIMEOUT_MS
  );
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

// ── Format tool results as readable context ───────────────────────────

function formatResult(toolName, result) {
  if (!result) return `[${toolName}: no result]`;

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
      const preview = String(text).slice(0, 500);
      const truncated = String(text).length > 500 ? "\n[...truncated]" : "";
      return `[Clipboard content]\n${preview}${truncated}`;
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
      if (result.stdout) parts.push(`STDOUT:\n${result.stdout}`);
      if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
      return parts.join("\n");
    }

    case "lumina_notify_toast": {
      return `[Toast notification sent: "${result.message ?? result.title ?? ""}"]`;
    }

    default:
      return `[${toolName}]\n${JSON.stringify(result, null, 2)}`;
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

  return null;
}

// ── Approval helpers ──────────────────────────────────────────────────

const APPROVAL_SENTINEL_RE = /\[LUMINA_PENDING:(\{[\s\S]*?\})\]/;
const APPROVE_RE = /^\s*(approve|yes|s[ií]|autorizo|ok|confirm|adelante|go\s+ahead|ejecuta|run\s+it)\s*$/i;
const DENY_RE    = /^\s*(no|cancel|deny|nope|cancelar|abort)\s*$/i;

function extractPendingApproval(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const match = String(messages[i].content ?? "").match(APPROVAL_SENTINEL_RE);
    if (match) {
      try { return JSON.parse(match[1]); } catch { /* ignore */ }
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

async function askI24DWithContext(contextBlock, messages, body) {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const augmented   = messages.map((m, i) => {
    if (i !== lastUserIdx) return m;
    return {
      ...m,
      content:
        `[REAL-TIME PC DATA]\n${contextBlock}\n[/REAL-TIME PC DATA]\n\n` +
        `User question: ${m.content}`,
    };
  });
  return callI24D(augmented, body);
}

// ── Main chat completion handler ──────────────────────────────────────

async function handleChatCompletion(req, res, body) {
  const isStreaming = body.stream === true;
  const messages    = body.messages ?? [];
  const userText    = lastUserMessage(messages);

  console.log(`[proxy] ← "${userText.slice(0, 80)}"`);

  // ── 1. Approval check ───────────────────────────────────────────────
  const pending = extractPendingApproval(messages);
  if (pending) {
    if (APPROVE_RE.test(userText)) {
      console.log(`[proxy] ✓ approved: ${pending.tool}`);
      const result    = await invokeTool(pending.tool, pending.args);
      const formatted = formatResult(pending.tool, result);
      console.log(`[proxy] ✓ executed: ${pending.tool}`);

      const i24d = await callI24D(
        [
          ...messages,
          {
            role:    "system",
            content: `The user approved the action. Result:\n\n${formatted}\n\nReport clearly and concisely.`,
          },
        ],
        body
      );
      if (i24d.status === 200 && i24d.body?.choices?.[0])
        return sendResponse(res, i24d.body, isStreaming);
      return sendResponse(res, makeResponse(formatted, body), isStreaming);
    }

    if (DENY_RE.test(userText)) {
      console.log(`[proxy] ✗ denied: ${pending.tool}`);
      return sendResponse(
        res,
        makeResponse("Cancelled. Let me know if you need anything else.", body),
        isStreaming
      );
    }
  }

  // ── 2. Slash commands ───────────────────────────────────────────────
  const slash = parseSlashCommand(userText);
  if (slash) {
    if (slash.type === "auto") {
      console.log(`[proxy] /cmd: ${slash.tool}`);
      const result    = await invokeTool(slash.tool, slash.args);
      const formatted = formatResult(slash.tool, result);

      const lastIdx  = messages.map((m) => m.role).lastIndexOf("user");
      const augmented = messages.map((m, i) =>
        i === lastIdx
          ? { ...m, content: `${userText}\n\n[PC Data]\n${formatted}\n[/PC Data]\n\nRespond based on the data above.` }
          : m
      );
      const i24d = await callI24D(augmented, body);
      if (i24d.status === 200 && i24d.body?.choices?.[0])
        return sendResponse(res, i24d.body, isStreaming);
      return sendResponse(res, makeResponse(formatted, body), isStreaming);
    }

    if (slash.type === "approval") {
      console.log(`[proxy] /cmd needs approval: ${slash.tool}`);
      const sentinel = JSON.stringify({ tool: slash.tool, args: slash.args });
      const msg =
        `I need your authorization before I can proceed.\n\n` +
        `**Action:** \`${slash.tool}\`\n` +
        `**Details:** ${slash.description ?? JSON.stringify(slash.args)}\n\n` +
        `Reply **approve** to authorize or **no** to cancel.\n` +
        `[LUMINA_PENDING:${sentinel}]`;
      return sendResponse(res, makeResponse(msg, body), isStreaming);
    }
  }

  // ── 3. Intent detection — fetch tools in parallel ───────────────────
  const intents = detectIntents(userText);
  if (intents.length > 0) {
    console.log(`[proxy] intents: ${intents.map((i) => i.label).join(", ")}`);

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

    const contextBlock = results.map(({ name, result }) => formatResult(name, result)).join("\n\n");

    let i24d;
    try {
      i24d = await askI24DWithContext(contextBlock, messages, body);
    } catch (err) {
      console.error(`[proxy] I24D error (falling back to raw data): ${err.message}`);
      i24d = null;
    }

    if (i24d?.status === 200 && i24d.body?.choices?.[0]) {
      console.log(`[proxy] → I24D answered with context (${unique.length} tool(s))`);
      return sendResponse(res, i24d.body, isStreaming);
    }

    // I24D unavailable or returned non-200 — return the raw tool data directly
    console.log(`[proxy] → I24D fallback: returning raw tool data`);
    return sendResponse(res, makeResponse(contextBlock, body), isStreaming);
  }

  // ── 4. Pass through to I24D unchanged ───────────────────────────────
  console.log(`[proxy] → pass-through`);
  const i24d = await callI24D(messages, body);
  if (i24d.status === 200)
    return sendResponse(res, i24d.body, isStreaming);

  res.writeHead(i24d.status ?? 502, { "Content-Type": "application/json" });
  res.end(JSON.stringify(i24d.body ?? { error: "upstream error" }));
}

// ── Pass-through proxy for non-chat routes (e.g. /v1/models) ─────────

function proxyToI24D(reqPath, method, body, res) {
  return new Promise((resolve, reject) => {
    const bodyStr = body && typeof body === "object" ? JSON.stringify(body) : body ?? "";
    const target  = new URL(reqPath, I24D_MODELS_BASE);

    const opts = {
      hostname: target.hostname,
      port:     443,
      path:     target.pathname + target.search,
      method,
      headers:  {
        "Content-Type":  "application/json",
        Authorization:   `Bearer ${I24D_TOKEN}`,
      },
    };
    if (bodyStr) opts.headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const pr = https.request(opts, (proxyRes) => {
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

  if (url.pathname === "/v1/chat/completions" && req.method === "POST" && body) {
    try {
      await handleChatCompletion(req, res, body);
    } catch (err) {
      console.error("[proxy] error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "proxy_error", message: err.message }));
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
});

server.on("error", (err) => {
  console.error("[proxy] fatal:", err.message);
  process.exit(1);
});
