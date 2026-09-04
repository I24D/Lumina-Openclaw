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
 */
import type { RiskTier } from "../../risk/policies.js";
import { AttentionFilter, type CognitiveEvent } from "../attention.js";
import { decideAutonomy, type AutonomyLevel, type AutonomyOutcome } from "../autonomy-levels.js";
import { GoalManager } from "../goals/goal-manager.js";
import { assessConfidence, type ConfidenceSignal } from "../uncertainty.js";

/** Something the reasoner thinks should happen. */
export type ProposedAction = {
  readonly summary: string;
  readonly riskTier: RiskTier;
  readonly reversible: boolean;
  readonly preAuthorized?: boolean;
  /** Executed only when the gate returns "execute". */
  readonly run?: () => Promise<void> | void;
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
  readonly error?: string;
  readonly reason: string;
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

  /** Run one full cycle for one event. */
  async handle(event: CognitiveEvent): Promise<CycleRecord> {
    const nowMs = this.now();
    const atISO = new Date(nowMs).toISOString();

    // attend
    const verdict = this.attention.consider(event, nowMs);
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
    try {
      await proposal.action.run?.();
      return this.record({ ...shared, executed: true, reason: decision.reason });
    } catch (err) {
      return this.record({
        ...shared,
        executed: false,
        error: err instanceof Error ? err.message : String(err),
        reason: `execution failed: ${decision.reason}`,
      });
    }
  }
}
