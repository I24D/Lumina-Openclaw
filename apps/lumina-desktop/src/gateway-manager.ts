import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import type { LuminaConfig } from "./config.js";
import { bootstrapLuminaRuntime } from "./bootstrap.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 30_000;

let gatewayProcess: ChildProcess | null = null;
let proxyProcess: ChildProcess | null = null;

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

async function waitForPort(port: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isPortReady(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

function logChildOutput(child: ChildProcess, prefix: string): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[${prefix}] ${chunk.toString()}`);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${prefix}] ${chunk.toString()}`);
  });
}

function spawnBundledNodeProcess(
  entryPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prefix: string,
): ChildProcess {
  const child = spawn(process.execPath, [entryPath], {
    cwd,
    env: {
      ...process.env,
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  logChildOutput(child, prefix);
  child.on("exit", (code, signal) => {
    console.log(`[${prefix}] Exited â€” code=${code ?? "?"} signal=${signal ?? "none"}`);
  });

  return child;
}

export async function startGateway(config: LuminaConfig): Promise<void> {
  const runtimePaths = resolveRuntimePaths();
  bootstrapLuminaRuntime(config, runtimePaths);

  const runtimeEnv: NodeJS.ProcessEnv = {
    OPENCLAW_CONFIG_PATH: config.openclawConfigPath,
    OPENCLAW_STATE_DIR: config.openclawStateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: runtimePaths.openClawBundledPluginsDir,
    OPENCLAW_GATEWAY_TOKEN: config.gatewayToken,
    OPENCLAW_GATEWAY_PORT: String(config.gatewayPort),
    OPENCLAW_PORT: String(config.gatewayPort),
    OPENCLAW_TOKEN: config.gatewayToken,
  };

  if (!(await isPortReady(config.proxyPort))) {
    console.log(`[proxy] Spawning bundled runtime on port ${config.proxyPort}`);
    proxyProcess = spawnBundledNodeProcess(
      runtimePaths.proxyEntryPath,
      runtimePaths.proxyRoot,
      {
        ...runtimeEnv,
        PROXY_PORT: String(config.proxyPort),
        I24D_URL: config.i24dChatUrl,
        I24D_MODELS_BASE: config.i24dModelsBaseUrl,
        I24D_TOKEN: config.i24dToken,
      },
      "proxy",
    );
    const proxyReady = await waitForPort(config.proxyPort);
    if (!proxyReady) {
      proxyProcess.kill("SIGTERM");
      proxyProcess = null;
      throw new Error(
        `Lumina proxy did not open port ${config.proxyPort} within ${READY_TIMEOUT_MS / 1000}s`,
      );
    }
  } else {
    console.log("[proxy] Port already open â€” assuming Lumina proxy is running.");
  }

  if (!(await isPortReady(config.gatewayPort))) {
    console.log(`[gateway] Spawning bundled OpenClaw gateway on port ${config.gatewayPort}`);
    gatewayProcess = spawnBundledNodeProcess(
      runtimePaths.openClawEntryPath,
      runtimePaths.openClawRoot,
      runtimeEnv,
      "openclaw",
    );

    const gatewayReady = await waitForPort(config.gatewayPort);
    if (!gatewayReady) {
      gatewayProcess.kill("SIGTERM");
      gatewayProcess = null;
      throw new Error(
        `Gateway did not open port ${config.gatewayPort} within ${READY_TIMEOUT_MS / 1000}s`,
      );
    }
  } else {
    console.log("[gateway] Port already open â€” assuming OpenClaw gateway is running.");
  }

  console.log(`[gateway] Ready on port ${config.gatewayPort}`);
}

export function stopGateway(): void {
  if (gatewayProcess) {
    gatewayProcess.kill("SIGTERM");
    gatewayProcess = null;
  }
  if (proxyProcess) {
    proxyProcess.kill("SIGTERM");
    proxyProcess = null;
  }
}
