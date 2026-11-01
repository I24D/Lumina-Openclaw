/**
 * Tests the scheduler, which is the one part of the mesh that owns a timer.
 *
 * Every timer here is injected, so the loop is driven by hand and nothing
 * sleeps: the repository's test budget forbids real timers and polling. What is
 * being proven is the behaviour the modules below cannot prove on their own —
 * that a pass is actually scheduled, that the interval responds to whether work
 * happened, that a thrown pass does not kill the loop, and that an unhandled
 * topic is recorded rather than quietly marked applied.
 */
import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import type { MeshTransportResult } from "./dispatcher.js";
import { createEnvelope, type MeshEnvelope, type MeshParty } from "./envelope.js";
import { MeshRuntime, type MeshRuntimeOptions } from "./mesh-runtime.js";
import type { ReadMeshEnvelopesResult } from "./supabase-transport.js";

const PARTY: MeshParty = "openclaw-gateway";
const PEER: MeshParty = "chatgpt-lumina";
const CONFIG = {
  url: "https://example.supabase.co",
  serviceKey: "test-key",
  schema: "public",
  maxRows: 100,
  allowWrites: true,
} as never;

/** A hand-driven clock and timer queue: one pending beat, fired on demand. */
function createHarness(
  overrides: Partial<MeshRuntimeOptions> = {},
  inbound: ReadMeshEnvelopesResult[] = [],
) {
  let nowMs = 1_760_000_000_000;
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const logs: string[] = [];
  const sent: Array<{ envelope: MeshEnvelope; recipient: MeshParty }> = [];
  let nextSend: MeshTransportResult = { ok: true, ref: "ref-1" };
  const reads = [...inbound];

  const runtime = new MeshRuntime({
    party: PARTY,
    outboxStore: new MemoryStateStore(),
    inboxStore: new MemoryStateStore(),
    journalStore: new MemoryStateStore(),
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
    now: () => nowMs,
    config: CONFIG,
    activeIntervalMs: 1_000,
    idleIntervalMs: 8_000,
    setTimer: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    clearTimer: () => undefined,
    transport: {
      name: "test-transport",
      async send(envelope, recipient) {
        sent.push({ envelope, recipient });
        return nextSend;
      },
    },
    readInbound: async () => reads.shift() ?? { ok: true, envelopes: [], rejected: [] },
    ...overrides,
  });

  return {
    runtime,
    logs,
    sent,
    scheduled,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setSendResult: (result: MeshTransportResult) => {
      nextSend = result;
    },
    /** Fires the beat the runtime last scheduled. */
    fire: async () => {
      const beat = scheduled.pop();
      expect(beat, "expected a scheduled beat").toBeDefined();
      beat?.fn();
      await runtime.tick();
    },
    lastInterval: () => scheduled.at(-1)?.ms,
  };
}

function envelopeFor(
  topic: string,
  nowMs = 1_760_000_000_000,
  overrides: Partial<Parameters<typeof createEnvelope>[0]> = {},
): MeshEnvelope {
  return createEnvelope({
    origin: PEER,
    recipients: [PARTY],
    topic,
    event_type: `${topic}.v1`,
    priority: 3,
    nowMs,
    ...overrides,
  });
}

describe("start and schedule", () => {
  it("reports nothing observed before the first pass", async () => {
    const harness = createHarness();
    const snapshot = await harness.runtime.snapshot();
    expect(snapshot.running).toBe(false);
    // Null, not a zero or a placeholder date: "never ran" and "ran and found
    // nothing" must not look the same in the panel.
    expect(snapshot.lastPassAt).toBeNull();
    expect(snapshot.passes).toBe(0);
  });

  it("schedules the first beat immediately and reports real counters after it", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    expect(harness.scheduled.at(-1)?.ms).toBe(0);
    await harness.fire();
    const snapshot = await harness.runtime.snapshot();
    expect(snapshot.running).toBe(true);
    expect(snapshot.passes).toBe(1);
    expect(snapshot.lastPassAt).not.toBeNull();
    expect(snapshot.outbound?.records).toBe(0);
    expect(snapshot.inbound?.records).toBe(0);
  });
});

describe("outbound delivery", () => {
  it("delivers an enqueued envelope through the transport", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    await harness.runtime.outboxPort.enqueue(
      createEnvelope({
        origin: PARTY,
        recipients: [PEER],
        topic: "task.handoff",
        event_type: "task.claimed",
        priority: 2,
        nowMs: 1_760_000_000_000,
      }),
    );
    await harness.fire();
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.recipient).toBe(PEER);
    const snapshot = await harness.runtime.snapshot();
    expect(snapshot.lastPass?.delivered).toBe(1);
  });

  it("keeps a retryable failure visible instead of losing it", async () => {
    const harness = createHarness();
    harness.setSendResult({ ok: false, error: "503 upstream", retryable: true });
    await harness.runtime.start();
    await harness.runtime.outboxPort.enqueue(
      createEnvelope({
        origin: PARTY,
        recipients: [PEER],
        topic: "task.handoff",
        event_type: "task.claimed",
        priority: 2,
        nowMs: 1_760_000_000_000,
      }),
    );
    await harness.fire();
    const snapshot = await harness.runtime.snapshot();
    expect(snapshot.lastPass?.retrying).toBe(1);
    expect(snapshot.lastPass?.delivered).toBe(0);
    // Still open, so a later pass will try again: at-least-once, not at-most-once.
    expect(snapshot.outbound?.pendingDeliveries).toBe(1);
  });
});

describe("the interval", () => {
  it("doubles while idle and stops at the ceiling", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    await harness.fire();
    expect(harness.lastInterval()).toBe(2_000);
    await harness.fire();
    expect(harness.lastInterval()).toBe(4_000);
    await harness.fire();
    expect(harness.lastInterval()).toBe(8_000);
    await harness.fire();
    expect(harness.lastInterval()).toBe(8_000);
  });

  it("drops back to the floor as soon as a pass does work", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    await harness.fire();
    await harness.fire();
    expect(harness.lastInterval()).toBe(4_000);
    await harness.runtime.outboxPort.enqueue(
      createEnvelope({
        origin: PARTY,
        recipients: [PEER],
        topic: "task.handoff",
        event_type: "task.claimed",
        priority: 2,
        nowMs: 1_760_000_000_000,
      }),
    );
    await harness.fire();
    expect(harness.lastInterval()).toBe(1_000);
  });
});

describe("inbound", () => {
  it("runs a registered handler once and suppresses the repeat", async () => {
    // What a real resend looks like: a fresh `message_id` and a later
    // `created_at`, but the same defining fields, so `deriveIdempotencyKey`
    // returns the same key. Re-sending the identical `message_id` would not
    // test anything — the inbox refuses to count one message twice, and the
    // cursor's lower bound is exclusive, so the same row never comes back.
    const first = envelopeFor("review.verdict", 1_760_000_000_000, {
      message_id: "msg_first",
      correlation_id: "corr_shared",
    });
    const second = envelopeFor("review.verdict", 1_760_000_060_000, {
      message_id: "msg_second",
      correlation_id: "corr_shared",
    });
    expect(second.idempotency_key).toBe(first.idempotency_key);
    const harness = createHarness({}, [
      { ok: true, envelopes: [first], rejected: [], cursor: first.created_at },
      { ok: true, envelopes: [second], rejected: [], cursor: second.created_at },
    ]);
    let runs = 0;
    harness.runtime.handle("review.verdict", {
      effect: "idempotent",
      run: async () => {
        runs += 1;
        return "applied-once";
      },
    });
    await harness.runtime.start();
    await harness.fire();
    await harness.fire();
    expect(runs).toBe(1);
    const snapshot = await harness.runtime.snapshot();
    expect(snapshot.inbound?.applied).toBe(1);
    expect(snapshot.inbound?.suppressedDuplicates).toBe(1);
    expect(snapshot.cursor).toBe(second.created_at);
  });

  it("records an unhandled topic without claiming it was applied", async () => {
    const envelope = envelopeFor("nobody.listens");
    const harness = createHarness({}, [
      { ok: true, envelopes: [envelope], rejected: [], cursor: envelope.created_at },
    ]);
    await harness.runtime.start();
    await harness.fire();
    const snapshot = await harness.runtime.snapshot();
    expect(snapshot.unhandled).toBe(1);
    // The decisive assertion: nothing was marked applied. A queue that reports
    // success for a message no handler saw has lost it.
    expect(snapshot.inbound?.applied).toBe(0);
    expect(snapshot.inbound?.records).toBe(0);
    // The cursor still moves, or one unroutable message blocks every later one.
    expect(snapshot.cursor).toBe(envelope.created_at);
    expect(harness.logs.some((line) => line.includes("no handler for topic"))).toBe(true);
  });

  it("surfaces a failing handler and keeps the loop alive", async () => {
    const envelope = envelopeFor("task.handoff");
    const harness = createHarness({}, [
      { ok: true, envelopes: [envelope], rejected: [], cursor: envelope.created_at },
    ]);
    harness.runtime.handle("task.handoff", {
      effect: "idempotent",
      run: async () => {
        throw new Error("handler exploded");
      },
    });
    await harness.runtime.start();
    await harness.fire();
    const snapshot = await harness.runtime.snapshot();
    expect(snapshot.inbound?.failed).toBe(1);
    expect(snapshot.lastError).toContain("handler exploded");
    // Still scheduled: one bad message must not end the service.
    expect(harness.lastInterval()).toBeGreaterThan(0);
  });

  it("reports a reader error without advancing the cursor", async () => {
    const harness = createHarness({}, [{ ok: false, error: "network down", retryable: true }]);
    await harness.runtime.start();
    await harness.fire();
    const snapshot = await harness.runtime.snapshot();
    expect(snapshot.lastError).toContain("network down");
    expect(snapshot.cursor).toBeNull();
  });

  it("logs a rejected row by field and reason and keeps the page", async () => {
    const envelope = envelopeFor("review.verdict");
    const harness = createHarness({}, [
      {
        ok: true,
        envelopes: [envelope],
        rejected: [{ id: "row-9", problems: [{ field: "priority", reason: "out of range" }] }],
        cursor: envelope.created_at,
      },
    ]);
    let runs = 0;
    harness.runtime.handle("review.verdict", {
      effect: "idempotent",
      run: async () => {
        runs += 1;
      },
    });
    await harness.runtime.start();
    await harness.fire();
    expect(runs).toBe(1);
    expect(harness.logs.some((line) => line.includes("priority: out of range"))).toBe(true);
  });
});

describe("stop", () => {
  it("waits for the pass in flight rather than abandoning its claim", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      readInbound: async () => {
        await gate;
        return { ok: true, envelopes: [], rejected: [] };
      },
    });
    await harness.runtime.start();
    const beat = harness.scheduled.pop();
    beat?.fn();
    const stopping = harness.runtime.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
    expect((await harness.runtime.snapshot()).running).toBe(false);
  });
});
