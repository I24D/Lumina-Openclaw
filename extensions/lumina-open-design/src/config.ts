import path from "node:path";

export type LuminaOpenDesignSettings = {
  daemonUrl: string;
  executablePath: string;
  cliPath: string;
  resourceRoot: string;
  dataDir: string;
  autoStart: boolean;
  sessionKey: string;
  startupTimeoutMs: number;
};

type StringMap = Record<string, unknown>;

function record(value: unknown): StringMap {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StringMap) : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveLuminaOpenDesignSettings(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): LuminaOpenDesignSettings {
  const config = record(input);
  const localAppData = stringValue(
    env.LOCALAPPDATA,
    path.join(env.USERPROFILE ?? "", "AppData", "Local"),
  );
  const installRoot = path.join(localAppData, "Programs", "Open Design");
  const appRoot = path.join(installRoot, "resources", "app");
  const daemonUrl = stringValue(config.daemonUrl, "http://127.0.0.1:7456");
  const parsed = new URL(daemonUrl);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("lumina-open-design daemonUrl must be an HTTP loopback URL");
  }
  return {
    daemonUrl: parsed.toString().replace(/\/$/u, ""),
    executablePath: stringValue(config.executablePath, path.join(installRoot, "Open Design.exe")),
    cliPath: stringValue(
      config.cliPath,
      path.join(appRoot, "prebundled", "daemon", "daemon-cli.mjs"),
    ),
    resourceRoot: stringValue(
      config.resourceRoot,
      path.join(installRoot, "resources", "open-design"),
    ),
    dataDir: path.join(appRoot, "prebundled", ".od"),
    autoStart: config.autoStart !== false,
    sessionKey: stringValue(config.sessionKey, "agent:main:main"),
    startupTimeoutMs: Math.min(
      120_000,
      Math.max(5_000, numberValue(config.startupTimeoutMs, 45_000)),
    ),
  };
}
