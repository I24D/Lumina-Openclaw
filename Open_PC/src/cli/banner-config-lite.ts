import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaglineMode } from "./tagline.js";

function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  try {
    const raw = fs.readFileSync(resolveBannerConfigPath(env), "utf8");
    return readTaglineModeFromRawConfig(raw);
  } catch {
    return undefined;
  }
}

function resolveBannerConfigPath(env: NodeJS.ProcessEnv, homeDir = os.homedir()): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return path.resolve(resolveHomeRelativePath(explicit, homeDir));
  }

  const stateDir = env.OPENCLAW_STATE_DIR?.trim()
    ? resolveHomeRelativePath(env.OPENCLAW_STATE_DIR.trim(), homeDir)
    : path.join(homeDir, ".openclaw");
  return path.resolve(stateDir, "openclaw.json");
}

function resolveHomeRelativePath(rawPath: string, homeDir: string): string {
  if (rawPath === "~") {
    return homeDir;
  }
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

function readTaglineModeFromRawConfig(raw: string): TaglineMode | undefined {
  const match = raw.match(/["']?taglineMode["']?\s*:\s*["'](random|default|off)["']/);
  return parseTaglineMode(match?.[1]);
}

export const __testing = {
  readTaglineModeFromRawConfig,
  resolveBannerConfigPath,
};
