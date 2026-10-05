/**
 * embodied-controller.ts — The single door between cognition and the body.
 *
 * Every body intent, whoever proposes it (the cognitive loop, the agent by
 * voice, a behavior), goes through `request()`: the safety supervisor reviews
 * it, and only ALLOW or MODIFY reaches the body adapter, with the motion limits
 * it must respect. STOP halts the body at once. Every request, its review and
 * its outcome are kept in the history and, when an audit log is attached, in
 * the tamper-evident audit (spec §21, §48).
 *
 * CONFIRM requests wait in a queue that only a person can clear, through the
 * owner channel (the authenticated dashboard). The agent has no way to
 * approve: an approval arriving from the agent channel is refused and flagged
 * as tampering. On approval the intent is reviewed again, because the world
 * may have changed while it waited.
 *
 * The emergency stop is wired in rather than polled: the moment it engages,
 * the body is told to halt, and the supervisor refuses everything but `stop`
 * until a person re-arms it.
 */
import type { AuditLog } from "../safety/audit-log.js";
import { newEntityId } from "../shared/ids.js";
import type { BodyAdapter, BodyIntent, BodyOutcome } from "./body.js";
import {
  permitsMotion,
  reviewIntent,
  type SafetyContext,
  type SafetyReview,
} from "./safety-supervisor.js";

/** The slice of the global kill switch this controller depends on. */
export type EmergencyStop = {
  isEngaged(): boolean;
  onEngage(listener: (reason: string) => void): () => void;
};

export type EmbodiedResult = {
  readonly atISO: string;
  readonly intent: BodyIntent;
  readonly review: SafetyReview;
  /** Present only when the body was actually asked to act or to stop. */
  readonly outcome?: BodyOutcome;
  /** Set when the request now waits for a person's confirmation. */
  readonly pendingId?: string;
  /** Who asked: "agent", "cognitive-loop", "behavior:<name>", "owner:<who>". */
  readonly requestedBy: string;
};

export type PendingConfirmation = {
  readonly id: string;
  readonly intent: BodyIntent;
  readonly review: SafetyReview;
  readonly requestedBy: string;
  readonly requestedAtISO: string;
  readonly expiresAtISO: string;
};

export type ApprovalResult =
  | { readonly ok: true; readonly result: EmbodiedResult }
  | { readonly ok: false; readonly reason: string; readonly tamper: boolean };

export type EmbodiedControllerOptions = {
  readonly body: BodyAdapter;
  readonly emergencyStop: EmergencyStop;
  /** Everything the supervisor needs except the body and e-stop, read fresh per request. */
  readonly context: () => Omit<SafetyContext, "bodyMode" | "emergencyStop" | "nowMs">;
  readonly audit?: AuditLog;
  /** Reported when the agent tries to approve its own request. */
  readonly onTamper?: (detail: string) => void;
  readonly now?: () => number;
  readonly onResult?: (result: EmbodiedResult) => void;
  /** Retained history entries. Default 128. */
  readonly historyLimit?: number;
  /** How long a confirmation may wait. Default 5 minutes. */
  readonly confirmationTtlMs?: number;
};

export class EmbodiedController {
  private readonly history: EmbodiedResult[] = [];
  private readonly waiting = new Map<string, PendingConfirmation>();
  private readonly now: () => number;
  private readonly historyLimit: number;
  private readonly ttlMs: number;
  private readonly detachEmergency: () => void;
  private active: AbortController | undefined;
  private stopping = 0;
  private disposed = false;
  private stopFailed = false;

  constructor(private readonly options: EmbodiedControllerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.historyLimit = Math.max(1, options.historyLimit ?? 128);
    this.ttlMs = Math.max(1000, options.confirmationTtlMs ?? 5 * 60_000);
    this.detachEmergency = options.emergencyStop.onEngage((reason) => {
      void this.stopAll(reason, "emergency-stop");
    });
  }

  get body(): BodyAdapter {
    return this.options.body;
  }

  /** Review an intent without acting on it: "could you do X right now?" */
  review(intent: BodyIntent): SafetyReview {
    if (
      intent.type !== "stop" &&
      (this.disposed || this.stopFailed || this.stopping > 0 || this.active)
    ) {
      return {
        verdict: "deny",
        capability: "robot.stop",
        reasons: [
          "Body controller is disposed, stopping, has an unconfirmed stop, or is already executing an intent.",
        ],
        limits: { maxSpeedMps: 0, maxForceN: 0 },
      };
    }
    return reviewIntent(intent, this.safetyContext());
  }

  async request(
    requestedIntent: BodyIntent,
    options: { readonly requestedBy?: string; readonly signal?: AbortSignal } = {},
  ): Promise<EmbodiedResult> {
    const requestedBy = options.requestedBy ?? "agent";
    // Retain the exact reviewed request; caller mutation must not change a queued action.
    const intent = { ...requestedIntent };
    const review = this.review(intent);
    if (options.signal?.aborted && intent.type !== "stop") {
      return this.record({
        atISO: new Date(this.now()).toISOString(),
        intent,
        review,
        requestedBy,
        outcome: { ok: false, detail: "Interrupted before moving." },
      });
    }
    if (review.verdict === "confirm") {
      return this.enqueue(intent, review, requestedBy);
    }
    return this.carryOut(intent, review, requestedBy, options.signal);
  }

  /** Requests waiting for a person, oldest first. Expired ones are dropped. */
  pending(): ReadonlyArray<PendingConfirmation> {
    const nowISO = new Date(this.now()).toISOString();
    for (const [id, p] of this.waiting) {
      if (p.expiresAtISO <= nowISO) {
        this.waiting.delete(id);
      }
    }
    return structuredClone([...this.waiting.values()]);
  }

  /** A person approves a waiting request. The agent channel is refused. */
  async approve(
    id: string,
    by: { readonly channel: "owner" | "agent"; readonly actor: string },
  ): Promise<ApprovalResult> {
    if (by.channel !== "owner") {
      const detail = `agent tried to approve its own physical request ${id}`;
      this.options.audit?.append({
        actor: by.actor,
        action: "body.approve",
        reason: detail,
        execution: "refused",
      });
      this.options.onTamper?.(detail);
      return { ok: false, reason: "Only a person can confirm a physical action.", tamper: true };
    }
    const waiting = this.pending().find((p) => p.id === id);
    if (!waiting) {
      return {
        ok: false,
        reason: `No waiting request ${id} (it may have expired).`,
        tamper: false,
      };
    }
    this.waiting.delete(id);
    // The world may have changed while it waited: review again. A person's
    // approval satisfies CONFIRM, never DENY or STOP.
    const fresh = this.review(waiting.intent);
    if (fresh.resolution === "verify") {
      return {
        ok: false,
        reason:
          "Fresh sensor evidence is required before motion; approval does not verify the target.",
        tamper: false,
      };
    }
    if (fresh.verdict === "deny" || fresh.verdict === "stop") {
      const result = await this.carryOut(waiting.intent, fresh, `owner:${by.actor}`);
      return { ok: true, result };
    }
    const approved: SafetyReview = {
      ...fresh,
      verdict:
        fresh.verdict === "confirm"
          ? fresh.modifications?.length
            ? "modify"
            : "allow"
          : fresh.verdict,
      reasons: [...fresh.reasons, `Confirmed by ${by.actor} through the owner channel.`],
    };
    return { ok: true, result: await this.carryOut(waiting.intent, approved, `owner:${by.actor}`) };
  }

  reject(id: string, by: { readonly actor: string }): boolean {
    const existed = this.waiting.delete(id);
    if (existed) {
      this.options.audit?.append({
        actor: by.actor,
        action: "body.reject",
        reason: `rejected ${id}`,
        execution: "refused",
      });
    }
    return existed;
  }

  /** Halt the body now, whatever it was doing (human override, safe state). */
  async stopAll(reason: string, actor: string): Promise<BodyOutcome> {
    this.waiting.clear();
    this.active?.abort(new Error(reason));
    this.stopping++;
    try {
      await this.options.body.stop();
      this.stopFailed = false;
      this.options.audit?.append({ actor, action: "body.stop", reason, execution: "stopped" });
      return { ok: true, detail: "Stopped." };
    } catch (error) {
      this.stopFailed = true;
      const detail = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
      this.options.audit?.append({
        actor,
        action: "body.stop",
        reason,
        execution: "refused",
        outcome: detail,
      });
      return { ok: false, detail };
    } finally {
      this.stopping--;
    }
  }

  recent(limit = 16): ReadonlyArray<EmbodiedResult> {
    return structuredClone(this.history.slice(0, Math.max(0, Math.min(this.historyLimit, limit))));
  }

  dispose(): void {
    this.disposed = true;
    this.detachEmergency();
    void this.stopAll("Body controller disposed.", "runtime");
  }

  private enqueue(intent: BodyIntent, review: SafetyReview, requestedBy: string): EmbodiedResult {
    const nowMs = this.now();
    const pending: PendingConfirmation = {
      id: newEntityId("confirm", nowMs),
      intent,
      review,
      requestedBy,
      requestedAtISO: new Date(nowMs).toISOString(),
      expiresAtISO: new Date(nowMs + this.ttlMs).toISOString(),
    };
    this.waiting.set(pending.id, pending);
    return this.record({
      atISO: pending.requestedAtISO,
      intent,
      review,
      requestedBy,
      pendingId: pending.id,
    });
  }

  private async carryOut(
    intent: BodyIntent,
    review: SafetyReview,
    requestedBy: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<EmbodiedResult> {
    const atISO = new Date(this.now()).toISOString();
    if (review.verdict === "stop" || intent.type === "stop") {
      const stopped = await this.stopAll(review.reasons.join(" "), requestedBy);
      return this.record({
        atISO,
        intent,
        review,
        requestedBy,
        outcome: { ok: intent.type === "stop" && stopped.ok, detail: stopped.detail },
      });
    }
    if (!permitsMotion(review.verdict)) {
      return this.record({ atISO, intent, review, requestedBy });
    }
    let outcome: BodyOutcome;
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    try {
      outcome = controller.signal.aborted
        ? { ok: false, detail: "Interrupted before moving." }
        : await this.options.body.execute(intent, review.limits, controller.signal);
      if (controller.signal.aborted) {
        outcome = { ok: false, detail: "Intent interrupted; completion is not confirmed." };
      }
    } catch (error) {
      // A body that failed mid-motion is told to stop before anything else.
      const stopped = await this.stopAll("Body execution failed.", requestedBy);
      outcome = {
        ok: false,
        detail: `Body error: ${error instanceof Error ? error.message : String(error)}${stopped.ok ? "" : `; ${stopped.detail}`}`,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      this.active = undefined;
    }
    return this.record({ atISO, intent, review, requestedBy, outcome });
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
    this.history.unshift(structuredClone(result));
    if (this.history.length > this.historyLimit) {
      this.history.length = this.historyLimit;
    }
    const execution =
      result.pendingId !== undefined
        ? "pending"
        : result.outcome?.ok
          ? result.review.verdict === "modify"
            ? "modified"
            : "executed"
          : "refused";
    this.options.audit?.append({
      actor: result.requestedBy,
      action: `body.${result.intent.type}`,
      reason: result.review.reasons.join(" "),
      execution,
      permissions: [result.review.capability],
      ...(result.outcome ? { outcome: result.outcome.detail } : {}),
      data: {
        intent: result.intent,
        verdict: result.review.verdict,
        ...(result.pendingId ? { pendingId: result.pendingId } : {}),
      },
    });
    try {
      this.options.onResult?.(result);
    } catch {
      /* an observer must never break the body path */
    }
    return result;
  }
}
