import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { traceStartup } from "../../infra/startup-trace.js";
import { defaultRuntime } from "../../runtime.js";
import { inheritOptionFromParent } from "../command-options.js";

export type GatewayRunOpts = {
  port?: unknown;
  bind?: unknown;
  token?: unknown;
  auth?: unknown;
  password?: unknown;
  passwordFile?: unknown;
  tailscale?: unknown;
  tailscaleResetOnExit?: boolean;
  allowUnconfigured?: boolean;
  force?: boolean;
  verbose?: boolean;
  cliBackendLogs?: boolean;
  claudeCliLogs?: boolean;
  wsLog?: unknown;
  compact?: boolean;
  rawStream?: boolean;
  rawStreamPath?: unknown;
  dev?: boolean;
  reset?: boolean;
};

const gatewayLog = {
  info(message: string) {
    defaultRuntime.log(message);
  },
  warn(message: string) {
    defaultRuntime.error(message);
  },
};

const GATEWAY_RUN_VALUE_KEYS = [
  "port",
  "bind",
  "token",
  "auth",
  "password",
  "passwordFile",
  "tailscale",
  "wsLog",
  "rawStreamPath",
] as const;

const GATEWAY_RUN_BOOLEAN_KEYS = [
  "tailscaleResetOnExit",
  "allowUnconfigured",
  "dev",
  "reset",
  "force",
  "verbose",
  "cliBackendLogs",
  "claudeCliLogs",
  "compact",
  "rawStream",
] as const;

const SUPERVISED_GATEWAY_LOCK_RETRY_MS = 5000;
const GATEWAY_AUTH_MODES = ["none", "token", "password", "trusted-proxy"] as const;
const GATEWAY_TAILSCALE_MODES = ["off", "serve", "funnel"] as const;

function toOptionString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(value: unknown): number | null {
  const raw = toOptionString(value);
  if (!raw) {
    return null;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function warnInlinePasswordFlag() {
  defaultRuntime.error(
    "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
  );
}

function resolveGatewayPasswordOption(opts: GatewayRunOpts): string | undefined {
  const direct = toOptionString(opts.password);
  const file = toOptionString(opts.passwordFile);
  if (direct && file) {
    throw new Error("Use either --password or --password-file.");
  }
  if (!file) {
    return direct;
  }
  const contents = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  if (!contents) {
    throw new Error(`Gateway password file is empty: ${file}`);
  }
  return contents;
}

function parseEnumOption<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | null {
  if (!raw) {
    return null;
  }
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

function formatModeChoices<T extends string>(modes: readonly T[]): string {
  return modes.map((mode) => `"${mode}"`).join("|");
}

function formatModeErrorList<T extends string>(modes: readonly T[]): string {
  const quoted = modes.map((mode) => `"${mode}"`);
  if (quoted.length === 0) {
    return "";
  }
  if (quoted.length === 1) {
    return quoted[0];
  }
  if (quoted.length === 2) {
    return `${quoted[0]} or ${quoted[1]}`;
  }
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

function getGatewayStartGuardErrors(params: {
  allowUnconfigured?: boolean;
  configExists: boolean;
  configAuditPath: string;
  mode: string | undefined;
}): string[] {
  if (params.allowUnconfigured || params.mode === "local") {
    return [];
  }
  if (!params.configExists) {
    return [
      "Missing config. Run `openclaw setup` or set gateway.mode=local (or pass --allow-unconfigured).",
    ];
  }
  if (params.mode === undefined) {
    return [
      [
        "Gateway start blocked: existing config is missing gateway.mode.",
        "Treat this as suspicious or clobbered config.",
        "Re-run `openclaw onboard --mode local` or `openclaw setup`, set gateway.mode=local manually, or pass --allow-unconfigured.",
      ].join(" "),
      `Config write audit: ${params.configAuditPath}`,
    ];
  }
  return [
    `Gateway start blocked: set gateway.mode=local (current: ${params.mode}) or pass --allow-unconfigured.`,
    `Config write audit: ${params.configAuditPath}`,
  ];
}

export function resolveGatewayRunOptions(
  opts: GatewayRunOpts,
  command?: Command,
): GatewayRunOpts {
  const resolved: GatewayRunOpts = { ...opts };

  for (const key of GATEWAY_RUN_VALUE_KEYS) {
    const inherited = inheritOptionFromParent(command, key);
    if (key === "wsLog") {
      resolved[key] = inherited ?? resolved[key];
      continue;
    }
    resolved[key] = resolved[key] ?? inherited;
  }

  for (const key of GATEWAY_RUN_BOOLEAN_KEYS) {
    const inherited = inheritOptionFromParent<boolean>(command, key);
    resolved[key] = Boolean(resolved[key] || inherited);
  }

  return resolved;
}

function isGatewayLockError(err: unknown): err is Error {
  return !!err && typeof err === "object" && (err as { name?: string }).name === "GatewayLockError";
}

function isHealthyGatewayLockError(err: unknown): boolean {
  if (!isGatewayLockError(err) || typeof err.message !== "string") {
    return false;
  }
  return (
    err.message.includes("gateway already running") ||
    err.message.includes("another gateway instance is already listening")
  );
}

function describeUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runGatewayCommand(opts: GatewayRunOpts) {
  traceStartup("gateway.run.begin");
  traceStartup("gateway.run.import-core.begin");
  traceStartup("gateway.run.import.config.begin");
  const configMod = await import("../../config/config.js");
  traceStartup("gateway.run.import.config.ready");

  traceStartup("gateway.run.import.types-secrets.begin");
  const { hasConfiguredSecretInput } = await import("../../config/types.secrets.js");
  traceStartup("gateway.run.import.types-secrets.ready");

  traceStartup("gateway.run.import.auth.begin");
  const { resolveGatewayAuth } = await import("../../gateway/auth.js");
  traceStartup("gateway.run.import.auth.ready");

  traceStartup("gateway.run.import.supervisor.begin");
  const { detectRespawnSupervisor } = await import("../../infra/supervisor-markers.js");
  traceStartup("gateway.run.import.supervisor.ready");

  traceStartup("gateway.run.import.run-loop.begin");
  const { runGatewayLoop } = await import("./run-loop.js");
  traceStartup("gateway.run.import.run-loop.ready");

  traceStartup("gateway.run.import.ports.begin");
  const { inspectPortUsage, formatPortDiagnostics } = await import("../../infra/ports.js");
  traceStartup("gateway.run.import.ports.ready");

  traceStartup("gateway.run.import.shared.begin");
  const { maybeExplainGatewayServiceStop, extractGatewayMiskeys } = await import("./shared.js");
  traceStartup("gateway.run.import.shared.ready");
  traceStartup("gateway.run.import-core.ready");

  const isDevProfile = process.env.OPENCLAW_PROFILE?.trim().toLowerCase() === "dev";
  const devMode = Boolean(opts.dev) || isDevProfile;
  if (opts.reset && !devMode) {
    defaultRuntime.error("Use --reset with --dev.");
    defaultRuntime.exit(1);
    return;
  }

  if (opts.rawStream) {
    process.env.OPENCLAW_RAW_STREAM = "1";
  }
  const rawStreamPath = toOptionString(opts.rawStreamPath);
  if (rawStreamPath) {
    process.env.OPENCLAW_RAW_STREAM_PATH = rawStreamPath;
  }

  if (devMode) {
    traceStartup("gateway.run.dev-config.begin");
    const { ensureDevGatewayConfig } = await import("./dev.js");
    await ensureDevGatewayConfig({ reset: Boolean(opts.reset) });
    traceStartup("gateway.run.dev-config.ready");
  }

  gatewayLog.info("loading configuration...");
  traceStartup("gateway.run.load-config.begin");
  const cfg = configMod.loadConfig();
  traceStartup("gateway.run.load-config.ready");

  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return;
  }
  const port = portOverride ?? configMod.resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return;
  }

  const bindRaw = toOptionString(opts.bind) ?? cfg.gateway?.bind ?? "loopback";
  const bind =
    bindRaw === "loopback" ||
    bindRaw === "lan" ||
    bindRaw === "auto" ||
    bindRaw === "custom" ||
    bindRaw === "tailnet"
      ? bindRaw
      : null;
  if (!bind) {
    defaultRuntime.error('Invalid --bind (use "loopback", "lan", "tailnet", "auto", or "custom")');
    defaultRuntime.exit(1);
    return;
  }

  if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
    const { cleanStaleGatewayProcessesSync } = await import("../../infra/restart-stale-pids.js");
    const stale = cleanStaleGatewayProcessesSync(port);
    if (stale.length > 0) {
      gatewayLog.info(
        `service-mode: cleared ${stale.length} stale gateway pid(s) before bind on port ${port}`,
      );
    }
  }

  if (opts.force) {
    try {
      const { forceFreePortAndWait, waitForPortBindable } = await import("../ports.js");
      const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(port, {
        timeoutMs: 2000,
        intervalMs: 100,
        sigtermTimeoutMs: 700,
      });
      if (killed.length === 0) {
        gatewayLog.info(`force: no listeners on port ${port}`);
      } else {
        for (const proc of killed) {
          gatewayLog.info(
            `force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`,
          );
        }
        if (escalatedToSigkill) {
          gatewayLog.info(`force: escalated to SIGKILL while freeing port ${port}`);
        }
        if (waitedMs > 0) {
          gatewayLog.info(`force: waited ${waitedMs}ms for port ${port} to free`);
        }
      }
      const bindProbeHost =
        bind === "loopback"
          ? "127.0.0.1"
          : bind === "lan"
            ? "0.0.0.0"
            : bind === "custom"
              ? toOptionString(cfg.gateway?.customBindHost)
              : undefined;
      const bindWaitMs = await waitForPortBindable(port, {
        timeoutMs: 3000,
        intervalMs: 150,
        host: bindProbeHost,
      });
      if (bindWaitMs > 0) {
        gatewayLog.info(`force: waited ${bindWaitMs}ms for port ${port} to become bindable`);
      }
    } catch (err) {
      defaultRuntime.error(`Force: ${String(err)}`);
      defaultRuntime.exit(1);
      return;
    }
  }

  if (opts.token) {
    const token = toOptionString(opts.token);
    if (token) {
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
    }
  }

  const authModeRaw = toOptionString(opts.auth);
  const authMode = parseEnumOption(authModeRaw, GATEWAY_AUTH_MODES);
  if (authModeRaw && !authMode) {
    defaultRuntime.error(`Invalid --auth (use ${formatModeErrorList(GATEWAY_AUTH_MODES)})`);
    defaultRuntime.exit(1);
    return;
  }

  const tailscaleRaw = toOptionString(opts.tailscale);
  const tailscaleMode = parseEnumOption(tailscaleRaw, GATEWAY_TAILSCALE_MODES);
  if (tailscaleRaw && !tailscaleMode) {
    defaultRuntime.error(
      `Invalid --tailscale (use ${formatModeErrorList(GATEWAY_TAILSCALE_MODES)})`,
    );
    defaultRuntime.exit(1);
    return;
  }

  let passwordRaw: string | undefined;
  try {
    passwordRaw = resolveGatewayPasswordOption(opts);
  } catch (err) {
    defaultRuntime.error(err instanceof Error ? err.message : String(err));
    defaultRuntime.exit(1);
    return;
  }
  if (toOptionString(opts.password)) {
    warnInlinePasswordFlag();
  }

  const tokenRaw = toOptionString(opts.token);
  gatewayLog.info("resolving authentication...");
  const snapshot = await configMod.readConfigFileSnapshot().catch(() => null);
  const configExists = snapshot?.exists ?? fs.existsSync(configMod.CONFIG_PATH);
  const configAuditPath = path.join(configMod.resolveStateDir(process.env), "logs", "config-audit.jsonl");
  const effectiveCfg = snapshot?.valid ? snapshot.config : cfg;
  const mode = effectiveCfg.gateway?.mode;
  const guardErrors = getGatewayStartGuardErrors({
    allowUnconfigured: opts.allowUnconfigured,
    configExists,
    configAuditPath,
    mode,
  });
  if (guardErrors.length > 0) {
    for (const error of guardErrors) {
      defaultRuntime.error(error);
    }
    defaultRuntime.exit(1);
    return;
  }

  const miskeys = extractGatewayMiskeys(snapshot?.parsed);
  const authOverride =
    authMode || passwordRaw || tokenRaw || authModeRaw
      ? {
          ...(authMode ? { mode: authMode } : {}),
          ...(tokenRaw ? { token: tokenRaw } : {}),
          ...(passwordRaw ? { password: passwordRaw } : {}),
        }
      : undefined;
  const resolvedAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    authOverride,
    env: process.env,
    tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off",
  });
  const resolvedAuthMode = resolvedAuth.mode;
  const tokenValue = resolvedAuth.token;
  const passwordValue = resolvedAuth.password;
  const hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
  const hasPassword =
    typeof passwordValue === "string" && passwordValue.trim().length > 0;
  const tokenConfigured =
    hasToken ||
    hasConfiguredSecretInput(
      authOverride?.token ?? cfg.gateway?.auth?.token,
      cfg.secrets?.defaults,
    );
  const passwordConfigured =
    hasPassword ||
    hasConfiguredSecretInput(
      authOverride?.password ?? cfg.gateway?.auth?.password,
      cfg.secrets?.defaults,
    );
  const hasSharedSecret =
    (resolvedAuthMode === "token" && tokenConfigured) ||
    (resolvedAuthMode === "password" && passwordConfigured);
  const canBootstrapToken = resolvedAuthMode === "token" && !tokenConfigured;
  const authHints: string[] = [];
  if (miskeys.hasGatewayToken) {
    authHints.push('Found "gateway.token" in config. Use "gateway.auth.token" instead.');
  }
  if (miskeys.hasRemoteToken) {
    authHints.push(
      '"gateway.remote.token" is for remote CLI calls; it does not enable local gateway auth.',
    );
  }
  if (resolvedAuthMode === "password" && !passwordConfigured) {
    defaultRuntime.error(
      [
        "Gateway auth is set to password, but no password is configured.",
        "Set gateway.auth.password (or OPENCLAW_GATEWAY_PASSWORD), or pass --password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }
  if (resolvedAuthMode === "none") {
    gatewayLog.warn(
      "Gateway auth mode=none explicitly configured; all gateway connections are unauthenticated.",
    );
  }
  if (
    bind !== "loopback" &&
    !hasSharedSecret &&
    !canBootstrapToken &&
    resolvedAuthMode !== "trusted-proxy"
  ) {
    defaultRuntime.error(
      [
        `Refusing to bind gateway to ${bind} without auth.`,
        "Set gateway.auth.token/password (or OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD) or pass --token/--password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }

  const tailscaleOverride =
    tailscaleMode || opts.tailscaleResetOnExit
      ? {
          ...(tailscaleMode ? { mode: tailscaleMode } : {}),
          ...(opts.tailscaleResetOnExit ? { resetOnExit: true } : {}),
        }
      : undefined;

  gatewayLog.info("starting...");
  traceStartup("gateway.run.import-server.begin");
  const { startGatewayServer } = await import("../../gateway/server.js");
  traceStartup("gateway.run.import-server.ready");

  traceStartup("gateway.run.start-loop.begin");
  const startLoop = async () =>
    await runGatewayLoop({
      runtime: defaultRuntime,
      lockPort: port,
      start: async ({ startupStartedAt } = {}) => {
        traceStartup("gateway.run.start-server.begin");
        const server = await startGatewayServer(port, {
          bind,
          auth: authOverride,
          tailscale: tailscaleOverride,
          startupStartedAt,
        });
        traceStartup("gateway.run.start-server.ready");
        return server;
      },
    });

  try {
    const supervisor = detectRespawnSupervisor(process.env);
    while (true) {
      try {
        await startLoop();
        break;
      } catch (err) {
        const isGatewayAlreadyRunning =
          isGatewayLockError(err) &&
          typeof err.message === "string" &&
          err.message.includes("gateway already running");
        if (!supervisor || !isGatewayAlreadyRunning) {
          throw err;
        }
        gatewayLog.warn(
          `gateway already running under ${supervisor}; waiting ${SUPERVISED_GATEWAY_LOCK_RETRY_MS}ms before retrying startup`,
        );
        await new Promise((resolve) => setTimeout(resolve, SUPERVISED_GATEWAY_LOCK_RETRY_MS));
      }
    }
  } catch (err) {
    if (isGatewayLockError(err)) {
      const errMessage = describeUnknownError(err);
      defaultRuntime.error(
        `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: openclaw gateway stop`,
      );
      try {
        const diagnostics = await inspectPortUsage(port);
        if (diagnostics.status === "busy") {
          for (const line of formatPortDiagnostics(diagnostics)) {
            defaultRuntime.error(line);
          }
        }
      } catch {
        // ignore diagnostics failures
      }
      await maybeExplainGatewayServiceStop();
      defaultRuntime.exit(isHealthyGatewayLockError(err) ? 0 : 1);
      return;
    }
    defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export function addGatewayRunCommand(cmd: Command): Command {
  return cmd
    .option("--port <port>", "Port for the gateway WebSocket")
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"lan"|"tailnet"|"auto"|"custom"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", `Gateway auth mode (${formatModeChoices(GATEWAY_AUTH_MODES)})`)
    .option("--password <password>", "Password for auth mode=password")
    .option("--password-file <path>", "Read gateway password from file")
    .option(
      "--tailscale <mode>",
      `Tailscale exposure mode (${formatModeChoices(GATEWAY_TAILSCALE_MODES)})`,
    )
    .option(
      "--tailscale-reset-on-exit",
      "Reset Tailscale serve/funnel configuration on shutdown",
      false,
    )
    .option(
      "--allow-unconfigured",
      "Allow gateway start without enforcing gateway.mode=local in config (does not repair config)",
      false,
    )
    .option("--dev", "Create a dev config + workspace if missing (no BOOTSTRAP.md)", false)
    .option(
      "--reset",
      "Reset dev config + credentials + sessions + workspace (requires --dev)",
      false,
    )
    .option("--force", "Kill any existing listener on the target port before starting", false)
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--cli-backend-logs",
      "Only show CLI backend logs in the console (includes stdout/stderr)",
      false,
    )
    .option("--claude-cli-logs", "Deprecated alias for --cli-backend-logs", false)
    .option("--ws-log <style>", 'WebSocket log style ("auto"|"full"|"compact")', "auto")
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .option("--raw-stream", "Log raw model stream events to jsonl", false)
    .option("--raw-stream-path <path>", "Raw stream jsonl path")
    .action(async (opts, command) => {
      await runGatewayCommand(resolveGatewayRunOptions(opts, command));
    });
}
