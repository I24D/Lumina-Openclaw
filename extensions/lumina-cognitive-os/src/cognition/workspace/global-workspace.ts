/**
 * global-workspace.ts — The one picture of "what is going on right now".
 *
 * M3GAN spec §3.5: a central representation of the current cognitive state —
 * goal, people present, location, attention target, active task, recent
 * events, relevant memories, environment, uncertainty and body state — that
 * every module reads instead of each one assembling its own partial view.
 *
 * The workspace owns no data. Each field is read from the module that already
 * owns it (goals, world model, router, loop, lessons, working memory,
 * awareness, self model), so there is exactly one source of truth per fact and
 * nothing to keep in sync. Every source is optional: a missing module yields
 * an empty field instead of an error, which keeps the workspace usable while
 * the system is only partly assembled.
 *
 * `snapshot()` rebuilds from the live sources on every read, so the picture is
 * always current without anything having to push updates into it; that is
 * what "updated continuously" means here.
 */
import type { EnvironmentSnapshot } from "../../awareness/snapshot.js";
import type { WorkingMemory } from "../../memory/working-memory.js";
import { STALE_BELOW, type WorldModel } from "../../world/world-model.js";
import type { GoalManager } from "../goals/goal-manager.js";
import type { LessonStore } from "../learning/lessons.js";
import type { CognitiveLoop } from "../loop/cognitive-loop.js";
import type { ThalamicRouter } from "../router/thalamic-router.js";
import type { SelfModel } from "../self/self-model.js";

export type WorkspaceSources = {
  readonly goals?: GoalManager;
  readonly world?: WorldModel;
  readonly router?: ThalamicRouter;
  readonly loop?: CognitiveLoop;
  readonly lessons?: LessonStore;
  readonly working?: () => WorkingMemory;
  readonly environment?: () => EnvironmentSnapshot | null;
  readonly self?: () => SelfModel;
  readonly now?: () => number;
};

export type GlobalWorkspaceSnapshot = {
  readonly atISO: string;
  readonly currentGoal: {
    readonly id: string;
    readonly title: string;
    readonly priority: number;
    readonly score: number;
    readonly reason: string;
  } | null;
  readonly activePeople: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly confidence: number;
    readonly placeId: string | null;
  }>;
  readonly currentLocation: { readonly id: string; readonly label: string } | null;
  readonly attentionTarget: {
    readonly source: string;
    readonly kind: string;
    readonly salience: number;
    readonly atISO: string;
  } | null;
  readonly activeTask: {
    readonly event: string;
    readonly action: string | null;
    readonly outcome: string | null;
    readonly executed: boolean;
    readonly interrupted: boolean;
    readonly atISO: string;
  } | null;
  readonly recentEvents: ReadonlyArray<{
    readonly source: string;
    readonly kind: string;
    readonly atISO: string;
    readonly salience: number;
    readonly admitted: boolean;
  }>;
  readonly pendingEvents: number;
  readonly relevantMemories: ReadonlyArray<{
    readonly trigger: string;
    readonly claim: string;
    readonly confidence: number;
  }>;
  readonly userContext: {
    readonly intent: string | null;
    readonly activeWindow: string | null;
    readonly pinned: ReadonlyArray<string>;
  } | null;
  readonly environmentState: {
    readonly batteryPercent: number | null;
    readonly charging: boolean | null;
    readonly networkOnline: boolean;
    readonly cpuPct: number;
    readonly memoryPct: number;
  } | null;
  readonly uncertainty: {
    /** Beliefs that have gone stale and should be refreshed before acting on them. */
    readonly staleBeliefs: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly confidence: number;
    }>;
    readonly lastDecisionConfidence: number | null;
  };
  readonly robotState: {
    readonly mode: string;
    readonly emergencyStop: boolean;
    readonly placeId: string | null;
  } | null;
};

export type WorkspaceLimits = {
  readonly recentEvents?: number;
  readonly memories?: number;
  readonly staleBeliefs?: number;
};

export class GlobalWorkspace {
  private latest: GlobalWorkspaceSnapshot | undefined;
  private readonly now: () => number;

  constructor(
    private readonly sources: WorkspaceSources,
    private readonly limits: WorkspaceLimits = {},
  ) {
    this.now = sources.now ?? (() => Date.now());
  }

  /** The last snapshot built, without rebuilding. */
  current(): GlobalWorkspaceSnapshot {
    return this.latest ?? this.snapshot();
  }

  /** Rebuild from live sources and remember the result. */
  snapshot(): GlobalWorkspaceSnapshot {
    const nowMs = this.now();
    const { goals, world, router, loop, lessons } = this.sources;
    const self = this.sources.self?.();
    const lastCycle = loop?.recent(1)[0];
    const focus = loop?.activeEvent() ?? router?.pendingEvents(1)[0];

    const next = goals?.next(nowMs);
    const people = world?.query({ kind: "person", minConfidence: STALE_BELOW }) ?? [];
    const placeId = self?.body.placeId;
    const place = placeId ? world?.get(placeId) : undefined;
    const attentionKind = focus?.event.kind ?? lastCycle?.event.kind;
    const working = this.sources.working?.();
    const env = this.sources.environment?.() ?? null;

    const snapshot: GlobalWorkspaceSnapshot = {
      atISO: new Date(nowMs).toISOString(),
      currentGoal: next
        ? {
            id: next.goal.id,
            title: next.goal.title,
            priority: next.goal.priority,
            score: next.score,
            reason: next.reason,
          }
        : null,
      activePeople: people.map(({ entity, confidence }) => ({
        id: entity.id,
        label: entity.label,
        confidence,
        placeId: entity.position?.placeId ?? null,
      })),
      currentLocation: place ? { id: place.id, label: place.label } : null,
      attentionTarget: focus
        ? {
            source: focus.event.source,
            kind: focus.event.kind,
            salience: focus.verdict.salience,
            atISO: focus.event.atISO,
          }
        : null,
      activeTask: lastCycle
        ? {
            event: lastCycle.event.kind,
            action: lastCycle.action ?? null,
            outcome: lastCycle.outcome ?? null,
            executed: lastCycle.executed,
            interrupted: lastCycle.interrupted === true,
            atISO: lastCycle.atISO,
          }
        : null,
      recentEvents: (router?.recent(this.limits.recentEvents ?? 10) ?? []).map(
        ({ event, verdict }) => ({
          source: event.source,
          kind: event.kind,
          atISO: event.atISO,
          salience: verdict.salience,
          admitted: verdict.admitted,
        }),
      ),
      pendingEvents: router?.pending ?? 0,
      relevantMemories: attentionKind
        ? (lessons?.applicable(attentionKind) ?? [])
            .slice(0, this.limits.memories ?? 5)
            .map((l) => ({ trigger: l.trigger, claim: l.claim, confidence: l.confidence }))
        : [],
      userContext: working
        ? {
            intent: working.currentIntent,
            activeWindow: working.activeWindow?.title ?? null,
            pinned: working.pinnedContext,
          }
        : null,
      environmentState: env
        ? {
            batteryPercent: env.battery?.percent ?? null,
            charging: env.battery?.charging ?? null,
            networkOnline: env.network.online,
            cpuPct: env.cpu.usagePct,
            memoryPct: env.memory.usedPct,
          }
        : null,
      uncertainty: {
        staleBeliefs: this.staleBeliefs(world),
        lastDecisionConfidence: lastCycle?.confidence ?? null,
      },
      robotState: self
        ? {
            mode: self.body.mode,
            emergencyStop: self.body.emergencyStop,
            placeId: self.body.placeId ?? null,
          }
        : null,
    };
    this.latest = snapshot;
    return snapshot;
  }

  /** People and movable things whose belief has decayed below the stale line. */
  private staleBeliefs(
    world: WorldModel | undefined,
  ): GlobalWorkspaceSnapshot["uncertainty"]["staleBeliefs"] {
    if (!world) {
      return [];
    }
    return world
      .query()
      .filter(({ confidence }) => confidence < STALE_BELOW)
      .toSorted((a, b) => a.confidence - b.confidence)
      .slice(0, this.limits.staleBeliefs ?? 5)
      .map(({ entity, confidence }) => ({ id: entity.id, label: entity.label, confidence }));
  }
}
