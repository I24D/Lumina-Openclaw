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
import { Brainstem } from "../brainstem/brainstem.js";
import { coreProbes } from "../brainstem/core-probes.js";
import { assessEnergy, type EnergyAdvice } from "../brainstem/energy.js";
import { createHealthTool } from "../brainstem/health-tool.js";
import { createBehaviorTool } from "../embodiment/behavior-tool.js";
import { createBodyAdapter, type SimulatorContext } from "../embodiment/body-adapter.js";
import { createBodyTool } from "../embodiment/body-tool.js";
import { BODY_CAPABILITIES, type BodyAdapter } from "../embodiment/body.js";
import {
  EmbodiedController,
  type EmbodiedResult,
  type EmergencyStop,
} from "../embodiment/embodied-controller.js";
import { SimulatedRobot } from "../embodiment/simulated-robot.js";
import { TeleoperationGateway } from "../embodiment/teleoperation.js";
import {
  ArtifactRegistry,
  type ArtifactInput,
  type ArtifactRecord,
} from "../evaluation/artifact-registry.js";
import { createArtifactTool } from "../evaluation/artifact-tool.js";
import { payloadOf } from "../events/catalog.js";
import type { EpisodicMemoryStore } from "../memory/episodic-memory.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import type { PerceptionEvent } from "../perception/perception-process.js";
import {
  createRecognition,
  type Recognition,
  type RecognitionSensors,
} from "../perception/recognition.js";
import { createForgetSession } from "../privacy/forget-session.js";
import { PrivacyControls, type PrivacyState } from "../privacy/privacy-state.js";
import { createPrivacyTool } from "../privacy/privacy-tool.js";
import type { CheckpointStore } from "../safety/audit-checkpoint.js";
import { AuditLog, type AuditRecord } from "../safety/audit-log.js";
import { InteractionModes, MODE_GUIDANCE, type ModeState } from "../safety/interaction-mode.js";
import { createModeTool } from "../safety/mode-tool.js";
import { HumanOverrides, type OverrideState } from "../safety/overrides.js";
import type { ConfirmPort } from "../safety/physical-confirm.js";
import { attachSafeguards } from "../safety/safeguards.js";
import { SafetyKernel, type KernelEmergencyStop } from "../safety/safety-kernel.js";
import { createExplainTool, createSafetyTool } from "../safety/safety-tools.js";
import type { StateStorePort } from "../shared/state-store.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import type { BiometricRecord } from "../social/biometrics.js";
import { PeopleRegistry, type Person } from "../social/people.js";
import { createPracticeTool } from "../social/practice-tool.js";
import { PracticeBook, type PracticeItem } from "../social/practice.js";
import { presenceState, type PresenceState } from "../social/presence.js";
import { createMindTool, createPeopleTool } from "../social/social-tools.js";
import { MindModel, type Belief } from "../social/theory-of-mind.js";
import { knowledgeGap } from "../world/curiosity.js";
import { WorldModel, type Observation } from "../world/world-model.js";
import { attachWorldModel } from "../world/world-perception.js";
import { createWorldObserveTool, createWorldQueryTool } from "../world/world-tools.js";
import type { AutonomyLevel } from "./autonomy-levels.js";
import { createGoalTool, createSelfModelTool, createWorkspaceTool } from "./cognition-tools.js";
import { consolidate } from "./consolidation.js";
import { GoalManager, type Goal } from "./goals/goal-manager.js";
import { LessonStore, type Lesson } from "./learning/lessons.js";
import { createReflectTool } from "./learning/reflection-tool.js";
import { createReflection } from "./learning/reflection.js";
import { attachAwareness } from "./loop/awareness-bridge.js";
import { CognitiveLoop, type CycleRecord, type Reasoner } from "./loop/cognitive-loop.js";
import { attachScreenPerception } from "./loop/perception-bridge.js";
import {
  createSituationalReasoner,
  surfaceProposals,
  type Initiative,
} from "./loop/situational-reasoner.js";
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

export type { SimulatorContext } from "../embodiment/body-adapter.js";

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
    readonly biometrics?: StateStorePort<BiometricRecord>;
    readonly goals?: StateStorePort<Goal>;
    readonly lessons?: StateStorePort<Lesson>;
    readonly mode?: StateStorePort<ModeState>;
    readonly practice?: StateStorePort<PracticeItem>;
    readonly artifacts?: StateStorePort<ArtifactRecord>;
  };
  /** Model and dataset files to register and check against their pinned hashes (spec §135). */
  readonly artifacts?: ReadonlyArray<ArtifactInput>;
  /** The owner, given the owner role when nobody holds it (config is an owner channel). */
  readonly ownerName?: string;
  /**
   * Wakes the agent with an initiative. With it, the situational reasoner runs: at L3 its
   * proposals reach the agent as questions for the person, at L4+ reversible low-risk ones run.
   */
  readonly initiative?: (initiative: Initiative) => void;
  /** Append-only store outside the gateway for the audit chain's head (spec §24, §48). */
  readonly auditCheckpoints?: CheckpointStore;
  /** Real-keyboard confirmation of physical actions; injected key presses never count. */
  readonly physicalConfirm?: ConfirmPort;
  /**
   * A richer simulated body (a physics simulator, a ROS 2 robot in simulation) in place of the
   * symbolic one when bodyMode is "simulated". It still only receives supervised intents.
   */
  readonly simulator?: (context: SimulatorContext) => BodyAdapter;
  /** Recognizing sensors (webcam faces, microphone voices); each runs only while allowed. */
  readonly sensors?: RecognitionSensors;
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
  /** Who Lumina sees and hears: consented templates and the recognizing sensors. */
  readonly recognition: Recognition;
  /** The adapter the supervised intents reach (none, symbolic, physics simulator...). */
  readonly bodyAdapter: BodyAdapter;
  /** Looks back at the audit and cycles and proposes lessons for a person to accept. */
  readonly reflection: ReturnType<typeof createReflection>;
  /** Normal, child, companion or maintenance: restrictions on top of a person's overrides. */
  readonly modes: InteractionModes;
  /** What people are learning with Lumina (teaching and language practice). */
  readonly practice: PracticeBook;
  /** Lumina's own models and datasets, with provenance and pinned hashes. */
  readonly artifacts: ArtifactRegistry;
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
  // A person's sensor switch reaches the recognizing sensors at once (they exist further down).
  let refreshSensors: () => void = () => undefined;
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
      refreshSensors();
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
  const practice = new PracticeBook({
    now,
    onError,
    ...(stores.practice ? { store: stores.practice } : {}),
  });
  const artifacts = new ArtifactRegistry({
    now,
    onError,
    ...(stores.artifacts ? { store: stores.artifacts } : {}),
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
  const recognition = createRecognition({
    people,
    router,
    privacy: () => privacy.state(),
    now,
    onError,
    ...(options.sensors ? { sensors: options.sensors } : {}),
    ...(stores.biometrics ? { store: stores.biometrics } : {}),
  });
  refreshSensors = () => recognition.refresh();

  const granted = new Set(options.grantedCapabilities.filter((c) => BODY_CAPABILITIES.includes(c)));
  const preAuthorized = new Set(options.preAuthorizedCapabilities.filter((c) => granted.has(c)));
  const adapter = createBodyAdapter({
    bodyMode: options.bodyMode,
    world,
    nameOf: (id) => people.get(id)?.name ?? world.get(id)?.label,
    ingest: (event) => void router.ingest(event),
    ...(options.simulator ? { simulator: options.simulator } : {}),
  });
  const robot = options.bodyMode === "simulated" ? new SimulatedRobot({ now }) : undefined;

  const sensors = (): SensorStatus[] => {
    const p = privacy.state();
    const { camera: webcam, microphone } = recognition.status();
    return [
      { id: "screen", kind: "screen", available: true },
      { id: "battery", kind: "battery", available: options.environment()?.battery != null },
      {
        id: "camera",
        kind: "camera",
        available: p.camera && (webcam?.running === true || robot !== undefined),
        detail: !p.camera
          ? "switched off by a person"
          : webcam?.running
            ? "webcam: face detection and consented recognition"
            : robot
              ? "simulated camera (MOCK)"
              : (webcam?.lastError ?? "no camera perception adapter is connected"),
      },
      {
        id: "microphone",
        kind: "microphone",
        available: p.microphone && microphone?.running === true,
        detail: !p.microphone
          ? "switched off by a person"
          : microphone?.running
            ? "microphone: voice activity and consented speaker recognition"
            : (microphone?.lastError ?? "no audio perception adapter is connected"),
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
  const initiative = options.initiative;
  const loop = new CognitiveLoop({
    level: overrides.effectiveLevel(options.autonomyLevel),
    reason:
      options.reason ??
      (initiative
        ? createSituationalReasoner({
            people,
            deliver: initiative,
            fallback: observeOnlyReasoner(lessons),
            now,
            world,
            presence,
            mode: () => modes.state().mode,
          })
        : observeOnlyReasoner(lessons)),
    goals,
    now,
    ...(options.onCycle ? { onCycle: options.onCycle } : {}),
    ...(initiative ? { onSurface: surfaceProposals(initiative) } : {}),
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
      interactionMode: { mode: modes.state().mode, guidance: MODE_GUIDANCE[modes.state().mode] },
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
      // A mode's restrictions add to a person's overrides; neither ever lifts the other.
      paused: overrides.state().paused || modes.restrictions().paused,
      ...(!overrides.state().paused && modes.restrictions().paused
        ? { pauseReason: "Maintenance mode: autonomy is paused while someone works on Lumina." }
        : {}),
      disabledCapabilities: new Set([
        ...overrides.state().disabledCapabilities,
        ...modes.restrictions().disabledCapabilities,
      ]),
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
      options.emergencyStop.isEngaged() || modes.restrictions().paused
        ? 0
        : overrides.effectiveLevel(options.autonomyLevel),
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
  const modes = new InteractionModes({
    safety,
    now,
    onError,
    ...(stores.mode ? { store: stores.mode } : {}),
    activity: () => audit.recent(1000),
    onChange: (state) => {
      syncLevel();
      audit.append({
        actor: state.by,
        action: "mode.change",
        reason: `interaction mode ${state.mode}`,
        execution: "executed",
        ...(state.lastSummary ? { outcome: state.lastSummary } : {}),
      });
      initiative?.({
        key: "mode",
        text: `Interaction mode is now ${state.mode}. ${MODE_GUIDANCE[state.mode]}${
          state.mode === "normal" && state.lastSummary
            ? ` Tell the guardian: ${state.lastSummary}`
            : ""
        }`,
      });
    },
  });
  const safeguards = attachSafeguards({
    audit,
    safety,
    body,
    onError,
    ...(options.auditCheckpoints ? { checkpoints: options.auditCheckpoints } : {}),
    ...(options.physicalConfirm ? { physicalConfirm: options.physicalConfirm } : {}),
    ...(options.notify ? { notify: (message: string) => options.notify?.(message, "warn") } : {}),
  });
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
    recognition.ready,
    modes.ready,
    practice.ready,
    artifacts.ready,
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
  const brainstem = new Brainstem({
    now,
    ...(options.brainstemIntervalMs ? { intervalMs: options.brainstemIntervalMs } : {}),
    probes: [
      ...coreProbes({
        environment: options.environment,
        energy,
        hasBody: adapter.mode !== "none",
        persistent: Boolean(
          stores.audit &&
          stores.overrides &&
          stores.world &&
          stores.goals &&
          stores.lessons &&
          options.episodicMemory,
        ),
        audit,
        robot,
        privacy: () => privacy.state(),
        ...(options.activeModel ? { activeModel: options.activeModel } : {}),
        now,
      }),
      ...safeguards.probes(),
      ...recognition.probes(),
      artifacts.probe(),
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

  const reflection = createReflection({ audit, loop, now });
  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (options.startTimers !== false) {
    brainstem.start();
    const reflecting = setInterval(() => {
      try {
        reflection.run();
      } catch (error) {
        onError(error);
      }
    }, 6 * 3_600_000);
    reflecting.unref?.();
    timers.push(reflecting);
    // Pin what is on disk, then check it now and every 6 hours.
    const checkArtifacts = () =>
      void artifacts
        .registerPresent(options.artifacts ?? [])
        .then(() => artifacts.verifyAll())
        .catch(onError);
    checkArtifacts();
    const artifactCheck = setInterval(checkArtifacts, 6 * 3_600_000);
    artifactCheck.unref?.();
    timers.push(artifactCheck);
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

  const forgetSession = createForgetSession({
    world,
    mind,
    audit,
    ...(options.episodicMemory ? { episodicMemory: options.episodicMemory } : {}),
  });

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
    // Curiosity (spec §92): a new thing nothing explains earns a cycle of its own.
    attachWorldModel(router, world, (result, event) => {
      const gap = knowledgeGap(result, event);
      if (gap) {
        void router.ingest(gap);
      }
    }),
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
    bodyAdapter: adapter,
    recognition,
    reflection,
    modes,
    practice,
    artifacts,
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
        recognition.gallery.flush(),
        modes.flush(),
        practice.flush(),
        artifacts.flush(),
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
      createPeopleTool(people, presence, recognition),
      createMindTool(mind),
      createHealthTool(brainstem, energy),
      createReflectTool(reflection),
      createModeTool(modes),
      createPracticeTool(practice, people),
      createArtifactTool(artifacts),
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
      recognition.dispose();
      safeguards.dispose();
      adapter.dispose?.();
      body.dispose();
    },
  };
}
