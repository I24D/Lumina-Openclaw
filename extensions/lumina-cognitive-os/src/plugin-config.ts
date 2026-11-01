/**
 * plugin-config.ts — The plugin's settings, and where each default comes from.
 *
 * Lifted out of `index.ts` because that file had reached 698 of its 700
 * effective lines and the next setting would have broken the cap. Settings are
 * a cohesive unit with no dependency on the rest of the entry, so they are the
 * natural thing to move; the entry is now a list of registrations.
 *
 * ## Precedence
 *
 * Plugin config first, then `process.env`, then the operator's `.env` loaded by
 * `loadLuminaEnv`, then a literal. Two settings invert the first two steps on
 * purpose and say so at their own line. Absolute machine paths are this file's
 * convention: the extension is bundled into `dist/`, where `import.meta.dirname`
 * no longer sits beside the checkout.
 */
import os from "node:os";
import path from "node:path";
import type { BrainProviderName } from "./operator/brain-gemini.js";

export type CognitiveConfig = {
  enabled?: boolean;
  envPath?: string;
  memoryDir?: string;
  awarenessIntervalMs?: number;
  wakeWordEnabled?: boolean;
  wakeWordModel?: string;
  bootGreetingEnabled?: boolean;
  browserDriverEnabled?: boolean;
  perceptionAutoStart?: boolean;
  perceptionFps?: number;
  recipesDir?: string;
  bridgeUrl?: string;
  skillsDir?: string;
  operativeEnabled?: boolean;
  /** LUMINA-MESH/1 delivery loop. `LUMINA_MESH_ENABLED=0` is the kill switch. */
  meshEnabled?: boolean;
  operativeRulesPath?: string;
  codeActWorkspaceRoot?: string;
  recordingsDir?: string;
  replayAllowedApps?: string[];
  pcOperatorProvider?: BrainProviderName;
  pcOperatorModel?: string;
  supabaseSchema?: string;
  supabaseMaxRows?: number;
  supabaseAllowWrites?: boolean;
  warehousesPath?: string;
  governancePolicyPath?: string;
};

/** The operator `.env` values this module reads, as `loadLuminaEnv` returns them. */
export type LuminaEnvValues = {
  readonly LUMINA_SUPABASE_SCHEMA?: string;
  readonly LUMINA_SUPABASE_MAX_ROWS?: string;
  readonly LUMINA_SUPABASE_ALLOW_WRITES?: string;
  readonly LUMINA_WAREHOUSES_PATH?: string;
};

export function parseAllowedApps(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[,;\s]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function readNumberEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function defaultMemoryDir(): string {
  const base =
    process.env.APPDATA ??
    process.env.XDG_DATA_HOME ??
    path.join(os.homedir(), ".lumina-cognitive-os");
  return path.join(base, "lumina-cognitive-os", "memory");
}

/** The default `.env` the operator keeps every Lumina secret in. */
export const DEFAULT_ENV_PATH = "c:/I24D_WhatsApp/.env";

export function resolveCognitiveConfig(
  raw: CognitiveConfig,
  envPath: string,
  luminaEnv: LuminaEnvValues,
): Required<CognitiveConfig> {
  return {
    enabled: raw.enabled ?? true,
    envPath,
    memoryDir: raw.memoryDir ?? defaultMemoryDir(),
    awarenessIntervalMs: raw.awarenessIntervalMs ?? 15_000,
    wakeWordEnabled: raw.wakeWordEnabled ?? false,
    wakeWordModel: raw.wakeWordModel ?? "hey_jarvis_v0.1",
    bootGreetingEnabled: raw.bootGreetingEnabled ?? true,
    browserDriverEnabled: raw.browserDriverEnabled ?? false,
    perceptionAutoStart: raw.perceptionAutoStart ?? false,
    perceptionFps: raw.perceptionFps ?? 3,
    recipesDir: raw.recipesDir ?? "",
    bridgeUrl: raw.bridgeUrl ?? process.env.LUMINA_BRIDGE_URL ?? "http://127.0.0.1:8765",
    // The old fallback pointed at c:/I24D_WhatsApp/skills, which does not
    // exist: the skills live inside the checkout, and the gateway logged
    // "Agent Skills: 0 loaded, 0 errors" every start because of it.
    skillsDir:
      raw.skillsDir ?? process.env.LUMINA_SKILLS_DIR ?? "c:/I24D_WhatsApp/openclaw-main/skills",
    operativeEnabled: raw.operativeEnabled ?? true,
    // Env first here: the mesh is on by default because Dal asked for it
    // connected in production, so the one-line way to take it back out has to
    // win over a config file nobody edits in a hurry.
    meshEnabled: readBooleanEnv(process.env.LUMINA_MESH_ENABLED) ?? raw.meshEnabled ?? true,
    operativeRulesPath: raw.operativeRulesPath ?? process.env.LUMINA_OPERATIVE_RULES ?? "",
    codeActWorkspaceRoot:
      raw.codeActWorkspaceRoot ??
      process.env.LUMINA_CODEACT_WORKSPACE ??
      "c:/I24D_WhatsApp/codeact-workspace",
    recordingsDir:
      raw.recordingsDir ?? process.env.LUMINA_RECORDINGS_DIR ?? "c:/I24D_WhatsApp/recordings",
    replayAllowedApps:
      raw.replayAllowedApps ?? parseAllowedApps(process.env.LUMINA_REPLAY_ALLOWED_APPS),
    pcOperatorProvider:
      raw.pcOperatorProvider ??
      (process.env.LUMINA_PC_OPERATOR_PROVIDER as BrainProviderName | undefined) ??
      "auto",
    pcOperatorModel: raw.pcOperatorModel ?? process.env.LUMINA_PC_OPERATOR_MODEL ?? "",
    supabaseSchema:
      raw.supabaseSchema ??
      process.env.LUMINA_SUPABASE_SCHEMA ??
      luminaEnv.LUMINA_SUPABASE_SCHEMA ??
      "public",
    supabaseMaxRows:
      raw.supabaseMaxRows ??
      readNumberEnv(process.env.LUMINA_SUPABASE_MAX_ROWS) ??
      readNumberEnv(luminaEnv.LUMINA_SUPABASE_MAX_ROWS) ??
      100,
    // Env first again, and ahead of plugin config: this is the kill switch for
    // every Supabase writer in the plugin.
    supabaseAllowWrites:
      readBooleanEnv(process.env.LUMINA_SUPABASE_ALLOW_WRITES) ??
      readBooleanEnv(luminaEnv.LUMINA_SUPABASE_ALLOW_WRITES) ??
      raw.supabaseAllowWrites ??
      false,
    warehousesPath:
      raw.warehousesPath ??
      process.env.LUMINA_WAREHOUSES_PATH ??
      luminaEnv.LUMINA_WAREHOUSES_PATH ??
      "c:/I24D_WhatsApp/src/cuerpo/warehouses",
    governancePolicyPath:
      raw.governancePolicyPath ?? process.env.LUMINA_GOVERNANCE_POLICY_PATH ?? "",
  };
}
