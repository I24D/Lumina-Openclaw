/**
 * outbox.ts — The durable outbox behind LUMINA-MESH/1 delivery.
 *
 * The mesh's reliability lives here, and deliberately *not* in the gateway. The
 * gateway keeps its fire-and-forget emitter (`src/lumina/cognitive-bus.ts`)
 * untouched: it must never block or fail because Supabase is unreachable. This
 * module is the independent layer that does promise delivery, so it owns the
 * record of what still has to go out.
 *
 * ## Why one record per effect
 *
 * A record's storage key is derived from the envelope's `idempotency_key`, not
 * from its `message_id`. Enqueueing is therefore one single write, and a sender
 * that retries the same intent after a crash collapses onto the record already
 * there instead of queueing a second send. That makes sender-side duplication
 * structural rather than advisory.
 *
 * It does not make the system exactly-once, and nothing here should ever claim
 * that. A delivery can still be observed twice by a recipient (the write
 * succeeded, the ack was lost); `inbox.ts` is what makes the second observation
 * harmless. The contract is **at least once, with a logically idempotent
 * effect**.
 *
 * ## Storage
 *
 * The backing store is a `StateStorePort` (`../shared/state-store.ts`), which is
 * the host's SQLite plugin state in production and an in-memory map in tests
 * (ADR 0003: durable state lives in SQLite plugin state, never in ad-hoc JSON).
 * Each record holds the envelope *and* every recipient's delivery state in one
 * value, so a record and its outbound state are written atomically by
 * construction — there is no window where an event exists without its delivery
 * row.
 *
 * ## Ownership
 *
 * This module decides delivery state. It performs no I/O of its own: the
 * dispatcher (`dispatcher.ts`) asks it what is due, performs the transport call,
 * and reports back. Keeping the two apart is what lets the retry policy be
 * tested without a network, and what lets a transport fail without corrupting
 * the record.
 *
 * Not for the Gateway main thread: `StateStorePort` is async, but a production
 * backend is SQLite-backed, and `docs/reference/database-schemas/worker-access.md`
 * keeps runtime SQL off the main thread. Phase 1 runs this in its own process.
 */
import type { StateStorePort } from "../shared/state-store.js";
import {
  isEnvelopeExpired,
  type MeshEnvelope,
  type MeshParty,
  type MeshPriority,
} from "./envelope.js";

/**
 * A recipient's delivery state.
 *
 * `processed` and `verified` are deliberately separate: a recipient saying "I
 * applied this" is delivery, and an independent check saying "the effect is
 * really there" is verifiability. Collapsing them would let an agent's own
 * claim count as proof.
 */
export type MeshDeliveryStatus = "pending" | "claimed" | "processed" | "verified" | "failed";

/** Terminal states: nothing further is attempted. */
const TERMINAL_STATUSES: ReadonlySet<MeshDeliveryStatus> = new Set([
  "processed",
  "verified",
  "failed",
]);

export type MeshDelivery = {
  readonly recipient: MeshParty;
  readonly status: MeshDeliveryStatus;
  /** Transport attempts made so far. */
  readonly attempts: number;
  /** Earliest time the dispatcher may try again. Absent means "now". */
  readonly next_attempt_at_ms?: number;
  /** Short reason for the last failure. Never the payload. */
  readonly last_error?: string;
  /** The dispatcher holding the current attempt, when `claimed`. */
  readonly claimed_by?: string;
  /** Monotonic token of the claim, so a stale dispatcher's write is refused. */
  readonly fencing_token?: number;
  /** Who verified the effect, when `verified`. Never the recipient itself. */
  readonly verified_by?: MeshParty;
  /** Hash of the evidence backing a `verified` status. */
  readonly evidence_hash?: string;
  readonly updated_at_ms: number;
};

/** A record's own lifecycle, derived from its deliveries. */
export type MeshRecordState = "open" | "settled" | "dead";

export type MeshOutboxRecord = {
  /** The storage key: `out_` plus the envelope's idempotency key. */
  readonly key: string;
  readonly envelope: MeshEnvelope;
  readonly deliveries: readonly MeshDelivery[];
  readonly state: MeshRecordState;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  /** Why the record went to the dead-letter state. */
  readonly dead_reason?: string;
};

/** How retries are spaced, and when a delivery gives up. */
export type MeshRetryPolicy = {
  /** Attempts per recipient before the delivery fails into the DLQ. */
  readonly maxAttempts: number;
  /** First backoff, doubled each attempt. */
  readonly baseDelayMs: number;
  /** Ceiling on the doubled delay, before jitter. */
  readonly maxDelayMs: number;
  /** Fraction of the delay added as jitter, 0 to 1. Spreads a thundering herd. */
  readonly jitterRatio: number;
};

export const DEFAULT_MESH_RETRY_POLICY: MeshRetryPolicy = Object.freeze({
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  jitterRatio: 0.2,
});

export type MeshOutboxOptions = {
  readonly store: StateStorePort<MeshOutboxRecord>;
  /** Injected so tests are deterministic and the policy is observable. */
  readonly now: () => number;
  /** Injected jitter source in [0, 1). */
  readonly random?: () => number;
  readonly retry?: MeshRetryPolicy;
  /** How long a settled or dead record is kept before `prune` may drop it. */
  readonly retentionMs?: number;
};

const KEY_PREFIX = "out_";
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ERROR_MAX_CHARS = 300;

/** Backlog and health counters, for the ICCV window and for the CLI. */
export type MeshOutboxMetrics = {
  readonly records: number;
  readonly open: number;
  readonly settled: number;
  readonly dead: number;
  /** Deliveries not yet in a terminal state. */
  readonly pendingDeliveries: number;
  /** Deliveries that failed permanently: the dead-letter queue. */
  readonly deadLetters: number;
  /** Deliveries due now and waiting on a dispatcher. */
  readonly dueNow: number;
  /** Age in ms of the oldest due delivery: the backlog lag. */
  readonly oldestDueAgeMs: number;
  /** Deliveries still open whose envelope has expired. */
  readonly expired: number;
  /** Open deliveries by envelope priority. */
  readonly openByPriority: Readonly<Record<MeshPriority, number>>;
  /** Deliveries that need an ack and have not been verified. */
  readonly awaitingAck: number;
};

function clampError(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, ERROR_MAX_CHARS);
}

function recordKey(idempotencyKey: string): string {
  return `${KEY_PREFIX}${idempotencyKey}`;
}

function deriveState(
  deliveries: readonly MeshDelivery[],
  previous: MeshRecordState,
): MeshRecordState {
  if (previous === "dead") {
    return "dead";
  }
  if (deliveries.length === 0) {
    return "settled";
  }
  if (deliveries.some((d) => !TERMINAL_STATUSES.has(d.status))) {
    return "open";
  }
  return deliveries.every((d) => d.status === "failed") ? "dead" : "settled";
}

/** The result of asking the outbox to take a message. */
export type EnqueueResult = {
  readonly record: MeshOutboxRecord;
  /** False when an equal-effect record already existed and was reused. */
  readonly created: boolean;
};

/**
 * One delivery the dispatcher may attempt now, with the claim it must present
 * when it reports the outcome.
 */
export type MeshClaim = {
  readonly key: string;
  readonly envelope: MeshEnvelope;
  readonly recipient: MeshParty;
  readonly attempt: number;
  readonly fencing_token: number;
  readonly claimed_by: string;
};

/** Why a reported outcome was refused. */
export type MeshRejection =
  | { readonly reason: "unknown-record" }
  | { readonly reason: "unknown-recipient" }
  | { readonly reason: "stale-fencing-token"; readonly current?: number }
  | { readonly reason: "not-claimed"; readonly status: MeshDeliveryStatus };

export type MeshSettleResult =
  | { readonly ok: true; readonly record: MeshOutboxRecord }
  | { readonly ok: false; readonly rejection: MeshRejection };

/**
 * The durable outbox.
 *
 * Every mutation is read-modify-write against one key. Concurrent dispatchers
 * are kept apart by the fencing token on each claim, not by a store-level lock:
 * a dispatcher whose claim was superseded is refused at the point it reports an
 * outcome, which is the only place its write can do damage.
 */
export class MeshOutbox {
  private readonly store: StateStorePort<MeshOutboxRecord>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly retry: MeshRetryPolicy;
  private readonly retentionMs: number;
  /** Serializes read-modify-write on this instance, per key. */
  private readonly writeChains = new Map<string, Promise<unknown>>();
  /** Monotonic within the process; persisted per delivery so it survives one. */
  private fencingCounter = 0;

  constructor(options: MeshOutboxOptions) {
    this.store = options.store;
    this.now = options.now;
    this.random = options.random ?? Math.random;
    this.retry = options.retry ?? DEFAULT_MESH_RETRY_POLICY;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  /**
   * Serializes work on one key so two awaited read-modify-write cycles in this
   * process cannot interleave and lose an update. Cross-process safety is the
   * fencing token's job, not this chain's.
   */
  private async withKey<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    // Chained on both settlements: one failed cycle must not stall the key.
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, settled);
    // Drop the entry once nothing queued behind it, so the map stays bounded.
    void settled.then(() => {
      if (this.writeChains.get(key) === settled) {
        this.writeChains.delete(key);
      }
    });
    return run;
  }

  /**
   * Takes a message for delivery. An envelope whose effect is already recorded
   * reuses that record: same effect, one send.
   *
   * An envelope that is already expired is recorded as dead rather than sent, so
   * the backlog never carries work that cannot matter.
   */
  async enqueue(envelope: MeshEnvelope): Promise<EnqueueResult> {
    const key = recordKey(envelope.idempotency_key);
    return this.withKey(key, async () => {
      const existing = await this.store.lookup(key);
      if (existing) {
        return { record: existing, created: false };
      }
      const at = this.now();
      const expired = isEnvelopeExpired(envelope, at);
      const deliveries: MeshDelivery[] = envelope.recipients.map((recipient) => ({
        recipient,
        status: expired ? "failed" : "pending",
        attempts: 0,
        updated_at_ms: at,
        ...(expired ? { last_error: "expired before first attempt" } : {}),
      }));
      const record: MeshOutboxRecord = {
        key,
        envelope,
        deliveries,
        state: expired ? "dead" : deriveState(deliveries, "open"),
        created_at_ms: at,
        updated_at_ms: at,
        ...(expired ? { dead_reason: "expired before first attempt" } : {}),
      };
      await this.store.register(key, record);
      return { record, created: true };
    });
  }

  /** The record for one effect, or undefined. */
  async get(idempotencyKey: string): Promise<MeshOutboxRecord | undefined> {
    return this.store.lookup(recordKey(idempotencyKey));
  }

  /** Every record, newest last. Callers should prefer `claimDue` or `metrics`. */
  async list(): Promise<readonly MeshOutboxRecord[]> {
    const entries = await this.store.entries();
    return entries
      .map((entry) => entry.value)
      .filter((record) => record.key.startsWith(KEY_PREFIX))
      .toSorted((a, b) => a.created_at_ms - b.created_at_ms);
  }

  /**
   * Claims up to `limit` deliveries that are due, highest priority first and
   * oldest first within a priority, and marks each `claimed` with a fresh
   * fencing token.
   *
   * An expired envelope is failed here instead of being handed out: expiry is a
   * delivery outcome, not a transport error.
   */
  async claimDue(options: {
    readonly dispatcherId: string;
    readonly limit: number;
  }): Promise<readonly MeshClaim[]> {
    const at = this.now();
    const records = await this.list();
    const candidates: Array<{ record: MeshOutboxRecord; delivery: MeshDelivery }> = [];
    for (const record of records) {
      if (record.state !== "open") {
        continue;
      }
      for (const delivery of record.deliveries) {
        // Only `pending` is claimable. A `claimed` delivery is in flight: it
        // returns to the queue through `reclaimAbandoned`, which is this
        // outbox's lease expiry, so two dispatchers never hold one delivery.
        if (delivery.status !== "pending") {
          continue;
        }
        if ((delivery.next_attempt_at_ms ?? 0) > at) {
          continue;
        }
        candidates.push({ record, delivery });
      }
    }
    candidates.sort(
      (a, b) =>
        b.record.envelope.priority - a.record.envelope.priority ||
        a.record.created_at_ms - b.record.created_at_ms ||
        a.delivery.recipient.localeCompare(b.delivery.recipient),
    );

    const claims: MeshClaim[] = [];
    for (const candidate of candidates) {
      if (claims.length >= options.limit) {
        break;
      }
      const claim = await this.claimOne(candidate.record.key, candidate.delivery.recipient, {
        dispatcherId: options.dispatcherId,
      });
      if (claim) {
        claims.push(claim);
      }
    }
    return claims;
  }

  /** Claims one delivery, re-reading the record so a racing claim is not lost. */
  private async claimOne(
    key: string,
    recipient: MeshParty,
    options: { readonly dispatcherId: string },
  ): Promise<MeshClaim | undefined> {
    return this.withKey(key, async () => {
      const record = await this.store.lookup(key);
      if (!record || record.state !== "open") {
        return undefined;
      }
      const at = this.now();
      const delivery = record.deliveries.find((d) => d.recipient === recipient);
      // Re-read under the key's write chain: a racing claimer may have taken
      // this delivery between the scan and here, and it is no longer `pending`.
      if (!delivery || delivery.status !== "pending" || (delivery.next_attempt_at_ms ?? 0) > at) {
        return undefined;
      }
      if (isEnvelopeExpired(record.envelope, at)) {
        await this.writeDelivery(record, recipient, {
          status: "failed",
          attempts: delivery.attempts,
          last_error: "expired before delivery",
          updated_at_ms: at,
        });
        return undefined;
      }
      this.fencingCounter += 1;
      const token = Math.max(this.fencingCounter, (delivery.fencing_token ?? 0) + 1);
      this.fencingCounter = token;
      const attempt = delivery.attempts + 1;
      await this.writeDelivery(record, recipient, {
        status: "claimed",
        attempts: attempt,
        claimed_by: options.dispatcherId,
        fencing_token: token,
        updated_at_ms: at,
      });
      return {
        key,
        envelope: record.envelope,
        recipient,
        attempt,
        fencing_token: token,
        claimed_by: options.dispatcherId,
      };
    });
  }

  /** Replaces one delivery on a record and rewrites the record in one call. */
  private async writeDelivery(
    record: MeshOutboxRecord,
    recipient: MeshParty,
    patch: Partial<MeshDelivery> & {
      readonly status: MeshDeliveryStatus;
      readonly attempts: number;
    },
  ): Promise<MeshOutboxRecord> {
    const deliveries = record.deliveries.map((delivery) => {
      if (delivery.recipient !== recipient) {
        return delivery;
      }
      // Rebuilt rather than spread over, so `next_attempt_at_ms` and
      // `last_error` really clear when a patch omits them. The claim identity is
      // the exception: it carries forward, because the holder check must keep
      // refusing a superseded dispatcher after the delivery has settled, and a
      // repeated report from the live holder must stay a harmless no-op.
      const claimedBy = patch.claimed_by ?? delivery.claimed_by;
      const fencingToken = patch.fencing_token ?? delivery.fencing_token;
      const next: MeshDelivery = {
        recipient,
        status: patch.status,
        attempts: patch.attempts,
        updated_at_ms: patch.updated_at_ms ?? this.now(),
        ...(patch.next_attempt_at_ms === undefined
          ? {}
          : { next_attempt_at_ms: patch.next_attempt_at_ms }),
        ...(patch.last_error === undefined ? {} : { last_error: clampError(patch.last_error) }),
        ...(claimedBy === undefined ? {} : { claimed_by: claimedBy }),
        ...(fencingToken === undefined ? {} : { fencing_token: fencingToken }),
        ...(patch.verified_by === undefined ? {} : { verified_by: patch.verified_by }),
        ...(patch.evidence_hash === undefined ? {} : { evidence_hash: patch.evidence_hash }),
      };
      return next;
    });
    const state = deriveState(deliveries, record.state);
    const next: MeshOutboxRecord = {
      ...record,
      deliveries,
      state,
      updated_at_ms: patch.updated_at_ms ?? this.now(),
      ...(state === "dead" && record.dead_reason === undefined
        ? { dead_reason: "every recipient failed" }
        : {}),
    };
    await this.store.register(record.key, next);
    return next;
  }

  /**
   * Checks that `claim` still owns its delivery. This is the holder check, run
   * immediately before the write that would take effect: a dispatcher that lost
   * its claim is refused even though its transport call may have succeeded.
   */
  private holderCheck(
    record: MeshOutboxRecord | undefined,
    claim: Pick<MeshClaim, "recipient" | "fencing_token">,
  ):
    | { ok: true; record: MeshOutboxRecord; delivery: MeshDelivery }
    | { ok: false; rejection: MeshRejection } {
    if (!record) {
      return { ok: false, rejection: { reason: "unknown-record" } };
    }
    const delivery = record.deliveries.find((d) => d.recipient === claim.recipient);
    if (!delivery) {
      return { ok: false, rejection: { reason: "unknown-recipient" } };
    }
    if (delivery.fencing_token === undefined || delivery.fencing_token !== claim.fencing_token) {
      return {
        ok: false,
        rejection: {
          reason: "stale-fencing-token",
          ...(delivery.fencing_token === undefined ? {} : { current: delivery.fencing_token }),
        },
      };
    }
    return { ok: true, record, delivery };
  }

  /** Marks a claimed delivery as handed to its recipient. */
  async markProcessed(
    claim: Pick<MeshClaim, "key" | "recipient" | "fencing_token">,
  ): Promise<MeshSettleResult> {
    return this.withKey(claim.key, async () => {
      const held = this.holderCheck(await this.store.lookup(claim.key), claim);
      if (!held.ok) {
        return { ok: false as const, rejection: held.rejection };
      }
      const next = await this.writeDelivery(held.record, claim.recipient, {
        status: "processed",
        attempts: held.delivery.attempts,
        updated_at_ms: this.now(),
      });
      return { ok: true as const, record: next };
    });
  }

  /**
   * Records an independent verification of an already-processed delivery.
   *
   * `verified_by` must differ from the recipient: an agent cannot verify its own
   * work (the same rule the academic engine applies to itself).
   */
  async markVerified(options: {
    readonly idempotencyKey: string;
    readonly recipient: MeshParty;
    readonly verifiedBy: MeshParty;
    readonly evidenceHash?: string;
  }): Promise<MeshSettleResult> {
    const key = recordKey(options.idempotencyKey);
    return this.withKey(key, async () => {
      const record = await this.store.lookup(key);
      if (!record) {
        return { ok: false as const, rejection: { reason: "unknown-record" as const } };
      }
      const delivery = record.deliveries.find((d) => d.recipient === options.recipient);
      if (!delivery) {
        return { ok: false as const, rejection: { reason: "unknown-recipient" as const } };
      }
      if (delivery.status !== "processed" && delivery.status !== "verified") {
        return {
          ok: false as const,
          rejection: { reason: "not-claimed" as const, status: delivery.status },
        };
      }
      if (options.verifiedBy === options.recipient) {
        return {
          ok: false as const,
          rejection: { reason: "not-claimed" as const, status: delivery.status },
        };
      }
      const next = await this.writeDelivery(record, options.recipient, {
        status: "verified",
        attempts: delivery.attempts,
        verified_by: options.verifiedBy,
        updated_at_ms: this.now(),
        ...(options.evidenceHash === undefined ? {} : { evidence_hash: options.evidenceHash }),
      });
      return { ok: true as const, record: next };
    });
  }

  /**
   * Records a failed attempt. Below `maxAttempts` the delivery goes back to
   * `pending` with a backoff; at the limit it fails into the dead-letter state.
   *
   * `terminal` skips the remaining attempts: a recipient that *rejected* the
   * message will reject it eight more times, so retrying only hides the reason.
   */
  async markFailed(
    claim: Pick<MeshClaim, "key" | "recipient" | "fencing_token">,
    error: string,
    options: { readonly terminal?: boolean } = {},
  ): Promise<MeshSettleResult> {
    return this.withKey(claim.key, async () => {
      const held = this.holderCheck(await this.store.lookup(claim.key), claim);
      if (!held.ok) {
        return { ok: false as const, rejection: held.rejection };
      }
      const at = this.now();
      const attempts = held.delivery.attempts;
      const exhausted = options.terminal === true || attempts >= this.retry.maxAttempts;
      const next = await this.writeDelivery(held.record, claim.recipient, {
        status: exhausted ? "failed" : "pending",
        attempts,
        last_error: error,
        updated_at_ms: at,
        ...(exhausted ? {} : { next_attempt_at_ms: at + this.backoffMs(attempts) }),
      });
      return { ok: true as const, record: next };
    });
  }

  /**
   * Exponential backoff with additive jitter: `base * 2^(attempt-1)`, capped,
   * plus up to `jitterRatio` of that. Jitter is added, never subtracted, so a
   * delivery never retries sooner than its backoff allows.
   */
  backoffMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const raw = this.retry.baseDelayMs * 2 ** Math.min(exponent, 30);
    const capped = Math.min(raw, this.retry.maxDelayMs);
    const jitter = capped * this.retry.jitterRatio * this.random();
    return Math.round(capped + jitter);
  }

  /**
   * Fails every open delivery whose envelope has expired. Called by the
   * dispatcher's reconciliation pass so a stalled backlog drains instead of
   * being retried forever.
   */
  async expireStale(): Promise<number> {
    const at = this.now();
    let expired = 0;
    for (const record of await this.list()) {
      if (record.state !== "open" || !isEnvelopeExpired(record.envelope, at)) {
        continue;
      }
      for (const delivery of record.deliveries) {
        if (TERMINAL_STATUSES.has(delivery.status)) {
          continue;
        }
        await this.withKey(record.key, async () => {
          const current = await this.store.lookup(record.key);
          if (!current) {
            return;
          }
          const live = current.deliveries.find((d) => d.recipient === delivery.recipient);
          if (!live || TERMINAL_STATUSES.has(live.status)) {
            return;
          }
          await this.writeDelivery(current, delivery.recipient, {
            status: "failed",
            attempts: live.attempts,
            last_error: "expired",
            updated_at_ms: at,
          });
          expired += 1;
        });
      }
    }
    return expired;
  }

  /**
   * Returns claimed deliveries whose dispatcher went away, so the next pass can
   * retry them. A claim older than `claimTimeoutMs` is assumed abandoned; the
   * delivery returns to `pending` and its fencing token stays, so the original
   * dispatcher's late report is refused.
   */
  async reclaimAbandoned(claimTimeoutMs: number): Promise<number> {
    const at = this.now();
    let reclaimed = 0;
    for (const record of await this.list()) {
      if (record.state !== "open") {
        continue;
      }
      for (const delivery of record.deliveries) {
        if (delivery.status !== "claimed" || at - delivery.updated_at_ms < claimTimeoutMs) {
          continue;
        }
        await this.withKey(record.key, async () => {
          const current = await this.store.lookup(record.key);
          const live = current?.deliveries.find((d) => d.recipient === delivery.recipient);
          if (!current || !live || live.status !== "claimed") {
            return;
          }
          const exhausted = live.attempts >= this.retry.maxAttempts;
          await this.writeDelivery(current, delivery.recipient, {
            status: exhausted ? "failed" : "pending",
            attempts: live.attempts,
            last_error: "dispatcher abandoned the claim",
            updated_at_ms: at,
            // The token is kept: the abandoned dispatcher must still be refused.
            ...(live.fencing_token === undefined ? {} : { fencing_token: live.fencing_token }),
            ...(exhausted ? {} : { next_attempt_at_ms: at + this.backoffMs(live.attempts) }),
          });
          reclaimed += 1;
        });
      }
    }
    return reclaimed;
  }

  /** Drops settled and dead records older than the retention window. */
  async prune(): Promise<number> {
    const cutoff = this.now() - this.retentionMs;
    let dropped = 0;
    for (const record of await this.list()) {
      if (record.state === "open" || record.updated_at_ms > cutoff) {
        continue;
      }
      if (await this.store.delete(record.key)) {
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Counters for the ICCV window and the CLI. Every denominator is explicit. */
  async metrics(): Promise<MeshOutboxMetrics> {
    const at = this.now();
    const records = await this.list();
    const openByPriority: Record<MeshPriority, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    let open = 0;
    let settled = 0;
    let dead = 0;
    let pendingDeliveries = 0;
    let deadLetters = 0;
    let dueNow = 0;
    let oldestDueAt = Number.POSITIVE_INFINITY;
    let expired = 0;
    let awaitingAck = 0;

    for (const record of records) {
      if (record.state === "open") {
        open += 1;
      } else if (record.state === "dead") {
        dead += 1;
      } else {
        settled += 1;
      }
      const envelopeExpired = isEnvelopeExpired(record.envelope, at);
      for (const delivery of record.deliveries) {
        if (delivery.status === "failed") {
          deadLetters += 1;
          continue;
        }
        if (TERMINAL_STATUSES.has(delivery.status)) {
          if (record.envelope.requires_ack && delivery.status !== "verified") {
            awaitingAck += 1;
          }
          continue;
        }
        pendingDeliveries += 1;
        openByPriority[record.envelope.priority] += 1;
        if (record.envelope.requires_ack) {
          awaitingAck += 1;
        }
        if (envelopeExpired) {
          expired += 1;
        }
        if ((delivery.next_attempt_at_ms ?? 0) <= at) {
          dueNow += 1;
          oldestDueAt = Math.min(oldestDueAt, record.created_at_ms);
        }
      }
    }

    return {
      records: records.length,
      open,
      settled,
      dead,
      pendingDeliveries,
      deadLetters,
      dueNow,
      oldestDueAgeMs: Number.isFinite(oldestDueAt) ? Math.max(0, at - oldestDueAt) : 0,
      expired,
      openByPriority: Object.freeze(openByPriority),
      awaitingAck,
    };
  }
}
