/**
 * dispatcher.ts — The decoupled sender: one pass over everything that is due.
 *
 * The outbox decides *what* should go out; a transport knows *how* to reach one
 * party; this module is the loop between them. Keeping it separate is what lets
 * the retry policy be proven without a network, and what lets a transport fail
 * without ever corrupting a record.
 *
 * ## No timers here
 *
 * `runOnce` does one pass and returns. Scheduling belongs to the caller, so
 * tests drive the loop by hand instead of sleeping, and a host can pick its own
 * cadence. That matches the repository's test cost budget, which forbids real
 * timers, sleeps and polling inside tests.
 *
 * ## Polling is the floor, notification is the ceiling
 *
 * Reconciliation runs on every pass: expired envelopes are failed, abandoned
 * claims return to the queue. A push notification can only make delivery
 * *sooner*, never possible — which matters here, because `lumina_events` is not
 * in the project's Realtime publication today, so there is no push to rely on.
 * A pass with no notification at all still delivers everything that is due.
 */
import type { MeshEnvelope, MeshParty } from "./envelope.js";
import type { MeshClaim, MeshOutbox, MeshRejection } from "./outbox.js";

/** What a transport reports back. `retryable` decides backoff versus DLQ. */
export type MeshTransportResult =
  | { readonly ok: true; readonly ref?: string }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

/** One way of reaching one or more parties. */
export type MeshTransport = {
  /** Recorded on dispatch events, so a failure names the route that failed. */
  readonly name: string;
  send(envelope: MeshEnvelope, recipient: MeshParty): Promise<MeshTransportResult>;
};

/** Why a delivery was not attempted or did not settle, for the pass report. */
export type MeshDispatchProblem = {
  readonly recipient: MeshParty;
  readonly idempotencyKey: string;
  readonly reason: string;
  /** Present when the outbox refused the settlement. */
  readonly rejection?: MeshRejection;
};

/** What one pass did. Every number has a denominator the caller can see. */
export type MeshDispatchPass = {
  readonly claimed: number;
  readonly delivered: number;
  /** Attempts that failed and will be retried. */
  readonly retrying: number;
  /** Attempts that failed terminally, into the dead-letter state. */
  readonly deadLettered: number;
  /** Deliveries skipped because no transport serves that recipient. */
  readonly unroutable: number;
  /** Claims returned to the queue because their dispatcher went away. */
  readonly reclaimed: number;
  /** Open deliveries failed because their envelope expired. */
  readonly expired: number;
  /** Settlements the outbox refused, usually a superseded claim. */
  readonly refused: number;
  readonly problems: readonly MeshDispatchProblem[];
};

/** An observation worth recording on the bus. The host decides where it goes. */
export type MeshDispatchEvent =
  | { readonly kind: "delivered"; readonly claim: MeshClaim; readonly ref?: string }
  | {
      readonly kind: "failed";
      readonly claim: MeshClaim;
      readonly error: string;
      readonly retryable: boolean;
    }
  | { readonly kind: "unroutable"; readonly claim: MeshClaim }
  | { readonly kind: "refused"; readonly claim: MeshClaim; readonly rejection: MeshRejection };

export type MeshDispatcherOptions = {
  readonly outbox: MeshOutbox;
  /** This dispatcher's identity, recorded on each claim it takes. */
  readonly dispatcherId: string;
  /** Resolves the transport for a recipient, or undefined when none serves it. */
  readonly route: (recipient: MeshParty) => MeshTransport | undefined;
  /** Deliveries claimed per pass. Bounds both fan-out and pass duration. */
  readonly batchSize?: number;
  /**
   * How long a claim may sit unreported before the next pass takes it back.
   * This is the outbox's lease expiry, so it must exceed a transport's own
   * timeout or a slow-but-live attempt gets reclaimed under itself.
   */
  readonly claimTimeoutMs?: number;
  /** Observer for bus events. Never throws into the pass. */
  readonly onEvent?: (event: MeshDispatchEvent) => void;
};

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_CLAIM_TIMEOUT_MS = 120_000;

export class MeshDispatcher {
  private readonly outbox: MeshOutbox;
  private readonly dispatcherId: string;
  private readonly route: (recipient: MeshParty) => MeshTransport | undefined;
  private readonly batchSize: number;
  private readonly claimTimeoutMs: number;
  private readonly onEvent: (event: MeshDispatchEvent) => void;
  /** One pass at a time per dispatcher, so a slow pass does not overlap itself. */
  private inFlight: Promise<MeshDispatchPass> | undefined;

  constructor(options: MeshDispatcherOptions) {
    this.outbox = options.outbox;
    this.dispatcherId = options.dispatcherId;
    this.route = options.route;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
    const observer = options.onEvent;
    this.onEvent = observer
      ? (event) => {
          try {
            observer(event);
          } catch {
            // Observation never breaks delivery.
          }
        }
      : () => undefined;
  }

  /**
   * One full pass: reconcile, claim what is due, attempt each delivery, settle.
   *
   * Concurrent callers share the pass already running rather than starting a
   * second one, so a host that both polls and reacts to a notification cannot
   * double-send.
   */
  async runOnce(): Promise<MeshDispatchPass> {
    this.inFlight ??= this.pass().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async pass(): Promise<MeshDispatchPass> {
    const problems: MeshDispatchProblem[] = [];
    // Reconciliation first: a reclaimed delivery can be sent in this same pass
    // once its backoff has elapsed, and an expired one is never handed out.
    const expired = await this.outbox.expireStale();
    const reclaimed = await this.outbox.reclaimAbandoned(this.claimTimeoutMs);

    const claims = await this.outbox.claimDue({
      dispatcherId: this.dispatcherId,
      limit: this.batchSize,
    });

    let delivered = 0;
    let retrying = 0;
    let deadLettered = 0;
    let unroutable = 0;
    let refused = 0;

    // Attempts run concurrently: one slow recipient must not hold up the rest.
    const outcomes = await Promise.all(claims.map((claim) => this.attempt(claim)));
    for (const outcome of outcomes) {
      switch (outcome.kind) {
        case "delivered":
          delivered += 1;
          break;
        case "retrying":
          retrying += 1;
          problems.push(outcome.problem);
          break;
        case "dead-lettered":
          deadLettered += 1;
          problems.push(outcome.problem);
          break;
        case "unroutable":
          unroutable += 1;
          problems.push(outcome.problem);
          break;
        case "refused":
          refused += 1;
          problems.push(outcome.problem);
          break;
      }
    }

    return {
      claimed: claims.length,
      delivered,
      retrying,
      deadLettered,
      unroutable,
      reclaimed,
      expired,
      refused,
      problems,
    };
  }

  private async attempt(
    claim: MeshClaim,
  ): Promise<
    | { readonly kind: "delivered" }
    | { readonly kind: "retrying"; readonly problem: MeshDispatchProblem }
    | { readonly kind: "dead-lettered"; readonly problem: MeshDispatchProblem }
    | { readonly kind: "unroutable"; readonly problem: MeshDispatchProblem }
    | { readonly kind: "refused"; readonly problem: MeshDispatchProblem }
  > {
    const idempotencyKey = claim.envelope.idempotency_key;
    const transport = this.route(claim.recipient);
    if (!transport) {
      // Retryable on purpose: a route can appear when a plugin finishes
      // loading. The pass reports it so it is never a silent drop.
      this.onEvent({ kind: "unroutable", claim });
      const settled = await this.outbox.markFailed(claim, `no transport for ${claim.recipient}`);
      if (!settled.ok) {
        return {
          kind: "refused",
          problem: {
            recipient: claim.recipient,
            idempotencyKey,
            reason: "settlement refused after an unroutable attempt",
            rejection: settled.rejection,
          },
        };
      }
      return {
        kind: "unroutable",
        problem: {
          recipient: claim.recipient,
          idempotencyKey,
          reason: `no transport serves ${claim.recipient}`,
        },
      };
    }

    let result: MeshTransportResult;
    try {
      result = await transport.send(claim.envelope, claim.recipient);
    } catch (error) {
      // A transport that throws is treated as a retryable failure: an
      // exception says nothing about whether the recipient refused.
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }

    if (result.ok) {
      this.onEvent({
        kind: "delivered",
        claim,
        ...(result.ref === undefined ? {} : { ref: result.ref }),
      });
      const settled = await this.outbox.markProcessed(claim);
      if (!settled.ok) {
        // The transport call landed but this dispatcher no longer owns the
        // delivery. The write is refused; the live owner will attempt again and
        // the recipient's inbox collapses the duplicate. This is exactly the
        // at-least-once seam, and it is recorded rather than hidden.
        this.onEvent({ kind: "refused", claim, rejection: settled.rejection });
        return {
          kind: "refused",
          problem: {
            recipient: claim.recipient,
            idempotencyKey,
            reason: `delivered over ${transport.name} but the claim was superseded`,
            rejection: settled.rejection,
          },
        };
      }
      return { kind: "delivered" };
    }

    this.onEvent({ kind: "failed", claim, error: result.error, retryable: result.retryable });
    const settled = await this.outbox.markFailed(claim, `${transport.name}: ${result.error}`, {
      terminal: !result.retryable,
    });
    if (!settled.ok) {
      this.onEvent({ kind: "refused", claim, rejection: settled.rejection });
      return {
        kind: "refused",
        problem: {
          recipient: claim.recipient,
          idempotencyKey,
          reason: "settlement refused after a failed attempt",
          rejection: settled.rejection,
        },
      };
    }
    const delivery = settled.record.deliveries.find((d) => d.recipient === claim.recipient);
    const problem: MeshDispatchProblem = {
      recipient: claim.recipient,
      idempotencyKey,
      reason: `${transport.name}: ${result.error}`,
    };
    return delivery?.status === "failed"
      ? { kind: "dead-lettered", problem }
      : { kind: "retrying", problem };
  }
}

/** Builds a `route` from a party-to-transport map. */
export function routeByParty(
  routes: ReadonlyMap<MeshParty, MeshTransport>,
): (recipient: MeshParty) => MeshTransport | undefined {
  return (recipient) => routes.get(recipient);
}
