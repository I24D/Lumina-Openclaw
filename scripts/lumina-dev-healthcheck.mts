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
  "qa-lab",
  "workboard",
];
const REQUIRED_SKILLS = [
  "coding-agent",
  "github",
  "gh-issues",
  "healthcheck",
  "session-logs",
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
  };
};
type HealthConfig = {
  plugins?: { allow?: string[]; entries?: Record<string, PluginEntry | undefined> };
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

  return cfg;
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
await checkSupabase(env);
printReport();
