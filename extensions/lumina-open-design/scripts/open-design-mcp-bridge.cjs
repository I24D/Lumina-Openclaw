const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_INSTALL_ROOT = path.join(process.env.LOCALAPPDATA || "", "Programs", "Open Design");
const executablePath =
  process.env.OD_EXECUTABLE_PATH || path.join(DEFAULT_INSTALL_ROOT, "Open Design.exe");
const daemonCliPath =
  process.env.OD_DAEMON_CLI_PATH ||
  path.join(DEFAULT_INSTALL_ROOT, "resources", "app", "prebundled", "daemon", "daemon-cli.mjs");
const namespace = (process.env.OD_DESKTOP_NAMESPACE || "release-stable-win").replace(
  /[^A-Za-z0-9._-]/gu,
  "-",
);
const daemonPipe = `\\\\.\\pipe\\open-design-${namespace}-daemon`;
const startupTimeoutMs = Number(process.env.OD_STARTUP_TIMEOUT_MS || 30_000);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function discoverDaemonUrl(timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(daemonPipe);
    let buffer = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("OpenDesign Studio IPC timed out"))),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "status" })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        const url = response?.ok === true ? response?.result?.url : undefined;
        if (typeof url !== "string" || !isLoopbackUrl(url)) {
          throw new Error("OpenDesign Studio returned an invalid daemon URL");
        }
        finish(() => resolve(url.replace(/\/$/u, "")));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
  });
}

function launchStudio() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const studio = spawn(executablePath, [], {
    detached: true,
    env,
    stdio: "ignore",
    windowsHide: false,
  });
  studio.unref();
}

async function waitForDaemon() {
  try {
    return await discoverDaemonUrl();
  } catch {
    launchStudio();
  }
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    await sleep(350);
    try {
      return await discoverDaemonUrl();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `OpenDesign Studio did not expose its daemon within ${startupTimeoutMs}ms: ${lastError?.message || "unknown error"}`,
  );
}

async function main() {
  const daemonUrl = await waitForDaemon();
  const child = spawn(executablePath, [daemonCliPath, "mcp", "--daemon-url", daemonUrl], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.once("error", (error) => {
    console.error(`[lumina-open-design] MCP bridge failed: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[lumina-open-design] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { discoverDaemonUrl, isLoopbackUrl, waitForDaemon };
