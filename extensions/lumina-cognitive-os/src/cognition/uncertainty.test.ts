/**
 * Tests for the Confidence Engine.
 */
import { describe, expect, it } from "vitest";
import {
  assessConfidence,
  clampConfidence,
  combineSignals,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  normalizeThresholds,
  stanceFor,
} from "./uncertainty.js";

describe("clampConfidence", () => {
  it("clamps out-of-range and non-finite values", () => {
    expect(clampConfidence(1.7)).toBe(1);
    expect(clampConfidence(-2)).toBe(0);
    expect(clampConfidence(Number.NaN)).toBe(0);
    // Infinity is garbage input, not certainty: it must collapse to 0 so the
    // stance degrades to "ask" instead of authorizing an autonomous action.
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(0);
    expect(stanceFor(Number.POSITIVE_INFINITY)).toBe("ask");
  });
});

describe("stanceFor", () => {
  it("applies the spec thresholds", () => {
    expect(stanceFor(0.95)).toBe("act");
    expect(stanceFor(0.8)).toBe("verify");
    expect(stanceFor(0.5)).toBe("ask");
  });

  it("treats the act threshold as exclusive and verify as inclusive", () => {
    expect(stanceFor(DEFAULT_CONFIDENCE_THRESHOLDS.act)).toBe("verify");
    expect(stanceFor(DEFAULT_CONFIDENCE_THRESHOLDS.verify)).toBe("verify");
    expect(stanceFor(DEFAULT_CONFIDENCE_THRESHOLDS.verify - 0.01)).toBe("ask");
  });
});

describe("normalizeThresholds", () => {
  it("never lets verify exceed act", () => {
    expect(normalizeThresholds({ act: 0.5, verify: 0.9 })).toEqual({ act: 0.5, verify: 0.5 });
  });
});

describe("combineSignals", () => {
  it("returns 0 with no signals so absence of evidence reads as 'ask'", () => {
    expect(combineSignals([])).toBe(0);
    expect(stanceFor(combineSignals([]))).toBe("ask");
  });

  it("ignores zero and negative weights", () => {
    const v = combineSignals([
      { source: "a", value: 1, weight: 0 },
      { source: "b", value: 0.5, weight: -3 },
      { source: "c", value: 0.4 },
    ]);
    expect(v).toBeCloseTo(0.4, 5);
  });

  it("weights signals proportionally", () => {
    const v = combineSignals([
      { source: "strong", value: 1, weight: 3 },
      { source: "weak", value: 0, weight: 1 },
    ]);
    expect(v).toBeCloseTo(0.75, 5);
  });
});

describe("assessConfidence", () => {
  it("explains an autonomous decision", () => {
    const a = assessConfidence({
      signals: [{ source: "memory.hit", value: 0.98 }],
      subject: "reply to Sandra",
    });
    expect(a.stance).toBe("act");
    expect(a.rationale).toContain("reply to Sandra");
    expect(a.rationale).toContain("acting autonomously");
  });

  it("falls back to asking when every signal is unusable", () => {
    const a = assessConfidence({ signals: [{ source: "x", value: 0.99, weight: 0 }] });
    expect(a.confidence).toBe(0);
    expect(a.stance).toBe("ask");
    expect(a.signals).toHaveLength(0);
    expect(a.rationale).toContain("no usable signals");
  });
});
