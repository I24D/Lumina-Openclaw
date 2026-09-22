// Verifies the Lumina development environment: config, plugins, skills, env
// secrets, Gateway reachability, and Supabase connectivity.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEFAULT_ENV_PATH = "C:\\I24D_WhatsApp\\.env";
const REQUIRED_PLUGINS = [
  "lumina-supabase",
  "active-memory",
  "memory-core",
  "memory-wiki",
  "diagnostics-otel",
  "diagnostics-prometheus",
  "workboard",
];
// coding-agent stays off on purpose: Dal's 2026-09-19 order routes coding agents
// through the session catalogs instead. session-logs was removed upstream.
const REQUIRED_SKILLS = [
  "github",
  "gh-issues",
  "healthcheck",
  "skill-creator",
  "taskflow",
  "spike",
  "diagram-maker",
  "node-inspect-debugger",
  "python-debugpy",
];
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "LUMINA_SUPABASE_ALLOW_WRITES",
  "LUMINA_SUPABASE_MAX_ROWS",
  "LUMINA_SUPABASE_SCHEMA",
  "I24D_GITHUB",
];
// Recall tools registered by each memory slot owner
// (docs/concepts/active-memory/memory-tools.md). Active Memory skips recall
// silently when its tools do not match the provider that owns the slot.
const MEMORY_SLOT_RECALL_TOOLS: Record<string, readonly string[]> = {
  "memory-core": ["memory_search", "memory_get"],
  "memory-lancedb": ["memory_recall"],
};
// Channels where Lumina answers other people. Private recall must never reach them.
const CONTACT_CHANNELS = new Set(["whatsapp"]);
// Upstream default for agents.defaults.bootstrapMaxChars (embedded-agent-helpers/bootstrap.ts).
const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;

type HealthCheck = { ok: boolean; name: string; detail: string };

/**
 * Best-effort read model for the fields this healthcheck inspects. The config
 * on disk carries far more, so every branch stays optional rather than
 * mirroring the Zod schema, which would need updating on every upstream change.
 */
type PluginEntry = {
  enabled?: boolean;
  config?: {
    envPath?: string;
    vaultMode?: string;
    bridge?: { enabled?: boolean };
    search?: { corpus?: string };
    embedding?: Record<string, unknown>;
    agents?: string[];
    toolsAllow?: string[];
  };
};
type HealthConfig = {
  agents?: {
    defaults?: { workspace?: string; bootstrapMaxChars?: number };
    entries?: Record<string, { workspace?: string } | undefined>;
  };
  bindings?: Array<{ match?: { channel?: string }; agentId?: string }>;
  plugins?: {
    allow?: string[];
    slots?: { memory?: string };
    entries?: Record<string, PluginEntry | undefined>;
  };
  skills?: { entries?: Record<string, { enabled?: boolean } | undefined> };
  diagnostics?: {
    enabled?: boolean;
    // captureContent is a plain boolean in the config schema
    // (zod-schema.root-shape.ts: z.boolean().optional()), not a nested object.
    otel?: { enabled?: boolean; captureContent?: boolean };
  };
};

type TextResponse = { status: number; body: string };
type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

const checks: HealthCheck[] = [];

function pass(name: string, detail = ""): void {
  checks.push({ ok: true, name, detail });
}

function fail(name: string, detail = ""): void {
  checks.push({ ok: false, name, detail });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readConfigFile(filePath: string): HealthConfig {
  const raw = fs.readFileSync(filePath, "utf8");
  // A config rewritten by PowerShell (Out-File/Set-Content) carries a UTF-8 BOM.
  // The Gateway's own config IO tolerates that, so this healthcheck must too:
  // JSON.parse rejects the BOM and would otherwise crash before any check runs.
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as HealthConfig;
}

/** execFileSync attaches stderr as a Buffer; anything else carries no usable detail. */
function execFailureDetail(err: unknown): string {
  const stderr =
    err && typeof err === "object" && "stderr" in err
      ? (err as { stderr?: unknown }).stderr
      : undefined;
  if (typeof stderr === "string") {
    return stderr.trim() || errorMessage(err);
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf8").trim() || errorMessage(err);
  }
  return errorMessage(err);
}

function readDotEnv(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    return env;
  }
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    const key = match?.[1];
    if (key === undefined) {
      continue;
    }
    env[key] = match?.[2] ?? "";
  }
  return env;
}

function requestText(url: string, options: RequestOptions = {}): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    let settled = false;
    const settle = (deliver: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      deliver();
    };
    const req = lib.request(
      parsed,
      {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        timeout: options.timeoutMs ?? 10_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 4096) {
            body += chunk;
            if (body.length > 4096) {
              body = body.slice(0, 4096);
            }
          }
        });
        res.on("end", () => settle(() => resolve({ status: res.statusCode ?? 0, body })));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      settle(() => reject(new Error("timeout")));
    });
    req.on("error", (err) => settle(() => reject(err)));
    req.end();
  });
}

function canConnect(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function runOpenClawConfigValidate(): void {
  try {
    // Windows resolves `openclaw` through a PATHEXT shim, so it needs cmd.exe.
    const [bin, args] =
      process.platform === "win32"
        ? (["cmd.exe", ["/d", "/s", "/c", "openclaw config validate"]] as const)
        : (["openclaw", ["config", "validate"]] as const);
    const output = execFileSync(bin, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    pass("openclaw config validate", output.split(/\r?\n/u)[0] ?? "valid");
  } catch (err) {
    fail("openclaw config validate", execFailureDetail(err));
  }
}

function checkConfig(configPath: string): HealthConfig | null {
  if (!fs.existsSync(configPath)) {
    fail("config file", `missing: ${configPath}`);
    return null;
  }
  let cfg: HealthConfig;
  try {
    cfg = readConfigFile(configPath);
  } catch (err) {
    // An unreadable config is a finding, not a reason to abort every other check.
    fail("config file", `unparseable: ${errorMessage(err)}`);
    return null;
  }
  pass("config file", configPath);

  const rawAllow = cfg.plugins?.allow;
  const allow = Array.isArray(rawAllow) ? rawAllow : [];
  const entries = cfg.plugins?.entries ?? {};
  for (const plugin of REQUIRED_PLUGINS) {
    if (!allow.includes(plugin)) {
      fail(`plugin allow: ${plugin}`, "missing from plugins.allow");
    } else if (entries[plugin]?.enabled === false) {
      fail(`plugin enabled: ${plugin}`, "explicitly disabled");
    } else {
      pass(`plugin enabled: ${plugin}`, "allowed and not disabled");
    }
  }

  const skills = cfg.skills?.entries ?? {};
  for (const skill of REQUIRED_SKILLS) {
    if (skills[skill]?.enabled === true) {
      pass(`skill enabled: ${skill}`);
    } else {
      fail(`skill enabled: ${skill}`, "missing or disabled");
    }
  }

  if (cfg.diagnostics?.enabled === true) {
    pass("diagnostics.enabled", "true");
  } else {
    fail("diagnostics.enabled", "not true");
  }
  if (cfg.diagnostics?.otel?.enabled === true) {
    pass("diagnostics.otel.enabled", "true");
  } else {
    fail("diagnostics.otel.enabled", "not true");
  }
  // Unset means disabled, so only an explicit `true` is a finding.
  if (cfg.diagnostics?.otel?.captureContent !== true) {
    pass("diagnostics content capture", "disabled");
  } else {
    fail("diagnostics content capture", "should stay disabled unless explicitly debugging content");
  }

  const wiki = entries["memory-wiki"]?.config;
  if (wiki?.vaultMode === "bridge" && wiki.bridge?.enabled === true) {
    pass("memory-wiki bridge", "enabled");
  } else {
    fail("memory-wiki bridge", "not enabled");
  }
  if (wiki?.search?.corpus === "all") {
    pass("memory-wiki search corpus", "all");
  } else {
    fail("memory-wiki search corpus", "not all");
  }

  checkMemoryCoherence(cfg, allow);
  return cfg;
}

/**
 * The memory plugins can each look healthy on their own while recall is dead:
 * a slot owner that never loads, or Active Memory asking for tools the owner
 * does not register. Both fail silently at runtime, so they are checked here.
 */
function checkMemoryCoherence(cfg: HealthConfig, allow: string[]): void {
  const entries = cfg.plugins?.entries ?? {};
  const slot = cfg.plugins?.slots?.memory ?? "memory-core";
  if (!allow.includes(slot) || entries[slot]?.enabled === false) {
    fail("memory slot owner", `${slot} is not allowed or is disabled`);
  } else if (slot === "memory-lancedb" && !entries[slot]?.config?.embedding) {
    // memory-lancedb refuses to load without an embedding config.
    fail(
      "memory slot owner",
      "memory-lancedb has no embedding config, so no recall provider loads",
    );
  } else {
    pass("memory slot owner", slot);
  }

  const activeMemory = entries["active-memory"];
  if (!activeMemory || activeMemory.enabled === false) {
    return;
  }
  const agentIds = Object.keys(cfg.agents?.entries ?? {});
  const targeted = activeMemory.config?.agents ?? [];
  const unknown = targeted.filter((id) => !agentIds.includes(id));
  if (targeted.length === 0) {
    fail("active-memory agents", "config.agents is empty, so deep recall never runs");
  } else if (unknown.length > 0) {
    fail("active-memory agents", `unknown agent ids: ${unknown.join(", ")}`);
  } else {
    pass("active-memory agents", targeted.join(", "));
  }

  const slotTools = MEMORY_SLOT_RECALL_TOOLS[slot];
  const toolsAllow = activeMemory.config?.toolsAllow;
  const foreignTools = slotTools && toolsAllow?.filter((tool) => !slotTools.includes(tool));
  if (foreignTools && foreignTools.length > 0) {
    fail("active-memory tools", `${foreignTools.join(", ")} not registered by ${slot}`);
  } else {
    pass(
      "active-memory tools",
      toolsAllow ? toolsAllow.join(", ") : `provider default for ${slot}`,
    );
  }

  const contactAgents = new Set(
    (cfg.bindings ?? [])
      .filter((binding) => CONTACT_CHANNELS.has(binding.match?.channel ?? ""))
      .map((binding) => binding.agentId),
  );
  const exposed = targeted.filter((id) => contactAgents.has(id));
  if (exposed.length > 0) {
    fail("active-memory privacy", `contact-facing agents targeted: ${exposed.join(", ")}`);
  } else {
    pass("active-memory privacy", "no contact-facing agent targeted");
  }

  checkCuratedMemoryBudget(cfg);
}

/** A MEMORY.md over the bootstrap budget is silently cut in the middle every session. */
function checkCuratedMemoryBudget(cfg: HealthConfig): void {
  const workspace = cfg.agents?.defaults?.workspace;
  if (!workspace) {
    return;
  }
  const memoryPath = path.join(workspace, "MEMORY.md");
  if (!fs.existsSync(memoryPath)) {
    return;
  }
  const budget = cfg.agents?.defaults?.bootstrapMaxChars ?? DEFAULT_BOOTSTRAP_MAX_CHARS;
  const length = fs.readFileSync(memoryPath, "utf8").trim().length;
  if (length > budget) {
    fail(
      "MEMORY.md budget",
      `${length} chars > bootstrapMaxChars ${budget}; the middle is truncated`,
    );
  } else {
    pass("MEMORY.md budget", `${length}/${budget} chars`);
  }
}

function checkEnv(envPath: string): Record<string, string> {
  const env = readDotEnv(envPath);
  if (Object.keys(env).length === 0) {
    fail("env file", `missing or empty: ${envPath}`);
    return env;
  }
  pass("env file", envPath);
  for (const key of REQUIRED_ENV) {
    const value = env[key];
    if (value) {
      // Length only: the values are live secrets and must never be logged.
      pass(`env ${key}`, `present length=${value.length}`);
    } else {
      fail(`env ${key}`, "missing");
    }
  }
  return env;
}

async function checkGateway(port: number): Promise<void> {
  const connected = await canConnect("127.0.0.1", port);
  if (!connected) {
    fail("gateway port", `127.0.0.1:${port} not listening`);
    return;
  }
  pass("gateway port", `127.0.0.1:${port}`);
  try {
    const res = await requestText(`http://127.0.0.1:${port}/chat?session=agent%3Amain%3Amain`, {
      timeoutMs: 10_000,
    });
    if (res.status === 200) {
      pass("gateway chat route", `HTTP ${res.status}`);
    } else {
      fail("gateway chat route", `HTTP ${res.status}`);
    }
  } catch (err) {
    fail("gateway chat route", errorMessage(err));
  }
}

/**
 * A coherent config can still recall nothing: a stale index or an embedding
 * provider out of credits both answer with an empty result set. Only a real
 * query through the running gateway shows it.
 */
function checkMemorySearch(): void {
  const openclawEntry = path.join(path.dirname(import.meta.dirname), "openclaw.mjs");
  try {
    const output = execFileSync(
      process.execPath,
      [
        openclawEntry,
        "gateway",
        "call",
        "memory.search",
        "--params",
        JSON.stringify({ query: "Dal", agentId: "main", maxResults: 1 }),
        "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    const response = JSON.parse(output.slice(output.indexOf("{"))) as {
      provider?: string;
      searchMode?: string;
      results?: unknown[];
      stale?: boolean;
      warning?: string;
    };
    if (response.stale) {
      fail("memory search", response.warning ?? "index stale");
    } else if (!response.results?.length) {
      fail("memory search", "no results for a query the memory must answer");
    } else {
      pass("memory search", `${response.provider ?? "?"}, ${response.searchMode ?? "?"}`);
    }
  } catch (err) {
    // `gateway call --json` reports request errors on stdout with a non-zero exit.
    const stdout =
      err && typeof err === "object" && "stdout" in err
        ? String((err as { stdout?: unknown }).stdout)
        : "";
    const gatewayError = /"message":\s*"([^"]+)"/u.exec(stdout)?.[1];
    fail("memory search", gatewayError ?? execFailureDetail(err).split(/\r?\n/u)[0] ?? "failed");
  }
}

async function checkSupabase(env: Record<string, string>): Promise<void> {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    fail("supabase connectivity", "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return;
  }
  const base = url.replace(/\/+$/u, "");
  try {
    const res = await requestText(`${base}/rest/v1/`, {
      timeoutMs: 10_000,
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        accept: "application/openapi+json",
      },
    });
    if (res.status >= 200 && res.status < 300) {
      pass("supabase connectivity", `HTTP ${res.status}`);
    } else {
      fail("supabase connectivity", `HTTP ${res.status}`);
    }
  } catch (err) {
    fail("supabase connectivity", errorMessage(err));
  }
}

function printReport(): void {
  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    const icon = check.ok ? "OK " : "BAD";
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`${icon} ${check.name}${detail}`);
  }
  console.log("");
  if (failed.length > 0) {
    console.log(`Lumina health: ${failed.length} failing check(s).`);
    process.exitCode = 1;
  } else {
    console.log("Lumina health: all checks passed.");
  }
}

const configPath = process.env.OPENCLAW_CONFIG_PATH || DEFAULT_CONFIG_PATH;
const cfg = checkConfig(configPath);
const luminaEnvPath =
  cfg?.plugins?.entries?.["lumina-supabase"]?.config?.envPath ||
  process.env.LUMINA_ENV_PATH ||
  DEFAULT_ENV_PATH;
const env = checkEnv(luminaEnvPath);
runOpenClawConfigValidate();
await checkGateway(Number(process.env.OPENCLAW_GATEWAY_PORT || 18789));
checkMemorySearch();
await checkSupabase(env);
printReport();
