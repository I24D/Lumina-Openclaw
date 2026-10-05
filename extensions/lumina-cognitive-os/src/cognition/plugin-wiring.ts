/**
 * plugin-wiring.ts — Starts the cognitive core from inside the plugin entry.
 *
 * The core owns its settings and its plumbing, so the plugin entry only has to
 * hand over what already exists there (awareness, working memory, the
 * transparency log) and register the tools that come back. Keeping this out
 * of `index.ts` is what keeps the entry a list of capabilities rather than a
 * monolith.
 */
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import type { AwarenessEventBus } from "../awareness/event-bus.js";
import type { EnvironmentSnapshot } from "../awareness/snapshot.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import { killSwitch } from "../operator/kill-switch.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import type { ActivityLog } from "../transparency/activity-log.js";
import type { AutonomyLevel } from "./autonomy-levels.js";
import {
  createCognitiveRuntime,
  type CognitiveRuntime,
  type RuntimeBodyMode,
} from "./cognitive-runtime.js";

export type CognitiveSettings = {
  readonly enabled: boolean;
  readonly autonomyLevel: AutonomyLevel;
  readonly bodyMode: RuntimeBodyMode;
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly preAuthorizedCapabilities: ReadonlyArray<string>;
};

// Which capabilities exist is the runtime's call; here config is only type-checked.
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : [];

/**
 * Read the core's keys from the raw plugin config. Config is user input, so an
 * out-of-range level is clamped; the runtime drops unknown capabilities. The
 * defaults are the conservative ones (L3, no body, nothing granted).
 */
export function resolveCognitiveSettings(pluginConfig: unknown): CognitiveSettings {
  const raw = (pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {}) as Record<
    string,
    unknown
  >;
  const level =
    typeof raw.autonomyLevel === "number" && Number.isFinite(raw.autonomyLevel)
      ? Math.round(raw.autonomyLevel)
      : 3;
  return {
    enabled: raw.cognitiveCoreEnabled !== false,
    autonomyLevel: Math.min(5, Math.max(0, level)) as AutonomyLevel,
    bodyMode: raw.bodyMode === "simulated" ? "simulated" : "none",
    grantedCapabilities: asStrings(raw.grantedCapabilities),
    preAuthorizedCapabilities: asStrings(raw.preAuthorizedCapabilities),
  };
}

/** Registers tools through the host while remembering their names for the self model. */
export function createToolRecorder<T>(host: { registerTool(tool: T): void }): {
  readonly register: (tool: T) => void;
  readonly names: () => ReadonlyArray<string>;
} {
  const names: string[] = [];
  return {
    register: (tool) => {
      if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
        names.push(tool.name);
      }
      host.registerTool(tool);
    },
    names: () => names,
  };
}

export type CognitiveCoreDeps = {
  readonly pluginConfig: unknown;
  readonly memoryDir: string;
  readonly awarenessBus: AwarenessEventBus;
  readonly environment: () => EnvironmentSnapshot | null;
  readonly working: () => WorkingMemory;
  readonly activity: ActivityLog;
  readonly toolNames: () => ReadonlyArray<string>;
  /** Registers the core's tools with the agent. */
  readonly registerTool: (tool: AnyAgentTool) => void;
  /** The live OpenClaw config, read for the active model. */
  readonly liveConfig: () =>
    | { readonly agents?: { readonly defaults?: { readonly model?: unknown } } }
    | undefined;
  readonly logger: { info(message: string): void; warn(message: string): void };
};

/** Start the core and register its tools, or return undefined when Dal turned it off. */
export function startCognitiveCore(deps: CognitiveCoreDeps): CognitiveRuntime | undefined {
  const settings = resolveCognitiveSettings(deps.pluginConfig);
  if (!settings.enabled) {
    deps.logger.info("[lumina-cognitive-os] cognitive core disabled by config");
    return undefined;
  }
  const runtime = createCognitiveRuntime({
    memoryDir: deps.memoryDir,
    autonomyLevel: settings.autonomyLevel,
    bodyMode: settings.bodyMode,
    grantedCapabilities: settings.grantedCapabilities,
    preAuthorizedCapabilities: settings.preAuthorizedCapabilities,
    awarenessBus: deps.awarenessBus,
    emergencyStop: killSwitch,
    environment: deps.environment,
    working: deps.working,
    toolNames: deps.toolNames,
    activeModel: () =>
      resolveAgentModelPrimaryValue(
        deps.liveConfig()?.agents?.defaults?.model as Parameters<
          typeof resolveAgentModelPrimaryValue
        >[0],
      ),
    onBodyResult: (r) => {
      deps.activity.push({
        category: "command",
        summary: `Cuerpo: ${r.intent.type} → ${r.review.verdict}`,
        detail: r.outcome?.detail ?? r.review.reasons.join(" "),
        ref: { intent: r.intent, verdict: r.review.verdict, capability: r.review.capability },
      });
    },
    onError: (error) => deps.logger.warn(`[lumina-cognitive-os] cognitive core: ${String(error)}`),
  });
  for (const tool of runtime.tools) {
    deps.registerTool(tool);
  }
  deps.logger.info(
    `[lumina-cognitive-os] cognitive core ready (L${settings.autonomyLevel}, body=${settings.bodyMode}, ` +
      `granted=${settings.grantedCapabilities.length}, world=${runtime.world.size} entities)`,
  );
  return runtime;
}
