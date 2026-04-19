import { spawn, type ChildProcess } from "node:child_process";
import net  from "node:net";
import path from "node:path";
import fs   from "node:fs";
import os   from "node:os";
import type { LuminaConfig } from "./config.js";

// process.resourcesPath is injected by Electron at runtime.
// Declare it here so TypeScript doesn't complain in this non-electron-importing file.
declare const process: NodeJS.Process & { resourcesPath: string };

const POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 30_000;

let gatewayProcess: ChildProcess | null = null;

function findOpenclaw(): string | null {
  // 1. Binary bundled inside the Electron extraResources folder
  const bundledBase = path.join(process.resourcesPath ?? "", "openclaw", "openclaw");
  const candidates  = [
    process.platform === "win32" ? `${bundledBase}.exe` : bundledBase,
    // 2. Common system locations
    ...(process.platform === "win32"
      ? [
          path.join(os.homedir(), "AppData", "Local", "Programs", "openclaw", "openclaw.exe"),
          "openclaw.exe",
          "openclaw",
        ]
      : [
          "/usr/local/bin/openclaw",
          "/opt/homebrew/bin/openclaw",
          path.join(os.homedir(), ".local", "bin", "openclaw"),
          "openclaw",
        ]),
  ];

  for (const candidate of candidates) {
    // Absolute path — check existence; relative path — trust OS PATH
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }

  return null;
}

function isPortReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket
      .on("connect", () => { socket.destroy(); resolve(true);  })
      .on("error",   () => { socket.destroy(); resolve(false); })
      .on("timeout", () => { socket.destroy(); resolve(false); })
      .connect(port, "127.0.0.1");
  });
}

async function waitForPort(port: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isPortReady(port)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

export async function startGateway(config: LuminaConfig): Promise<void> {
  // If the port is already open, a gateway is already running — skip spawn
  if (await isPortReady(config.gatewayPort)) {
    console.log("[gateway] Port already open — assuming gateway is running.");
    return;
  }

  const openclaw = findOpenclaw();
  if (!openclaw) {
    throw new Error(
      "Openclaw CLI not found.\n" +
      "Install it from https://openclaw.ai, or bundle it in the app's extraResources.",
    );
  }

  console.log(`[gateway] Spawning: ${openclaw} gateway run`);

  gatewayProcess = spawn(openclaw, ["gateway", "run"], {
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_TOKEN: config.gatewayToken,
      OPENCLAW_GATEWAY_PORT:  String(config.gatewayPort),
      BRAIN_URL:              config.brainUrl,
    },
    stdio:    ["ignore", "pipe", "pipe"],
    detached: false,
  });

  gatewayProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[openclaw] ${chunk.toString()}`);
  });

  gatewayProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[openclaw] ${chunk.toString()}`);
  });

  gatewayProcess.on("exit", (code, signal) => {
    console.log(`[gateway] Exited — code=${code ?? "?"} signal=${signal ?? "none"}`);
    gatewayProcess = null;
  });

  const ready = await waitForPort(config.gatewayPort);
  if (!ready) {
    gatewayProcess.kill("SIGTERM");
    gatewayProcess = null;
    throw new Error(
      `Gateway did not open port ${config.gatewayPort} within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }

  console.log(`[gateway] Ready on port ${config.gatewayPort}`);
}

export function stopGateway(): void {
  if (gatewayProcess) {
    gatewayProcess.kill("SIGTERM");
    gatewayProcess = null;
  }
}
