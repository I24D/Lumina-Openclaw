const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_INSTALL_ROOT = path.join(process.env.LOCALAPPDATA || "", "Programs", "Open Design");
const DEFAULT_APPDATA =
  process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
const executablePath =
  process.env.OD_EXECUTABLE_PATH || path.join(DEFAULT_INSTALL_ROOT, "Open Design.exe");
const daemonCliPath =
  process.env.OD_DAEMON_CLI_PATH ||
  path.join(DEFAULT_INSTALL_ROOT, "resources", "app", "prebundled", "daemon", "daemon-cli.mjs");
const namespace = (process.env.OD_DESKTOP_NAMESPACE || "release-stable-win").replace(
  /[^A-Za-z0-9._-]/gu,
  "-",
);
const resourceRoot =
  process.env.OD_RESOURCE_ROOT || path.join(DEFAULT_INSTALL_ROOT, "resources", "open-design");
const dataDir =
  process.env.OD_DATA_DIR ||
  path.join(DEFAULT_APPDATA, "Open Design", "namespaces", namespace, "data");
const daemonPipe = `\\\\.\\pipe\\open-design-${namespace}-daemon`;
const headlessDaemonUrl = (process.env.OD_DAEMON_URL || "http://127.0.0.1:7456").replace(
  /\/$/u,
  "",
);
const startupTimeoutMs = Number(process.env.OD_STARTUP_TIMEOUT_MS || 30_000);

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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

/**
 * The Studio window belongs to the user. This bridge never summons it on its own;
 * only an explicit opt-in may, so that closing the window keeps it closed.
 */
function studioLaunchAllowed(env = process.env) {
  return env.OD_LAUNCH_STUDIO === "1";
}

/** Daemon with no user interface: ELECTRON_RUN_AS_NODE keeps Electron from creating a window. */
function headlessDaemonPlan() {
  return {
    command: executablePath,
    args: [daemonCliPath, "--no-open"],
    options: {
      cwd: resourceRoot,
      detached: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OD_BIN: daemonCliPath,
        OD_DAEMON_CLI_PATH: daemonCliPath,
        OD_DATA_DIR: dataDir,
        OD_NODE_BIN: executablePath,
        OD_RESOURCE_ROOT: resourceRoot,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  };
}

/** The full desktop Studio, window included. Only for an explicit user request. */
function studioPlan() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    command: executablePath,
    args: [],
    options: { detached: true, env, stdio: "ignore", windowsHide: false },
  };
}

function runPlan(plan) {
  const child = spawn(plan.command, plan.args, plan.options);
  child.unref();
  return child;
}

function launchHeadlessDaemon() {
  return runPlan(headlessDaemonPlan());
}

function launchStudio() {
  return runPlan(studioPlan());
}

/** Which process to start when nothing is serving yet. Pure: decides, does not act. */
function chooseLaunchPlan(env = process.env) {
  return studioLaunchAllowed(env) ? studioPlan() : headlessDaemonPlan();
}

function discoverDaemonUrl(timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(daemonPipe);
    let buffer = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
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
      if (newline < 0) {
        return;
      }
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

/** The headless daemon URL when one is already listening, else null. */
async function probeHeadlessDaemon(timeoutMs = 1_500) {
  if (!isLoopbackUrl(headlessDaemonUrl)) {
    return null;
  }
  try {
    const response = await fetch(`${headlessDaemonUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? headlessDaemonUrl : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a daemon URL for the MCP server, preferring whatever is already running
 * so that starting a chat never materializes a window the user did not ask for.
 */
async function waitForDaemon(deps = {}) {
  const launch = deps.launch ?? runPlan;
  const findStudio = deps.discoverDaemonUrl ?? discoverDaemonUrl;
  const findHeadless = deps.probeHeadlessDaemon ?? probeHeadlessDaemon;
  const env = deps.env ?? process.env;

  // 1. The Studio is already open because the user opened it: reuse it, never duplicate it.
  try {
    return await findStudio();
  } catch {
    // The Studio is closed. That is a legitimate state, not an error.
  }

  // 2. A headless daemon is already serving (the plugin service starts one with the Gateway).
  const running = await findHeadless();
  if (running) {
    return running;
  }

  // 3. Nothing is serving: start a windowless daemon, or the Studio only on explicit request.
  launch(chooseLaunchPlan(env));

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(350);
    const headless = await findHeadless();
    if (headless) {
      return headless;
    }
    try {
      return await findStudio();
    } catch {
      // Keep polling until the deadline.
    }
  }
  throw new Error(
    `OpenDesign did not expose its daemon within ${startupTimeoutMs}ms (headless=${headlessDaemonUrl}, studioLaunch=${studioLaunchAllowed(env)})`,
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

module.exports = {
  chooseLaunchPlan,
  discoverDaemonUrl,
  headlessDaemonPlan,
  isLoopbackUrl,
  launchHeadlessDaemon,
  launchStudio,
  probeHeadlessDaemon,
  studioLaunchAllowed,
  studioPlan,
  waitForDaemon,
};
