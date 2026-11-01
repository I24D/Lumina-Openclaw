/**
 * Tests for the durable outbox — the delivery half of TEST M1.
 *
 * What these prove, in the order's words: a message persists, a lost
 * notification is recovered by the next pass, an offline recipient is retried,
 * a duplicate send collapses to one effect, a crash loses nothing, and a
 * dispatcher that lost its claim cannot report an outcome.
 *
 * The clock and the jitter source are injected, so every assertion about timing
 * is exact rather than approximate.
 */
import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import { createEnvelope, type MeshEnvelope, type MeshPriority } from "./envelope.js";
import {
  DEFAULT_MESH_RETRY_POLICY,
  MeshOutbox,
  type MeshOutboxRecord,
  type MeshRetryPolicy,
} from "./outbox.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");

/** A clock the test moves by hand. */
function clock(start = T0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
      return current;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

function envelope(
  overrides: {
    readonly recipients?: readonly string[];
    readonly priority?: MeshPriority;
    readonly nowMs?: number;
    readonly ttlMs?: number;
    readonly requires_ack?: boolean;
    readonly idempotency_key?: string;
    readonly topic?: string;
  } = {},
): MeshEnvelope {
  const topic = overrides.topic ?? "task.handoff";
  return createEnvelope({
    origin: "chatgpt-lumina",
    recipients: overrides.recipients ?? ["openclaw-gateway"],
    topic,
    event_type: "task.assigned",
    priority: overrides.priority ?? 2,
    nowMs: overrides.nowMs ?? T0,
    // A real retry of the same intent carries the same correlation id. Without
    // one, each call would mint its own and name a different effect.
    correlation_id: `corr-${topic}`,
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
    ...(overrides.requires_ack === undefined ? {} : { requires_ack: overrides.requires_ack }),
    ...(overrides.idempotency_key === undefined
      ? {}
      : { idempotency_key: overrides.idempotency_key }),
  });
}

type Harness = {
  readonly outbox: MeshOutbox;
  readonly store: MemoryStateStore<MeshOutboxRecord>;
  readonly time: ReturnType<typeof clock>;
};

function harness(options: { readonly retry?: Partial<MeshRetryPolicy> } = {}): Harness {
  const store = new MemoryStateStore<MeshOutboxRecord>();
  const time = clock();
  const outbox = new MeshOutbox({
    store,
    now: time.now,
    // No jitter by default, so backoff assertions are exact.
    random: () => 0,
    retry: { ...DEFAULT_MESH_RETRY_POLICY, ...options.retry },
  });
  return { outbox, store, time };
}

function delivery(record: MeshOutboxRecord, recipient: string) {
  const found = record.deliveries.find((d) => d.recipient === recipient);
  if (!found) {
    throw new Error(`no delivery for ${recipient}`);
  }
  return found;
}

describe("enqueue", () => {
  it("persists the envelope and one pending delivery per recipient", async () => {
    const { outbox } = harness();
    const result = await outbox.enqueue(envelope({ recipients: ["muse", "openclaw-gateway"] }));
    expect(result.created).toBe(true);
    expect(result.record.state).toBe("open");
    expect(result.record.deliveries.map((d) => d.recipient)).toEqual(["muse", "openclaw-gateway"]);
    expect(result.record.deliveries.every((d) => d.status === "pending")).toBe(true);
    expect(result.record.deliveries.every((d) => d.attempts === 0)).toBe(true);
  });

  it("collapses a repeated send of the same effect onto one record", async () => {
    const { outbox } = harness();
    const first = await outbox.enqueue(envelope({ nowMs: T0 }));
    // A crash-and-retry mints a new message id but names the same effect.
    const retry = await outbox.enqueue(envelope({ nowMs: T0 + 5_000 }));
    expect(retry.created).toBe(false);
    expect(retry.record.key).toBe(first.record.key);
    expect(await outbox.list()).toHaveLength(1);
  });

  it("keeps two different effects apart", async () => {
    const { outbox } = harness();
    await outbox.enqueue(envelope({ topic: "task.handoff" }));
    await outbox.enqueue(envelope({ topic: "review.verdict" }));
    expect(await outbox.list()).toHaveLength(2);
  });

  it("records an already-expired envelope as dead instead of queueing it", async () => {
    const { outbox, time } = harness();
    const stale = envelope({ nowMs: T0, ttlMs: 1_000 });
    time.advance(2_000);
    const result = await outbox.enqueue(stale);
    expect(result.record.state).toBe("dead");
    expect(result.record.dead_reason).toMatch(/expired/u);
    expect(delivery(result.record, "openclaw-gateway").status).toBe("failed");
    expect(await outbox.claimDue({ dispatcherId: "d1", limit: 10 })).toEqual([]);
  });

  it("settles a broadcast record with no recipients", async () => {
    const { outbox } = harness();
    const result = await outbox.enqueue(envelope({ recipients: [] }));
    expect(result.record.state).toBe("settled");
  });
});

describe("claimDue", () => {
  it("hands out highest priority first, then oldest first", async () => {
    const { outbox, time } = harness();
    await outbox.enqueue(envelope({ topic: "low.one", priority: 1 }));
    time.advance(1_000);
    await outbox.enqueue(envelope({ topic: "high.late", priority: 4 }));
    time.advance(1_000);
    await outbox.enqueue(envelope({ topic: "mid.one", priority: 3 }));
    const claims = await outbox.claimDue({ dispatcherId: "d1", limit: 10 });
    expect(claims.map((c) => c.envelope.topic)).toEqual(["high.late", "mid.one", "low.one"]);
  });

  it("respects the limit and does not hand the same delivery out twice", async () => {
    const { outbox } = harness();
    await outbox.enqueue(envelope({ topic: "a.one" }));
    await outbox.enqueue(envelope({ topic: "b.one" }));
    const first = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    expect(first).toHaveLength(1);
    const second = await outbox.claimDue({ dispatcherId: "d2", limit: 10 });
    expect(second).toHaveLength(1);
    expect(second[0]?.envelope.topic).not.toBe(first[0]?.envelope.topic);
    expect(await outbox.claimDue({ dispatcherId: "d3", limit: 10 })).toEqual([]);
  });

  it("issues a strictly increasing fencing token", async () => {
    const { outbox } = harness();
    await outbox.enqueue(envelope({ topic: "a.one" }));
    await outbox.enqueue(envelope({ topic: "b.one" }));
    const claims = await outbox.claimDue({ dispatcherId: "d1", limit: 10 });
    const tokens = claims.map((c) => c.fencing_token);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toBeGreaterThan(tokens[0] as number);
  });

  it("counts the attempt on the claim, not on the outcome", async () => {
    const { outbox } = harness();
    await outbox.enqueue(envelope());
    const [claim] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    expect(claim?.attempt).toBe(1);
    const record = await outbox.get(claim?.envelope.idempotency_key as string);
    expect(delivery(record as MeshOutboxRecord, "openclaw-gateway").status).toBe("claimed");
    expect(delivery(record as MeshOutboxRecord, "openclaw-gateway").attempts).toBe(1);
  });

  it("fails an envelope that expired while it sat in the backlog", async () => {
    const { outbox, time } = harness();
    await outbox.enqueue(envelope({ ttlMs: 10_000 }));
    time.advance(11_000);
    expect(await outbox.claimDue({ dispatcherId: "d1", limit: 10 })).toEqual([]);
    const record = (await outbox.list())[0] as MeshOutboxRecord;
    expect(delivery(record, "openclaw-gateway").status).toBe("failed");
    expect(delivery(record, "openclaw-gateway").last_error).toMatch(/expired/u);
  });
});

describe("retry and the dead-letter queue", () => {
  it("backs off after a failure and becomes due again on time", async () => {
    const { outbox, time } = harness();
    await outbox.enqueue(envelope());
    const [claim] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    const failed = await outbox.markFailed(claim as never, "recipient offline");
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      const d = delivery(failed.record, "openclaw-gateway");
      expect(d.status).toBe("pending");
      expect(d.last_error).toBe("recipient offline");
      expect(d.next_attempt_at_ms).toBe(T0 + DEFAULT_MESH_RETRY_POLICY.baseDelayMs);
    }
    // Not due yet.
    expect(await outbox.claimDue({ dispatcherId: "d1", limit: 10 })).toEqual([]);
    time.advance(DEFAULT_MESH_RETRY_POLICY.baseDelayMs);
    const retry = await outbox.claimDue({ dispatcherId: "d1", limit: 10 });
    expect(retry).toHaveLength(1);
    expect(retry[0]?.attempt).toBe(2);
  });

  it("doubles the delay, caps it, and never retries sooner than the backoff", async () => {
    const store = new MemoryStateStore<MeshOutboxRecord>();
    const time = clock();
    const outbox = new MeshOutbox({
      store,
      now: time.now,
      // Maximum jitter: it must only ever add.
      random: () => 0.999,
      retry: { maxAttempts: 40, baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.2 },
    });
    expect(outbox.backoffMs(1)).toBeGreaterThanOrEqual(1_000);
    expect(outbox.backoffMs(1)).toBeLessThanOrEqual(1_200);
    expect(outbox.backoffMs(2)).toBeGreaterThanOrEqual(2_000);
    expect(outbox.backoffMs(3)).toBeGreaterThanOrEqual(4_000);
    // Capped at maxDelayMs plus its jitter, however large the attempt.
    expect(outbox.backoffMs(30)).toBeLessThanOrEqual(12_000);
    expect(outbox.backoffMs(1_000)).toBeLessThanOrEqual(12_000);
  });

  it("retries an offline recipient until maxAttempts, then dead-letters it", async () => {
    const { outbox, time } = harness({ retry: { maxAttempts: 3, baseDelayMs: 100 } });
    await outbox.enqueue(envelope());
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [claim] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
      expect(claim?.attempt).toBe(attempt);
      const result = await outbox.markFailed(claim as never, `attempt ${attempt} failed`);
      expect(result.ok).toBe(true);
      time.advance(10_000);
    }
    const record = (await outbox.list())[0] as MeshOutboxRecord;
    expect(delivery(record, "openclaw-gateway").status).toBe("failed");
    expect(record.state).toBe("dead");
    expect(await outbox.claimDue({ dispatcherId: "d1", limit: 10 })).toEqual([]);
    const metrics = await outbox.metrics();
    expect(metrics.deadLetters).toBe(1);
    expect(metrics.pendingDeliveries).toBe(0);
  });

  it("keeps a record open while any recipient is still deliverable", async () => {
    const { outbox } = harness({ retry: { maxAttempts: 1 } });
    await outbox.enqueue(envelope({ recipients: ["muse", "openclaw-gateway"] }));
    const claims = await outbox.claimDue({ dispatcherId: "d1", limit: 10 });
    const museClaim = claims.find((c) => c.recipient === "muse");
    await outbox.markFailed(museClaim as never, "muse offline");
    const record = (await outbox.list())[0] as MeshOutboxRecord;
    expect(delivery(record, "muse").status).toBe("failed");
    expect(record.state).toBe("open");
  });
});

describe("the holder check at the point of effect", () => {
  it("refuses a report from a dispatcher whose claim was superseded", async () => {
    const { outbox, time } = harness({ retry: { baseDelayMs: 100 } });
    await outbox.enqueue(envelope());
    const [stale] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    // The claim is abandoned and taken over by a second dispatcher.
    time.advance(60_000);
    expect(await outbox.reclaimAbandoned(30_000)).toBe(1);
    time.advance(60_000);
    const [fresh] = await outbox.claimDue({ dispatcherId: "d2", limit: 1 });
    expect(fresh?.fencing_token).toBeGreaterThan(stale?.fencing_token as number);

    // The stale dispatcher's transport call may well have succeeded; its write
    // is refused anyway, and the refusal names the current token.
    const refused = await outbox.markProcessed(stale as never);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.rejection.reason).toBe("stale-fencing-token");
      if (refused.rejection.reason === "stale-fencing-token") {
        expect(refused.rejection.current).toBe(fresh?.fencing_token);
      }
    }

    // And the fresh owner's write is the only one that lands.
    const accepted = await outbox.markProcessed(fresh as never);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(delivery(accepted.record, "openclaw-gateway").status).toBe("processed");
      expect(delivery(accepted.record, "openclaw-gateway").claimed_by).toBe("d2");
    }
  });

  it("refuses an unknown record and an unknown recipient", async () => {
    const { outbox } = harness();
    const missing = await outbox.markProcessed({
      key: "out_nope",
      recipient: "muse",
      fencing_token: 1,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.rejection.reason).toBe("unknown-record");
    }
    const enqueued = await outbox.enqueue(envelope());
    const wrongParty = await outbox.markProcessed({
      key: enqueued.record.key,
      recipient: "muse",
      fencing_token: 1,
    });
    expect(wrongParty.ok).toBe(false);
    if (!wrongParty.ok) {
      expect(wrongParty.rejection.reason).toBe("unknown-recipient");
    }
  });

  it("refuses a report on a delivery that was never claimed", async () => {
    const { outbox } = harness();
    const enqueued = await outbox.enqueue(envelope());
    const result = await outbox.markProcessed({
      key: enqueued.record.key,
      recipient: "openclaw-gateway",
      fencing_token: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe("stale-fencing-token");
    }
  });

  it("applies exactly one effect when the same claim is reported twice", async () => {
    const { outbox } = harness();
    await outbox.enqueue(envelope());
    const [claim] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    const first = await outbox.markProcessed(claim as never);
    expect(first.ok).toBe(true);
    // A duplicate report is accepted but changes nothing: still one processed
    // delivery, still one attempt.
    const again = await outbox.markProcessed(claim as never);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.record.deliveries).toHaveLength(1);
      expect(delivery(again.record, "openclaw-gateway").status).toBe("processed");
      expect(delivery(again.record, "openclaw-gateway").attempts).toBe(1);
    }
    expect(await outbox.claimDue({ dispatcherId: "d1", limit: 10 })).toEqual([]);
  });
});

describe("verification is separate from delivery", () => {
  it("records an independent verifier over a processed delivery", async () => {
    const { outbox } = harness();
    const enqueued = await outbox.enqueue(envelope({ requires_ack: true }));
    const [claim] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    await outbox.markProcessed(claim as never);
    const verified = await outbox.markVerified({
      idempotencyKey: enqueued.record.envelope.idempotency_key,
      recipient: "openclaw-gateway",
      verifiedBy: "muse",
      evidenceHash: `sha256:${"b".repeat(64)}`,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      const d = delivery(verified.record, "openclaw-gateway");
      expect(d.status).toBe("verified");
      expect(d.verified_by).toBe("muse");
      expect(d.evidence_hash).toBe(`sha256:${"b".repeat(64)}`);
      expect(verified.record.state).toBe("settled");
    }
  });

  it("refuses to let a recipient verify its own work", async () => {
    const { outbox } = harness();
    const enqueued = await outbox.enqueue(envelope());
    const [claim] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    await outbox.markProcessed(claim as never);
    const selfVerified = await outbox.markVerified({
      idempotencyKey: enqueued.record.envelope.idempotency_key,
      recipient: "openclaw-gateway",
      verifiedBy: "openclaw-gateway",
    });
    expect(selfVerified.ok).toBe(false);
  });

  it("refuses to verify a delivery that was never processed", async () => {
    const { outbox } = harness();
    const enqueued = await outbox.enqueue(envelope());
    const result = await outbox.markVerified({
      idempotencyKey: enqueued.record.envelope.idempotency_key,
      recipient: "openclaw-gateway",
      verifiedBy: "muse",
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.rejection.reason === "not-claimed") {
      expect(result.rejection.status).toBe("pending");
    }
  });
});

describe("reconciliation", () => {
  it("recovers a lost notification on the next pass, with no notification at all", async () => {
    // The order's failure mode: the accelerator never arrives. Nothing here
    // sends a notification; polling alone has to deliver the message.
    const { outbox } = harness();
    await outbox.enqueue(envelope());
    const claims = await outbox.claimDue({ dispatcherId: "poller", limit: 10 });
    expect(claims).toHaveLength(1);
    const settled = await outbox.markProcessed(claims[0] as never);
    expect(settled.ok).toBe(true);
  });

  it("returns an abandoned claim to the queue and keeps its token reserved", async () => {
    const { outbox, time } = harness({ retry: { baseDelayMs: 100 } });
    await outbox.enqueue(envelope());
    const [abandoned] = await outbox.claimDue({ dispatcherId: "crashed", limit: 1 });
    expect(await outbox.reclaimAbandoned(30_000)).toBe(0); // not old enough yet
    time.advance(30_000);
    expect(await outbox.reclaimAbandoned(30_000)).toBe(1);
    const record = (await outbox.list())[0] as MeshOutboxRecord;
    expect(delivery(record, "openclaw-gateway").status).toBe("pending");
    expect(delivery(record, "openclaw-gateway").fencing_token).toBe(abandoned?.fencing_token);
    expect(delivery(record, "openclaw-gateway").last_error).toMatch(/abandoned/u);
  });

  it("dead-letters an abandoned claim that had already used its last attempt", async () => {
    const { outbox, time } = harness({ retry: { maxAttempts: 1 } });
    await outbox.enqueue(envelope());
    await outbox.claimDue({ dispatcherId: "crashed", limit: 1 });
    time.advance(60_000);
    expect(await outbox.reclaimAbandoned(30_000)).toBe(1);
    const record = (await outbox.list())[0] as MeshOutboxRecord;
    expect(delivery(record, "openclaw-gateway").status).toBe("failed");
    expect(record.state).toBe("dead");
  });

  it("expires stale open deliveries", async () => {
    const { outbox, time } = harness();
    await outbox.enqueue(envelope({ ttlMs: 5_000, topic: "a.one" }));
    await outbox.enqueue(envelope({ topic: "b.one" })); // no ttl
    time.advance(6_000);
    expect(await outbox.expireStale()).toBe(1);
    expect(await outbox.expireStale()).toBe(0); // idempotent
    const records = await outbox.list();
    expect(records.filter((r) => r.state === "dead")).toHaveLength(1);
    expect(records.filter((r) => r.state === "open")).toHaveLength(1);
  });

  it("prunes only terminal records past the retention window", async () => {
    const store = new MemoryStateStore<MeshOutboxRecord>();
    const time = clock();
    const outbox = new MeshOutbox({ store, now: time.now, random: () => 0, retentionMs: 1_000 });
    await outbox.enqueue(envelope({ topic: "done.one" }));
    const [claim] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    await outbox.markProcessed(claim as never);
    await outbox.enqueue(envelope({ topic: "open.one" }));
    expect(await outbox.prune()).toBe(0);
    time.advance(2_000);
    expect(await outbox.prune()).toBe(1);
    const left = await outbox.list();
    expect(left).toHaveLength(1);
    expect(left[0]?.state).toBe("open");
  });
});

describe("crash recovery", () => {
  it("loses nothing when the process restarts over the same store", async () => {
    const store = new MemoryStateStore<MeshOutboxRecord>();
    const time = clock();
    const before = new MeshOutbox({ store, now: time.now, random: () => 0 });
    await before.enqueue(envelope({ topic: "survives.one", requires_ack: true }));
    await before.enqueue(envelope({ topic: "also.one" }));
    const [claimed] = await before.claimDue({ dispatcherId: "d1", limit: 1 });

    // The process dies here: the claim is never reported.
    const after = new MeshOutbox({ store, now: time.now, random: () => 0 });
    expect(await after.list()).toHaveLength(2);
    time.advance(60_000);
    // The claim is recovered and reissued with a token above the stale one. The
    // reclaimed delivery waits out its backoff first, which is why time moves
    // again before the next pass.
    expect(await after.reclaimAbandoned(30_000)).toBe(1);
    time.advance(60_000);
    const reissued = await after.claimDue({ dispatcherId: "d2", limit: 10 });
    expect(reissued).toHaveLength(2);
    const sameDelivery = reissued.find((c) => c.recipient === claimed?.recipient);
    expect(sameDelivery?.fencing_token).toBeGreaterThan(claimed?.fencing_token as number);

    // The pre-crash dispatcher is still refused.
    const refused = await after.markProcessed(claimed as never);
    expect(refused.ok).toBe(false);
  });

  it("does not resend an effect the pre-crash process had already settled", async () => {
    const store = new MemoryStateStore<MeshOutboxRecord>();
    const time = clock();
    const before = new MeshOutbox({ store, now: time.now, random: () => 0 });
    const sent = envelope({ topic: "settled.one" });
    await before.enqueue(sent);
    const [claim] = await before.claimDue({ dispatcherId: "d1", limit: 1 });
    await before.markProcessed(claim as never);

    const after = new MeshOutbox({ store, now: time.now, random: () => 0 });
    // The sender retries the same intent after the restart.
    const retry = await after.enqueue(sent);
    expect(retry.created).toBe(false);
    expect(await after.claimDue({ dispatcherId: "d2", limit: 10 })).toEqual([]);
  });
});

describe("metrics", () => {
  it("reports counts with explicit denominators and a real backlog age", async () => {
    const { outbox, time } = harness({ retry: { maxAttempts: 1, baseDelayMs: 100 } });
    await outbox.enqueue(envelope({ topic: "p4.one", priority: 4, requires_ack: true }));
    time.advance(5_000);
    await outbox.enqueue(envelope({ topic: "p1.one", priority: 1 }));
    const [dead] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    await outbox.markFailed(dead as never, "gone");
    time.advance(1_000);

    const metrics = await outbox.metrics();
    expect(metrics.records).toBe(2);
    expect(metrics.dead).toBe(1);
    expect(metrics.open).toBe(1);
    expect(metrics.deadLetters).toBe(1);
    expect(metrics.pendingDeliveries).toBe(1);
    expect(metrics.dueNow).toBe(1);
    expect(metrics.openByPriority).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 });
    // The remaining due delivery was created 1 s ago.
    expect(metrics.oldestDueAgeMs).toBe(1_000);
    expect(metrics.expired).toBe(0);
  });

  it("reports a zero backlog age when nothing is due, not a fake number", async () => {
    const { outbox } = harness();
    const metrics = await outbox.metrics();
    expect(metrics.records).toBe(0);
    expect(metrics.dueNow).toBe(0);
    expect(metrics.oldestDueAgeMs).toBe(0);
  });

  it("counts a message that needs an ack until it is verified", async () => {
    const { outbox } = harness();
    const enqueued = await outbox.enqueue(envelope({ requires_ack: true }));
    expect((await outbox.metrics()).awaitingAck).toBe(1);
    const [claim] = await outbox.claimDue({ dispatcherId: "d1", limit: 1 });
    await outbox.markProcessed(claim as never);
    // Processed is delivery, not proof: it still awaits an ack.
    expect((await outbox.metrics()).awaitingAck).toBe(1);
    await outbox.markVerified({
      idempotencyKey: enqueued.record.envelope.idempotency_key,
      recipient: "openclaw-gateway",
      verifiedBy: "muse",
    });
    expect((await outbox.metrics()).awaitingAck).toBe(0);
  });

  it("counts open deliveries whose envelope has expired", async () => {
    const { outbox, time } = harness();
    await outbox.enqueue(envelope({ ttlMs: 1_000 }));
    time.advance(2_000);
    expect((await outbox.metrics()).expired).toBe(1);
  });
});

describe("concurrent writers in one process", () => {
  it("serializes read-modify-write so no update is lost", async () => {
    const { outbox } = harness();
    await outbox.enqueue(
      envelope({ recipients: ["muse", "openclaw-gateway", "claude-code"], topic: "fan.one" }),
    );
    // Three dispatchers claim at once against the same record.
    const [a, b, c] = await Promise.all([
      outbox.claimDue({ dispatcherId: "d1", limit: 1 }),
      outbox.claimDue({ dispatcherId: "d2", limit: 1 }),
      outbox.claimDue({ dispatcherId: "d3", limit: 1 }),
    ]);
    const claims = [...a, ...b, ...c];
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((x) => x.recipient)).size).toBe(3);
    expect(new Set(claims.map((x) => x.fencing_token)).size).toBe(3);

    await Promise.all(claims.map((claim) => outbox.markProcessed(claim)));
    const record = (await outbox.list())[0] as MeshOutboxRecord;
    expect(record.deliveries.every((d) => d.status === "processed")).toBe(true);
    expect(record.state).toBe("settled");
  });
});
