/**
 * cognitive-runtime.ts — Assembles the cognitive core and wires it to live inputs.
 *
 * Every piece here existed in isolation (attention, autonomy, uncertainty,
 * goals, lessons, the loop) or is new (router, world model, workspace, self
 * model, embodiment). This is the one place that connects them:
 *
 *   awareness bus ──┐
 *   perception ─────┼─▶ thalamic router ─┬─▶ world model     (every event)
 *   agent tools ────┘                    └─▶ attention queue ─▶ cognitive loop
 *                                                                 │
 *   goals, lessons, working memory, environment, self ──▶ global workspace
 *
 *   agent / loop ─▶ embodied controller ─▶ safety supervisor ─▶ body adapter
 *
 *   privacy gate ─▶ router (switched-off sensors never enter) · brainstem
 *   probes every subsystem on a timer · people, presence, minds · danger protocol
 *
 * The loop starts observe-only: its default reasoner proposes no actions, so
 * enabling the core gives Lumina situational awareness without giving it new
 * initiative. A reasoner that proposes actions is a separate, deliberate step.
 */
import path from "node:path";
import type { AwarenessEventBus } from "../awareness/event-bus.js";
import type { EnvironmentSnapshot } from "../awareness/snapshot.js";
import { Brainstem, type Probe, type ProbeResult } from "../brainstem/brainstem.js";
import { assessEnergy, type EnergyAdvice } from "../brainstem/energy.js";
import { createHealthTool } from "../brainstem/health-tool.js";
import { createBehaviorTool } from "../embodiment/behavior-tool.js";
import { createBodyTool } from "../embodiment/body-tool.js";
import {
  BODY_CAPABILITIES,
  NullBody,
  SimulatedBody,
  type BodyAdapter,
} from "../embodiment/body.js";
import {
  EmbodiedController,
  type EmbodiedResult,
  type EmergencyStop,
} from "../embodiment/embodied-controller.js";
import { SimulatedRobot } from "../embodiment/simulated-robot.js";
import { TeleoperationGateway } from "../embodiment/teleoperation.js";
import { payloadOf } from "../events/catalog.js";
import type { EpisodicMemoryStore } from "../memory/episodic-memory.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import type { PerceptionEvent } from "../perception/perception-process.js";
import { PrivacyControls, type PrivacyState } from "../privacy/privacy-state.js";
import { createPrivacyTool } from "../privacy/privacy-tool.js";
import { AuditLog, type AuditRecord } from "../safety/audit-log.js";
import { HumanOverrides, type OverrideState } from "../safety/overrides.js";
import { SafetyKernel, type KernelEmergencyStop } from "../safety/safety-kernel.js";
import { createExplainTool, createSafetyTool } from "../safety/safety-tools.js";
import type { StateStorePort } from "../shared/state-store.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import { PeopleRegistry, type Person } from "../social/people.js";
import { presenceState, type PresenceState } from "../social/presence.js";
import { createMindTool, createPeopleTool } from "../social/social-tools.js";
import { MindModel, type Belief } from "../social/theory-of-mind.js";
import { WorldModel, type Observation } from "../world/world-model.js";
import { attachWorldModel } from "../world/world-perception.js";
import { createWorldObserveTool, createWorldQueryTool } from "../world/world-tools.js";
import type { AutonomyLevel } from "./autonomy-levels.js";
import { createGoalTool, createSelfModelTool, createWorkspaceTool } from "./cognition-tools.js";
import { consolidate } from "./consolidation.js";
import { GoalManager, type Goal } from "./goals/goal-manager.js";
import { LessonStore, type Lesson } from "./learning/lessons.js";
import { attachAwareness } from "./loop/awareness-bridge.js";
import { CognitiveLoop, type CycleRecord, type Reasoner } from "./loop/cognitive-loop.js";
import { attachScreenPerception } from "./loop/perception-bridge.js";
import { ThalamicRouter } from "./router/thalamic-router.js";
import {
  buildSelfModel,
  type BodyMode,
  type SelfModel,
  type SensorStatus,
} from "./self/self-model.js";
import { GlobalWorkspace } from "./workspace/global-workspace.js";

/** Body modes the runtime can construct; "physical" needs a hardware adapter. */
export type RuntimeBodyMode = Exclude<BodyMode, "physical">;

export type CognitiveRuntimeOptions = {
  /** Where goals, lessons and the world log persist. */
  readonly memoryDir: string;
  readonly name?: string;
  readonly autonomyLevel: AutonomyLevel;
  readonly bodyMode: RuntimeBodyMode;
  /** Body capabilities Dal granted (spec §20). Config only; never a tool. */
  readonly grantedCapabilities: ReadonlyArray<string>;
  /** Granted capabilities that may run without asking, where safety allows. */
  readonly preAuthorizedCapabilities: ReadonlyArray<string>;
  readonly awarenessBus: AwarenessEventBus;
  readonly emergencyStop: EmergencyStop & KernelEmergencyStop;
  readonly environment: () => EnvironmentSnapshot | null;
  readonly working: () => WorkingMemory;
  /** Shared N2 episodic store, so privacy forget-session can erase the same memory tools use. */
  readonly episodicMemory?: EpisodicMemoryStore;
  /** Names of every agent tool registered so far, for the self model. */
  readonly toolNames: () => ReadonlyArray<string>;
  readonly activeModel?: () => string | undefined;
  /** Defaults to an observe-only reasoner. */
  readonly reason?: Reasoner;
  readonly onCycle?: (record: CycleRecord) => void;
  /** Every body request, allowed or not, for the transparency log. */
  readonly onBodyResult?: (result: EmbodiedResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
  /**
   * Durable stores (the host's SQLite plugin state). Any one omitted is
   * session-only: it works, and nothing of it survives the process.
   */
  readonly stores?: {
    readonly audit?: StateStorePort<AuditRecord>;
    readonly overrides?: StateStorePort<OverrideState>;
    readonly world?: StateStorePort<Observation>;
    readonly privacy?: StateStorePort<PrivacyState>;
    readonly people?: StateStorePort<Person>;
    readonly beliefs?: StateStorePort<Belief>;
    readonly goals?: StateStorePort<Goal>;
    readonly lessons?: StateStorePort<Lesson>;
  };
  /** The owner, given the owner role when nobody holds it (config is an owner channel). */
  readonly ownerName?: string;
  /** Stop real sensor daemons when a person switches a sensor off. */
  readonly sensorDaemons?: {
    readonly stopMicrophone?: () => void;
    readonly stopCamera?: () => void;
  };
  /** The screen perception sidecar's bus, when the plugin runs one. */
  readonly screenPerception?: {
    on(listener: (event: PerceptionEvent) => void): () => void;
  };
  /** Tell a person something (transparency panel, toast). */
  readonly notify?: (message: string, severity: "info" | "warn" | "critical") => void;
  /** Brainstem heartbeat. Default 30 s. */
  readonly brainstemIntervalMs?: number;
  /** How often sightings are consolidated into knowledge. Default 1 h. */
  readonly consolidationIntervalMs?: number;
  /** Start the brainstem and consolidation timers. Default true; tests turn it off. */
  readonly startTimers?: boolean;
};

export type CognitiveRuntime = {
  readonly router: ThalamicRouter;
  readonly world: WorldModel;
  readonly goals: GoalManager;
  readonly lessons: LessonStore;
  readonly loop: CognitiveLoop;
  readonly workspace: GlobalWorkspace;
  readonly body: EmbodiedController;
  readonly teleop: TeleoperationGateway;
  readonly safety: SafetyKernel;
  readonly audit: AuditLog;
  readonly privacy: PrivacyControls;
  readonly people: PeopleRegistry;
  readonly mind: MindModel;
  readonly brainstem: Brainstem;
  /** Present only with a simulated body (MOCK). */
  readonly robot: SimulatedRobot | undefined;
  readonly presence: () => PresenceState;
  readonly energy: () => EnergyAdvice;
  /** Resolves once every durable store has loaded what earlier processes saved. */
  readonly ready: Promise<void>;
  /** Resolves once every change so far has been handed to the durable stores. */
  readonly flush: () => Promise<void>;
  readonly selfModel: () => SelfModel;
  readonly tools: ReadonlyArray<AnyAgentTool>;
  readonly dispose: () => void;
};

/**
 * The default reasoner observes and proposes nothing. It still consults
 * lessons, so the cycle record says what Lumina already knows about the event.
 */
export function observeOnlyReasoner(lessons: LessonStore): Reasoner {
  return (event) => {
    const known = lessons.applicable(event.kind);
    return {
      signals: [],
      note:
        known.length > 0
          ? `observed ${event.kind}; ${known.length} lesson(s) apply, top: ${known[0]?.claim}`
          : `observed ${event.kind}`,
    };
  };
}

export function createCognitiveRuntime(options: CognitiveRuntimeOptions): CognitiveRuntime {
  const now = options.now ?? (() => Date.now());
  const dir = path.join(options.memoryDir, "cognition");
  const onError = (error: unknown) => options.onError?.(error);
  const stores = options.stores ?? {};
  const goals = new GoalManager({
    dir,
    onError,
    ...(stores.goals ? { store: stores.goals } : {}),
  });
  const lessons = new LessonStore({
    dir,
    onError,
    ...(stores.lessons ? { store: stores.lessons } : {}),
  });
  const world = new WorldModel({ now, onError, ...(stores.world ? { store: stores.world } : {}) });
  // Until the stored overrides load, the system counts as paused (fail safe).
  const overrides = new HumanOverrides({
    now,
    onError,
    ...(stores.overrides ? { store: stores.overrides } : {}),
  });
  const audit = new AuditLog({ now, onError, ...(stores.audit ? { store: stores.audit } : {}) });
  // Until stored privacy choices load, camera and microphone count as off.
  const privacy = new PrivacyControls({
    now,
    onError,
    ...(stores.privacy ? { store: stores.privacy } : {}),
    onChange: (state) => {
      if (!state.microphone) {
        options.sensorDaemons?.stopMicrophone?.();
      }
      if (!state.camera) {
        options.sensorDaemons?.stopCamera?.();
      }
      const on = (v: boolean) => (v ? "on" : "off");
      audit.append({
        actor: state.updatedBy,
        action: "privacy.state",
        reason: `microphone ${on(state.microphone)}, camera ${on(state.camera)}, recording ${on(state.recording)}, private mode ${on(state.privateMode)}`,
        execution: "recorded",
      });
    },
  });
  const people = new PeopleRegistry({
    now,
    onError,
    ...(stores.people ? { store: stores.people } : {}),
  });
  const mind = new MindModel({
    now,
    onError,
    ...(stores.beliefs ? { store: stores.beliefs } : {}),
  });
  const router = new ThalamicRouter({
    now,
    onConsumerError: (error) => options.onError?.(error),
    // Privacy is enforced here: a switched-off sensor's events never enter.
    admit: (event) => privacy.admits(event),
  });

  const granted = new Set(options.grantedCapabilities.filter((c) => BODY_CAPABILITIES.includes(c)));
  const preAuthorized = new Set(options.preAuthorizedCapabilities.filter((c) => granted.has(c)));
  const resolvePlace = (id: string): string | undefined => {
    const entity = world.get(id);
    if (!entity) {
      return undefined;
    }
    return entity.kind === "room" || entity.kind === "location"
      ? entity.id
      : entity.position?.placeId;
  };
  const adapter: BodyAdapter =
    options.bodyMode === "simulated" ? new SimulatedBody(resolvePlace) : new NullBody();
  const robot = options.bodyMode === "simulated" ? new SimulatedRobot({ now }) : undefined;

  const sensors = (): SensorStatus[] => {
    const p = privacy.state();
    return [
      { id: "screen", kind: "screen", available: true },
      { id: "battery", kind: "battery", available: options.environment()?.battery != null },
      {
        id: "camera",
        kind: "camera",
        available: p.camera && robot !== undefined,
        detail: !p.camera
          ? "switched off by a person"
          : robot
            ? "simulated camera (MOCK)"
            : "no camera perception adapter is connected",
      },
      {
        id: "microphone",
        kind: "microphone",
        available: false,
        detail: p.microphone
          ? "no audio perception adapter is connected to the cognitive core"
          : "switched off by a person",
      },
    ];
  };
  const chargerId = () =>
    world.query({ property: { key: "charger", value: true }, limit: 1 })[0]?.entity.id;
  const energy = (): EnergyAdvice => {
    const id = chargerId();
    return assessEnergy({
      battery: options.environment()?.battery ?? null,
      hasBody: adapter.mode !== "none",
      ...(id ? { chargerId: id } : {}),
    });
  };
  const presence = (): PresenceState =>
    presenceState({
      world,
      people,
      recentEvents: router.recent(64).map((r) => r.event),
      nowMs: now(),
    });

  // Construction order follows the dependencies, so nothing is read before it exists:
  // loop -> self model -> workspace -> body.
  const loop = new CognitiveLoop({
    level: overrides.effectiveLevel(options.autonomyLevel),
    reason: options.reason ?? observeOnlyReasoner(lessons),
    goals,
    now,
    ...(options.onCycle ? { onCycle: options.onCycle } : {}),
  });

  const selfModel = (): SelfModel => {
    const placeId = adapter.placeId();
    const activeModel = options.activeModel?.();
    const focus = loop.activeEvent();
    return buildSelfModel({
      name: options.name ?? "Lumina",
      atISO: new Date(now()).toISOString(),
      body: { mode: adapter.mode, adapterId: adapter.id, ...(placeId ? { placeId } : {}) },
      emergencyStop: options.emergencyStop.isEngaged(),
      sensors: sensors(),
      capabilities: [...options.toolNames(), ...granted],
      battery: options.environment()?.battery ?? null,
      ...(activeModel ? { activeModel } : {}),
      autonomyLevel: loop.getLevel(),
      tasks: goals.rank(now()).map((r) => ({ id: r.goal.id, title: r.goal.title, score: r.score })),
      ...(focus ? { attentionTarget: focus.event.kind } : {}),
      pendingEvents: router.pending,
    });
  };

  // Built from live sources on every read, so it never needs refreshing.
  const workspace = new GlobalWorkspace({
    goals,
    world,
    router,
    loop,
    lessons,
    working: options.working,
    environment: options.environment,
    self: selfModel,
    privacy: () => privacy.state(),
    presence,
    health: () => brainstem.status(),
    energy,
    now,
  });

  const body = new EmbodiedController({
    body: adapter,
    emergencyStop: options.emergencyStop,
    now,
    audit,
    onTamper: (detail) => {
      void safety.reportTamper(detail, "agent").catch((error) => options.onError?.(error));
    },
    ...(options.onBodyResult ? { onResult: options.onBodyResult } : {}),
    context: () => ({
      autonomyLevel: overrides.effectiveLevel(loop.getLevel()),
      granted,
      preAuthorized,
      world,
      canObserve: sensors().some((s) => s.kind === "camera" && s.available),
      canAsk: true,
      paused: overrides.state().paused,
      disabledCapabilities: new Set(overrides.state().disabledCapabilities),
      energy: options.environment()?.battery ?? null,
      people: world.query({ kind: "person" }).map(({ entity, confidence }) => ({
        id: entity.id,
        confidence,
        distanceM: entity.position?.distanceM,
      })),
      isCharger: (id) => world.get(id)?.properties.charger === true,
    }),
  });

  const teleop = new TeleoperationGateway(people, body, audit);

  const syncLevel = () =>
    loop.setLevel(
      options.emergencyStop.isEngaged() ? 0 : overrides.effectiveLevel(options.autonomyLevel),
    );
  const safety = new SafetyKernel({
    overrides,
    audit,
    body,
    loop,
    emergencyStop: options.emergencyStop,
    onOverride: () => syncLevel(),
    ...(options.notify ? { notify: options.notify } : {}),
  });
  const latchEmergency = () => {
    overrides.apply({ type: "pause" }, { channel: "agent", actor: "emergency-stop" });
    loop.setLevel(0);
    loop.cancelActive("Emergency stop engaged.");
  };
  if (options.emergencyStop.isEngaged()) {
    latchEmergency();
  }
  // The loop starts at the stored-override level (paused while loading) and
  // takes the real one once a person's stored orders are known.
  const ready = Promise.all([
    goals.ready,
    lessons.ready,
    options.episodicMemory?.ready ?? Promise.resolve(),
    world.ready,
    overrides.ready,
    audit.ready,
    privacy.ready,
    mind.ready,
    people.ready.then(() => {
      const ownerName = options.ownerName?.trim();
      if (ownerName && !people.owner()) {
        const config = { channel: "owner", actor: "config" } as const;
        const owner = people.remember({ name: ownerName }, config);
        if (owner.ok) {
          people.setRole(owner.person.id, "owner", config);
        }
      }
    }),
  ]).then(syncLevel);

  // Brainstem: every subsystem checked on a timer, with no language model involved.
  const probe = (name: string, critical: boolean, check: () => ProbeResult): Probe => ({
    name,
    critical,
    check,
  });
  const on = (v: boolean) => (v ? "on" : "off");
  const persistent = Boolean(
    stores.audit &&
    stores.overrides &&
    stores.world &&
    stores.goals &&
    stores.lessons &&
    options.episodicMemory,
  );
  const brainstem = new Brainstem({
    now,
    ...(options.brainstemIntervalMs ? { intervalMs: options.brainstemIntervalMs } : {}),
    probes: [
      probe("awareness", false, () => {
        const env = options.environment();
        if (!env) {
          return {
            status: "degraded",
            detail: "No environment snapshot yet.",
            recommendation: "Wait for the first awareness poll.",
          };
        }
        const ageMs = now() - Date.parse(env.atISO);
        return ageMs > 5 * 60_000
          ? {
              status: "degraded",
              detail: `Environment snapshot is ${Math.round(ageMs / 60_000)} min old.`,
              recommendation: "Check the awareness poller.",
            }
          : { status: "ok", detail: "Environment snapshot is current." };
      }),
      probe("network", false, () =>
        options.environment()?.network.online === false
          ? {
              status: "degraded",
              detail: "Offline: cloud models and messaging may fail; local functions continue.",
              recommendation: "Check the connection.",
            }
          : { status: "ok", detail: "Online or unknown." },
      ),
      probe("energy", adapter.mode !== "none", () => {
        const advice = energy();
        const status =
          advice.level === "critical"
            ? "down"
            : advice.level === "low"
              ? "degraded"
              : advice.level === "unknown"
                ? "absent"
                : "ok";
        return {
          status,
          detail: advice.detail,
          ...(advice.action !== "none" ? { recommendation: advice.action } : {}),
        };
      }),
      probe("stores", false, () =>
        persistent
          ? {
              status: "ok",
              detail:
                "Safety, world, goals, lessons and episodic memory persist in SQLite plugin state.",
            }
          : {
              status: "degraded",
              detail:
                "One or more cognitive stores are session-only and will not survive a restart.",
              recommendation: "Run inside the gateway with plugin state available.",
            },
      ),
      probe("audit", true, () => {
        const v = audit.verify();
        return v.ok
          ? { status: "ok", detail: `Audit chain intact (${v.entries} entries).` }
          : {
              status: "down",
              detail: `Audit chain broken at entry ${v.brokenAt}: ${v.reason}.`,
              recommendation: "Treat as tampering; a person must review.",
            };
      }),
      probe("body", false, () =>
        robot
          ? { status: robot.health().status, detail: robot.health().detail }
          : { status: "absent", detail: "No body: this is a desktop." },
      ),
      probe("privacy", false, () => {
        const p = privacy.state();
        return {
          status: "ok",
          detail: `microphone ${on(p.microphone)}, camera ${on(p.camera)}, recording ${on(p.recording)}, private mode ${on(p.privateMode)}`,
        };
      }),
      probe("model", false, () => {
        const model = options.activeModel?.();
        return model
          ? { status: "ok", detail: `Active model: ${model}.` }
          : {
              status: "degraded",
              detail: "No active model reported: reasoning may be unavailable.",
              recommendation: "Check the agent model configuration.",
            };
      }),
    ],
    onDegraded: (subsystem) => {
      audit.append({
        actor: "brainstem",
        action: `health.${subsystem.name}`,
        reason: subsystem.detail,
        execution: "recorded",
      });
      if (subsystem.status === "down") {
        options.notify?.(
          `Subsistema ${subsystem.name} caído: ${subsystem.detail}`,
          subsystem.critical ? "critical" : "warn",
        );
      }
    },
    onCriticalDown: async (subsystem) => {
      if (subsystem.name === "audit") {
        await safety.reportTamper(subsystem.detail, "brainstem");
        return;
      }
      // Isolate without freezing the rest of Lumina: stop the body and pause autonomy.
      await body.stopAll(`${subsystem.name} down: ${subsystem.detail}`, "brainstem");
      await safety.override({ type: "pause" }, { channel: "agent", actor: "brainstem" });
    },
    onRecovered: (subsystem) => {
      audit.append({
        actor: "brainstem",
        action: `health.${subsystem.name}`,
        reason: `recovered: ${subsystem.detail}`,
        execution: "recorded",
      });
    },
  });

  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (options.startTimers !== false) {
    brainstem.start();
    const consolidation = setInterval(
      () => {
        try {
          consolidate({ world, lessons });
        } catch (error) {
          onError(error);
        }
      },
      Math.max(60_000, options.consolidationIntervalMs ?? 3_600_000),
    );
    consolidation.unref?.();
    timers.push(consolidation);
  }

  const forgetSession = (sinceISO: string) => {
    const worldForgotten = world.forgetSince(sinceISO);
    const episodicForgotten = options.episodicMemory?.forgetSince(sinceISO) ?? 0;
    const beliefsForgotten = mind.forgetSince(sinceISO);
    const forgotten = worldForgotten + episodicForgotten + beliefsForgotten;
    audit.append({
      actor: "agent",
      action: "privacy.forget_session",
      reason: `session-local world observations, episodes and mind beliefs since ${sinceISO}`,
      execution: "executed",
      outcome: `${forgotten} removed (world=${worldForgotten}, episodic=${episodicForgotten}, beliefs=${beliefsForgotten})`,
    });
    return {
      forgotten,
      worldForgotten,
      episodicForgotten,
      beliefsForgotten,
      note:
        "World observations, episodic memories and theory-of-mind beliefs from this session were removed. " +
        "Shared Supabase memory is a separate continuity store and was not changed.",
    };
  };

  const detachers = [
    options.emergencyStop.onEngage(latchEmergency),
    // Danger: the harm-reducing protocol, recorded as an incident (spec §33).
    router.subscribe({ kind: "danger.detected" }, ({ event }) => {
      const report = payloadOf(event, "danger.detected");
      if (report) {
        safety.handleDanger(
          {
            hazard: report.hazard,
            severity: report.severity,
            confidence: report.confidence,
            ...(report.personId ? { personId: report.personId } : {}),
          },
          adapter.mode !== "none",
        );
      }
    }),
    attachWorldModel(router, world),
    attachAwareness(options.awarenessBus, router, { onError: (error) => options.onError?.(error) }),
    loop.consume(router, { onError: (error) => options.onError?.(error) }),
    ...(options.screenPerception
      ? [attachScreenPerception(options.screenPerception, router, { onError })]
      : []),
  ];

  return {
    router,
    world,
    goals,
    lessons,
    loop,
    workspace,
    body,
    teleop,
    safety,
    audit,
    privacy,
    people,
    mind,
    brainstem,
    robot,
    presence,
    energy,
    ready,
    flush: async () => {
      await Promise.all([
        goals.flush(),
        lessons.flush(),
        options.episodicMemory?.flush() ?? Promise.resolve(),
        world.flush(),
        overrides.flush(),
        audit.flush(),
        privacy.flush(),
        people.flush(),
        mind.flush(),
      ]);
    },
    selfModel,
    tools: [
      createWorkspaceTool(workspace),
      createSelfModelTool(selfModel),
      createGoalTool(goals),
      createWorldObserveTool(world),
      createWorldQueryTool(world),
      createBodyTool(body, () => safety.status()),
      createBehaviorTool(body, world, now),
      createSafetyTool(safety, audit),
      createExplainTool(audit, loop),
      createPrivacyTool(privacy, forgetSession),
      createPeopleTool(people, presence),
      createMindTool(mind),
      createHealthTool(brainstem, energy),
    ],
    dispose: () => {
      brainstem.stop();
      for (const timer of timers) {
        clearInterval(timer);
      }
      loop.setLevel(0);
      for (const detach of detachers) {
        detach();
      }
      body.dispose();
    },
  };
}
