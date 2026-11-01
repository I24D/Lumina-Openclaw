/**
 * Tests for shared-memory deduplication, supersession and the review stage.
 *
 * The audit tests are written against the exact inconsistencies the live table
 * holds, so they are regressions for real data rather than invented cases.
 */
import { describe, expect, it } from "vitest";
import {
  auditSharedMemory,
  isEstablished,
  memoryContentHash,
  normalizeActor,
  reviewOf,
  SharedMemory,
  type MemoryRow,
  type MemoryStorePort,
} from "./shared-memory.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");

/** An in-memory `shared_memory`, with the column defaults the table declares. */
function memoryStore(seed: readonly MemoryRow[] = []) {
  const rows = new Map<string, MemoryRow>(seed.map((entry) => [entry.id, entry]));
  let next = seed.length + 1;
  let clock = T0;
  const store: MemoryStorePort = {
    async findByHash(hash) {
      return [...rows.values()]
        .filter((entry) => entry.content_hash === hash)
        .toSorted((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async insert(draft) {
      const stamp = new Date(clock).toISOString();
      const created: MemoryRow = {
        ...draft,
        id: `mem_${String(next).padStart(4, "0")}`,
        created_at: stamp,
        updated_at: stamp,
        touched_at: stamp,
      };
      next += 1;
      rows.set(created.id, created);
      return created;
    },
    async patch(id, fields) {
      const current = rows.get(id);
      if (!current) {
        throw new Error(`no row ${id}`);
      }
      const updated = { ...current, ...fields } as MemoryRow;
      rows.set(id, updated);
      return updated;
    },
    async byId(id) {
      return rows.get(id);
    },
    async all() {
      return [...rows.values()];
    },
  };
  return {
    store,
    rows,
    advance(ms: number) {
      clock += ms;
    },
    memory: new SharedMemory({ store, now: () => clock }),
  };
}

function row(overrides: Partial<MemoryRow> & { readonly id: string }): MemoryRow {
  const stamp = new Date(T0).toISOString();
  return {
    mem_type: "fact",
    topic: "mesh",
    content_norm: `claim ${overrides.id}`,
    summary: `summary ${overrides.id}`,
    content_hash: `hash_${overrides.id}`,
    source: "claude-code",
    actor: "claude-code",
    status: "active",
    importance: 0.5,
    confidence: 0.7,
    version: 1,
    supersedes: null,
    superseded_by: null,
    conflict_with: null,
    metadata: {},
    created_at: stamp,
    updated_at: stamp,
    touched_at: stamp,
    ...overrides,
  };
}

describe("memoryContentHash", () => {
  it("folds whitespace and case so the same claim collapses", () => {
    const a = memoryContentHash({
      mem_type: "fact",
      topic: "mesh",
      content_norm: "The  outbox is keyed by idempotency_key",
    });
    const b = memoryContentHash({
      mem_type: "fact",
      topic: "mesh",
      content_norm: "the outbox is keyed by IDEMPOTENCY_KEY",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps the same sentence under two topics apart", () => {
    const base = { mem_type: "fact", content_norm: "the lease expired" };
    expect(memoryContentHash({ ...base, topic: "mesh" })).not.toBe(
      memoryContentHash({ ...base, topic: "whatsapp" }),
    );
  });

  it("keeps the same sentence under two types apart", () => {
    const base = { topic: "mesh", content_norm: "the lease expired" };
    expect(memoryContentHash({ ...base, mem_type: "fact" })).not.toBe(
      memoryContentHash({ ...base, mem_type: "decision" }),
    );
  });
});

describe("normalizeActor", () => {
  it("collapses the case collisions the live table holds", () => {
    expect(normalizeActor("ChatGPT-Lumina")).toBe("chatgpt-lumina");
    expect(normalizeActor("chatgpt-lumina")).toBe("chatgpt-lumina");
    expect(normalizeActor("Lumina-OpenClaw")).toBe("lumina-openclaw");
    expect(normalizeActor("  Claude Code  ")).toBe("claude-code");
    expect(normalizeActor("muse")).toBe("muse");
  });
});

describe("remember", () => {
  it("inserts a new claim as proposed, with a normalized actor", async () => {
    const h = memoryStore();
    const result = await h.memory.remember({
      mem_type: "fact",
      topic: "mesh",
      content_norm: "the dispatcher reconciles on every pass",
      summary: "dispatcher reconciles every pass",
      source: "claude-code-report",
      actor: "Claude Code",
    });
    expect(result.kind).toBe("inserted");
    if (result.kind === "inserted") {
      expect(result.row.actor).toBe("claude-code");
      expect(result.row.status).toBe("active");
      expect(result.row.version).toBe(1);
      expect(reviewOf(result.row)).toBe("proposed");
      expect(isEstablished(result.row)).toBe(false);
    }
  });

  it("collapses an exact repeat onto the row already there", async () => {
    const h = memoryStore();
    const draft = {
      mem_type: "fact",
      topic: "mesh",
      content_norm: "priority is 1 to 6",
      summary: "priority 1-6",
      source: "schema",
      actor: "claude-code",
    };
    const first = await h.memory.remember(draft);
    h.advance(60_000);
    const second = await h.memory.remember({ ...draft, actor: "ChatGPT-Lumina" });
    expect(second.kind).toBe("duplicate");
    if (first.kind === "inserted" && second.kind === "duplicate") {
      expect(second.row.id).toBe(first.row.id);
      // Touched, so recency reflects the second sighting.
      expect(second.row.touched_at).not.toBe(first.row.touched_at);
    }
    expect(h.rows.size).toBe(1);
  });

  it("does not let a repeat undo a human approval", async () => {
    const h = memoryStore();
    const draft = {
      mem_type: "decision",
      topic: "mesh",
      content_norm: "ship the mesh behind a flag",
      summary: "ship behind a flag",
      source: "dal",
      actor: "dal",
    };
    const inserted = await h.memory.remember(draft);
    if (inserted.kind !== "inserted") {
      throw new Error("expected an insert");
    }
    await h.memory.advanceReview(inserted.row.id, "approved", { approvedBy: "dal" });
    // A later agent re-states it as a bare proposal.
    const repeat = await h.memory.remember(draft);
    expect(repeat.kind).toBe("duplicate");
    if (repeat.kind === "duplicate") {
      expect(reviewOf(repeat.row)).toBe("approved");
    }
  });

  it("raises confidence on a repeat but never lowers it", async () => {
    const h = memoryStore();
    const draft = {
      mem_type: "fact",
      topic: "mesh",
      content_norm: "the bus has no realtime publication",
      summary: "no realtime",
      source: "schema",
      actor: "claude-code",
      confidence: 0.6,
    };
    await h.memory.remember(draft);
    const raised = await h.memory.remember({ ...draft, confidence: 0.95 });
    if (raised.kind === "duplicate") {
      expect(raised.row.confidence).toBeCloseTo(0.95, 5);
    }
    const lowered = await h.memory.remember({ ...draft, confidence: 0.1 });
    if (lowered.kind === "duplicate") {
      expect(lowered.row.confidence).toBeCloseTo(0.95, 5);
    }
  });

  it("reports a claim that exists only on a superseded row as revived", async () => {
    const hash = memoryContentHash({
      mem_type: "fact",
      topic: "mesh",
      content_norm: "the old claim",
    });
    const h = memoryStore([
      row({ id: "mem_old", status: "superseded", content_hash: hash, superseded_by: "mem_x" }),
    ]);
    const result = await h.memory.remember({
      mem_type: "fact",
      topic: "mesh",
      content_norm: "the old claim",
      summary: "again",
      source: "claude-code",
      actor: "claude-code",
    });
    expect(result.kind).toBe("revived");
    if (result.kind === "revived") {
      expect(result.previous.id).toBe("mem_old");
      expect(result.row.status).toBe("active");
    }
  });

  it("records a claimed stage as proposed when nothing corroborates it", async () => {
    const h = memoryStore();
    const result = await h.memory.remember({
      mem_type: "fact",
      topic: "mesh",
      content_norm: "an unsupported assertion",
      summary: "unsupported",
      source: "guess",
      actor: "muse",
      review: "contrasted",
    });
    if (result.kind === "inserted") {
      expect(reviewOf(result.row)).toBe("proposed");
      expect(isEstablished(result.row)).toBe(false);
    }
  });

  it("accepts a contrasted stage when corroboration is named", async () => {
    const h = memoryStore();
    const result = await h.memory.remember({
      mem_type: "fact",
      topic: "mesh",
      content_norm: "priority check allows 1 to 6",
      summary: "priority 1-6",
      source: "pg_constraint",
      actor: "claude-code",
      review: "contrasted",
      corroboration: ["pg_constraint:lumina_events_priority_check", "bus README"],
    });
    if (result.kind === "inserted") {
      expect(reviewOf(result.row)).toBe("contrasted");
      expect(isEstablished(result.row)).toBe(true);
    }
  });
});

describe("isEstablished", () => {
  it("refuses a proposal however confident it is", () => {
    expect(isEstablished(row({ id: "a", confidence: 1, metadata: { review: "proposed" } }))).toBe(
      false,
    );
  });

  it("refuses a superseded or archived row however well reviewed", () => {
    for (const status of ["superseded", "archived"]) {
      expect(
        isEstablished(row({ id: "a", status, metadata: { review: "approved" } })),
        status,
      ).toBe(false);
    }
  });

  it("accepts a contrasted or approved active row", () => {
    expect(isEstablished(row({ id: "a", metadata: { review: "contrasted" } }))).toBe(true);
    expect(isEstablished(row({ id: "a", metadata: { review: "approved" } }))).toBe(true);
  });

  it("treats an unknown or missing review as a proposal", () => {
    expect(reviewOf(row({ id: "a", metadata: {} }))).toBe("proposed");
    expect(reviewOf(row({ id: "a", metadata: { review: "gospel" } }))).toBe("proposed");
  });
});

describe("supersede", () => {
  it("writes both sides of the link, so no reader sees a stale row as current", async () => {
    const h = memoryStore([row({ id: "mem_0001" })]);
    const result = await h.memory.supersede("mem_0001", {
      mem_type: "fact",
      topic: "mesh",
      content_norm: "the corrected claim",
      summary: "corrected",
      source: "claude-code",
      actor: "claude-code",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.row.version).toBe(2);
    expect(result.row.supersedes).toBe("mem_0001");
    expect(result.row.status).toBe("active");
    // Both the pointer AND the status moved: this is the live table's bug.
    expect(result.superseded.superseded_by).toBe(result.row.id);
    expect(result.superseded.status).toBe("superseded");
    expect(
      auditSharedMemory(await h.store.all()).byKind["superseded-without-status"],
    ).toBeUndefined();
  });

  it("refuses to supersede a row twice", async () => {
    const h = memoryStore([row({ id: "mem_0001", superseded_by: "mem_0002" })]);
    const result = await h.memory.supersede("mem_0001", {
      mem_type: "fact",
      topic: "mesh",
      content_norm: "another claim",
      summary: "another",
      source: "claude-code",
      actor: "claude-code",
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.refusal.reason === "already-superseded") {
      expect(result.refusal.by).toBe("mem_0002");
    }
  });

  it("refuses to supersede a row with the same claim", async () => {
    const hash = memoryContentHash({
      mem_type: "fact",
      topic: "mesh",
      content_norm: "unchanged",
    });
    const h = memoryStore([row({ id: "mem_0001", content_hash: hash })]);
    const result = await h.memory.supersede("mem_0001", {
      mem_type: "fact",
      topic: "mesh",
      content_norm: "unchanged",
      summary: "unchanged",
      source: "claude-code",
      actor: "claude-code",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("same-claim");
    }
  });

  it("refuses an unknown row", async () => {
    const h = memoryStore();
    const result = await h.memory.supersede("mem_ghost", {
      mem_type: "fact",
      topic: "mesh",
      content_norm: "x",
      summary: "x",
      source: "s",
      actor: "a",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("unknown-row");
    }
  });
});

describe("recordConflict", () => {
  it("links both rows and picks no winner", async () => {
    const h = memoryStore([row({ id: "mem_0001" }), row({ id: "mem_0002" })]);
    const result = await h.memory.recordConflict("mem_0001", "mem_0002", "priority  1-4   vs 1-6");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [a, b] = result.rows;
    expect(a.conflict_with).toBe("mem_0002");
    expect(b.conflict_with).toBe("mem_0001");
    // Neither was demoted: reconciliation is a decision, not a side effect.
    expect(a.status).toBe("active");
    expect(b.status).toBe("active");
    expect((a.metadata as { conflict_note?: string }).conflict_note).toBe("priority 1-4 vs 1-6");
  });

  it("refuses a row conflicting with itself, and an unknown row", async () => {
    const h = memoryStore([row({ id: "mem_0001" })]);
    expect(await h.memory.recordConflict("mem_0001", "mem_0001", "x")).toEqual({
      ok: false,
      reason: "same-row",
    });
    expect(await h.memory.recordConflict("mem_0001", "mem_ghost", "x")).toEqual({
      ok: false,
      reason: "unknown-row",
    });
  });
});

describe("advanceReview", () => {
  it("needs corroboration to reach contrasted", async () => {
    const h = memoryStore([row({ id: "mem_0001" })]);
    expect(await h.memory.advanceReview("mem_0001", "contrasted", {})).toEqual({
      ok: false,
      reason: "needs-corroboration",
    });
    const ok = await h.memory.advanceReview("mem_0001", "contrasted", {
      corroboration: ["pg_constraint"],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(reviewOf(ok.row)).toBe("contrasted");
    }
  });

  it("needs a named approver to reach approved", async () => {
    const h = memoryStore([row({ id: "mem_0001" })]);
    expect(await h.memory.advanceReview("mem_0001", "approved", {})).toEqual({
      ok: false,
      reason: "needs-approver",
    });
    const ok = await h.memory.advanceReview("mem_0001", "approved", { approvedBy: "dal" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect((ok.row.metadata as { approved_by?: string }).approved_by).toBe("dal");
    }
  });

  it("never regresses a stage", async () => {
    const h = memoryStore([row({ id: "mem_0001", metadata: { review: "approved" } })]);
    expect(
      await h.memory.advanceReview("mem_0001", "contrasted", { corroboration: ["x"] }),
    ).toEqual({ ok: false, reason: "would-regress" });
    expect(await h.memory.advanceReview("mem_0001", "approved", { approvedBy: "dal" })).toEqual({
      ok: false,
      reason: "would-regress",
    });
  });
});

describe("auditSharedMemory", () => {
  it("finds a pointer without the matching status, which the live table has", () => {
    // Ten rows on the live table carry superseded_by with another status.
    const audit = auditSharedMemory([
      row({ id: "mem_0001", superseded_by: "mem_0002", status: "active" }),
      row({ id: "mem_0002" }),
    ]);
    const finding = audit.findings.find((f) => f.kind === "superseded-without-status");
    expect(finding?.rows).toEqual(["mem_0001"]);
    expect(finding?.detail).toMatch(/still treat it as current/u);
  });

  it("finds a superseded status with no pointer", () => {
    const audit = auditSharedMemory([row({ id: "mem_0001", status: "superseded" })]);
    expect(audit.byKind["status-without-pointer"]).toBe(1);
  });

  it("finds duplicate active rows sharing a content hash", () => {
    const audit = auditSharedMemory([
      row({ id: "mem_0001", content_hash: "same" }),
      row({ id: "mem_0002", content_hash: "same" }),
      // A superseded duplicate is history, not a duplicate.
      row({
        id: "mem_0003",
        content_hash: "same",
        status: "superseded",
        superseded_by: "mem_0001",
      }),
    ]);
    const finding = audit.findings.find((f) => f.kind === "duplicate-hash");
    expect(finding?.rows).toEqual(["mem_0001", "mem_0002"]);
  });

  it("finds the actor case collisions the live table has", () => {
    const audit = auditSharedMemory([
      row({ id: "mem_0001", actor: "chatgpt-lumina" }),
      row({ id: "mem_0002", actor: "ChatGPT-Lumina" }),
      row({ id: "mem_0003", actor: "muse" }),
    ]);
    const finding = audit.findings.find((f) => f.kind === "actor-case-collision");
    expect(finding?.detail).toMatch(
      /2 spellings of "chatgpt-lumina": ChatGPT-Lumina, chatgpt-lumina/u,
    );
    expect(finding?.rows).toEqual(["mem_0001", "mem_0002"]);
  });

  it("finds a supersedes pointer into nothing", () => {
    const audit = auditSharedMemory([row({ id: "mem_0001", supersedes: "mem_gone" })]);
    expect(audit.byKind["broken-supersedes"]).toBe(1);
  });

  it("finds a row reading as established with nothing behind it", () => {
    const audit = auditSharedMemory([
      row({ id: "mem_0001", metadata: { review: "contrasted" } }),
      row({ id: "mem_0002", metadata: { review: "contrasted", corroboration: ["src"] } }),
      row({ id: "mem_0003", metadata: { review: "approved", approved_by: "dal" } }),
    ]);
    const finding = audit.findings.find((f) => f.kind === "established-without-corroboration");
    expect(finding?.rows).toEqual(["mem_0001"]);
  });

  it("finds a one-sided conflict link", () => {
    const audit = auditSharedMemory([
      row({ id: "mem_0001", conflict_with: "mem_0002" }),
      row({ id: "mem_0002", conflict_with: null }),
    ]);
    const finding = audit.findings.find((f) => f.kind === "one-sided-conflict");
    expect(finding?.rows).toEqual(["mem_0001", "mem_0002"]);
  });

  it("reports a clean set as clean, and counts what it scanned", () => {
    const audit = auditSharedMemory([
      row({ id: "mem_0001", actor: "muse" }),
      row({ id: "mem_0002", actor: "claude-code", content_hash: "other" }),
    ]);
    expect(audit.scanned).toBe(2);
    expect(audit.findings).toEqual([]);
    expect(audit.byKind).toEqual({});
  });

  it("reports rather than repairs: the rows it was given are unchanged", () => {
    const rows = [row({ id: "mem_0001", superseded_by: "mem_0002", status: "active" })];
    const before = JSON.stringify(rows);
    auditSharedMemory(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("established", () => {
  it("returns only rows that may be relied on", async () => {
    const h = memoryStore([
      row({ id: "mem_0001", metadata: { review: "proposed" } }),
      row({ id: "mem_0002", metadata: { review: "contrasted", corroboration: ["s"] } }),
      row({ id: "mem_0003", status: "superseded", metadata: { review: "approved" } }),
    ]);
    expect((await h.memory.established()).map((r) => r.id)).toEqual(["mem_0002"]);
  });
});
