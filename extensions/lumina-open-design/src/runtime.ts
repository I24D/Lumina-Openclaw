import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { LuminaOpenDesignSettings } from "./config.js";

type RuntimeLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type LuminaOpenDesignGatewayAccess = {
  apiBaseUrl: string;
  bearerToken?: string;
  openAiProxyBaseUrl?: string;
  nodeBinPath?: string;
  opencodeBinPath?: string;
};

export type OpenDesignRuntimeStatus = {
  ready: boolean;
  installed: boolean;
  version?: string;
  daemonUrl: string;
  managed: boolean;
  source: "studio" | "managed" | "configured";
  sharedDataDir: string;
  error?: string;
};

export type OpenDesignGatewayIntegration = {
  configured: boolean;
  connected: boolean;
  agentId: "opencode";
  model: "lumina/openclaw/design";
  baseUrl: string;
  error?: string;
};

type IpcResponse = {
  ok?: unknown;
  result?: unknown;
  error?: { message?: unknown };
};

const STUDIO_AGENT_ID = "opencode";
const STUDIO_MODEL = "lumina/openclaw/design";
const OPENCLAW_DESIGN_MODEL = "openclaw/design";
const LUMINA_INSTRUCTIONS_MARKER = "[Lumina OpenClaw design bridge]";
const CONNECTION_TEST_TIMEOUT_MS = 120_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requestJsonIpc(
  pipePath: string,
  payload: Record<string, unknown>,
  timeoutMs = 1_200,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath);
    let buffer = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("OpenDesign Studio IPC timed out")));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as IpcResponse;
        if (response.ok === true) {
          finish(() => resolve(response.result));
          return;
        }
        const message =
          typeof response.error?.message === "string"
            ? response.error.message
            : "OpenDesign Studio IPC rejected the request";
        finish(() => reject(new Error(message)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => {
      finish(() => reject(error));
    });
  });
}

export class LuminaOpenDesignRuntime {
  private child: ChildProcess | null = null;
  private starting: Promise<OpenDesignRuntimeStatus> | null = null;
  private gatewayIntegration: OpenDesignGatewayIntegration | null = null;

  constructor(
    readonly settings: LuminaOpenDesignSettings,
    private readonly logger: RuntimeLogger,
    private readonly gatewayAccess?: LuminaOpenDesignGatewayAccess,
  ) {}

  private async installed(): Promise<boolean> {
    try {
      await Promise.all([access(this.settings.executablePath), access(this.settings.cliPath)]);
      return true;
    } catch {
      return false;
    }
  }

  private desktopPipe(app: "daemon" | "desktop"): string {
    const namespace = this.settings.desktopNamespace.replace(/[^A-Za-z0-9._-]/gu, "-");
    return `\\\\.\\pipe\\open-design-${namespace}-${app}`;
  }

  private async desktopDaemonUrl(): Promise<string | null> {
    try {
      const status = record(await requestJsonIpc(this.desktopPipe("daemon"), { type: "status" }));
      const rawUrl = typeof status.url === "string" ? status.url : "";
      const parsed = new URL(rawUrl);
      if (
        parsed.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      ) {
        return null;
      }
      return parsed.toString().replace(/\/$/u, "");
    } catch {
      return null;
    }
  }

  private async probe(
    daemonUrl: string,
    source: OpenDesignRuntimeStatus["source"],
    installed: boolean,
  ): Promise<OpenDesignRuntimeStatus> {
    try {
      const response = await fetch(`${daemonUrl}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) {
        throw new Error(`health returned ${response.status}`);
      }
      const body = (await response.json()) as { version?: unknown };
      return {
        ready: true,
        installed,
        version: typeof body.version === "string" ? body.version : undefined,
        daemonUrl,
        managed: source === "managed",
        source,
        sharedDataDir: this.settings.dataDir,
      };
    } catch (error) {
      return {
        ready: false,
        installed,
        daemonUrl,
        managed: source === "managed",
        source,
        sharedDataDir: this.settings.dataDir,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async status(): Promise<OpenDesignRuntimeStatus> {
    const installed = await this.installed();
    if (!installed) {
      return {
        ready: false,
        installed: false,
        daemonUrl: this.settings.daemonUrl,
        managed: false,
        source: "configured",
        sharedDataDir: this.settings.dataDir,
        error: "OpenDesign is not installed at the configured paths",
      };
    }
    const studioUrl = await this.desktopDaemonUrl();
    if (studioUrl) {
      const studio = await this.probe(studioUrl, "studio", true);
      if (studio.ready) {
        return studio;
      }
    }
    const source = this.child ? "managed" : "configured";
    return await this.probe(this.settings.daemonUrl, source, true);
  }

  async ensureReady(): Promise<OpenDesignRuntimeStatus> {
    const current = await this.status();
    if (current.ready || !this.settings.autoStart || !current.installed) {
      return current;
    }
    if (this.starting) {
      return await this.starting;
    }
    this.starting = this.startManaged();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startManaged(): Promise<OpenDesignRuntimeStatus> {
    this.logger.info(
      `lumina-open-design: starting the shared OpenDesign daemon at ${this.settings.dataDir}`,
    );
    const child = spawn(this.settings.executablePath, [this.settings.cliPath, "--no-open"], {
      cwd: this.settings.resourceRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OD_BIN: this.settings.cliPath,
        OD_DAEMON_CLI_PATH: this.settings.cliPath,
        OD_DATA_DIR: this.settings.dataDir,
        OD_NODE_BIN: this.settings.executablePath,
        OD_RESOURCE_ROOT: this.settings.resourceRoot,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    this.child = child;
    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (code !== 0 && signal !== "SIGTERM") {
        this.logger.warn(
          `lumina-open-design: daemon exited (code=${String(code)}, signal=${String(signal)})`,
        );
      }
    });
    child.once("error", (error) => {
      if (this.child === child) {
        this.child = null;
      }
      this.logger.warn(`lumina-open-design: daemon launch failed: ${error.message}`);
    });

    const deadline = Date.now() + this.settings.startupTimeoutMs;
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.ready) {
        return status;
      }
      if (child.exitCode !== null) {
        return { ...status, error: `OpenDesign exited with code ${child.exitCode}` };
      }
      await sleep(350);
    }
    return {
      ...(await this.status()),
      error: `OpenDesign did not become ready within ${this.settings.startupTimeoutMs}ms`,
    };
  }

  private async stopManaged(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) {
      return;
    }
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(2_500),
    ]);
  }

  async stop(): Promise<void> {
    await this.stopManaged();
  }

  async launchDesktop(projectId?: string): Promise<OpenDesignRuntimeStatus> {
    await this.stopManaged();
    const args = projectId ? [`od://app/projects/${encodeURIComponent(projectId)}`] : [];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(this.settings.executablePath, args, {
      detached: true,
      env,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();

    const deadline = Date.now() + Math.min(this.settings.startupTimeoutMs, 30_000);
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.ready && status.source === "studio") {
        return status;
      }
      await sleep(350);
    }
    throw new Error("OpenDesign Studio did not expose its local daemon in time");
  }

  private async writeBridgeFile(filePath: string, contents: string): Promise<void> {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, filePath);
  }

  private async ensureOpenCodeBridge(): Promise<string> {
    const access = this.gatewayAccess;
    if (!access?.bearerToken) {
      throw new Error("Gateway bearer token is unavailable");
    }
    const bridgeDir = path.join(this.settings.dataDir, "lumina-openclaw");
    await mkdir(bridgeDir, { recursive: true });
    const providerPath = path.join(bridgeDir, "opencode-provider.json");
    const wrapperPath = path.join(bridgeDir, "lumina-opencode-wrapper.cjs");
    const launcherPath = path.join(bridgeDir, "lumina-opencode.cmd");
    const proxyBaseUrl =
      access.openAiProxyBaseUrl ??
      `${new URL(access.apiBaseUrl).origin}/plugins/lumina-open-design/openai/v1`;
    const opencodeBin =
      access.opencodeBinPath ??
      path.join(
        this.settings.resourceRoot,
        "bin",
        "libexec",
        "opencode",
        process.platform === "win32" ? "opencode.exe" : "opencode",
      );
    const providerConfig = {
      provider: {
        lumina: {
          npm: "@ai-sdk/openai-compatible",
          name: "Lumina OpenClaw",
          options: {
            baseURL: proxyBaseUrl,
            apiKey: access.bearerToken,
          },
          models: {
            [OPENCLAW_DESIGN_MODEL]: {
              name: "Lumina GLM 5.2",
              limit: { context: 131_072, output: 16_384 },
            },
          },
        },
      },
    };
    const wrapper = [
      'const { readFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `const provider = JSON.parse(readFileSync(${JSON.stringify(providerPath)}, "utf8"));`,
      "let inherited = {};",
      'try { inherited = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}"); } catch {}',
      "const merged = { ...inherited, provider: { ...(inherited.provider || {}), ...provider.provider } };",
      `const result = spawnSync(${JSON.stringify(opencodeBin)}, process.argv.slice(2), {`,
      '  stdio: "inherit",',
      "  env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(merged) },",
      "});",
      "if (result.error) { console.error(result.error.message); process.exit(1); }",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n");
    const nodeBin = access.nodeBinPath ?? process.execPath;
    const launcher = `@echo off\r\n"${nodeBin}" "${wrapperPath}" %*\r\n`;
    await this.writeBridgeFile(providerPath, `${JSON.stringify(providerConfig, null, 2)}\n`);
    await this.writeBridgeFile(wrapperPath, wrapper);
    await this.writeBridgeFile(launcherPath, launcher);
    return launcherPath;
  }

  async syncGatewayAgent(
    options: { testConnection?: boolean } = {},
  ): Promise<OpenDesignGatewayIntegration> {
    const access = this.gatewayAccess;
    const baseUrl =
      access?.openAiProxyBaseUrl ??
      `${new URL(access?.apiBaseUrl ?? "http://127.0.0.1:18789/v1").origin}/plugins/lumina-open-design/openai/v1`;
    if (!access?.bearerToken) {
      this.gatewayIntegration = {
        configured: false,
        connected: false,
        agentId: STUDIO_AGENT_ID,
        model: STUDIO_MODEL,
        baseUrl,
        error: "Gateway bearer token is unavailable",
      };
      return this.gatewayIntegration;
    }
    const configResponse = await this.request("/api/app-config");
    const configPayload = record(await configResponse.json());
    const current = record(configPayload.config);
    const agentCliEnv = record(current.agentCliEnv);
    const opencodeEnv = record(agentCliEnv[STUDIO_AGENT_ID]);
    const agentModels = record(current.agentModels);
    const existingInstructions =
      typeof current.customInstructions === "string" ? current.customInstructions.trim() : "";
    const bridgeInstructions = [
      LUMINA_INSTRUCTIONS_MARKER,
      "This Studio is connected to Lumina OpenClaw through the dedicated design runtime. Use the active OpenDesign project and never switch providers or models automatically.",
    ].join("\n");
    const customInstructions = existingInstructions.includes(LUMINA_INSTRUCTIONS_MARKER)
      ? existingInstructions
      : [existingInstructions, bridgeInstructions].filter(Boolean).join("\n\n");
    const opencodeBinPath = await this.ensureOpenCodeBridge();
    const nextConfig = {
      agentId: STUDIO_AGENT_ID,
      agentModels: {
        ...agentModels,
        [STUDIO_AGENT_ID]: { model: STUDIO_MODEL },
      },
      agentCliEnv: {
        ...agentCliEnv,
        [STUDIO_AGENT_ID]: {
          ...opencodeEnv,
          OPENCODE_BIN: opencodeBinPath,
        },
      },
      customInstructions,
    };
    const update = await this.request("/api/app-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nextConfig),
    });
    if (!update.ok) {
      throw new Error(`OpenDesign app config update returned ${update.status}`);
    }

    if (options.testConnection === false) {
      this.gatewayIntegration = {
        configured: true,
        connected: false,
        agentId: STUDIO_AGENT_ID,
        model: STUDIO_MODEL,
        baseUrl,
        error: "Connection check pending",
      };
      return this.gatewayIntegration;
    }

    try {
      const test = await this.request("/api/test/connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "agent",
          agentId: STUDIO_AGENT_ID,
          model: STUDIO_MODEL,
          agentCliEnv: nextConfig.agentCliEnv,
        }),
        // Spawns OpenCode and waits on a cold model round-trip, so the shared
        // 20s request budget is not enough; this runs off the boot path.
        signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
      });
      const result = record(await test.json());
      const connected = result.ok === true;
      this.gatewayIntegration = {
        configured: true,
        connected,
        agentId: STUDIO_AGENT_ID,
        model: STUDIO_MODEL,
        baseUrl,
        ...(connected
          ? {}
          : {
              error: typeof result.detail === "string" ? result.detail : "Connection test failed",
            }),
      };
      return this.gatewayIntegration;
    } catch (error) {
      this.gatewayIntegration = {
        configured: true,
        connected: false,
        agentId: STUDIO_AGENT_ID,
        model: STUDIO_MODEL,
        baseUrl,
        error: error instanceof Error ? error.message : String(error),
      };
      return this.gatewayIntegration;
    }
  }

  integrationStatus(): OpenDesignGatewayIntegration {
    return (
      this.gatewayIntegration ?? {
        configured: false,
        connected: false,
        agentId: STUDIO_AGENT_ID,
        model: STUDIO_MODEL,
        baseUrl: this.gatewayAccess?.apiBaseUrl ?? "http://127.0.0.1:18789/v1",
        error: "Integration has not been checked yet",
      }
    );
  }

  async gatewayChatCompletions(payload: Record<string, unknown>): Promise<Response> {
    const access = this.gatewayAccess;
    if (!access?.bearerToken) {
      throw new Error("Gateway bearer token is unavailable");
    }
    return await fetch(`${access.apiBaseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
  }

  async request(pathname: string, init?: RequestInit): Promise<Response> {
    const status = await this.ensureReady();
    if (!status.ready) {
      throw new Error(status.error ?? "OpenDesign daemon is unavailable");
    }
    return await fetch(`${status.daemonUrl}${pathname}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
  }
}
