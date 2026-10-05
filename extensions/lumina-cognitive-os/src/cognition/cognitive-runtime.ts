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
 * The loop starts observe-only: its default reasoner proposes no actions, so
 * enabling the core gives Lumina situational awareness without giving it new
 * initiative. A reasoner that proposes actions is a separate, deliberate step.
 */
import path from "node:path";
import type { AwarenessEventBus } from "../awareness/event-bus.js";
import type { EnvironmentSnapshot } from "../awareness/snapshot.js";
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
import type { WorkingMemory } from "../memory/working-memory.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import { WorldModel } from "../world/world-model.js";
import { attachWorldModel } from "../world/world-perception.js";
import { createWorldObserveTool, createWorldQueryTool } from "../world/world-tools.js";
import type { AutonomyLevel } from "./autonomy-levels.js";
import { createGoalTool, createSelfModelTool, createWorkspaceTool } from "./cognition-tools.js";
import { GoalManager } from "./goals/goal-manager.js";
import { LessonStore } from "./learning/lessons.js";
import { attachAwareness } from "./loop/awareness-bridge.js";
import { CognitiveLoop, type CycleRecord, type Reasoner } from "./loop/cognitive-loop.js";
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
  readonly emergencyStop: EmergencyStop;
  readonly environment: () => EnvironmentSnapshot | null;
  readonly working: () => WorkingMemory;
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
};

export type CognitiveRuntime = {
  readonly router: ThalamicRouter;
  readonly world: WorldModel;
  readonly goals: GoalManager;
  readonly lessons: LessonStore;
  readonly loop: CognitiveLoop;
  readonly workspace: GlobalWorkspace;
  readonly body: EmbodiedController;
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
  const goals = new GoalManager(dir);
  const lessons = new LessonStore(dir);
  const world = new WorldModel({ dir, now });
  const router = new ThalamicRouter({
    now,
    onConsumerError: (error) => options.onError?.(error),
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

  const sensors = (): SensorStatus[] => [
    { id: "screen", kind: "screen", available: true },
    { id: "battery", kind: "battery", available: options.environment()?.battery != null },
    {
      id: "camera",
      kind: "camera",
      available: false,
      detail: "no camera perception adapter is connected",
    },
  ];

  // Construction order follows the dependencies, so nothing is read before it exists:
  // loop -> self model -> workspace -> body.
  const loop = new CognitiveLoop({
    level: options.autonomyLevel,
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
    now,
  });

  const body = new EmbodiedController({
    body: adapter,
    emergencyStop: options.emergencyStop,
    now,
    ...(options.onBodyResult ? { onResult: options.onBodyResult } : {}),
    context: () => ({
      autonomyLevel: loop.getLevel(),
      granted,
      preAuthorized,
      world,
      canObserve: sensors().some((s) => s.kind === "camera" && s.available),
      canAsk: true,
    }),
  });

  const detachers = [
    attachWorldModel(router, world),
    attachAwareness(options.awarenessBus, router, { onError: (error) => options.onError?.(error) }),
    loop.consume(router, { onError: (error) => options.onError?.(error) }),
  ];

  return {
    router,
    world,
    goals,
    lessons,
    loop,
    workspace,
    body,
    selfModel,
    tools: [
      createWorkspaceTool(workspace),
      createSelfModelTool(selfModel),
      createGoalTool(goals),
      createWorldObserveTool(world),
      createWorldQueryTool(world),
      createBodyTool(body),
    ],
    dispose: () => {
      for (const detach of detachers) {
        detach();
      }
      body.dispose();
    },
  };
}
