/**
 * embodied-controller.ts — The single door between cognition and the body.
 *
 * Every body intent, whoever proposes it (the cognitive loop, the agent by
 * voice, a behavior), goes through `request()`: the safety supervisor reviews
 * it and only an "allow" reaches the body adapter, together with the motion
 * limits it must respect. Every request is kept in an audit trail, allowed or
 * not, so "what did the body do and why" always has an answer (spec §21).
 *
 * The emergency stop is wired in rather than polled: the moment it engages,
 * the body is told to halt, and the supervisor refuses everything but `stop`
 * until Dal re-arms it.
 */
import type { BodyAdapter, BodyIntent, BodyOutcome } from "./body.js";
import { reviewIntent, type SafetyContext, type SafetyReview } from "./safety-supervisor.js";

/** The slice of the global kill switch this controller depends on. */
export type EmergencyStop = {
  isEngaged(): boolean;
  onEngage(listener: (reason: string) => void): () => void;
};

export type EmbodiedResult = {
  readonly atISO: string;
  readonly intent: BodyIntent;
  readonly review: SafetyReview;
  /** Present only when the body was actually asked to act. */
  readonly outcome?: BodyOutcome;
};

export type EmbodiedControllerOptions = {
  readonly body: BodyAdapter;
  readonly emergencyStop: EmergencyStop;
  /** Everything the supervisor needs except the body and e-stop, read fresh per request. */
  readonly context: () => Omit<SafetyContext, "bodyMode" | "emergencyStop" | "nowMs">;
  readonly now?: () => number;
  readonly onResult?: (result: EmbodiedResult) => void;
  /** Retained audit entries. Default 128. */
  readonly historyLimit?: number;
};

export class EmbodiedController {
  private readonly history: EmbodiedResult[] = [];
  private readonly now: () => number;
  private readonly historyLimit: number;
  private readonly detachEmergency: () => void;

  constructor(private readonly options: EmbodiedControllerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.historyLimit = Math.max(1, options.historyLimit ?? 128);
    this.detachEmergency = options.emergencyStop.onEngage(() => {
      void options.body.stop().catch(() => undefined);
    });
  }

  get body(): BodyAdapter {
    return this.options.body;
  }

  /** Review an intent without acting on it: "could you do X right now?" */
  review(intent: BodyIntent): SafetyReview {
    return reviewIntent(intent, this.safetyContext());
  }

  async request(
    intent: BodyIntent,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<EmbodiedResult> {
    const atISO = new Date(this.now()).toISOString();
    const review = this.review(intent);
    if (review.verdict !== "allow") {
      return this.record({ atISO, intent, review });
    }
    if (intent.type === "stop") {
      await this.options.body.stop();
      return this.record({ atISO, intent, review, outcome: { ok: true, detail: "Stopped." } });
    }
    let outcome: BodyOutcome;
    try {
      outcome = await this.options.body.execute(intent, review.limits, signal);
    } catch (error) {
      // A body that failed mid-motion is told to stop before anything else.
      await this.options.body.stop().catch(() => undefined);
      outcome = {
        ok: false,
        detail: `Body error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return this.record({ atISO, intent, review, outcome });
  }

  recent(limit = 16): ReadonlyArray<EmbodiedResult> {
    return this.history.slice(0, Math.max(0, Math.min(this.historyLimit, limit)));
  }

  dispose(): void {
    this.detachEmergency();
  }

  private safetyContext(): SafetyContext {
    return {
      ...this.options.context(),
      bodyMode: this.options.body.mode,
      emergencyStop: this.options.emergencyStop.isEngaged(),
      nowMs: this.now(),
    };
  }

  private record(result: EmbodiedResult): EmbodiedResult {
    this.history.unshift(result);
    if (this.history.length > this.historyLimit) {
      this.history.length = this.historyLimit;
    }
    try {
      this.options.onResult?.(result);
    } catch {
      /* an observer must never break the body path */
    }
    return result;
  }
}
