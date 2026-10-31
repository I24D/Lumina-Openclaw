/**
 * iccv.ts — The mesh's own scorecard, with its denominators in plain sight.
 *
 * Five weighted components over a time window:
 *
 *   D  delivered and confirmed        25%
 *   E  executed correctly             25%
 *   V  verified independently         20%
 *   R  recovered correctly            15%
 *   T  transactionally intact         15%
 *
 * ## The rule this module exists to enforce
 *
 * A component with no denominator is **N/A**, never 100%. Nothing was attempted,
 * so nothing succeeded; reporting a perfect score for an idle component is the
 * single most tempting lie a dashboard can tell. So `score` is weighted over the
 * measured components *only*, and it is always reported next to `coverage`: the
 * share of the total weight those components actually represent. A score of 1.0
 * at coverage 0.25 says "the quarter of this index we could measure looks
 * clean", which is a different claim from "everything is fine".
 *
 * When nothing at all was observed, `score` is `null`. Not zero, not one.
 *
 * ## Gauges are not ratios
 *
 * Backlog, dead letters, unacked messages and lease conflicts are levels, not
 * success rates. They are reported as counts beside the index, never folded
 * into it, because a backlog of 3 is not "75% healthy".
 *
 * This module is pure: observations in, report out, no clock and no I/O of its
 * own. The caller assembles observations from the outbox, the inbox and each
 * dispatcher pass.
 */
import type { MeshPriority } from "./envelope.js";

/** The five components of the index. */
export type IccvComponent = "D" | "E" | "V" | "R" | "T";

export const ICCV_COMPONENTS: readonly IccvComponent[] = Object.freeze([
  "D",
  "E",
  "V",
  "R",
  "T",
] as const);

/** The weights the order fixes. They sum to 1. */
export const ICCV_WEIGHTS: Readonly<Record<IccvComponent, number>> = Object.freeze({
  D: 0.25,
  E: 0.25,
  V: 0.2,
  R: 0.15,
  T: 0.15,
});

/** What each component means, for a report a person reads. */
export const ICCV_LABELS: Readonly<Record<IccvComponent, string>> = Object.freeze({
  D: "deliveries confirmed",
  E: "executions correct",
  V: "verifications independent",
  R: "recoveries correct",
  T: "transactional integrity",
});

/**
 * One thing that was attempted and how it came out.
 *
 * `component` says which denominator it belongs to. Every observation counts in
 * the denominator; only `outcome: "ok"` counts in the numerator.
 */
export type IccvObservation = {
  readonly at_ms: number;
  readonly component: IccvComponent;
  readonly outcome: "ok" | "fail";
  /** End-to-end milliseconds, when the caller measured it. */
  readonly latency_ms?: number;
  /** The bus priority of what failed, so severity is not guessed at. */
  readonly severity?: MeshPriority;
  /** Short label for the failure list. Never payload content. */
  readonly label?: string;
};

/** Levels at the end of the window, reported beside the index. */
export type IccvGauges = {
  /** Deliveries still open. */
  readonly backlog: number;
  /** Deliveries that failed permanently. */
  readonly deadLetters: number;
  /** Messages that asked for an ack and have not been verified. */
  readonly awaitingAck: number;
  /** Settlements refused because a claim had been superseded. */
  readonly leaseConflicts: number;
  /** Effects parked for a person to resolve. */
  readonly needsManual: number;
  /** Age of the oldest delivery still due, in ms. */
  readonly oldestDueAgeMs: number;
};

export type IccvComponentResult =
  | {
      readonly component: IccvComponent;
      readonly label: string;
      readonly weight: number;
      readonly status: "na";
      /** Why there is no ratio. Always "nothing was attempted in the window". */
      readonly reason: string;
      readonly denominator: 0;
    }
  | {
      readonly component: IccvComponent;
      readonly label: string;
      readonly weight: number;
      readonly status: "measured";
      readonly numerator: number;
      readonly denominator: number;
      readonly ratio: number;
    };

/** A failure worth naming, newest first, capped. */
export type IccvFailure = {
  readonly component: IccvComponent;
  readonly at_ms: number;
  readonly severity?: MeshPriority;
  readonly label: string;
};

export type IccvReport = {
  readonly window: { readonly fromMs: number; readonly toMs: number; readonly durationMs: number };
  readonly components: readonly IccvComponentResult[];
  /**
   * Weighted mean over the measured components, or null when none was measured.
   * Read it together with `coverage`: it is a score *of what was measurable*.
   */
  readonly score: number | null;
  /** Share of the total weight the measured components carry, 0 to 1. */
  readonly coverage: number;
  /** Components with no denominator. Named, so the gap is visible. */
  readonly notApplicable: readonly IccvComponent[];
  readonly observations: number;
  readonly latency: {
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly samples: number;
  };
  readonly gauges: IccvGauges;
  readonly failures: readonly IccvFailure[];
  /** Highest severity among the window's failures, or null when none failed. */
  readonly worstSeverity: MeshPriority | null;
};

const DEFAULT_MAX_FAILURES = 20;

/**
 * Nearest-rank percentile on a sorted sample: the value at
 * `ceil(p * n) - 1`. No interpolation, so every reported figure is a latency
 * that was actually observed.
 */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] as number;
}

/** Rounds to four decimals, so a ratio reads as a ratio and not as float noise. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Builds the report for one window.
 *
 * `fromMs` is inclusive and `toMs` exclusive, so consecutive windows neither
 * drop nor double-count an observation on the boundary.
 */
export function buildIccvReport(input: {
  readonly fromMs: number;
  readonly toMs: number;
  readonly observations: readonly IccvObservation[];
  readonly gauges: IccvGauges;
  readonly maxFailures?: number;
}): IccvReport {
  const inWindow = input.observations.filter(
    (observation) => observation.at_ms >= input.fromMs && observation.at_ms < input.toMs,
  );

  const components: IccvComponentResult[] = ICCV_COMPONENTS.map((component) => {
    const weight = ICCV_WEIGHTS[component];
    const label = ICCV_LABELS[component];
    const mine = inWindow.filter((observation) => observation.component === component);
    if (mine.length === 0) {
      return {
        component,
        label,
        weight,
        status: "na",
        reason: "nothing was attempted in this window",
        denominator: 0,
      };
    }
    const numerator = mine.filter((observation) => observation.outcome === "ok").length;
    return {
      component,
      label,
      weight,
      status: "measured",
      numerator,
      denominator: mine.length,
      ratio: round4(numerator / mine.length),
    };
  });

  const measured = components.filter(
    (result): result is Extract<IccvComponentResult, { status: "measured" }> =>
      result.status === "measured",
  );
  const coverage = round4(measured.reduce((sum, result) => sum + result.weight, 0));
  const score =
    measured.length === 0
      ? null
      : round4(
          measured.reduce((sum, result) => sum + result.ratio * result.weight, 0) /
            measured.reduce((sum, result) => sum + result.weight, 0),
        );

  const latencies = inWindow
    .map((observation) => observation.latency_ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .toSorted((a, b) => a - b);

  const failed = inWindow.filter((observation) => observation.outcome === "fail");
  const failures: IccvFailure[] = failed
    .toSorted((a, b) => b.at_ms - a.at_ms)
    .slice(0, input.maxFailures ?? DEFAULT_MAX_FAILURES)
    .map((observation) => {
      // Built by assignment rather than by spreading a conditional: an absent
      // severity must stay absent, not become an explicit undefined.
      const failure: {
        component: IccvComponent;
        at_ms: number;
        severity?: MeshPriority;
        label: string;
      } = {
        component: observation.component,
        at_ms: observation.at_ms,
        label: observation.label ?? `${observation.component} failed`,
      };
      if (observation.severity !== undefined) {
        failure.severity = observation.severity;
      }
      return failure;
    });
  const severities = failed
    .map((observation) => observation.severity)
    .filter((value): value is MeshPriority => value !== undefined);

  return {
    window: { fromMs: input.fromMs, toMs: input.toMs, durationMs: input.toMs - input.fromMs },
    components,
    score,
    coverage,
    notApplicable: components
      .filter((result) => result.status === "na")
      .map((result) => result.component),
    observations: inWindow.length,
    latency: {
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      samples: latencies.length,
    },
    gauges: input.gauges,
    failures,
    worstSeverity: severities.length === 0 ? null : (Math.max(...severities) as MeshPriority),
  };
}

/**
 * The report as lines a person can read, with every denominator shown.
 *
 * Deliberately plain text: the order asks for instrumentation and a CLI first
 * and a UI last, and a dashboard must never be the reason a gateway restarts.
 */
export function formatIccvReport(report: IccvReport): string {
  const lines: string[] = [];
  const seconds = Math.round(report.window.durationMs / 1_000);
  lines.push(`ICCV over ${seconds}s, ${report.observations} observations`);
  if (report.score === null) {
    lines.push("  score: N/A — nothing was attempted in this window");
  } else {
    lines.push(
      `  score: ${report.score} at coverage ${report.coverage} ` +
        `(a score of what was measurable, not of the whole index)`,
    );
  }
  for (const result of report.components) {
    if (result.status === "na") {
      lines.push(
        `  ${result.component} ${result.label}: N/A (weight ${result.weight}) — ${result.reason}`,
      );
    } else {
      lines.push(
        `  ${result.component} ${result.label}: ${result.numerator}/${result.denominator} = ` +
          `${result.ratio} (weight ${result.weight})`,
      );
    }
  }
  lines.push(
    `  latency: p50 ${report.latency.p50Ms ?? "N/A"}ms, p95 ${report.latency.p95Ms ?? "N/A"}ms ` +
      `over ${report.latency.samples} samples`,
  );
  lines.push(
    `  gauges: backlog ${report.gauges.backlog}, dead letters ${report.gauges.deadLetters}, ` +
      `awaiting ack ${report.gauges.awaitingAck}, lease conflicts ${report.gauges.leaseConflicts}, ` +
      `needs manual ${report.gauges.needsManual}, oldest due ${report.gauges.oldestDueAgeMs}ms`,
  );
  if (report.failures.length > 0) {
    lines.push(`  failures (worst severity ${report.worstSeverity ?? "unknown"}):`);
    for (const failure of report.failures) {
      lines.push(`    ${failure.component} ${failure.label}`);
    }
  }
  return lines.join("\n");
}

/**
 * LUMINA-001: whether a superadditive-learning claim may be made yet.
 *
 * The hypothesis is `A = C_tripartita - sum(C_i)`: that three agents together
 * learn more than the sum of the three alone. The order is explicit that it is
 * **unvalidated**, and that no amount of mesh traffic validates it. This
 * function exists so the claim has a single gate, and so a dashboard cannot
 * drift into asserting it.
 *
 * It returns `"unvalidated"` unless all three controls are present, and it has
 * no path that returns a numeric advantage. Measuring A is a separate,
 * deliberate experiment, not a side effect of running the mesh.
 */
export function assessSuperadditiveClaim(controls: {
  /** Each of the three agents measured alone, on the same task set. */
  readonly individualBaselines: number;
  /** Compute, time and tool access held equal between conditions. */
  readonly equivalentResources: boolean;
  /** Outcomes scored by a reviewer blind to the condition. */
  readonly blindReview: boolean;
}): {
  readonly status: "unvalidated";
  readonly missing: readonly string[];
  readonly note: string;
} {
  const missing: string[] = [];
  if (controls.individualBaselines < 3) {
    missing.push(
      `three individual baselines are required, ${controls.individualBaselines} provided`,
    );
  }
  if (!controls.equivalentResources) {
    missing.push("equivalent resources between conditions are not established");
  }
  if (!controls.blindReview) {
    missing.push("blind adversarial review of the outcomes is not established");
  }
  return {
    status: "unvalidated",
    missing,
    note:
      missing.length === 0
        ? "the controls are in place; A must still be measured by a dedicated experiment, and this function never reports a value"
        : "LUMINA-001 stays unvalidated: no superadditive learning may be claimed",
  };
}
