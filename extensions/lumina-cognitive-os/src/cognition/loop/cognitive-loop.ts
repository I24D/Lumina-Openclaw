/**
 * cognitive-loop.ts — perceive -> attend -> reason -> decide -> act -> learn.
 *
 * This is the spine. Everything else in `cognition/` is a component it calls:
 *
 *   perceive  the awareness bus already emits events; the loop subscribes
 *   attend    AttentionFilter drops noise before any thinking happens
 *   reason    an injected reasoner proposes an action (or nothing)
 *   decide    confidence + risk + autonomy level narrow it to one outcome
 *   act       only "execute" actually runs; everything else is surfaced
 *   learn     every cycle is recorded so reflection has material
 *
 * The reasoner is injected rather than hard-coded: what counts as a sensible
 * response to "disk.low" is policy that changes often, while the pipeline
 * around it should not. Injection also keeps the loop testable without a
 * model, a gateway, or a clock.
 *
 * Nothing here can widen an authorization. The loop's only powers are to run
 * an action the gate already approved, or to hand it to Dal.
 *
 * In production the loop does not subscribe to producers itself: it drains the
 * thalamic router's attention queue one event at a time (`consume`). Cognition
 * is serial so gaze, speech and action stay coherent, and a clearly more
 * salient event (or an emergency) aborts the running action through its
 * AbortSignal instead of waiting behind it.
 */
import type { RiskTier } from "../../risk/policies.js";
import type { QueuedEvent } from "../attention-queue.js";
import { AttentionFilter, type AttentionVerdict, type CognitiveEvent } from "../attention.js";
import { decideAutonomy, type AutonomyLevel, type AutonomyOutcome } from "../autonomy-levels.js";
import { GoalManager } from "../goals/goal-manager.js";
import type { ThalamicRouter } from "../router/thalamic-router.js";
import { assessConfidence, type ConfidenceSignal } from "../uncertainty.js";

/** Something the reasoner thinks should happen. */
export type ProposedAction = {
  readonly summary: string;
  readonly riskTier: RiskTier;
  readonly reversible: boolean;
  readonly preAuthorized?: boolean;
  /**
   * Executed only when the gate returns "execute". The signal fires when a more
   * salient event preempts this cycle; long-running work should honour it.
   */
  readonly run?: (signal: AbortSignal) => Promise<void> | void;
};

export type ReasonerResult = {
  readonly action?: ProposedAction;
  readonly signals: ReadonlyArray<ConfidenceSignal>;
  /** Optional note recorded on the cycle for later reflection. */
  readonly note?: string;
};

export type Reasoner = (
  event: CognitiveEvent,
  context: { readonly goals: GoalManager | undefined },
) => ReasonerResult | undefined;

export type CycleRecord = {
  readonly atISO: string;
  readonly event: CognitiveEvent;
  readonly admitted: boolean;
  readonly salience: number;
  readonly confidence?: number;
  readonly outcome?: AutonomyOutcome;
  readonly action?: string;
  readonly executed: boolean;
  /** A more salient event asked this cycle to stop while it was acting. */
  readonly interrupted?: boolean;
  readonly error?: string;
  readonly reason: string;
};

export type ConsumeOptions = {
  /** A cycle that failed outside the loop's own error capture. */
  readonly onError?: (error: unknown) => void;
  /** Every preemption, with the router's reason. */
  readonly onInterrupt?: (active: QueuedEvent, incoming: QueuedEvent, reason: string) => void;
};

type ActiveCycle = {
  readonly item: QueuedEvent;
  readonly controller: AbortController;
};

export type CognitiveLoopOptions = {
  readonly level: AutonomyLevel;
  readonly reason: Reasoner;
  readonly attention?: AttentionFilter;
  readonly goals?: GoalManager;
  /** Called for every outcome that is not executed, so Dal can see it. */
  readonly onSurface?: (record: CycleRecord) => void;
  /** Called for every completed cycle, admitted or not. */
  readonly onCycle?: (record: CycleRecord) => void;
  readonly now?: () => number;
  /** Retained cycle history size. Default 256. */
  readonly historyLimit?: number;
};

export class CognitiveLoop {
  private readonly attention: AttentionFilter;
  private readonly history: CycleRecord[] = [];
  private readonly historyLimit: number;
  private readonly now: () => number;
  private level: AutonomyLevel;
  private active: ActiveCycle | undefined;
  private draining = false;

  constructor(private readonly options: CognitiveLoopOptions) {
    this.attention = options.attention ?? new AttentionFilter();
    this.now = options.now ?? (() => Date.now());
    this.level = options.level;
    this.historyLimit = Math.max(1, options.historyLimit ?? 256);
  }

  /** Change how much initiative the loop may take, at runtime. */
  setLevel(level: AutonomyLevel): void {
    this.level = level;
  }

  getLevel(): AutonomyLevel {
    return this.level;
  }

  recent(limit = 32): ReadonlyArray<CycleRecord> {
    return this.history.slice(0, Math.max(1, Math.min(this.historyLimit, limit)));
  }

  private record(record: CycleRecord): CycleRecord {
    this.history.unshift(record);
    if (this.history.length > this.historyLimit) {
      this.history.length = this.historyLimit;
    }
    try {
      this.options.onCycle?.(record);
    } catch {
      /* a broken observer must never break the loop */
    }
    if (!record.executed) {
      try {
        this.options.onSurface?.(record);
      } catch {
        /* same */
      }
    }
    return record;
  }

  /** The event the loop is thinking about right now, if any. */
  activeEvent(): QueuedEvent | undefined {
    return this.active?.item;
  }

  /** Run one full cycle for one event, attention included. */
  async handle(event: CognitiveEvent): Promise<CycleRecord> {
    const verdict = this.attention.consider(event, this.now());
    return this.process(event, verdict, new AbortController().signal);
  }

  /**
   * Drain `router`'s attention queue, one cycle at a time, until detached.
   * The router already ran attention, so its verdict is reused rather than
   * scoring the event twice (which would also corrupt novelty tracking).
   * Returns the detach function; detaching aborts the running cycle.
   */
  consume(router: ThalamicRouter, options: ConsumeOptions = {}): () => void {
    // An object, not a let: the flag flips from the detach closure, outside the loop.
    const session = { detached: false };
    const drain = async (): Promise<void> => {
      if (this.draining) {
        return;
      }
      this.draining = true;
      try {
        // Check before taking: popping first would drop an event on detach.
        while (!session.detached) {
          const item = router.next();
          if (!item) {
            break;
          }
          const controller = new AbortController();
          this.active = { item, controller };
          try {
            await this.process(item.event, item.verdict, controller.signal);
          } finally {
            this.active = undefined;
          }
        }
      } finally {
        this.draining = false;
      }
    };
    const start = () => {
      void drain().catch((error: unknown) => options.onError?.(error));
    };
    const off = router.onAdmitted((incoming) => {
      const active = this.active;
      if (active) {
        const decision = router.shouldInterrupt(active.item, incoming);
        if (decision.interrupt) {
          options.onInterrupt?.(active.item, incoming, decision.reason);
          active.controller.abort(new Error(decision.reason));
        }
      }
      start();
    });
    start();
    return () => {
      session.detached = true;
      off();
      this.active?.controller.abort(new Error("cognitive loop detached"));
    };
  }

  private async process(
    event: CognitiveEvent,
    verdict: AttentionVerdict,
    signal: AbortSignal,
  ): Promise<CycleRecord> {
    const atISO = new Date(this.now()).toISOString();

    if (!verdict.admitted) {
      return this.record({
        atISO,
        event,
        admitted: false,
        salience: verdict.salience,
        executed: false,
        reason: verdict.reason,
      });
    }

    // reason
    let proposal: ReasonerResult | undefined;
    try {
      proposal = this.options.reason(event, { goals: this.options.goals });
    } catch (err) {
      return this.record({
        atISO,
        event,
        admitted: true,
        salience: verdict.salience,
        executed: false,
        error: err instanceof Error ? err.message : String(err),
        reason: "reasoner threw; nothing was done",
      });
    }
    if (!proposal?.action) {
      return this.record({
        atISO,
        event,
        admitted: true,
        salience: verdict.salience,
        executed: false,
        reason: proposal?.note ?? "no action proposed",
      });
    }

    // decide
    const assessment = assessConfidence({
      signals: proposal.signals,
      subject: proposal.action.summary,
    });
    const decision = decideAutonomy({
      level: this.level,
      stance: assessment.stance,
      riskTier: proposal.action.riskTier,
      reversible: proposal.action.reversible,
      preAuthorized: proposal.action.preAuthorized,
      action: proposal.action.summary,
    });

    const shared = {
      atISO,
      event,
      admitted: true,
      salience: verdict.salience,
      confidence: assessment.confidence,
      outcome: decision.outcome,
      action: proposal.action.summary,
    };

    if (decision.outcome !== "execute") {
      return this.record({
        ...shared,
        executed: false,
        reason: `${decision.reason} | ${assessment.rationale}`,
      });
    }

    // act
    if (signal.aborted) {
      return this.record({
        ...shared,
        executed: false,
        interrupted: true,
        reason: `preempted before acting: ${decision.reason}`,
      });
    }
    try {
      await proposal.action.run?.(signal);
      // The action may finish despite a late abort; it ran, so say so.
      return this.record({
        ...shared,
        executed: true,
        ...(signal.aborted ? { interrupted: true } : {}),
        reason: signal.aborted
          ? `${decision.reason} (an interrupt arrived but the action had already finished)`
          : decision.reason,
      });
    } catch (err) {
      return this.record({
        ...shared,
        executed: false,
        ...(signal.aborted ? { interrupted: true } : {}),
        error: err instanceof Error ? err.message : String(err),
        reason: signal.aborted
          ? `interrupted by a more salient event: ${decision.reason}`
          : `execution failed: ${decision.reason}`,
      });
    }
  }
}
