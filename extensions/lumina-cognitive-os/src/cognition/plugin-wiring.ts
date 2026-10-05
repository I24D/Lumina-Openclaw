/**
 * plugin-wiring.ts — Starts the cognitive core from inside the plugin entry.
 *
 * The core owns its settings and its plumbing, so the plugin entry only has to
 * hand over what already exists there (awareness, working memory, the
 * transparency log) and register the tools that come back. Keeping this out
 * of `index.ts` is what keeps the entry a list of capabilities rather than a
 * monolith.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import type { PlanStore } from "../action/action-tools.js";
import { createPlanRunTool } from "../action/plan-run-tool.js";
import { PlanRunner } from "../action/plan-run.js";
import type { AwarenessEventBus } from "../awareness/event-bus.js";
import type { EnvironmentSnapshot } from "../awareness/snapshot.js";
import { registerM3ganGatewayMethods } from "../dashboard/gateway-methods.js";
import { createM3ganHealthHandler, M3GAN_HEALTH_PATH } from "../dashboard/health-http.js";
import type { OwnerChannelDeps } from "../dashboard/owner-channel.js";
import { EpisodicMemoryStore, type Episode } from "../memory/episodic-memory.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import { killSwitch } from "../operator/kill-switch.js";
import type { PrivacyState } from "../privacy/privacy-state.js";
import type { AuditRecord } from "../safety/audit-log.js";
import type { OverrideState } from "../safety/overrides.js";
import { DeferredStateStore, type StateStorePort } from "../shared/state-store.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import type { Person } from "../social/people.js";
import type { Belief } from "../social/theory-of-mind.js";
import type { ActivityLog } from "../transparency/activity-log.js";
import type { Observation } from "../world/world-model.js";
import type { AutonomyLevel } from "./autonomy-levels.js";
import {
  createCognitiveRuntime,
  type CognitiveRuntime,
  type CognitiveRuntimeOptions,
  type RuntimeBodyMode,
} from "./cognitive-runtime.js";
import type { Goal } from "./goals/goal-manager.js";
import type { Lesson } from "./learning/lessons.js";

export type CognitiveSettings = {
  readonly enabled: boolean;
  readonly autonomyLevel: AutonomyLevel;
  readonly bodyMode: RuntimeBodyMode;
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly preAuthorizedCapabilities: ReadonlyArray<string>;
  readonly ownerName: string;
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
    ownerName:
      typeof raw.ownerName === "string" && raw.ownerName.trim() ? raw.ownerName.trim() : "Dal",
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
  /**
   * True in the gateway's live registration. Only then do timers run and state persist: discovery
   * and CLI loads keep session-only state, so two processes never append to one audit chain.
   */
  readonly live: boolean;
  readonly pluginConfig: unknown;
  readonly memoryDir: string;
  readonly awarenessBus: AwarenessEventBus;
  readonly environment: () => EnvironmentSnapshot | null;
  readonly working: () => WorkingMemory;
  /** Plans registered by lumina_action_plan, walked by lumina_plan_run. */
  readonly plans?: PlanStore;
  /** Shared episodic memory used by N2 tools and privacy forget-session. */
  readonly episodicMemory?: EpisodicMemoryStore;
  readonly activity: ActivityLog;
  readonly toolNames: () => ReadonlyArray<string>;
  /** Registers the core's tools with the agent. */
  readonly registerTool: (tool: AnyAgentTool) => void;
  /** Opens a durable keyed store (the host's SQLite plugin state). */
  readonly openStore?: <T>(namespace: string) => StateStorePort<T>;
  /** The live OpenClaw config, read for the active model. */
  readonly liveConfig: () =>
    | { readonly agents?: { readonly defaults?: { readonly model?: unknown } } }
    | undefined;
  readonly logger: { info(message: string): void; warn(message: string): void };
  /** Publishes the owner channel: the Control UI's M3GAN tab, its gateway methods, /health. */
  readonly dashboard?: (channel: OwnerChannelDeps) => void;
  /** The screen perception sidecar's bus, fed into the thalamic router. */
  readonly perceptionBus?: CognitiveRuntimeOptions["screenPerception"];
  /** Real sensor daemons to stop when a person switches a sensor off. */
  readonly sensorDaemons?: {
    readonly microphone?: { stop(): unknown };
    readonly camera?: { shutdown(): unknown };
  };
};

/** Version of the M3GAN core this plugin carries (milestone M3GAN CORE v0.1, spec §151). */
export const M3GAN_CORE_VERSION = "0.1.0";

/** The host-derived dependencies: plugin config, live config, durable stores, logger, dashboard. */
export function hostDeps(
  api: Pick<
    OpenClawPluginApi,
    | "pluginConfig"
    | "config"
    | "runtime"
    | "logger"
    | "registerGatewayMethod"
    | "registerHttpRoute"
    | "registerService"
    | "session"
    | "registrationMode"
  >,
): Pick<
  CognitiveCoreDeps,
  "live" | "pluginConfig" | "liveConfig" | "openStore" | "logger" | "dashboard"
> {
  const base = {
    pluginConfig: api.pluginConfig,
    liveConfig: () => api.runtime.config?.current?.() ?? api.config,
    logger: api.logger,
  };
  if (api.registrationMode !== "full") {
    return { ...base, live: false };
  }
  // Retained stores belong to the running plugin: opened during registration they lose their
  // admission when the gateway activates the registry, so they open when the service starts.
  let started: () => void = () => undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  api.registerService({ id: "m3gan-state", start: () => started() });
  return {
    ...base,
    live: true,
    openStore: <T>(namespace: string) =>
      new DeferredStateStore<T>(running, () =>
        api.runtime.state.openKeyedStore<T>({ namespace, retention: "retained" }),
      ),
    dashboard: (channel) => {
      registerM3ganGatewayMethods(api, channel);
      api.registerHttpRoute({
        path: M3GAN_HEALTH_PATH,
        auth: "gateway",
        match: "prefix",
        handler: createM3ganHealthHandler(channel),
      });
      // No path: the Control UI renders this tab natively, as it does Logbook.
      api.session.controls.registerControlUiDescriptor({
        surface: "tab",
        id: "m3gan",
        label: "M3GAN",
        description:
          "Live state, safety, people, world, health and robot of Lumina's cognitive core.",
        icon: "brain",
        group: "control",
        order: 36,
        requiredScopes: ["operator.write"],
      });
    },
  };
}

/** Plans walk only while no person has paused the system and the emergency stop is clear. */
function planRunner(runtime: CognitiveRuntime): PlanRunner {
  return new PlanRunner({
    blocked: () => {
      const safety = runtime.safety.status();
      if (safety.emergencyStop) {
        return "The emergency stop is engaged; a person re-arms it from the M3GAN tab.";
      }
      return safety.overrides.paused
        ? "A person paused autonomy; it resumes from the M3GAN tab."
        : null;
    },
    record: (entry) => runtime.audit.append({ actor: "agent", ...entry }),
  });
}

/** SQLite namespaces of the core's durable state. */
export const COGNITIVE_STORE_NAMESPACES = {
  audit: "m3gan.audit",
  overrides: "m3gan.overrides",
  world: "m3gan.world",
  privacy: "m3gan.privacy",
  people: "m3gan.people",
  beliefs: "m3gan.beliefs",
  goals: "m3gan.goals",
  lessons: "m3gan.lessons",
  episodic: "m3gan.episodic",
} as const;

/** Episodic memory on durable state in the live gateway; other loads keep the JSONL fallback. */
export function createEpisodicMemory(
  host: Pick<CognitiveCoreDeps, "openStore" | "logger">,
  dir: string,
): EpisodicMemoryStore {
  const store = host.openStore?.<Episode>(COGNITIVE_STORE_NAMESPACES.episodic);
  return new EpisodicMemoryStore({
    dir,
    ...(store ? { store } : {}),
    onError: (error) => host.logger.warn(`[lumina-cognitive-os] episodic memory: ${String(error)}`),
  });
}

function openStores(deps: CognitiveCoreDeps): NonNullable<CognitiveRuntimeOptions["stores"]> {
  const open = deps.openStore;
  if (!open) {
    if (!deps.live) {
      return {};
    }
    deps.logger.warn(
      "[lumina-cognitive-os] no durable plugin state: safety audit, overrides and world are session-only",
    );
    return {};
  }
  try {
    return {
      audit: open<AuditRecord>(COGNITIVE_STORE_NAMESPACES.audit),
      overrides: open<OverrideState>(COGNITIVE_STORE_NAMESPACES.overrides),
      world: open<Observation>(COGNITIVE_STORE_NAMESPACES.world),
      privacy: open<PrivacyState>(COGNITIVE_STORE_NAMESPACES.privacy),
      people: open<Person>(COGNITIVE_STORE_NAMESPACES.people),
      beliefs: open<Belief>(COGNITIVE_STORE_NAMESPACES.beliefs),
      goals: open<Goal>(COGNITIVE_STORE_NAMESPACES.goals),
      lessons: open<Lesson>(COGNITIVE_STORE_NAMESPACES.lessons),
    };
  } catch (error) {
    deps.logger.warn(
      `[lumina-cognitive-os] durable plugin state unavailable (${String(error)}): safety audit, overrides and world are session-only`,
    );
    return {};
  }
}

/** Start the core and register its tools, or return undefined when Dal turned it off. */
export function startCognitiveCore(deps: CognitiveCoreDeps): CognitiveRuntime | undefined {
  const settings = resolveCognitiveSettings(deps.pluginConfig);
  if (!settings.enabled) {
    deps.logger.info("[lumina-cognitive-os] cognitive core disabled by config");
    return undefined;
  }
  const runtime = createCognitiveRuntime({
    stores: openStores(deps),
    startTimers: deps.live,
    memoryDir: deps.memoryDir,
    autonomyLevel: settings.autonomyLevel,
    bodyMode: settings.bodyMode,
    grantedCapabilities: settings.grantedCapabilities,
    preAuthorizedCapabilities: settings.preAuthorizedCapabilities,
    awarenessBus: deps.awarenessBus,
    emergencyStop: killSwitch,
    environment: deps.environment,
    working: deps.working,
    ...(deps.episodicMemory ? { episodicMemory: deps.episodicMemory } : {}),
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
    ownerName: settings.ownerName,
    ...(deps.perceptionBus ? { screenPerception: deps.perceptionBus } : {}),
    sensorDaemons: {
      stopMicrophone: () => void deps.sensorDaemons?.microphone?.stop(),
      stopCamera: () => void deps.sensorDaemons?.camera?.shutdown(),
    },
    // Kernel and brainstem decisions reach the transparency panel, which the model does not draw.
    notify: (message, severity) => {
      deps.activity.push({
        category: severity === "info" ? "intent" : "risk",
        summary: message,
        ...(severity === "info" ? {} : { risk: severity === "critical" ? "CRITICAL" : "WARNING" }),
      });
      if (severity !== "info") {
        deps.logger.warn(`[lumina-cognitive-os] ${message}`);
      }
    },
  });
  for (const tool of runtime.tools) {
    deps.registerTool(tool);
  }
  if (deps.plans) {
    deps.registerTool(createPlanRunTool(deps.plans, planRunner(runtime)));
  }
  deps.dashboard?.({
    runtime,
    version: M3GAN_CORE_VERSION,
    // Re-arming is a person's action: it exists only behind the owner channel.
    rearmEmergencyStop: () => void killSwitch.reset(),
    activeModel: () =>
      resolveAgentModelPrimaryValue(
        deps.liveConfig()?.agents?.defaults?.model as Parameters<
          typeof resolveAgentModelPrimaryValue
        >[0],
      ),
  });
  deps.logger.info(
    `[lumina-cognitive-os] cognitive core ready (L${settings.autonomyLevel}, body=${settings.bodyMode}, ` +
      `granted=${settings.grantedCapabilities.length}, world=${runtime.world.size} entities)`,
  );
  return runtime;
}
