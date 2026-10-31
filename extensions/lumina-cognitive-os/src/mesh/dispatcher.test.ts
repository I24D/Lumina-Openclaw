/**
 * Tests for the dispatcher — the rest of TEST M1, end to end over a fake
 * transport.
 *
 * The order's scenarios are each a test here: a notification that never
 * arrives, a recipient that is offline and then comes back, a transport that
 * throws, a recipient that refuses outright, a dispatcher that is superseded
 * mid-flight, and a crash between the transport call and the settlement.
 *
 * No real timers: the clock is injected and every pass is driven by hand.
 */
import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import {
  MeshDispatcher,
  routeByParty,
  type MeshDispatchEvent,
  type MeshTransport,
  type MeshTransportResult,
} from "./dispatcher.js";
import { createEnvelope, type MeshEnvelope, type MeshParty } from "./envelope.js";
import { MeshInbox, type MeshProcessedRecord } from "./inbox.js";
import { MeshOutbox, type MeshOutboxRecord } from "./outbox.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");

function envelope(
  overrides: {
    readonly recipients?: readonly MeshParty[];
    readonly topic?: string;
    readonly ttlMs?: number;
    readonly nowMs?: number;
  } = {},
): MeshEnvelope {
  const topic = overrides.topic ?? "task.handoff";
  return createEnvelope({
    origin: "chatgpt-lumina",
    recipients: overrides.recipients ?? ["openclaw-gateway"],
    topic,
    event_type: "task.assigned",
    priority: 3,
    nowMs: overrides.nowMs ?? T0,
    correlation_id: `corr-${topic}`,
    requires_ack: true,
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
  });
}

/** A transport whose every outcome the test chooses. */
function fakeTransport(name: string) {
  const sent: Array<{ recipient: MeshParty; messageId: string; idempotencyKey: string }> = [];
  let next: MeshTransportResult | (() => MeshTransportResult | Promise<MeshTransportResult>) = {
    ok: true,
  };
  const transport: MeshTransport = {
    name,
    async send(env, recipient) {
      sent.push({
        recipient,
        messageId: env.message_id,
        idempotencyKey: env.idempotency_key,
      });
      return typeof next === "function" ? next() : next;
    },
  };
  return {
    transport,
    sent,
    set(result: typeof next) {
      next = result;
    },
  };
}

function harness(options: { readonly retryMaxAttempts?: number } = {}) {
  const store = new MemoryStateStore<MeshOutboxRecord>();
  let current = T0;
  const outbox = new MeshOutbox({
    store,
    now: () => current,
    random: () => 0,
    retry: {
      maxAttempts: options.retryMaxAttempts ?? 8,
      baseDelayMs: 1_000,
      maxDelayMs: 300_000,
      jitterRatio: 0,
    },
  });
  const gateway = fakeTransport("fake-gateway");
  const muse = fakeTransport("fake-muse");
  const events: MeshDispatchEvent[] = [];
  const routes = new Map<MeshParty, MeshTransport>([
    ["openclaw-gateway", gateway.transport],
    ["muse", muse.transport],
  ]);
  const dispatcher = new MeshDispatcher({
    outbox,
    dispatcherId: "dispatcher-1",
    route: routeByParty(routes),
    claimTimeoutMs: 30_000,
    onEvent: (event) => events.push(event),
  });
  return {
    outbox,
    dispatcher,
    gateway,
    muse,
    routes,
    events,
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

describe("a healthy pass", () => {
  it("delivers every due message and settles it", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope({ topic: "a.one" }));
    await h.outbox.enqueue(envelope({ topic: "b.one", recipients: ["muse"] }));

    const pass = await h.dispatcher.runOnce();
    expect(pass.claimed).toBe(2);
    expect(pass.delivered).toBe(2);
    expect(pass.retrying).toBe(0);
    expect(pass.problems).toEqual([]);
    expect(h.gateway.sent).toHaveLength(1);
    expect(h.muse.sent).toHaveLength(1);

    // Nothing left to do, and a second pass is not a second send.
    const again = await h.dispatcher.runOnce();
    expect(again.claimed).toBe(0);
    expect(h.gateway.sent).toHaveLength(1);
  });

  it("fans one message out to several recipients", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope({ recipients: ["openclaw-gateway", "muse"] }));
    const pass = await h.dispatcher.runOnce();
    expect(pass.delivered).toBe(2);
    expect(h.gateway.sent[0]?.idempotencyKey).toBe(h.muse.sent[0]?.idempotencyKey);
  });

  it("delivers with no notification at all — polling alone is enough", async () => {
    // The order's first failure mode: the accelerator is lost. Nothing in this
    // test notifies anything; the pass is the only mechanism.
    const h = harness();
    await h.outbox.enqueue(envelope());
    expect((await h.dispatcher.runOnce()).delivered).toBe(1);
  });

  it("shares one pass between concurrent callers instead of double-sending", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope());
    const [a, b] = await Promise.all([h.dispatcher.runOnce(), h.dispatcher.runOnce()]);
    expect(a).toBe(b);
    expect(h.gateway.sent).toHaveLength(1);
  });

  it("reports the delivery on the bus observer", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope());
    await h.dispatcher.runOnce();
    expect(h.events.map((e) => e.kind)).toEqual(["delivered"]);
  });

  it("survives an observer that throws", async () => {
    const store = new MemoryStateStore<MeshOutboxRecord>();
    const outbox = new MeshOutbox({ store, now: () => T0, random: () => 0 });
    const gateway = fakeTransport("fake-gateway");
    const dispatcher = new MeshDispatcher({
      outbox,
      dispatcherId: "d1",
      route: routeByParty(new Map([["openclaw-gateway", gateway.transport]])),
      onEvent: () => {
        throw new Error("observer is broken");
      },
    });
    await outbox.enqueue(envelope());
    expect((await dispatcher.runOnce()).delivered).toBe(1);
  });
});

describe("an offline recipient", () => {
  it("retries on a later pass and delivers when it returns", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope());
    h.gateway.set({ ok: false, error: "ECONNREFUSED", retryable: true });

    const first = await h.dispatcher.runOnce();
    expect(first.retrying).toBe(1);
    expect(first.delivered).toBe(0);
    expect(first.problems[0]?.reason).toBe("fake-gateway: ECONNREFUSED");

    // Still inside the backoff: the pass does nothing.
    const during = await h.dispatcher.runOnce();
    expect(during.claimed).toBe(0);
    expect(h.gateway.sent).toHaveLength(1);

    h.advance(1_000);
    h.gateway.set({ ok: true });
    const recovered = await h.dispatcher.runOnce();
    expect(recovered.delivered).toBe(1);
    expect(h.gateway.sent).toHaveLength(2);
    // The same effect, twice on the wire: at least once, as declared.
    expect(h.gateway.sent[0]?.idempotencyKey).toBe(h.gateway.sent[1]?.idempotencyKey);
  });

  it("dead-letters after the attempt limit and says so", async () => {
    const h = harness({ retryMaxAttempts: 2 });
    await h.outbox.enqueue(envelope());
    h.gateway.set({ ok: false, error: "still down", retryable: true });

    expect((await h.dispatcher.runOnce()).retrying).toBe(1);
    h.advance(10_000);
    const final = await h.dispatcher.runOnce();
    expect(final.deadLettered).toBe(1);
    h.advance(10_000);
    expect((await h.dispatcher.runOnce()).claimed).toBe(0);
    expect((await h.outbox.metrics()).deadLetters).toBe(1);
  });

  it("does not retry a recipient that refused the message", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope());
    h.gateway.set({ ok: false, error: "schema_version 2 not understood", retryable: false });
    const pass = await h.dispatcher.runOnce();
    expect(pass.deadLettered).toBe(1);
    expect(pass.retrying).toBe(0);
    h.advance(600_000);
    expect((await h.dispatcher.runOnce()).claimed).toBe(0);
    expect(h.gateway.sent).toHaveLength(1);
  });

  it("treats a transport that throws as retryable", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope());
    h.gateway.set(() => {
      throw new Error("socket hang up");
    });
    const pass = await h.dispatcher.runOnce();
    expect(pass.retrying).toBe(1);
    expect(pass.problems[0]?.reason).toMatch(/socket hang up/u);
    h.advance(1_000);
    h.gateway.set({ ok: true });
    expect((await h.dispatcher.runOnce()).delivered).toBe(1);
  });
});

describe("an unroutable recipient", () => {
  it("reports it instead of dropping it, and delivers once a route appears", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope({ recipients: ["claude-code"] }));
    const pass = await h.dispatcher.runOnce();
    expect(pass.unroutable).toBe(1);
    expect(pass.delivered).toBe(0);
    expect(pass.problems[0]?.reason).toMatch(/no transport serves claude-code/u);
    expect(h.events.map((e) => e.kind)).toEqual(["unroutable"]);

    // A late plugin registers the route; the backlog drains.
    const late = fakeTransport("fake-claude");
    h.routes.set("claude-code", late.transport);
    h.advance(1_000);
    expect((await h.dispatcher.runOnce()).delivered).toBe(1);
    expect(late.sent).toHaveLength(1);
  });
});

describe("reconciliation inside the pass", () => {
  it("takes back a claim its dispatcher abandoned", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope());
    // A first dispatcher claims and dies without reporting.
    const abandoned = await h.outbox.claimDue({ dispatcherId: "crashed", limit: 1 });
    expect(abandoned).toHaveLength(1);

    h.advance(31_000);
    const pass = await h.dispatcher.runOnce();
    expect(pass.reclaimed).toBe(1);
    // Reclaimed deliveries wait out their backoff before the next attempt.
    expect(pass.claimed).toBe(0);
    h.advance(10_000);
    expect((await h.dispatcher.runOnce()).delivered).toBe(1);
  });

  it("fails an envelope that expired in the backlog, without sending it", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope({ ttlMs: 5_000 }));
    h.advance(6_000);
    const pass = await h.dispatcher.runOnce();
    expect(pass.expired).toBe(1);
    expect(pass.claimed).toBe(0);
    expect(h.gateway.sent).toEqual([]);
  });
});

describe("a superseded dispatcher", () => {
  it("records that its successful send could not be settled", async () => {
    const h = harness();
    await h.outbox.enqueue(envelope());
    // The pass claims, and while the transport is in flight the claim is taken
    // over by reconciliation: the classic lost-ack window.
    h.gateway.set(async () => {
      h.advance(31_000);
      await h.outbox.reclaimAbandoned(30_000);
      h.advance(10_000);
      await h.outbox.claimDue({ dispatcherId: "dispatcher-2", limit: 1 });
      return { ok: true };
    });

    const pass = await h.dispatcher.runOnce();
    expect(pass.delivered).toBe(0);
    expect(pass.refused).toBe(1);
    expect(pass.problems[0]?.reason).toMatch(/superseded/u);
    expect(pass.problems[0]?.rejection?.reason).toBe("stale-fencing-token");
    expect(h.events.map((e) => e.kind)).toEqual(["delivered", "refused"]);
  });
});

describe("the whole loop, with a real inbox on the other side", () => {
  it("applies one effect even though the message crossed the wire twice", async () => {
    // Producer side.
    const h = harness();
    // Consumer side: a real inbox, and the effect it guards.
    const inboxStore = new MemoryStateStore<MeshProcessedRecord>();
    const inbox = new MeshInbox({ store: inboxStore, now: h.now, party: "openclaw-gateway" });
    const applied: string[] = [];

    // The transport hands the envelope to the recipient's inbox, then reports a
    // lost ack the first time: the message landed, the sender never heard so.
    let ackLost = true;
    h.gateway.set(async () => {
      const latest = (await h.outbox.list())[0] as MeshOutboxRecord;
      await inbox.apply(latest.envelope, async () => {
        applied.push(latest.envelope.message_id);
        return "ref_applied";
      });
      if (ackLost) {
        ackLost = false;
        return { ok: false, error: "ack lost in transit", retryable: true };
      }
      return { ok: true };
    });

    await h.outbox.enqueue(envelope());
    expect((await h.dispatcher.runOnce()).retrying).toBe(1);
    h.advance(1_000);
    expect((await h.dispatcher.runOnce()).delivered).toBe(1);

    // Delivered twice, applied once. This is the invariant the order asks for.
    expect(h.gateway.sent).toHaveLength(2);
    expect(applied).toHaveLength(1);
    const metrics = await inbox.metrics();
    expect(metrics.applied).toBe(1);
    expect(metrics.suppressedDuplicates).toBe(0); // same message id both times

    // And the sender's record is settled, awaiting only an independent ack.
    const outboxMetrics = await h.outbox.metrics();
    expect(outboxMetrics.pendingDeliveries).toBe(0);
    expect(outboxMetrics.awaitingAck).toBe(1);
  });

  it("reaches a verified ack once an independent party confirms it", async () => {
    const h = harness();
    const enqueued = await h.outbox.enqueue(envelope());
    await h.dispatcher.runOnce();
    expect((await h.outbox.metrics()).awaitingAck).toBe(1);
    const verified = await h.outbox.markVerified({
      idempotencyKey: enqueued.record.envelope.idempotency_key,
      recipient: "openclaw-gateway",
      verifiedBy: "muse",
      evidenceHash: `sha256:${"c".repeat(64)}`,
    });
    expect(verified.ok).toBe(true);
    expect((await h.outbox.metrics()).awaitingAck).toBe(0);
  });
});
