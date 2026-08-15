#!/usr/bin/env node
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

const checks = [];

function pass(name, detail = "") {
  checks.push({ ok: true, name, detail });
}

function fail(name, detail = "") {
  checks.push({ ok: false, name, detail });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readDotEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    env[match[1]] = match[2];
  }
  return env;
}

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
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
        res.on("data", (chunk) => {
          if (body.length < 4096) {
            body += chunk;
            if (body.length > 4096) body = body.slice(0, 4096);
          }
        });
        res.on("end", () => finish(resolve, { status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(reject, new Error("timeout"));
    });
    req.on("error", (err) => finish(reject, err));
    req.end();
  });
}

function canConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
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

function runOpenClawConfigValidate() {
  try {
    const command =
      process.platform === "win32"
        ? ["cmd.exe", ["/d", "/s", "/c", "openclaw config validate"]]
        : ["openclaw", ["config", "validate"]];
    const output = execFileSync(command[0], command[1], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    pass("openclaw config validate", output.split(/\r?\n/u)[0] ?? "valid");
  } catch (err) {
    fail("openclaw config validate", err.stderr?.toString().trim() || err.message);
  }
}

function checkConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    fail("config file", `missing: ${configPath}`);
    return null;
  }
  const cfg = readJson(configPath);
  pass("config file", configPath);

  const allow = Array.isArray(cfg.plugins?.allow) ? cfg.plugins.allow : [];
  const entries = cfg.plugins?.entries ?? {};
  for (const plugin of REQUIRED_PLUGINS) {
    if (!allow.includes(plugin)) fail(`plugin allow: ${plugin}`, "missing from plugins.allow");
    else if (entries[plugin]?.enabled === false)
      fail(`plugin enabled: ${plugin}`, "explicitly disabled");
    else pass(`plugin enabled: ${plugin}`, "allowed and not disabled");
  }

  const skills = cfg.skills?.entries ?? {};
  for (const skill of REQUIRED_SKILLS) {
    if (skills[skill]?.enabled === true) pass(`skill enabled: ${skill}`);
    else fail(`skill enabled: ${skill}`, "missing or disabled");
  }

  if (cfg.diagnostics?.enabled === true) pass("diagnostics.enabled", "true");
  else fail("diagnostics.enabled", "not true");
  if (cfg.diagnostics?.otel?.enabled === true) pass("diagnostics.otel.enabled", "true");
  else fail("diagnostics.otel.enabled", "not true");
  if (cfg.diagnostics?.otel?.captureContent?.enabled === false) {
    pass("diagnostics content capture", "disabled");
  } else {
    fail("diagnostics content capture", "should stay disabled unless explicitly debugging content");
  }

  const wiki = entries["memory-wiki"]?.config;
  if (wiki?.vaultMode === "bridge" && wiki?.bridge?.enabled === true) {
    pass("memory-wiki bridge", "enabled");
  } else {
    fail("memory-wiki bridge", "not enabled");
  }
  if (wiki?.search?.corpus === "all") pass("memory-wiki search corpus", "all");
  else fail("memory-wiki search corpus", "not all");

  return cfg;
}

function checkEnv(envPath) {
  const env = readDotEnv(envPath);
  if (Object.keys(env).length === 0) {
    fail("env file", `missing or empty: ${envPath}`);
    return env;
  }
  pass("env file", envPath);
  for (const key of REQUIRED_ENV) {
    if (env[key]) pass(`env ${key}`, `present length=${env[key].length}`);
    else fail(`env ${key}`, "missing");
  }
  return env;
}

async function checkGateway(port) {
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
    if (res.status === 200) pass("gateway chat route", `HTTP ${res.status}`);
    else fail("gateway chat route", `HTTP ${res.status}`);
  } catch (err) {
    fail("gateway chat route", err.message);
  }
}

async function checkSupabase(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    fail("supabase connectivity", "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return;
  }
  const base = env.SUPABASE_URL.replace(/\/+$/u, "");
  try {
    const res = await requestText(`${base}/rest/v1/`, {
      timeoutMs: 10_000,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: "application/openapi+json",
      },
    });
    if (res.status >= 200 && res.status < 300) pass("supabase connectivity", `HTTP ${res.status}`);
    else fail("supabase connectivity", `HTTP ${res.status}`);
  } catch (err) {
    fail("supabase connectivity", err.message);
  }
}

function printReport() {
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
