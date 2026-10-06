/**
 * The evaluation suite is also a regression test: every scenario must pass.
 */
import { describe, expect, it } from "vitest";
import { EVAL_SUITES, runM3ganEvaluation } from "./m3gan-eval.js";

describe("M3GAN evaluation", () => {
  it("passes every scenario in every suite", async () => {
    const report = await runM3ganEvaluation(Date.parse("2026-10-05T20:00:00.000Z"));
    const failures = report.results.filter((r) => !r.passed);
    expect(failures).toEqual([]);
    for (const suite of EVAL_SUITES) {
      expect(report.scores[suite].total).toBeGreaterThan(0);
    }
  }, 60_000);
});
