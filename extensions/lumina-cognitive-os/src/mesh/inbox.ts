/**
 * inbox.ts — The receiving half: one effect per `idempotency_key`.
 *
 * The outbox promises *at least once*. This module is what makes that safe: it
 * remembers which effects this agent has already applied, so a message the
 * transport delivered twice changes the world once.
 *
 * ## The crash window, named rather than coded around
 *
 * There is no way to make "apply the effect" and "record that it was applied"
 * one atomic step when the effect lands outside this database. So the inbox
 * records an attempt *before* running the effect and completes it after, and a
 * recovery that finds an unfinished attempt asks the caller what kind of effect
 * it was:
 *
 * - `idempotent` — redoing it is harmless (an upsert, a recomputation). The
 *   inbox re-runs it.
 * - `external` — redoing it may double a real-world action (a message sent, an
 *   order placed). The inbox refuses and parks the record as `needs-manual`,
 *   which is what the order requires of non-idempotent external effects.
 *
 * That is the honest contract. Nothing here claims exactly-once delivery.
 *
 * ## Ownership
 *
 * The inbox owns the processed-effect ledger and nothing else. It never calls a
 * transport and never decides authority: a message must already have passed
 * `authority.ts` before it reaches `apply`.
 */
import type { StateStorePort } from "../shared/state-store.js";
import { envelopeHash, type MeshEnvelope, type MeshParty } from "./envelope.js";

/** How a repeated attempt at an unfinished effect must be treated. */
export type MeshEffectKind = "idempotent" | "external";

export type MeshProcessedStatus = "in-progress" | "applied" | "failed" | "needs-manual";

/** The ledger row for one effect, keyed by its idempotency key. */
export type MeshProcessedRecord = {
  readonly key: string;
  readonly idempotency_key: string;
  /** The first message that carried this effect. Later copies are duplicates. */
  readonly first_message_id: string;
  /** Hash of the first envelope seen, so a changed envelope is detectable. */
  readonly first_envelope_hash: string;
  readonly origin: MeshParty;
  readonly topic: string;
  readonly event_type: string;
  readonly effect_kind: MeshEffectKind;
  readonly status: MeshProcessedStatus;
  readonly attempts: number;
  /** Every message id seen for this effect, capped, for audit. */
  readonly message_ids: readonly string[];
  readonly first_seen_at_ms: number;
  readonly updated_at_ms: number;
  /** Short reason for a `failed` or `needs-manual` status. Never the payload. */
  readonly detail?: string;
  /** Reference the effect produced, when the caller returned one. */
  readonly result_ref?: string;
};

/** What `apply` did, so the caller can report an honest ack. */
export type MeshApplyOutcome =
  /** The effect ran now and this is its first and only application. */
  | {
      readonly status: "applied";
      readonly record: MeshProcessedRecord;
      readonly resultRef?: string;
    }
  /** Already applied earlier. The effect was not run again. */
  | { readonly status: "duplicate"; readonly record: MeshProcessedRecord }
  /** The effect threw. Recorded as failed; the sender may retry. */
  | { readonly status: "failed"; readonly record: MeshProcessedRecord; readonly error: string }
  /** An unfinished external effect: a human has to resolve it. */
  | { readonly status: "needs-manual"; readonly record: MeshProcessedRecord }
  /** The envelope changed under a key that already named a different effect. */
  | { readonly status: "conflict"; readonly record: MeshProcessedRecord };

export type MeshInboxOptions = {
  readonly store: StateStorePort<MeshProcessedRecord>;
  readonly now: () => number;
  /** This agent, recorded on events it emits about its own processing. */
  readonly party: MeshParty;
  /** Message ids kept per effect for audit. Older ones are dropped. */
  readonly maxMessageIds?: number;
};

const KEY_PREFIX = "inb_";
const DEFAULT_MAX_MESSAGE_IDS = 8;
const DETAIL_MAX_CHARS = 300;

/** The caller's effect. Returning a reference records where the result landed. */
export type MeshEffect = () => Promise<string | void>;

function clampDetail(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, DETAIL_MAX_CHARS);
}

export class MeshInbox {
  private readonly store: StateStorePort<MeshProcessedRecord>;
  private readonly now: () => number;
  private readonly maxMessageIds: number;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(options: MeshInboxOptions) {
    this.store = options.store;
    this.now = options.now;
    this.maxMessageIds = options.maxMessageIds ?? DEFAULT_MAX_MESSAGE_IDS;
  }

  /** Serializes work per effect key, so two concurrent deliveries do not race. */
  private async withKey<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) {
        this.chains.delete(key);
      }
    });
    return run;
  }

  /**
   * Applies `effect` exactly once per `idempotency_key`.
   *
   * Concurrency: two deliveries of the same effect arriving at once are
   * serialized on the effect's key, so the second one sees the first's record
   * and reports a duplicate rather than running the effect again.
   */
  async apply(
    envelope: MeshEnvelope,
    effect: MeshEffect,
    options: { readonly effectKind?: MeshEffectKind } = {},
  ): Promise<MeshApplyOutcome> {
    const key = `${KEY_PREFIX}${envelope.idempotency_key}`;
    const effectKind = options.effectKind ?? "idempotent";
    return this.withKey(key, async () => {
      const at = this.now();
      const hash = envelopeHash(envelope);
      const existing = await this.store.lookup(key);

      if (existing) {
        if (existing.status === "applied") {
          return {
            status: "duplicate" as const,
            record: await this.note(existing, envelope.message_id, at),
          };
        }
        if (existing.status === "needs-manual") {
          return {
            status: "needs-manual" as const,
            record: await this.note(existing, envelope.message_id, at),
          };
        }
        if (existing.status === "in-progress") {
          // A previous attempt died mid-effect. Whether redoing it is safe is
          // the caller's contract, not something this module can guess.
          if (existing.effect_kind === "external" || effectKind === "external") {
            const parked = await this.write({
              ...existing,
              status: "needs-manual",
              detail: "an external effect was interrupted mid-apply",
              updated_at_ms: at,
              message_ids: this.appendId(existing.message_ids, envelope.message_id),
            });
            return { status: "needs-manual" as const, record: parked };
          }
        }
        // `failed` and a resumable `in-progress` both fall through to a retry.
        //
        // Conflict is judged on the fields that *define* the effect, not on the
        // envelope hash: a legitimate retry carries a new `message_id` and
        // `created_at`, so its hash differs while its effect is the same one.
        if (
          existing.origin !== envelope.origin ||
          existing.topic !== envelope.topic ||
          existing.event_type !== envelope.event_type
        ) {
          // Same effect key naming a different effect: either a derivation bug
          // or a forged key. Refuse rather than apply the newcomer's content.
          const conflicted = await this.write({
            ...existing,
            status: "needs-manual",
            detail: "idempotency key reused by a different envelope",
            updated_at_ms: at,
            message_ids: this.appendId(existing.message_ids, envelope.message_id),
          });
          return { status: "conflict" as const, record: conflicted };
        }
      }

      const claimed = await this.write({
        key,
        idempotency_key: envelope.idempotency_key,
        first_message_id: existing?.first_message_id ?? envelope.message_id,
        first_envelope_hash: existing?.first_envelope_hash ?? hash,
        origin: envelope.origin,
        topic: envelope.topic,
        event_type: envelope.event_type,
        effect_kind: effectKind,
        status: "in-progress",
        attempts: (existing?.attempts ?? 0) + 1,
        message_ids: this.appendId(existing?.message_ids ?? [], envelope.message_id),
        first_seen_at_ms: existing?.first_seen_at_ms ?? at,
        updated_at_ms: at,
      });

      try {
        const resultRef = await effect();
        const applied = await this.write({
          ...claimed,
          status: "applied",
          updated_at_ms: this.now(),
          ...(typeof resultRef === "string" ? { result_ref: resultRef } : {}),
        });
        return {
          status: "applied" as const,
          record: applied,
          ...(typeof resultRef === "string" ? { resultRef } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = await this.write({
          ...claimed,
          status: "failed",
          detail: clampDetail(message),
          updated_at_ms: this.now(),
        });
        return { status: "failed" as const, record: failed, error: clampDetail(message) };
      }
    });
  }

  /** Has this agent already applied the effect behind `idempotencyKey`? */
  async seen(idempotencyKey: string): Promise<MeshProcessedRecord | undefined> {
    return this.store.lookup(`${KEY_PREFIX}${idempotencyKey}`);
  }

  /** Effects parked for a person to resolve. */
  async needsManual(): Promise<readonly MeshProcessedRecord[]> {
    const entries = await this.store.entries();
    return entries
      .map((entry) => entry.value)
      .filter((record) => record.status === "needs-manual")
      .toSorted((a, b) => a.first_seen_at_ms - b.first_seen_at_ms);
  }

  /**
   * Resolves a parked effect after a person decided what happened.
   *
   * `appliedElsewhere` records that the interrupted effect did land, so a later
   * delivery is a duplicate rather than a fresh attempt; `abandoned` records
   * that it did not and will not.
   */
  async resolveManual(
    idempotencyKey: string,
    resolution: "appliedElsewhere" | "abandoned",
    detail: string,
  ): Promise<MeshProcessedRecord | undefined> {
    const key = `${KEY_PREFIX}${idempotencyKey}`;
    return this.withKey(key, async () => {
      const record = await this.store.lookup(key);
      if (!record || record.status !== "needs-manual") {
        return undefined;
      }
      return this.write({
        ...record,
        status: resolution === "appliedElsewhere" ? "applied" : "failed",
        detail: clampDetail(detail),
        updated_at_ms: this.now(),
      });
    });
  }

  /** Counters for the ICCV window: applied, duplicate-suppressed, parked. */
  async metrics(): Promise<{
    readonly records: number;
    readonly applied: number;
    readonly failed: number;
    readonly inProgress: number;
    readonly needsManual: number;
    /** Deliveries observed beyond the first for an effect: suppressed duplicates. */
    readonly suppressedDuplicates: number;
  }> {
    const entries = await this.store.entries();
    const records = entries.map((entry) => entry.value);
    let applied = 0;
    let failed = 0;
    let inProgress = 0;
    let needsManual = 0;
    let suppressedDuplicates = 0;
    for (const record of records) {
      if (record.status === "applied") {
        applied += 1;
      } else if (record.status === "failed") {
        failed += 1;
      } else if (record.status === "in-progress") {
        inProgress += 1;
      } else {
        needsManual += 1;
      }
      suppressedDuplicates += Math.max(0, record.message_ids.length - 1);
    }
    return {
      records: records.length,
      applied,
      failed,
      inProgress,
      needsManual,
      suppressedDuplicates,
    };
  }

  /** Adds a message id for audit, newest last, keeping the list bounded. */
  private appendId(ids: readonly string[], id: string): readonly string[] {
    if (ids.includes(id)) {
      return ids;
    }
    const next = [...ids, id];
    return next.length > this.maxMessageIds ? next.slice(next.length - this.maxMessageIds) : next;
  }

  /** Records another sighting of an already-settled effect. */
  private async note(
    record: MeshProcessedRecord,
    messageId: string,
    at: number,
  ): Promise<MeshProcessedRecord> {
    const message_ids = this.appendId(record.message_ids, messageId);
    if (message_ids === record.message_ids) {
      return record;
    }
    return this.write({ ...record, message_ids, updated_at_ms: at });
  }

  private async write(record: MeshProcessedRecord): Promise<MeshProcessedRecord> {
    await this.store.register(record.key, record);
    return record;
  }
}
