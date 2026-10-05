/**
 * Tests for the thalamic router.
 */
import { describe, expect, it, vi } from "vitest";
import { AttentionQueue } from "../attention-queue.js";
import { AttentionFilter, type CognitiveEvent } from "../attention.js";
import { ThalamicRouter, type RoutedEvent } from "./thalamic-router.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

const event = (source: string, kind: string, weight = 0.9): CognitiveEvent => ({
  source,
  kind,
  atISO: new Date(NOW).toISOString(),
  importance: weight,
  urgency: weight,
});

const router = (threshold = 0.35) =>
  new ThalamicRouter({ attention: new AttentionFilter({ threshold }), now: () => NOW });

describe("ThalamicRouter routing", () => {
  it("delivers to subscribers whose glob matches source and kind", () => {
    const r = router();
    const vision: string[] = [];
    const people: string[] = [];
    r.subscribe({ source: "vision" }, (e) => vision.push(e.event.kind));
    r.subscribe({ kind: "person.*" }, (e) => people.push(e.event.kind));

    r.ingest(event("vision", "person.entered"));
    r.ingest(event("vision", "object.moved"));
    r.ingest(event("audio", "person.spoke"));

    expect(vision).toEqual(["person.entered", "object.moved"]);
    expect(people).toEqual(["person.entered", "person.spoke"]);
  });

  it("delivers events attention ignored, so cheap consumers miss nothing", () => {
    const r = router(0.99);
    const seen: RoutedEvent[] = [];
    r.subscribe({}, (e) => seen.push(e));

    const result = r.ingest(event("vision", "object.seen", 0.1));

    expect(result.verdict.admitted).toBe(false);
    expect(seen).toHaveLength(1);
    expect(result.queued).toBe(false);
    expect(r.pending).toBe(0);
  });

  it("stops delivering after unsubscribe", () => {
    const r = router();
    const handler = vi.fn();
    const off = r.subscribe({}, handler);
    r.ingest(event("a", "x"));
    off();
    r.ingest(event("a", "y"));

    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("ThalamicRouter queueing", () => {
  it("queues only admitted events and announces them", () => {
    const r = router(0.5);
    const announced: string[] = [];
    r.onAdmitted((item) => announced.push(item.event.kind));

    r.ingest(event("awareness", "battery.critical", 0.95));
    r.ingest(event("awareness", "monitor.added", 0.05));

    expect(announced).toEqual(["battery.critical"]);
    expect(r.pending).toBe(1);
    expect(r.next()?.event.kind).toBe("battery.critical");
    expect(r.next()).toBeUndefined();
  });

  it("reports an eviction when the queue overflows", () => {
    const r = new ThalamicRouter({
      attention: new AttentionFilter({ threshold: 0 }),
      queue: new AttentionQueue({ capacity: 1 }),
      now: () => NOW,
    });
    r.ingest(event("s", "first", 0.5));
    const result = r.ingest(event("s", "urgent", 0.95));

    expect(result.queued).toBe(true);
    expect(result.evicted?.kind).toBe("first");
    expect(r.pendingEvents().map((i) => i.event.kind)).toEqual(["urgent"]);
  });
});

describe("ThalamicRouter isolation", () => {
  it("keeps routing when a consumer throws, and reports the failure", () => {
    const onConsumerError = vi.fn();
    const r = new ThalamicRouter({ now: () => NOW, onConsumerError });
    const healthy = vi.fn();
    r.subscribe({}, () => {
      throw new Error("consumer exploded");
    });
    r.subscribe({}, healthy);

    expect(() => r.ingest(event("s", "k"))).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    expect(onConsumerError).toHaveBeenCalledOnce();
  });

  it("keeps a bounded, newest-first history of everything ingested", () => {
    const r = new ThalamicRouter({ now: () => NOW, recentLimit: 2 });
    r.ingest(event("s", "one"));
    r.ingest(event("s", "two"));
    r.ingest(event("s", "three"));

    expect(r.recent().map((e) => e.event.kind)).toEqual(["three", "two"]);
  });
});
