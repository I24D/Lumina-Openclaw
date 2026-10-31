/**
 * Tests for the receiving half of TEST M1: one effect per idempotency key.
 *
 * Duplicates are the point here. Every test counts how many times the caller's
 * effect actually ran, because that count is the invariant the order asks for:
 * "un solo efecto por idempotency_key".
 */
import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import { createEnvelope, envelopeHash, type MeshEnvelope } from "./envelope.js";
import { MeshInbox, type MeshProcessedRecord } from "./inbox.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");

function envelope(
  overrides: {
    readonly messageId?: string;
    readonly nowMs?: number;
    readonly topic?: string;
    readonly origin?: string;
    readonly idempotencyKey?: string;
  } = {},
): MeshEnvelope {
  return createEnvelope({
    origin: overrides.origin ?? "chatgpt-lumina",
    recipients: ["openclaw-gateway"],
    topic: overrides.topic ?? "task.handoff",
    event_type: "task.assigned",
    priority: 3,
    nowMs: overrides.nowMs ?? T0,
    correlation_id: "corr-0001",
    ...(overrides.messageId === undefined ? {} : { message_id: overrides.messageId }),
    ...(overrides.idempotencyKey === undefined
      ? {}
      : { idempotency_key: overrides.idempotencyKey }),
  });
}

function harness() {
  const store = new MemoryStateStore<MeshProcessedRecord>();
  let current = T0;
  const inbox = new MeshInbox({
    store,
    now: () => current,
    party: "openclaw-gateway",
  });
  const calls: string[] = [];
  return {
    inbox,
    store,
    calls,
    /** An effect that records that it ran. */
    effect:
      (label = "run") =>
      async () => {
        calls.push(label);
        return `ref_${calls.length}`;
      },
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

describe("apply", () => {
  it("runs the effect once and records it", async () => {
    const h = harness();
    const result = await h.inbox.apply(envelope(), h.effect());
    expect(result.status).toBe("applied");
    expect(h.calls).toEqual(["run"]);
    if (result.status === "applied") {
      expect(result.record.status).toBe("applied");
      expect(result.record.attempts).toBe(1);
      expect(result.resultRef).toBe("ref_1");
      expect(result.record.result_ref).toBe("ref_1");
    }
  });

  it("suppresses a redelivery of the same effect without running it again", async () => {
    const h = harness();
    const first = envelope({ messageId: "msg_first" });
    await h.inbox.apply(first, h.effect());
    // The transport delivered it twice: a new message id, the same effect.
    const second = await h.inbox.apply(
      envelope({ messageId: "msg_second", nowMs: T0 + 30_000 }),
      h.effect(),
    );
    expect(second.status).toBe("duplicate");
    expect(h.calls).toEqual(["run"]);
    if (second.status === "duplicate") {
      expect(second.record.first_message_id).toBe("msg_first");
      expect(second.record.message_ids).toEqual(["msg_first", "msg_second"]);
      expect(second.record.attempts).toBe(1);
    }
  });

  it("suppresses the byte-identical message arriving twice", async () => {
    const h = harness();
    const same = envelope({ messageId: "msg_same" });
    await h.inbox.apply(same, h.effect());
    const again = await h.inbox.apply(same, h.effect());
    expect(again.status).toBe("duplicate");
    expect(h.calls).toEqual(["run"]);
    if (again.status === "duplicate") {
      // The same id is not recorded twice.
      expect(again.record.message_ids).toEqual(["msg_same"]);
    }
  });

  it("runs one effect when two copies arrive at the same moment", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.inbox.apply(envelope({ messageId: "msg_a" }), h.effect("a")),
      h.inbox.apply(envelope({ messageId: "msg_b" }), h.effect("b")),
    ]);
    expect(h.calls).toHaveLength(1);
    const statuses = [a.status, b.status].toSorted();
    expect(statuses).toEqual(["applied", "duplicate"]);
  });

  it("keeps different effects apart", async () => {
    const h = harness();
    await h.inbox.apply(envelope({ topic: "task.handoff" }), h.effect("one"));
    await h.inbox.apply(envelope({ topic: "review.verdict" }), h.effect("two"));
    expect(h.calls).toEqual(["one", "two"]);
  });
});

describe("a failing effect", () => {
  it("records the failure and allows a later retry to apply", async () => {
    const h = harness();
    const failing = await h.inbox.apply(envelope({ messageId: "msg_1" }), async () => {
      throw new Error("supabase unreachable");
    });
    expect(failing.status).toBe("failed");
    if (failing.status === "failed") {
      expect(failing.record.status).toBe("failed");
      expect(failing.error).toBe("supabase unreachable");
      expect(failing.record.attempts).toBe(1);
    }

    const retried = await h.inbox.apply(envelope({ messageId: "msg_2" }), h.effect());
    expect(retried.status).toBe("applied");
    expect(h.calls).toEqual(["run"]);
    if (retried.status === "applied") {
      expect(retried.record.attempts).toBe(2);
    }
  });

  it("keeps a non-Error throw readable and bounded", async () => {
    const h = harness();
    const result = await h.inbox.apply(envelope(), async () => {
      throw `plain ${"x".repeat(500)}`;
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.length).toBeLessThanOrEqual(300);
      expect(result.error.startsWith("plain xxx")).toBe(true);
    }
  });
});

describe("an attempt interrupted mid-effect", () => {
  /** The exact state a crash between "claim" and "complete" leaves behind. */
  async function crashedMidApply(kind: "idempotent" | "external") {
    const h = harness();
    const env = envelope({ messageId: "msg_crashed" });
    await h.store.register(`inb_${env.idempotency_key}`, {
      key: `inb_${env.idempotency_key}`,
      idempotency_key: env.idempotency_key,
      first_message_id: env.message_id,
      first_envelope_hash: envelopeHash(env),
      origin: env.origin,
      topic: env.topic,
      event_type: env.event_type,
      effect_kind: kind,
      status: "in-progress",
      attempts: 1,
      message_ids: [env.message_id],
      first_seen_at_ms: T0,
      updated_at_ms: T0,
    });
    return { h, env };
  }

  it("re-runs an idempotent effect", async () => {
    const { h, env } = await crashedMidApply("idempotent");
    const result = await h.inbox.apply(env, h.effect(), { effectKind: "idempotent" });
    expect(result.status).toBe("applied");
    expect(h.calls).toEqual(["run"]);
    if (result.status === "applied") {
      expect(result.record.attempts).toBe(2);
    }
  });

  it("parks an interrupted external effect for a person, and never re-runs it", async () => {
    const { h, env } = await crashedMidApply("external");
    const result = await h.inbox.apply(env, h.effect(), { effectKind: "external" });
    expect(result.status).toBe("needs-manual");
    expect(h.calls).toEqual([]);
    if (result.status === "needs-manual") {
      expect(result.record.detail).toMatch(/interrupted/u);
    }
    expect((await h.inbox.needsManual()).map((r) => r.idempotency_key)).toEqual([
      env.idempotency_key,
    ]);
  });

  it("parks it even when the redelivery claims the effect is idempotent", async () => {
    // The stored kind is what the interrupted attempt committed to. A later
    // caller cannot downgrade that and make a double real-world action safe.
    const { h, env } = await crashedMidApply("external");
    const result = await h.inbox.apply(env, h.effect(), { effectKind: "idempotent" });
    expect(result.status).toBe("needs-manual");
    expect(h.calls).toEqual([]);
  });

  it("stays parked on every later delivery", async () => {
    const { h, env } = await crashedMidApply("external");
    await h.inbox.apply(env, h.effect(), { effectKind: "external" });
    const again = await h.inbox.apply(
      envelope({ messageId: "msg_later", nowMs: T0 + 60_000, idempotencyKey: env.idempotency_key }),
      h.effect(),
    );
    expect(again.status).toBe("needs-manual");
    expect(h.calls).toEqual([]);
  });
});

describe("resolveManual", () => {
  it("records that the interrupted effect did land, so later copies are duplicates", async () => {
    const h = harness();
    const env = envelope();
    await h.store.register(`inb_${env.idempotency_key}`, {
      key: `inb_${env.idempotency_key}`,
      idempotency_key: env.idempotency_key,
      first_message_id: env.message_id,
      first_envelope_hash: envelopeHash(env),
      origin: env.origin,
      topic: env.topic,
      event_type: env.event_type,
      effect_kind: "external",
      status: "needs-manual",
      attempts: 1,
      message_ids: [env.message_id],
      first_seen_at_ms: T0,
      updated_at_ms: T0,
    });
    const resolved = await h.inbox.resolveManual(
      env.idempotency_key,
      "appliedElsewhere",
      "Dal confirmed the WhatsApp reply went out once",
    );
    expect(resolved?.status).toBe("applied");
    const later = await h.inbox.apply(env, h.effect());
    expect(later.status).toBe("duplicate");
    expect(h.calls).toEqual([]);
  });

  it("marks an abandoned effect failed, so a retry may apply it", async () => {
    const h = harness();
    const env = envelope();
    await h.store.register(`inb_${env.idempotency_key}`, {
      key: `inb_${env.idempotency_key}`,
      idempotency_key: env.idempotency_key,
      first_message_id: env.message_id,
      first_envelope_hash: envelopeHash(env),
      origin: env.origin,
      topic: env.topic,
      event_type: env.event_type,
      effect_kind: "external",
      status: "needs-manual",
      attempts: 1,
      message_ids: [env.message_id],
      first_seen_at_ms: T0,
      updated_at_ms: T0,
    });
    expect(
      (await h.inbox.resolveManual(env.idempotency_key, "abandoned", "never sent"))?.status,
    ).toBe("failed");
    const retry = await h.inbox.apply(env, h.effect(), { effectKind: "external" });
    expect(retry.status).toBe("applied");
    expect(h.calls).toEqual(["run"]);
  });

  it("refuses to resolve an effect that is not parked", async () => {
    const h = harness();
    const env = envelope();
    await h.inbox.apply(env, h.effect());
    expect(
      await h.inbox.resolveManual(env.idempotency_key, "appliedElsewhere", "no"),
    ).toBeUndefined();
    expect(await h.inbox.resolveManual("imk_missing", "abandoned", "no")).toBeUndefined();
  });
});

describe("a reused idempotency key", () => {
  it("refuses a different effect hiding under the same key", async () => {
    const h = harness();
    const first = envelope({ topic: "task.handoff", idempotencyKey: "imk_shared" });
    await h.inbox.apply(first, h.effect("legit"));
    // A forged or buggy sender reuses the key for a different topic.
    const forged = envelope({ topic: "money.transfer", idempotencyKey: "imk_shared" });
    const result = await h.inbox.apply(forged, h.effect("forged"));
    expect(result.status).toBe("duplicate");
    expect(h.calls).toEqual(["legit"]);
  });

  it("flags the conflict when the first attempt had not settled", async () => {
    const h = harness();
    const failing = envelope({ topic: "task.handoff", idempotencyKey: "imk_shared" });
    await h.inbox.apply(failing, async () => {
      throw new Error("down");
    });
    const forged = envelope({ topic: "money.transfer", idempotencyKey: "imk_shared" });
    const result = await h.inbox.apply(forged, h.effect("forged"));
    expect(result.status).toBe("conflict");
    expect(h.calls).toEqual([]);
    if (result.status === "conflict") {
      expect(result.record.status).toBe("needs-manual");
      expect(result.record.detail).toMatch(/reused/u);
      expect(result.record.topic).toBe("task.handoff");
    }
  });
});

describe("seen and metrics", () => {
  it("answers whether an effect was already applied", async () => {
    const h = harness();
    const env = envelope();
    expect(await h.inbox.seen(env.idempotency_key)).toBeUndefined();
    await h.inbox.apply(env, h.effect());
    expect((await h.inbox.seen(env.idempotency_key))?.status).toBe("applied");
  });

  it("counts applied effects, failures and suppressed duplicates", async () => {
    const h = harness();
    await h.inbox.apply(envelope({ topic: "a.one", messageId: "m1" }), h.effect());
    await h.inbox.apply(envelope({ topic: "a.one", messageId: "m2" }), h.effect());
    await h.inbox.apply(envelope({ topic: "a.one", messageId: "m3" }), h.effect());
    await h.inbox.apply(envelope({ topic: "b.one" }), async () => {
      throw new Error("nope");
    });
    const metrics = await h.inbox.metrics();
    expect(metrics.records).toBe(2);
    expect(metrics.applied).toBe(1);
    expect(metrics.failed).toBe(1);
    expect(metrics.needsManual).toBe(0);
    expect(metrics.inProgress).toBe(0);
    // Two redeliveries of the first effect were suppressed.
    expect(metrics.suppressedDuplicates).toBe(2);
  });

  it("keeps the audited message-id list bounded", async () => {
    const store = new MemoryStateStore<MeshProcessedRecord>();
    const inbox = new MeshInbox({
      store,
      now: () => T0,
      party: "openclaw-gateway",
      maxMessageIds: 3,
    });
    for (let i = 0; i < 6; i++) {
      await inbox.apply(envelope({ messageId: `m${i}` }), async () => undefined);
    }
    const record = await inbox.seen(envelope().idempotency_key);
    expect(record?.message_ids).toEqual(["m3", "m4", "m5"]);
  });
});
