import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { inheritOptionFromParent } from "../command-options.js";
import type { GatewayRunOpts } from "./run.js";

function runGatewayCommand(action: () => Promise<void>, label?: string) {
  return action().catch((err) => {
    const message = String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

function parseDaysOption(raw: unknown, fallback = 30): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return fallback;
}

function addGatewayRpcOptions(cmd: Command): Command {
  return cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--expect-final", "Wait for final response (agent)", false)
    .option("--json", "Output JSON", false);
}

function resolveGatewayRpcOptions<T extends { token?: string; password?: string }>(
  opts: T,
  command?: Command,
): T {
  const parentToken = inheritOptionFromParent<string>(command, "token");
  const parentPassword = inheritOptionFromParent<string>(command, "password");
  return {
    ...opts,
    token: opts.token ?? parentToken,
    password: opts.password ?? parentPassword,
  };
}

function addGatewayRunOptions(cmd: Command): Command {
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
    .option("--auth <mode>", 'Gateway auth mode ("none"|"token"|"password"|"trusted-proxy")')
    .option("--password <password>", "Password for auth mode=password")
    .option("--password-file <path>", "Read gateway password from file")
    .option("--tailscale <mode>", 'Tailscale exposure mode ("off"|"serve"|"funnel")')
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
    .option("--raw-stream-path <path>", "Raw stream jsonl path");
}

function addLazyGatewayRunCommand(cmd: Command): Command {
  return addGatewayRunOptions(cmd).action(async (opts, command) => {
    await runGatewayCommand(async () => {
      if (process.env.OPENCLAW_STARTUP_TRACE === "1") {
        process.stderr.write("[openclaw-startup gateway-cli] run.action.begin\n");
      }
      const mod = await import("./run.js");
      if (process.env.OPENCLAW_STARTUP_TRACE === "1") {
        process.stderr.write("[openclaw-startup gateway-cli] run.action.import.ready\n");
      }
      await mod.runGatewayCommand(mod.resolveGatewayRunOptions(opts as GatewayRunOpts, command));
    }, "Gateway failed to start");
  });
}

function addLazyGatewayServiceCommands(parent: Command, opts?: { statusDescription?: string }): void {
  parent
    .command("status")
    .description(opts?.statusDescription ?? "Show gateway service status + probe the Gateway")
    .option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--no-probe", "Skip RPC probe")
    .option("--require-rpc", "Exit non-zero when the RPC probe fails", false)
    .option("--deep", "Scan system-level services", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runGatewayCommand(async () => {
        const { runDaemonStatus } = await import("../daemon-cli/runners.js");
        await runDaemonStatus({
          rpc: resolveGatewayRpcOptions(cmdOpts, command),
          probe: Boolean(cmdOpts.probe),
          requireRpc: Boolean(cmdOpts.requireRpc),
          deep: Boolean(cmdOpts.deep),
          json: Boolean(cmdOpts.json),
        });
      }, "Gateway status failed");
    });

  parent
    .command("install")
    .description("Install the Gateway service (launchd/systemd/schtasks)")
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--token <token>", "Gateway token (token auth)")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runGatewayCommand(async () => {
        const { runDaemonInstall } = await import("../daemon-cli/runners.js");
        const parentForce = inheritOptionFromParent<boolean>(command, "force");
        const parentPort = inheritOptionFromParent<string>(command, "port");
        const parentToken = inheritOptionFromParent<string>(command, "token");
        await runDaemonInstall({
          ...cmdOpts,
          force: Boolean(cmdOpts.force || parentForce),
          port: cmdOpts.port ?? parentPort,
          token: cmdOpts.token ?? parentToken,
        });
      }, "Gateway install failed");
    });

  parent
    .command("uninstall")
    .description("Uninstall the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runGatewayCommand(async () => {
        const { runDaemonUninstall } = await import("../daemon-cli/runners.js");
        await runDaemonUninstall(cmdOpts);
      }, "Gateway uninstall failed");
    });

  parent
    .command("start")
    .description("Start the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runGatewayCommand(async () => {
        const { runDaemonStart } = await import("../daemon-cli/runners.js");
        await runDaemonStart(cmdOpts);
      }, "Gateway start failed");
    });

  parent
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runGatewayCommand(async () => {
        const { runDaemonStop } = await import("../daemon-cli/runners.js");
        await runDaemonStop(cmdOpts);
      }, "Gateway stop failed");
    });

  parent
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runGatewayCommand(async () => {
        const { runDaemonRestart } = await import("../daemon-cli/runners.js");
        await runDaemonRestart(cmdOpts);
      }, "Gateway restart failed");
    });
}

export function registerGatewayCli(program: Command) {
  const gateway = program
    .command("gateway")
    .description("Run, inspect, and query the WebSocket Gateway");

  addLazyGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );

  addLazyGatewayServiceCommands(gateway, {
    statusDescription: "Show gateway service status + probe the Gateway",
  });

  addGatewayRpcOptions(
    gateway
      .command("call")
      .description("Call a Gateway method")
      .argument("<method>", "Method name (health/status/system-presence/cron.*)")
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts, command) => {
        await runGatewayCommand(async () => {
          const [{ callGatewayCli }, { readBestEffortConfig }] = await Promise.all([
            import("./call.js"),
            import("../../config/config.js"),
          ]);
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const config = await readBestEffortConfig();
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, { ...rpcOpts, config }, params);
          defaultRuntime.writeJson(result);
        }, "Gateway call failed");
      }),
  );

  addGatewayRpcOptions(
    gateway
      .command("usage-cost")
      .description("Fetch usage cost summary from session logs")
      .option("--days <days>", "Number of days to include", "30")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const [{ callGatewayCli }, { readBestEffortConfig }, { formatTokenCount, formatUsd }] =
            await Promise.all([
              import("./call.js"),
              import("../../config/config.js"),
              import("../../utils/usage-format.js"),
            ]);
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const days = parseDaysOption(opts.days);
          const config = await readBestEffortConfig();
          const result = await callGatewayCli("usage.cost", { ...rpcOpts, config }, { days });
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const summary = result as {
            totals?: { totalCost?: number; totalTokens?: number; missingCostEntries?: number };
            daily?: Array<{ date?: string; totalCost?: number; totalTokens?: number }>;
          };
          const totalCost = formatUsd(summary.totals?.totalCost ?? 0) ?? "$0.00";
          const totalTokens = formatTokenCount(summary.totals?.totalTokens ?? 0) ?? "0";
          defaultRuntime.log(`Usage cost (${days} days)`);
          defaultRuntime.log(`Total: ${totalCost} | ${totalTokens} tokens`);
          if ((summary.totals?.missingCostEntries ?? 0) > 0) {
            defaultRuntime.log(`Missing entries: ${summary.totals?.missingCostEntries ?? 0}`);
          }
          const latest = summary.daily?.at(-1);
          if (latest) {
            const latestCost = formatUsd(latest.totalCost ?? 0) ?? "$0.00";
            const latestTokens = formatTokenCount(latest.totalTokens ?? 0) ?? "0";
            defaultRuntime.log(
              `Latest day: ${latest.date ?? "unknown"} | ${latestCost} | ${latestTokens} tokens`,
            );
          }
        }, "Gateway usage cost failed");
      }),
  );

  addGatewayRpcOptions(
    gateway
      .command("health")
      .description("Fetch Gateway health")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const [{ callGatewayCli }, { readBestEffortConfig }] = await Promise.all([
            import("./call.js"),
            import("../../config/config.js"),
          ]);
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const config = await readBestEffortConfig();
          const result = await callGatewayCli("health", { ...rpcOpts, config });
          defaultRuntime.writeJson(result);
        }, "Gateway health failed");
      }),
  );

  gateway
    .command("probe")
    .description("Show gateway reachability + discovery + health + status summary (local + remote)")
    .option("--url <url>", "Explicit Gateway WebSocket URL (still probes localhost)")
    .option("--ssh <target>", "SSH target for remote gateway tunnel (user@host or user@host:port)")
    .option("--ssh-identity <path>", "SSH identity file path")
    .option("--ssh-auto", "Try to derive an SSH target from Bonjour discovery", false)
    .option("--token <token>", "Gateway token (applies to all probes)")
    .option("--password <password>", "Gateway password (applies to all probes)")
    .option("--timeout <ms>", "Overall probe budget in ms", "3000")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      await runGatewayCommand(async () => {
        const rpcOpts = resolveGatewayRpcOptions(opts, command);
        const { gatewayStatusCommand } = await import("../../commands/gateway-status.js");
        await gatewayStatusCommand(rpcOpts, defaultRuntime);
      }, "Gateway probe failed");
    });

  gateway
    .command("discover")
    .description("Discover gateways via Bonjour (local + wide-area if configured)")
    .option("--timeout <ms>", "Per-command timeout in ms", "2000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runGatewayCommand(async () => {
        const [
          { readBestEffortConfig },
          { resolveWideAreaDiscoveryDomain },
          { discoverGatewayBeacons },
          { withProgress },
          { dedupeBeacons, parseDiscoverTimeoutMs, pickBeaconHost, pickGatewayPort, renderBeaconLines },
          { isRich },
        ] = await Promise.all([
          import("../../config/config.js"),
          import("../../infra/widearea-dns.js"),
          import("../../infra/bonjour-discovery.js"),
          import("../progress.js"),
          import("./discover.js"),
          import("../../terminal/theme.js"),
        ]);
        const cfg = await readBestEffortConfig();
        const wideAreaDomain = resolveWideAreaDiscoveryDomain({
          configDomain: cfg.discovery?.wideArea?.domain,
        });
        const timeoutMs = parseDiscoverTimeoutMs(opts.timeout, 2000);
        const domains = ["local.", ...(wideAreaDomain ? [wideAreaDomain] : [])];
        const beacons = await withProgress(
          {
            label: "Scanning for gateways...",
            indeterminate: true,
            enabled: opts.json !== true,
            delayMs: 0,
          },
          async () => await discoverGatewayBeacons({ timeoutMs, wideAreaDomain }),
        );

        const deduped = dedupeBeacons(beacons).toSorted((a, b) =>
          String(a.displayName || a.instanceName).localeCompare(
            String(b.displayName || b.instanceName),
          ),
        );

        if (opts.json) {
          const enriched = deduped.map((b) => {
            const host = pickBeaconHost(b);
            const port = pickGatewayPort(b);
            return { ...b, wsUrl: host ? `ws://${host}:${port}` : null };
          });
          defaultRuntime.writeJson({
            timeoutMs,
            domains,
            count: enriched.length,
            beacons: enriched,
          });
          return;
        }

        const rich = isRich();
        defaultRuntime.log("Gateway Discovery");
        defaultRuntime.log(`Found ${deduped.length} gateway(s) | domains: ${domains.join(", ")}`);
        if (deduped.length === 0) {
          return;
        }

        for (const beacon of deduped) {
          for (const line of renderBeaconLines(beacon, rich)) {
            defaultRuntime.log(line);
          }
        }
      }, "Gateway discover failed");
    });
}
