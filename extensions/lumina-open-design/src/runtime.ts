import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import type { LuminaOpenDesignSettings } from "./config.js";

type RuntimeLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type OpenDesignRuntimeStatus = {
  ready: boolean;
  installed: boolean;
  version?: string;
  daemonUrl: string;
  managed: boolean;
  error?: string;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class LuminaOpenDesignRuntime {
  private child: ChildProcess | null = null;
  private starting: Promise<OpenDesignRuntimeStatus> | null = null;

  constructor(
    readonly settings: LuminaOpenDesignSettings,
    private readonly logger: RuntimeLogger,
  ) {}

  private async installed(): Promise<boolean> {
    try {
      await Promise.all([access(this.settings.executablePath), access(this.settings.cliPath)]);
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<OpenDesignRuntimeStatus> {
    const installed = await this.installed();
    if (!installed) {
      return {
        ready: false,
        installed: false,
        daemonUrl: this.settings.daemonUrl,
        managed: Boolean(this.child),
        error: "OpenDesign is not installed at the configured paths",
      };
    }
    try {
      const response = await fetch(`${this.settings.daemonUrl}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) {
        throw new Error(`health returned ${response.status}`);
      }
      const body = (await response.json()) as { version?: unknown };
      return {
        ready: true,
        installed: true,
        version: typeof body.version === "string" ? body.version : undefined,
        daemonUrl: this.settings.daemonUrl,
        managed: Boolean(this.child),
      };
    } catch (error) {
      return {
        ready: false,
        installed: true,
        daemonUrl: this.settings.daemonUrl,
        managed: Boolean(this.child),
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
    this.logger.info("lumina-open-design: starting the local OpenDesign daemon");
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

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
    }
  }

  launchDesktop(): void {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(this.settings.executablePath, [], {
      detached: true,
      env,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  }

  async request(pathname: string, init?: RequestInit): Promise<Response> {
    const status = await this.ensureReady();
    if (!status.ready) {
      throw new Error(status.error ?? "OpenDesign daemon is unavailable");
    }
    return await fetch(`${this.settings.daemonUrl}${pathname}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
  }
}
