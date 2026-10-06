/**
 * plugin-wiring.ts — Starts the cognitive core from inside the plugin entry.
 *
 * The core owns its settings and its plumbing, so the plugin entry only has to
 * hand over what already exists there (awareness, working memory, the
 * transparency log) and register the tools that come back. Keeping this out
 * of `index.ts` is what keeps the entry a list of capabilities rather than a
 * monolith.
 */
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";
import type { PlanStore } from "../action/action-tools.js";
import { createPlanRunTool } from "../action/plan-run-tool.js";
import { PlanRunner } from "../action/plan-run.js";
import type { AwarenessEventBus } from "../awareness/event-bus.js";
import type { EnvironmentSnapshot } from "../awareness/snapshot.js";
import { registerCoreGatewayMethods } from "../dashboard/gateway-methods.js";
import { createCoreHealthHandler, CORE_HEALTH_PATH } from "../dashboard/health-http.js";
import type { OwnerChannelDeps } from "../dashboard/owner-channel.js";
import { PhysicsBody, type PhysicsEvent } from "../embodiment/physics-body.js";
import { Ros2Body, websocketTransport, type Ros2Places } from "../embodiment/ros2-body.js";
import { createSimTraining } from "../embodiment/sim-training.js";
import { perceptionModels, type ArtifactRecord } from "../evaluation/artifact-registry.js";
import { createEvaluation } from "../evaluation/core-eval.js";
import { createEvaluateTool } from "../evaluation/eval-tool.js";
import { EpisodicMemoryStore, type Episode } from "../memory/episodic-memory.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import { killSwitch } from "../operator/kill-switch.js";
import {
  createSensorSidecars,
  resolvePerceptionSettings,
  type PerceptionSettings,
} from "../perception/sensor-sidecars.js";
import type { PrivacyState } from "../privacy/privacy-state.js";
import type { AuditRecord } from "../safety/audit-log.js";
import { createChildGuard, type ChildGuard } from "../safety/child-guard.js";
import { createHonestyGuard, type HonestyGuard } from "../safety/honesty-guard.js";
import type { ModeState } from "../safety/interaction-mode.js";
import type { OverrideState } from "../safety/overrides.js";
import type { ConfirmEvent } from "../safety/physical-confirm.js";
import { NdjsonSidecar } from "../shared/ndjson-sidecar.js";
import { DeferredStateStore, type StateStorePort } from "../shared/state-store.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import type { BiometricRecord } from "../social/biometrics.js";
import type { Person } from "../social/people.js";
import { PersonaLedger, type PersonaVersion } from "../social/persona.js";
import type { PracticeItem } from "../social/practice.js";
import type { Belief } from "../social/theory-of-mind.js";
import { createSupabaseCheckpointStore } from "../supabase/audit-checkpoint-store.js";
import type { ActivityLog } from "../transparency/activity-log.js";
import type { Observation } from "../world/world-model.js";
import type { AutonomyLevel } from "./autonomy-levels.js";
import {
  createCognitiveRuntime,
  type CognitiveRuntime,
  type CognitiveRuntimeOptions,
  type SimulatorContext,
  type RuntimeBodyMode,
} from "./cognitive-runtime.js";
import type { Goal } from "./goals/goal-manager.js";
import type { CausalStats } from "./learning/causal-model.js";
import type { Lesson } from "./learning/lessons.js";
import type { Initiative } from "./loop/situational-reasoner.js";

export type CognitiveSettings = {
  readonly enabled: boolean;
  readonly autonomyLevel: AutonomyLevel;
  readonly bodyMode: RuntimeBodyMode;
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly preAuthorizedCapabilities: ReadonlyArray<string>;
  readonly ownerName: string;
  /** Recognizing sensors: webcam faces and microphone voices (off unless configured). */
  readonly perception: PerceptionSettings;
  /** Physical actions can also be approved on the real keyboard (Ctrl+Alt+Y / N). */
  readonly physicalConfirmation: boolean;
  /** Which simulator a simulated body runs on: symbolic (teleports), MuJoCo physics, or ROS 2. */
  readonly bodySimulator: "symbolic" | "mujoco" | "ros2";
  /** rosbridge WebSocket and named poses, for bodySimulator "ros2". */
  readonly ros2: { readonly url: string; readonly places: Ros2Places };
};

/** Named poses from config: { kitchen: [x, y, yaw?] }; malformed entries are dropped. */
const asPoses = (value: unknown): Ros2Places => {
  const out: Record<string, readonly [number, number, number?]> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, pose] of Object.entries(value)) {
      if (Array.isArray(pose) && pose.length >= 2 && pose.every((n) => typeof n === "number")) {
        out[name] = [pose[0] as number, pose[1] as number, pose[2] as number | undefined];
      }
    }
  }
  return out;
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
    perception: resolvePerceptionSettings(raw),
    physicalConfirmation: raw.physicalConfirmation === true,
    bodySimulator:
      raw.bodySimulator === "mujoco" || raw.bodySimulator === "ros2"
        ? raw.bodySimulator
        : "symbolic",
    ros2: {
      url:
        typeof raw.ros2Url === "string" && raw.ros2Url.trim()
          ? raw.ros2Url.trim()
          : "ws://127.0.0.1:9090",
      places: asPoses(raw.ros2Places),
    },
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

/** What the conversation hooks check before a reply is final. */
export type ConversationGuards = { readonly child: ChildGuard; readonly honesty: HonestyGuard };

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
  /** Wakes the agent's main session with one of the core's initiatives (live gateway only). */
  readonly initiative?: (initiative: Initiative) => void;
  /** Publishes the owner channel: the Control UI's Lumina tab, its gateway methods, /health. */
  readonly dashboard?: (channel: OwnerChannelDeps) => void;
  /** Puts the mode's guidance in every turn and screens replies in child mode (live gateway only). */
  readonly conversationHooks?: (guards: ConversationGuards) => void;
  /** The screen perception sidecar's bus, fed into the thalamic router. */
  readonly perceptionBus?: CognitiveRuntimeOptions["screenPerception"];
  /** Real sensor daemons to stop when a person switches a sensor off. */
  readonly sensorDaemons?: {
    readonly microphone?: { stop(): unknown };
    readonly camera?: { shutdown(): unknown };
  };
};

/** Version of Lumina's cognitive core this plugin carries (milestone LUMINA CORE v0.1, spec §151). */
export const LUMINA_CORE_VERSION = "0.1.0";

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
    | "on"
  >,
): Pick<
  CognitiveCoreDeps,
  | "live"
  | "pluginConfig"
  | "liveConfig"
  | "openStore"
  | "logger"
  | "dashboard"
  | "initiative"
  | "conversationHooks"
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
  api.registerService({ id: "lumina-core-state", start: () => started() });
  return {
    ...base,
    live: true,
    // The core speaks to the owner's agent through its main session, like any system notice.
    // With several agents the bare "main" key is ambiguous, so the session is named in full.
    initiative: ({ key, text }) => {
      try {
        const raw = (api.pluginConfig ?? {}) as Readonly<Record<string, unknown>>;
        const sessionKey = buildAgentMainSessionKey({
          agentId:
            typeof raw.ownerAgentId === "string" && raw.ownerAgentId.trim()
              ? raw.ownerAgentId.trim()
              : "main",
          mainKey: (api.runtime.config?.current?.() ?? api.config)?.session?.mainKey,
        });
        const queued = api.runtime.system.enqueueSystemEvent(`[Lumina core] ${text}`, {
          sessionKey,
          contextKey: `lumina-core:${key}`,
          replace: true,
        });
        if (queued) {
          api.runtime.system.requestHeartbeat({
            source: "other",
            intent: "immediate",
            reason: "lumina-core-initiative",
            sessionKey,
          });
        }
      } catch (error) {
        api.logger.warn(`[lumina-cognitive-os] initiative not delivered: ${String(error)}`);
      }
    },
    conversationHooks: ({ child, honesty }) => {
      api.on("before_prompt_build", () => {
        const context = child.systemContext();
        return context ? { appendSystemContext: context } : undefined;
      });
      // Before a reply is final: unsuitable for a child, or claiming an action that never ran.
      api.on("before_agent_finalize", (event) => {
        const instruction =
          child.revise(event.lastAssistantMessage) ?? honesty.revise(event.lastAssistantMessage);
        return instruction
          ? { action: "revise", reason: "lumina core", retry: { instruction, maxAttempts: 1 } }
          : undefined;
      });
      api.on("reply_payload_sending", (event) => {
        const text = child.outgoing(event.payload.text);
        return text ? { payload: { ...event.payload, text } } : undefined;
      });
      api.on("message_sending", (event) => {
        const content = child.outgoing(event.content);
        return content ? { content } : undefined;
      });
    },
    openStore: <T>(namespace: string) =>
      new DeferredStateStore<T>(running, () =>
        api.runtime.state.openKeyedStore<T>({ namespace, retention: "retained" }),
      ),
    dashboard: (channel) => {
      registerCoreGatewayMethods(api, channel);
      api.registerHttpRoute({
        path: CORE_HEALTH_PATH,
        auth: "gateway",
        match: "prefix",
        handler: createCoreHealthHandler(channel),
      });
      // No path: the Control UI renders this tab natively, as it does Logbook.
      api.session.controls.registerControlUiDescriptor({
        surface: "tab",
        id: "core",
        label: "Lumina",
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
        return "The emergency stop is engaged; a person re-arms it from the Lumina tab.";
      }
      return safety.overrides.paused
        ? "A person paused autonomy; it resumes from the Lumina tab."
        : null;
    },
    record: (entry) => runtime.audit.append({ actor: "agent", ...entry }),
  });
}

/** SQLite namespaces of the core's durable state. */
/**
 * Namespaces of the durable stores. Their historic prefix stays: renaming it would orphan the
 * stored state, the audit chain included.
 */
const STORE_PREFIX = "m3gan";

export const COGNITIVE_STORE_NAMESPACES = {
  audit: `${STORE_PREFIX}.audit`,
  overrides: `${STORE_PREFIX}.overrides`,
  world: `${STORE_PREFIX}.world`,
  privacy: `${STORE_PREFIX}.privacy`,
  people: `${STORE_PREFIX}.people`,
  beliefs: `${STORE_PREFIX}.beliefs`,
  biometrics: `${STORE_PREFIX}.biometrics`,
  goals: `${STORE_PREFIX}.goals`,
  lessons: `${STORE_PREFIX}.lessons`,
  mode: `${STORE_PREFIX}.mode`,
  practice: `${STORE_PREFIX}.practice`,
  persona: `${STORE_PREFIX}.persona`,
  causal: `${STORE_PREFIX}.causal`,
  artifacts: `${STORE_PREFIX}.artifacts`,
  episodic: `${STORE_PREFIX}.episodic`,
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
      biometrics: open<BiometricRecord>(COGNITIVE_STORE_NAMESPACES.biometrics),
      goals: open<Goal>(COGNITIVE_STORE_NAMESPACES.goals),
      lessons: open<Lesson>(COGNITIVE_STORE_NAMESPACES.lessons),
      mode: open<ModeState>(COGNITIVE_STORE_NAMESPACES.mode),
      practice: open<PracticeItem>(COGNITIVE_STORE_NAMESPACES.practice),
      artifacts: open<ArtifactRecord>(COGNITIVE_STORE_NAMESPACES.artifacts),
      causal: open<CausalStats>(COGNITIVE_STORE_NAMESPACES.causal),
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
  // The webcam and microphone run only in the live gateway, never in discovery or CLI loads.
  const sensors = deps.live ? createSensorSidecars(settings.perception) : undefined;
  // Learning to move happens in simulation only, started by a person from the Lumina tab (§133).
  const training =
    deps.live && settings.bodyMode === "simulated" && settings.bodySimulator === "mujoco"
      ? createSimTraining({ dir: path.join(deps.memoryDir, "simulation") })
      : undefined;
  // The persona lives in the agent workspace's identity files, outside any model (spec §11, §128).
  const workspace = (
    deps.liveConfig() as { agents?: { defaults?: { workspace?: unknown } } } | undefined
  )?.agents?.defaults?.workspace;
  const persona = deps.live
    ? new PersonaLedger({
        dir:
          typeof workspace === "string" && workspace.trim()
            ? workspace.trim()
            : path.join(os.homedir(), ".openclaw", "workspace"),
        ...(deps.openStore
          ? { store: deps.openStore<PersonaVersion>(COGNITIVE_STORE_NAMESPACES.persona) }
          : {}),
        onError: (error) => deps.logger.warn(`[lumina-cognitive-os] persona: ${String(error)}`),
      })
    : undefined;
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
    ...(sensors ? { sensors } : {}),
    ...(persona ? { persona } : {}),
    // The models the sensors load, pinned and checked by hash (spec §135).
    ...(sensors ? { artifacts: perceptionModels(settings.perception.modelsDir) } : {}),
    ...(deps.initiative ? { initiative: deps.initiative } : {}),
    ...(deps.live && settings.physicalConfirmation
      ? {
          physicalConfirm: new NdjsonSidecar<ConfirmEvent>({
            name: "physical_confirm",
            args: () => [],
          }),
        }
      : {}),
    // A physics simulator runs only in the live gateway; elsewhere the symbolic body stands in.
    ...(deps.live && settings.bodyMode === "simulated" && settings.bodySimulator !== "symbolic"
      ? {
          simulator: ({ nameOf, observe }: SimulatorContext) =>
            settings.bodySimulator === "ros2"
              ? new Ros2Body(websocketTransport(settings.ros2.url), settings.ros2.places, nameOf)
              : new PhysicsBody(
                  new NdjsonSidecar<PhysicsEvent>({
                    name: "mujoco_body",
                    // A navigation policy learned in simulation, once it passed its evaluation (§133).
                    args: () => {
                      const policy = training?.policyPath();
                      return ["--realtime", "1", ...(policy ? ["--policy", policy] : [])];
                    },
                  }),
                  nameOf,
                  observe,
                ),
        }
      : {}),
    // Only the live gateway checkpoints the audit chain it owns.
    ...(deps.live
      ? { auditCheckpoints: createSupabaseCheckpointStore({ host: os.hostname() }) }
      : {}),
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
  const evaluation = createEvaluation();
  deps.registerTool(createEvaluateTool(evaluation));
  deps.conversationHooks?.({
    child: createChildGuard({ mode: () => runtime.modes.state().mode, audit: runtime.audit }),
    honesty: createHonestyGuard({
      recentBody: () => runtime.body.recent(20),
      audit: runtime.audit,
    }),
  });
  deps.dashboard?.({
    runtime,
    ...(training ? { training } : {}),
    evaluation,
    version: LUMINA_CORE_VERSION,
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
