/**
 * Tests for the attention/salience filter.
 */
import { describe, expect, it } from "vitest";
import { AttentionFilter, fromAwareness, type CognitiveEvent } from "./attention.js";

const at = (kind: string, extra: Partial<CognitiveEvent> = {}): CognitiveEvent => ({
  source: "test",
  kind,
  atISO: "2026-09-01T12:00:00.000Z",
  ...extra,
});

describe("fromAwareness", () => {
  it("applies a high prior to a critical battery event", () => {
    const e = fromAwareness({ kind: "battery.critical", percent: 3 });
    expect(e.source).toBe("awareness");
    expect(e.importance).toBeGreaterThan(0.9);
    expect(e.urgency).toBeGreaterThan(0.9);
  });

  it("falls back to a neutral prior for an unmapped kind", () => {
    const e = fromAwareness({ kind: "monitor.added", index: 2 });
    expect(e.importance).toBeLessThan(0.5);
  });
});

describe("AttentionFilter", () => {
  it("admits a critical event", () => {
    const f = new AttentionFilter();
    const v = f.consider(fromAwareness({ kind: "battery.critical", percent: 2 }), 1_000);
    expect(v.admitted).toBe(true);
    expect(v.salience).toBeGreaterThan(0.9);
    expect(v.reason).toContain("admitted");
  });

  it("treats an unseen kind as fully novel", () => {
    const f = new AttentionFilter();
    expect(f.noveltyFor("never.seen", 1_000)).toBe(1);
  });

  it("suppresses an immediately repeated event", () => {
    const f = new AttentionFilter();
    const first = f.consider(at("cpu.high", { importance: 0.45, urgency: 0.4 }), 1_000);
    const second = f.consider(at("cpu.high", { importance: 0.45, urgency: 0.4 }), 1_000);
    expect(second.novelty).toBe(0);
    expect(second.salience).toBeLessThan(first.salience);
  });

  it("restores novelty once the window has elapsed", () => {
    const windowMs = 60_000;
    const f = new AttentionFilter({ noveltyWindowMs: windowMs });
    f.consider(at("disk.low"), 0);
    expect(f.noveltyFor("disk.low", windowMs / 2)).toBeCloseTo(0.5, 5);
    expect(f.noveltyFor("disk.low", windowMs)).toBe(1);
    expect(f.noveltyFor("disk.low", windowMs * 5)).toBe(1);
  });

  it("keeps admitting a high-stakes event even with zero novelty", () => {
    const f = new AttentionFilter();
    f.consider(fromAwareness({ kind: "network.offline" }), 1_000);
    const repeat = f.consider(fromAwareness({ kind: "network.offline" }), 1_000);
    expect(repeat.novelty).toBe(0);
    expect(repeat.admitted).toBe(true);
  });

  it("drops a low-stakes repeat below the threshold", () => {
    const f = new AttentionFilter();
    f.consider(fromAwareness({ kind: "battery.charging.changed", charging: true }), 1_000);
    const repeat = f.consider(
      fromAwareness({ kind: "battery.charging.changed", charging: false }),
      1_000,
    );
    expect(repeat.admitted).toBe(false);
    expect(repeat.reason).toContain("ignored");
  });

  it("forgets history on reset", () => {
    const f = new AttentionFilter();
    f.consider(at("cpu.high"), 1_000);
    f.reset();
    expect(f.noveltyFor("cpu.high", 1_000)).toBe(1);
  });
});
