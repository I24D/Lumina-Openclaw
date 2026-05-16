import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { LuminaConfig } from "./config.js";
import { bootstrapLuminaRuntime } from "./bootstrap.js";
import { resolveRuntimePaths, type RuntimePaths } from "./runtime-paths.js";

const POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 600_000;

let runtimeManagerProcess: ChildProcess | null = null;
let runtimeManagerOutput = "";
let intentionalStop = false;
let lastConfig: LuminaConfig | null = null;

function appendRuntimeManagerOutput(chunk: string): void {
  runtimeManagerOutput = `${runtimeManagerOutput}${chunk}`.slice(-12_000);
}

function findNodeOnPath(): string {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"];

  for (const segment of segments) {
    for (const candidate of candidates) {
      const fullPath = path.join(segment, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return "";
}

function resolveNodeRuntime(runtimePaths: RuntimePaths): string {
  const explicitPath = process.env.LUMINA_NODE_BINARY?.trim();
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }
  if (runtimePaths.nodeRuntimePath && fs.existsSync(runtimePaths.nodeRuntimePath)) {
    return runtimePaths.nodeRuntimePath;
  }
  const nodeOnPath = findNodeOnPath();
  if (nodeOnPath) {
    return nodeOnPath;
  }
  return process.execPath;
}

function isPortReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket
      .on("connect", () => {
        socket.destroy();
        resolve(true);
      })
      .on("error", () => {
        socket.destroy();
        resolve(false);
      })
      .on("timeout", () => {
        socket.destroy();
        resolve(false);
      })
      .connect(port, "127.0.0.1");
  });
}

async function waitForPortsOrManagerExit(
  child: ChildProcess,
  proxyPort: number,
  gatewayPort: number,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  while (Date.now() < deadline) {
    if (spawnError) {
      throw spawnError;
    }

    if (child.exitCode !== null) {
      const output = runtimeManagerOutput.trim();
      throw new Error(
        output
          ? `Rust runtime manager exited before readiness. ${output}`
          : `Rust runtime manager exited with code ${child.exitCode}.`,
      );
    }

    if ((await isPortReady(proxyPort)) && (await isPortReady(gatewayPort))) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    runtimeManagerOutput.trim() ||
      `Rust runtime manager did not open ports ${proxyPort}/${gatewayPort} within ${READY_TIMEOUT_MS / 1000}s.`,
  );
}

function logChildOutput(child: ChildProcess, prefix: string): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    appendRuntimeManagerOutput(text);
    process.stdout.write(`[${prefix}] ${text}`);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    appendRuntimeManagerOutput(text);
    process.stderr.write(`[${prefix}] ${text}`);
  });
}

function ensureRuntimeManagerBinary(runtimePaths: RuntimePaths): string {
  const binaryPath = runtimePaths.runtimeManagerBinaryPath;
  if (binaryPath && fs.existsSync(binaryPath)) {
    return binaryPath;
  }
  throw new Error(
    "Lumina runtime manager binary is missing. Run `pnpm --dir Lumina_PC desktop:bootstrapper:build` or rebuild the desktop package.",
  );
}

function buildRuntimeManagerStartArgs(
  config: LuminaConfig,
  runtimePaths: RuntimePaths,
  nodeRuntimePath: string,
): string[] {
  const args = [
    "start",
    "--runtime-root",
    runtimePaths.runtimeRoot,
    "--node-executable-path",
    nodeRuntimePath,
    "--open-claw-root",
    runtimePaths.openClawRoot,
    "--open-claw-entry-path",
    runtimePaths.openClawEntryPath,
    "--openclaw-bundled-plugins-dir",
    runtimePaths.openClawBundledPluginsDir,
    "--proxy-root",
    runtimePaths.proxyRoot,
    "--proxy-entry-path",
    runtimePaths.proxyEntryPath,
    "--openclaw-config-path",
    config.openclawConfigPath,
    "--openclaw-state-dir",
    config.openclawStateDir,
    "--gateway-token",
    config.gatewayToken,
    "--gateway-port",
    String(config.gatewayPort),
    "--proxy-port",
    String(config.proxyPort),
    "--i24d-chat-url",
    config.i24dChatUrl,
    "--i24d-models-base-url",
    config.i24dModelsBaseUrl,
    "--skip-openclaw-channels",
    String(config.skipOpenClawChannels),
    "--i24d-token",
    config.i24dToken,
    "--remote-brain-timeout-ms",
    String(config.remoteBrainTimeoutMs),
    "--remote-brain-max-turns",
    String(config.remoteBrainMaxTurns),
    "--startup-timeout-ms",
    String(READY_TIMEOUT_MS),
  ];

  if (config.remoteBrainEnabled) {
    args.push("--remote-brain-enabled");
  }
  if (config.remoteBrainUrl.trim()) {
    args.push("--remote-brain-url", config.remoteBrainUrl);
  }
  if (config.remoteBrainSecret.trim()) {
    args.push("--remote-brain-secret", config.remoteBrainSecret);
  }

  return args;
}

export async function startGateway(config: LuminaConfig): Promise<void> {
  if (runtimeManagerProcess && runtimeManagerProcess.exitCode === null) {
    return;
  }

  const runtimePaths = resolveRuntimePaths();
  bootstrapLuminaRuntime(config, runtimePaths);

  const nodeRuntimePath = resolveNodeRuntime(runtimePaths);
  const runtimeManagerBinary = ensureRuntimeManagerBinary(runtimePaths);

  console.log(`[runtime-manager] Using ${runtimeManagerBinary}`);
  console.log(`[runtime-manager] Using Node runtime ${nodeRuntimePath}`);
  if (config.remoteBrainEnabled) {
    console.log(`[runtime-manager] Remote brain bridge enabled -> ${config.remoteBrainUrl}`);
  } else {
    console.log("[runtime-manager] Remote brain bridge disabled.");
  }

  intentionalStop = false;
  lastConfig = config;
  runtimeManagerOutput = "";
  runtimeManagerProcess = spawn(
    runtimeManagerBinary,
    buildRuntimeManagerStartArgs(config, runtimePaths, nodeRuntimePath),
    {
      cwd: runtimePaths.repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
    },
  );

  logChildOutput(runtimeManagerProcess, "runtime-manager");
  runtimeManagerProcess.on("exit", (code: number | null, signal: string | null) => {
    console.log(`[runtime-manager] Exited - code=${code ?? "?"} signal=${signal ?? "none"}`);
    runtimeManagerProcess = null;
    if (!intentionalStop && lastConfig !== null) {
      const configSnapshot = lastConfig;
      console.log("[runtime-manager] Unexpected exit — restarting in 3s...");
      setTimeout(() => {
        if (!intentionalStop) {
          startGateway(configSnapshot).catch((err: unknown) => {
            console.error(
              "[runtime-manager] Auto-restart failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      }, 3_000);
    }
  });

  try {
    await waitForPortsOrManagerExit(runtimeManagerProcess, config.proxyPort, config.gatewayPort);
  } catch (error) {
    stopGateway();
    throw error;
  }

  console.log(`[runtime-manager] Ready on gateway port ${config.gatewayPort}`);
}

export function stopGateway(): void {
  intentionalStop = true;
  const runtimePaths = resolveRuntimePaths();
  const managerBinaryPath = runtimePaths.runtimeManagerBinaryPath;
  const activeManagerProcess = runtimeManagerProcess;
  runtimeManagerProcess = null;

  if (managerBinaryPath && fs.existsSync(managerBinaryPath)) {
    const stopResult = spawnSync(managerBinaryPath, ["stop", "--timeout-ms", "15000"], {
      cwd: runtimePaths.repoRoot,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
    });

    if (stopResult.error) {
      console.error("[runtime-manager] Failed to request shutdown:", stopResult.error.message);
    } else if ((stopResult.status ?? 0) !== 0) {
      const stderr = stopResult.stderr?.toString().trim();
      console.error(
        "[runtime-manager] Runtime shutdown command failed:",
        stderr || `exit code ${stopResult.status ?? 0}`,
      );
    }
  }

  if (activeManagerProcess && activeManagerProcess.exitCode === null && !activeManagerProcess.killed) {
    activeManagerProcess.kill("SIGKILL");
  }
}
