/**
 * shared-memory.ts — Deduplication, supersession and review stage over the
 * `shared_memory` table that already exists.
 *
 * Phase E of the mesh order. As with the task queue, the schema was already
 * there and nothing in TypeScript used it: `content_hash`, `version`,
 * `supersedes`, `superseded_by`, `conflict_with`, `status` and `metadata` are
 * all live columns. This module is the missing owner, not a new store.
 *
 * ## Why the review stage lives in `metadata`, not in `status`
 *
 * The order asks for a status of proposed / contrasted / approved. The live
 * `status` column has its own domain in production — 205 `active`, 96
 * `superseded`, 24 `archived` as of 2026-10-31 — and it drives what existing
 * readers consider current. Writing new words into it would silently change
 * what every other reader sees on a shared table.
 *
 * So the two axes are kept apart:
 *
 *   status            lifecycle: is this row the current one? (unchanged domain)
 *   metadata.review   epistemic stage: how well is it established?
 *
 * Both are existing columns, so this needs no migration, and a reader that
 * knows nothing about `metadata.review` keeps working.
 *
 * ## The rule that matters most
 *
 * A hypothesis must never be stored as a fact. `isEstablished` is the only
 * place that answers "may I rely on this?", and it answers no for anything that
 * has not been contrasted against an independent source.
 *
 * ## Consistency is auditable, because today it is broken
 *
 * Measured on the live table: 106 rows carry `superseded_by` but only 96 have
 * `status = 'superseded'`, so ten rows are superseded without saying so and a
 * reader filtering on status still treats them as current. Two content hashes
 * appear on more than one row. `conflict_with` has never been used. And actor
 * names collide on case (`chatgpt-lumina` 56 rows versus `ChatGPT-Lumina` 23),
 * so any grouping by actor is wrong today. `auditSharedMemory` finds all four,
 * and `supersede` writes both sides of the link so it cannot add more.
 *
 * The ten are graded, not lumped together: an `active` row with a pointer is
 * served to readers that filter on status, which is a real misread, while an
 * `archived` one is already excluded and is only bookkeeping drift. Measured on
 * 2026-11-01, all ten are `archived` test-suite fixtures and none is active, so
 * nothing there needed repairing.
 */
import { createHash } from "node:crypto";

/** The lifecycle domain the column already uses. */
export type MemoryLifecycle = "active" | "superseded" | "archived";

/**
 * How well a claim is established.
 *
 * - `proposed` — one source said it. Not a fact.
 * - `contrasted` — checked against an independent source, and they agree.
 * - `approved` — a person accepted it.
 */
export type MemoryReview = "proposed" | "contrasted" | "approved";

export const MEMORY_REVIEW_STAGES: readonly MemoryReview[] = Object.freeze([
  "proposed",
  "contrasted",
  "approved",
] as const);

/** One `shared_memory` row, as this module reads it. */
export type MemoryRow = {
  readonly id: string;
  readonly mem_type: string;
  readonly topic: string;
  readonly content_norm: string;
  readonly summary: string;
  readonly content_hash: string;
  readonly source: string;
  readonly actor: string;
  readonly status: string;
  readonly importance: number;
  readonly confidence: number;
  readonly version: number;
  readonly supersedes?: string | null;
  readonly superseded_by?: string | null;
  readonly conflict_with?: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly updated_at: string;
  readonly touched_at: string;
};

/** What a caller wants remembered. The hash and the stage are derived. */
export type MemoryDraft = {
  readonly mem_type: string;
  readonly topic: string;
  readonly content_norm: string;
  readonly summary: string;
  readonly source: string;
  readonly actor: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly review?: MemoryReview;
  /** Independent references backing the claim. Required to leave `proposed`. */
  readonly corroboration?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** The storage operations this module needs. Implemented over PostgREST. */
export type MemoryStorePort = {
  /** Rows with this content hash, newest first. */
  findByHash(hash: string): Promise<readonly MemoryRow[]>;
  insert(
    row: Omit<MemoryRow, "id" | "created_at" | "updated_at" | "touched_at">,
  ): Promise<MemoryRow>;
  /** Patches one row. Only the named fields change. */
  patch(id: string, fields: Readonly<Record<string, unknown>>): Promise<MemoryRow>;
  byId(id: string): Promise<MemoryRow | undefined>;
  /** Every row, for the audit. Callers should page in production. */
  all(): Promise<readonly MemoryRow[]>;
};

const ACTOR_RE = /[^a-z0-9]+/gu;

/**
 * Canonical actor id: lowercase, dashed, trimmed.
 *
 * The live table holds `chatgpt-lumina` and `ChatGPT-Lumina` as different
 * actors, and `lumina-openclaw` and `Lumina-OpenClaw` likewise, so anything
 * grouped by raw actor is already wrong. New rows go in normalized; existing
 * ones are reported by the audit rather than rewritten, because rewriting rows
 * other agents wrote is not this module's call.
 */
export function normalizeActor(actor: string): string {
  return actor
    .trim()
    .toLowerCase()
    .replace(ACTOR_RE, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * The content hash: sha256 over the normalized claim, with the topic and type.
 *
 * Whitespace and case are folded so two agents phrasing the same sentence
 * differently in spacing collapse to one row, which is the point of the
 * dedup. The topic and type are included so the same sentence under two
 * different topics stays two claims.
 */
export function memoryContentHash(draft: {
  readonly mem_type: string;
  readonly topic: string;
  readonly content_norm: string;
}): string {
  const canonical = [draft.mem_type, draft.topic, draft.content_norm]
    .map((part) => part.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " "))
    .join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The review stages as a set, so narrowing an unknown metadata value needs no
 * type assertion and stays in step with `MEMORY_REVIEW_STAGES`.
 */
const REVIEW_STAGES: ReadonlySet<string> = new Set(MEMORY_REVIEW_STAGES);

/** Narrows a value read out of `metadata` to a review stage. */
function isMemoryReview(value: unknown): value is MemoryReview {
  return typeof value === "string" && REVIEW_STAGES.has(value);
}

/** Reads the review stage off a row, defaulting to the cautious answer. */
export function reviewOf(row: Pick<MemoryRow, "metadata">): MemoryReview {
  // `metadata` is Record<string, unknown>, so this is already `unknown`.
  const raw = row.metadata.review;
  return isMemoryReview(raw) ? raw : "proposed";
}

/**
 * Whether a row may be relied on as established.
 *
 * `proposed` never qualifies, whatever its confidence: one agent being sure of
 * something is not corroboration. A superseded or archived row never qualifies
 * either, however well reviewed, because a newer row replaced it.
 */
export function isEstablished(row: MemoryRow): boolean {
  if (row.status !== "active") {
    return false;
  }
  const review = reviewOf(row);
  return review === "contrasted" || review === "approved";
}

/** What `remember` did. */
export type RememberOutcome =
  | { readonly kind: "inserted"; readonly row: MemoryRow }
  /** An active row already carried this exact claim; it was touched instead. */
  | { readonly kind: "duplicate"; readonly row: MemoryRow }
  /** The claim exists but only on a superseded or archived row. */
  | { readonly kind: "revived"; readonly row: MemoryRow; readonly previous: MemoryRow };

/** Why a supersession was refused. */
export type SupersedeRefusal =
  | { readonly reason: "unknown-row" }
  | { readonly reason: "already-superseded"; readonly by: string }
  | { readonly reason: "same-claim" };

export type SupersedeOutcome =
  | { readonly ok: true; readonly row: MemoryRow; readonly superseded: MemoryRow }
  | { readonly ok: false; readonly refusal: SupersedeRefusal };

export type SharedMemoryOptions = {
  readonly store: MemoryStorePort;
  readonly now: () => number;
};

export class SharedMemory {
  private readonly store: MemoryStorePort;
  private readonly now: () => number;

  constructor(options: SharedMemoryOptions) {
    this.store = options.store;
    this.now = options.now;
  }

  /**
   * Records a claim, collapsing an exact repeat onto the row already there.
   *
   * A duplicate is *touched*, not re-inserted: `touched_at` moves so the row's
   * recency reflects that it was seen again, and the review stage can only
   * advance, never regress, because a second sighting is weak evidence and must
   * not undo a human approval.
   */
  async remember(draft: MemoryDraft): Promise<RememberOutcome> {
    const hash = memoryContentHash(draft);
    const existing = await this.store.findByHash(hash);
    const active = existing.find((row) => row.status === "active");
    const stamp = new Date(this.now()).toISOString();

    if (active) {
      const incoming = this.resolveReview(draft);
      const current = reviewOf(active);
      const next = this.higherReview(current, incoming);
      const fields: Record<string, unknown> = { touched_at: stamp };
      if (next !== current) {
        fields.metadata = { ...active.metadata, ...this.reviewMetadata(draft, next) };
        fields.updated_at = stamp;
      }
      // Confidence may rise on corroboration but never falls on a repeat.
      if (draft.confidence !== undefined && draft.confidence > active.confidence) {
        fields.confidence = draft.confidence;
        fields.updated_at = stamp;
      }
      return { kind: "duplicate", row: await this.store.patch(active.id, fields) };
    }

    const inserted = await this.insertDraft(draft, hash, { version: 1 });
    const previous = existing[0];
    return previous === undefined
      ? { kind: "inserted", row: inserted }
      : { kind: "revived", row: inserted, previous };
  }

  /**
   * Replaces a row with a newer claim, writing BOTH sides of the link.
   *
   * The live table has ten rows with `superseded_by` set and a status that is
   * not `superseded`, which is what a half-written supersession leaves behind:
   * a reader filtering on status still treats them as current. So the old row's
   * status and pointer move together, and the new row records what it replaced.
   */
  async supersede(oldId: string, draft: MemoryDraft): Promise<SupersedeOutcome> {
    const old = await this.store.byId(oldId);
    if (!old) {
      return { ok: false, refusal: { reason: "unknown-row" } };
    }
    if (old.superseded_by) {
      return { ok: false, refusal: { reason: "already-superseded", by: old.superseded_by } };
    }
    const hash = memoryContentHash(draft);
    if (hash === old.content_hash) {
      // Nothing changed, so superseding would only add a version with no new
      // claim and leave the chain longer for no reason.
      return { ok: false, refusal: { reason: "same-claim" } };
    }

    const stamp = new Date(this.now()).toISOString();
    const inserted = await this.insertDraft(draft, hash, {
      version: old.version + 1,
      supersedes: old.id,
    });
    const superseded = await this.store.patch(old.id, {
      status: "superseded",
      superseded_by: inserted.id,
      updated_at: stamp,
    });
    return { ok: true, row: inserted, superseded };
  }

  /**
   * Records that two rows disagree, without choosing a winner.
   *
   * Reconciliation is a decision, and a decision belongs to a person or to a
   * contrast against an independent source. Marking the conflict is what lets
   * either happen; silently picking one would memorize a guess.
   */
  async recordConflict(
    aId: string,
    bId: string,
    note: string,
  ): Promise<
    | { readonly ok: true; readonly rows: readonly [MemoryRow, MemoryRow] }
    | { readonly ok: false; readonly reason: "unknown-row" | "same-row" }
  > {
    if (aId === bId) {
      return { ok: false, reason: "same-row" };
    }
    const [a, b] = await Promise.all([this.store.byId(aId), this.store.byId(bId)]);
    if (!a || !b) {
      return { ok: false, reason: "unknown-row" };
    }
    const stamp = new Date(this.now()).toISOString();
    const detail = note.replace(/\s+/gu, " ").trim().slice(0, 300);
    const patchedA = await this.store.patch(a.id, {
      conflict_with: b.id,
      updated_at: stamp,
      metadata: { ...a.metadata, conflict_note: detail },
    });
    const patchedB = await this.store.patch(b.id, {
      conflict_with: a.id,
      updated_at: stamp,
      metadata: { ...b.metadata, conflict_note: detail },
    });
    return { ok: true, rows: [patchedA, patchedB] };
  }

  /**
   * Advances a row's review stage. It can only move forward, and reaching
   * `contrasted` requires naming the independent source that agreed.
   */
  async advanceReview(
    id: string,
    to: MemoryReview,
    evidence: { readonly corroboration?: readonly string[]; readonly approvedBy?: string },
  ): Promise<
    | { readonly ok: true; readonly row: MemoryRow }
    | {
        readonly ok: false;
        readonly reason: "unknown-row" | "would-regress" | "needs-corroboration" | "needs-approver";
      }
  > {
    const row = await this.store.byId(id);
    if (!row) {
      return { ok: false, reason: "unknown-row" };
    }
    const current = reviewOf(row);
    if (this.higherReview(current, to) !== to || current === to) {
      return { ok: false, reason: "would-regress" };
    }
    if (to === "contrasted" && (evidence.corroboration?.length ?? 0) === 0) {
      return { ok: false, reason: "needs-corroboration" };
    }
    if (to === "approved" && !evidence.approvedBy) {
      return { ok: false, reason: "needs-approver" };
    }
    const stamp = new Date(this.now()).toISOString();
    const metadata: Record<string, unknown> = { ...row.metadata, review: to };
    if (evidence.corroboration?.length) {
      metadata.corroboration = [...evidence.corroboration];
    }
    if (evidence.approvedBy) {
      metadata.approved_by = evidence.approvedBy;
    }
    return { ok: true, row: await this.store.patch(id, { metadata, updated_at: stamp }) };
  }

  /** Every active row that may be relied on. */
  async established(): Promise<readonly MemoryRow[]> {
    return (await this.store.all()).filter((row) => isEstablished(row));
  }

  /** Runs the consistency audit over the whole table. */
  async audit(): Promise<SharedMemoryAudit> {
    return auditSharedMemory(await this.store.all());
  }

  private async insertDraft(
    draft: MemoryDraft,
    hash: string,
    extra: { readonly version: number; readonly supersedes?: string },
  ): Promise<MemoryRow> {
    const review = this.resolveReview(draft);
    return this.store.insert({
      mem_type: draft.mem_type,
      topic: draft.topic,
      content_norm: draft.content_norm,
      summary: draft.summary,
      content_hash: hash,
      source: draft.source,
      actor: normalizeActor(draft.actor),
      status: "active",
      importance: draft.importance ?? 0.5,
      confidence: draft.confidence ?? 0.7,
      version: extra.version,
      supersedes: extra.supersedes ?? null,
      superseded_by: null,
      conflict_with: null,
      metadata: { ...draft.metadata, ...this.reviewMetadata(draft, review) },
    });
  }

  /**
   * A draft asking for `contrasted` without naming corroboration is recorded as
   * `proposed`. Claiming a stage is not reaching it.
   */
  private resolveReview(draft: MemoryDraft): MemoryReview {
    const asked = draft.review ?? "proposed";
    if (asked === "proposed") {
      return "proposed";
    }
    return (draft.corroboration?.length ?? 0) > 0 ? asked : "proposed";
  }

  private reviewMetadata(draft: MemoryDraft, review: MemoryReview): Record<string, unknown> {
    const meta: Record<string, unknown> = { review };
    if (draft.corroboration?.length) {
      meta.corroboration = [...draft.corroboration];
    }
    return meta;
  }

  private higherReview(a: MemoryReview, b: MemoryReview): MemoryReview {
    const rank: Record<MemoryReview, number> = { proposed: 0, contrasted: 1, approved: 2 };
    return rank[b] > rank[a] ? b : a;
  }
}

/** One thing the audit found wrong, with the rows involved. */
export type MemoryFinding = {
  readonly kind:
    | "superseded-while-active"
    | "superseded-status-drift"
    | "status-without-pointer"
    | "duplicate-hash"
    | "actor-case-collision"
    | "broken-supersedes"
    | "established-without-corroboration"
    | "one-sided-conflict";
  readonly detail: string;
  readonly rows: readonly string[];
};

export type SharedMemoryAudit = {
  readonly scanned: number;
  readonly findings: readonly MemoryFinding[];
  readonly byKind: Readonly<Record<string, number>>;
};

/**
 * Pure consistency audit over a set of rows.
 *
 * Reports rather than repairs: these rows were written by several agents over
 * weeks, and rewriting another agent's memory on a hunch is exactly the kind of
 * silent change that makes a shared store untrustworthy.
 */
export function auditSharedMemory(rows: readonly MemoryRow[]): SharedMemoryAudit {
  const findings: MemoryFinding[] = [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const row of rows) {
    if (row.superseded_by && row.status === "active") {
      // The harmful case: a reader filtering on `status = 'active'` serves a row
      // that something else has already replaced.
      findings.push({
        kind: "superseded-while-active",
        detail: `points at ${row.superseded_by} while still active, so a status filter serves a row that was already replaced`,
        rows: [row.id],
      });
    } else if (row.superseded_by && row.status !== "superseded") {
      // Not harmful, and saying so matters. An `archived` row with a pointer is
      // already excluded by any status filter, so this is bookkeeping drift and
      // not a misread. Measured on the live table: all ten such rows are
      // `archived` test-suite fixtures, and none is active.
      findings.push({
        kind: "superseded-status-drift",
        detail: `points at ${row.superseded_by} but its status is "${row.status}"; a status filter already excludes it, so this is drift rather than a misread`,
        rows: [row.id],
      });
    }
    if (row.status === "superseded" && !row.superseded_by) {
      findings.push({
        kind: "status-without-pointer",
        detail: "is superseded but names nothing that replaced it",
        rows: [row.id],
      });
    }
    if (row.supersedes && !byId.has(row.supersedes)) {
      findings.push({
        kind: "broken-supersedes",
        detail: `claims to supersede ${row.supersedes}, which is not in the scanned set`,
        rows: [row.id],
      });
    }
    if (isEstablished(row)) {
      const corroboration = row.metadata.corroboration;
      const approvedBy = row.metadata.approved_by;
      if (!Array.isArray(corroboration) && typeof approvedBy !== "string") {
        findings.push({
          kind: "established-without-corroboration",
          detail: `reads as established (${reviewOf(row)}) but names neither corroboration nor an approver`,
          rows: [row.id],
        });
      }
    }
    if (row.conflict_with) {
      const other = byId.get(row.conflict_with);
      if (other && other.conflict_with !== row.id) {
        findings.push({
          kind: "one-sided-conflict",
          detail: `conflicts with ${row.conflict_with}, which does not point back`,
          rows: [row.id, row.conflict_with],
        });
      }
    }
  }

  const byHash = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== "active") {
      continue;
    }
    const bucket = byHash.get(row.content_hash) ?? [];
    bucket.push(row.id);
    byHash.set(row.content_hash, bucket);
  }
  for (const [hash, ids] of byHash) {
    if (ids.length > 1) {
      findings.push({
        kind: "duplicate-hash",
        detail: `${ids.length} active rows share content hash ${hash.slice(0, 12)}`,
        rows: ids,
      });
    }
  }

  const byActor = new Map<string, Set<string>>();
  for (const row of rows) {
    const canonical = normalizeActor(row.actor);
    const spellings = byActor.get(canonical) ?? new Set<string>();
    spellings.add(row.actor);
    byActor.set(canonical, spellings);
  }
  for (const [canonical, spellings] of byActor) {
    if (spellings.size > 1) {
      findings.push({
        kind: "actor-case-collision",
        detail: `${spellings.size} spellings of "${canonical}": ${[...spellings].toSorted().join(", ")}`,
        rows: rows.filter((row) => normalizeActor(row.actor) === canonical).map((row) => row.id),
      });
    }
  }

  const byKind: Record<string, number> = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }
  return { scanned: rows.length, findings, byKind: Object.freeze(byKind) };
}
