/**
 * Tests for the ICCV scorecard.
 *
 * The invariant worth most here is negative: an idle component must never read
 * 100%, and a score must never be reported without the coverage that qualifies
 * it. Several tests exist only to pin that down.
 */
import { describe, expect, it } from "vitest";
import {
  assessSuperadditiveClaim,
  buildIccvReport,
  formatIccvReport,
  ICCV_COMPONENTS,
  ICCV_WEIGHTS,
  type IccvGauges,
  type IccvObservation,
} from "./iccv.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const HOUR = 3_600_000;

const QUIET_GAUGES: IccvGauges = {
  backlog: 0,
  deadLetters: 0,
  awaitingAck: 0,
  leaseConflicts: 0,
  needsManual: 0,
  oldestDueAgeMs: 0,
};

function report(observations: readonly IccvObservation[], gauges: IccvGauges = QUIET_GAUGES) {
  return buildIccvReport({ fromMs: T0, toMs: T0 + HOUR, observations, gauges });
}

describe("the weights", () => {
  it("sum to exactly 1 over the five components", () => {
    const total = ICCV_COMPONENTS.reduce((sum, component) => sum + ICCV_WEIGHTS[component], 0);
    expect(total).toBeCloseTo(1, 10);
    expect(ICCV_WEIGHTS).toEqual({ D: 0.25, E: 0.25, V: 0.2, R: 0.15, T: 0.15 });
  });
});

describe("a component with no denominator", () => {
  it("is N/A, never 100%", () => {
    const result = report([{ at_ms: T0, component: "D", outcome: "ok" }]);
    const d = result.components.find((c) => c.component === "D");
    expect(d?.status).toBe("measured");
    for (const component of ["E", "V", "R", "T"] as const) {
      const entry = result.components.find((c) => c.component === component);
      expect(entry?.status, component).toBe("na");
      expect(entry?.denominator, component).toBe(0);
      if (entry?.status === "na") {
        expect(entry.reason).toMatch(/nothing was attempted/u);
      }
      // The shape itself makes a ratio unreachable for an N/A component.
      expect(entry && "ratio" in entry).toBe(false);
    }
    expect(result.notApplicable).toEqual(["E", "V", "R", "T"]);
  });

  it("reports a null score when nothing at all was observed", () => {
    const result = report([]);
    expect(result.score).toBeNull();
    expect(result.coverage).toBe(0);
    expect(result.observations).toBe(0);
    expect(result.notApplicable).toEqual(["D", "E", "V", "R", "T"]);
    // Not zero, and not one.
    expect(result.score).not.toBe(0);
    expect(result.score).not.toBe(1);
  });

  it("never silently inflates coverage", () => {
    // One perfect component out of five: the score is 1, but it covers 0.25.
    const result = report([{ at_ms: T0, component: "D", outcome: "ok" }]);
    expect(result.score).toBe(1);
    expect(result.coverage).toBe(0.25);
    expect(formatIccvReport(result)).toMatch(/score: 1 at coverage 0.25/u);
    expect(formatIccvReport(result)).toMatch(/not of the whole index/u);
  });
});

describe("the weighted score", () => {
  it("weighs the measured components against each other, not against the whole", () => {
    // D is perfect (weight .25), E is half (weight .25). Nothing else measured.
    const result = report([
      { at_ms: T0, component: "D", outcome: "ok" },
      { at_ms: T0, component: "D", outcome: "ok" },
      { at_ms: T0, component: "E", outcome: "ok" },
      { at_ms: T0, component: "E", outcome: "fail" },
    ]);
    // (1 * .25 + .5 * .25) / (.25 + .25) = .75
    expect(result.score).toBe(0.75);
    expect(result.coverage).toBe(0.5);
  });

  it("gives the exact weighted mean when every component is measured", () => {
    const observations: IccvObservation[] = [];
    for (const component of ICCV_COMPONENTS) {
      observations.push({ at_ms: T0, component, outcome: "ok" });
      observations.push({ at_ms: T0, component, outcome: "fail" });
    }
    const result = report(observations);
    expect(result.coverage).toBe(1);
    expect(result.score).toBe(0.5);
    expect(result.notApplicable).toEqual([]);
  });

  it("counts every attempt in the denominator", () => {
    const result = report([
      { at_ms: T0, component: "V", outcome: "ok" },
      { at_ms: T0, component: "V", outcome: "fail" },
      { at_ms: T0, component: "V", outcome: "fail" },
    ]);
    const v = result.components.find((c) => c.component === "V");
    expect(v?.status).toBe("measured");
    if (v?.status === "measured") {
      expect(v.numerator).toBe(1);
      expect(v.denominator).toBe(3);
      expect(v.ratio).toBe(0.3333);
    }
  });
});

describe("the window", () => {
  it("includes its start and excludes its end, so windows never double-count", () => {
    const observations: IccvObservation[] = [
      { at_ms: T0 - 1, component: "D", outcome: "fail" },
      { at_ms: T0, component: "D", outcome: "ok" },
      { at_ms: T0 + HOUR - 1, component: "D", outcome: "ok" },
      { at_ms: T0 + HOUR, component: "D", outcome: "fail" },
    ];
    const result = report(observations);
    expect(result.observations).toBe(2);
    const d = result.components.find((c) => c.component === "D");
    if (d?.status === "measured") {
      expect(d.numerator).toBe(2);
      expect(d.denominator).toBe(2);
    }
    // The adjacent window picks up exactly the two that were excluded.
    const next = buildIccvReport({
      fromMs: T0 + HOUR,
      toMs: T0 + 2 * HOUR,
      observations,
      gauges: QUIET_GAUGES,
    });
    expect(next.observations).toBe(1);
  });

  it("reports its own duration", () => {
    expect(report([]).window).toEqual({ fromMs: T0, toMs: T0 + HOUR, durationMs: HOUR });
  });
});

describe("latency", () => {
  it("reports nearest-rank percentiles that were actually observed", () => {
    const observations: IccvObservation[] = [120, 10, 50, 900, 30].map((latency_ms, i) => ({
      at_ms: T0 + i,
      component: "D",
      outcome: "ok",
      latency_ms,
    }));
    const result = report(observations);
    expect(result.latency.samples).toBe(5);
    // Sorted: 10 30 50 120 900. p50 -> index ceil(.5*5)-1 = 2 -> 50.
    expect(result.latency.p50Ms).toBe(50);
    // p95 -> index ceil(.95*5)-1 = 4 -> 900.
    expect(result.latency.p95Ms).toBe(900);
  });

  it("reports N/A rather than zero when nothing was timed", () => {
    const result = report([{ at_ms: T0, component: "D", outcome: "ok" }]);
    expect(result.latency.p50Ms).toBeNull();
    expect(result.latency.p95Ms).toBeNull();
    expect(result.latency.samples).toBe(0);
    expect(formatIccvReport(result)).toMatch(/p50 N\/Ams/u);
  });

  it("ignores a non-finite latency instead of poisoning the percentiles", () => {
    const result = report([
      { at_ms: T0, component: "D", outcome: "ok", latency_ms: 40 },
      { at_ms: T0 + 1, component: "D", outcome: "ok", latency_ms: Number.NaN },
      { at_ms: T0 + 2, component: "D", outcome: "ok", latency_ms: Number.POSITIVE_INFINITY },
    ]);
    expect(result.latency.samples).toBe(1);
    expect(result.latency.p50Ms).toBe(40);
  });
});

describe("failures and severity", () => {
  it("lists failures newest first and names the worst severity", () => {
    const result = report([
      { at_ms: T0 + 10, component: "E", outcome: "fail", severity: 4, label: "muse offline" },
      { at_ms: T0 + 20, component: "T", outcome: "fail", severity: 2, label: "partial write" },
      { at_ms: T0 + 30, component: "R", outcome: "ok" },
    ]);
    expect(result.failures.map((f) => f.label)).toEqual(["partial write", "muse offline"]);
    expect(result.worstSeverity).toBe(4);
  });

  it("reports a null worst severity when nothing failed", () => {
    expect(report([{ at_ms: T0, component: "D", outcome: "ok" }]).worstSeverity).toBeNull();
  });

  it("caps the failure list and says nothing about what it dropped being fine", () => {
    const many: IccvObservation[] = Array.from({ length: 30 }, (_, i) => ({
      at_ms: T0 + i,
      component: "E",
      outcome: "fail",
      label: `failure ${i}`,
    }));
    const capped = buildIccvReport({
      fromMs: T0,
      toMs: T0 + HOUR,
      observations: many,
      gauges: QUIET_GAUGES,
      maxFailures: 5,
    });
    expect(capped.failures).toHaveLength(5);
    // The denominator still counts all 30: the cap trims the list, not the maths.
    const e = capped.components.find((c) => c.component === "E");
    if (e?.status === "measured") {
      expect(e.denominator).toBe(30);
      expect(e.numerator).toBe(0);
      expect(e.ratio).toBe(0);
    }
  });

  it("labels an unlabelled failure rather than dropping it", () => {
    const result = report([{ at_ms: T0, component: "T", outcome: "fail" }]);
    expect(result.failures[0]?.label).toBe("T failed");
  });
});

describe("gauges", () => {
  it("are reported beside the index and never folded into it", () => {
    const gauges: IccvGauges = {
      backlog: 3,
      deadLetters: 1,
      awaitingAck: 2,
      leaseConflicts: 1,
      needsManual: 1,
      oldestDueAgeMs: 42_000,
    };
    const result = report([{ at_ms: T0, component: "D", outcome: "ok" }], gauges);
    // A dirty backlog does not move a clean delivery ratio.
    expect(result.score).toBe(1);
    expect(result.gauges).toEqual(gauges);
    const text = formatIccvReport(result);
    expect(text).toMatch(/backlog 3/u);
    expect(text).toMatch(/dead letters 1/u);
    expect(text).toMatch(/lease conflicts 1/u);
    expect(text).toMatch(/needs manual 1/u);
  });
});

describe("the human-readable report", () => {
  it("prints every denominator and every N/A", () => {
    const text = formatIccvReport(
      report([
        { at_ms: T0, component: "D", outcome: "ok" },
        { at_ms: T0, component: "D", outcome: "fail" },
      ]),
    );
    expect(text).toMatch(/D deliveries confirmed: 1\/2 = 0\.5 \(weight 0\.25\)/u);
    expect(text).toMatch(/E executions correct: N\/A \(weight 0\.25\)/u);
    expect(text).toMatch(/V verifications independent: N\/A/u);
    expect(text).toMatch(/R recoveries correct: N\/A/u);
    expect(text).toMatch(/T transactional integrity: N\/A/u);
  });

  it("says N/A outright when the window is empty", () => {
    expect(formatIccvReport(report([]))).toMatch(
      /score: N\/A — nothing was attempted in this window/u,
    );
  });
});

describe("LUMINA-001", () => {
  it("stays unvalidated with no controls, and names every missing one", () => {
    const verdict = assessSuperadditiveClaim({
      individualBaselines: 0,
      equivalentResources: false,
      blindReview: false,
    });
    expect(verdict.status).toBe("unvalidated");
    expect(verdict.missing).toHaveLength(3);
    expect(verdict.note).toMatch(/no superadditive learning may be claimed/u);
  });

  it("stays unvalidated even with all three controls, and reports no value", () => {
    const verdict = assessSuperadditiveClaim({
      individualBaselines: 3,
      equivalentResources: true,
      blindReview: true,
    });
    // The gate opens on the controls; the claim still needs a real experiment,
    // and this function has no path that returns an advantage figure.
    expect(verdict.status).toBe("unvalidated");
    expect(verdict.missing).toEqual([]);
    expect(verdict.note).toMatch(/never reports a value/u);
    expect(Object.keys(verdict).toSorted()).toEqual(["missing", "note", "status"]);
  });

  it("names a partial control set precisely", () => {
    const verdict = assessSuperadditiveClaim({
      individualBaselines: 2,
      equivalentResources: true,
      blindReview: false,
    });
    expect(verdict.missing).toEqual([
      "three individual baselines are required, 2 provided",
      "blind adversarial review of the outcomes is not established",
    ]);
  });
});
