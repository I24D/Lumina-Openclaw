/**
 * uncertainty.ts — Confidence Engine.
 *
 * Turns a belief about "how sure am I?" into one of three stances the rest of
 * the cognitive layer must obey:
 *
 *   confidence > 0.90          -> "act"     (autonomous, still subject to risk/governance)
 *   0.70 <= confidence <= 0.90 -> "verify"  (act only after a cheap confirming check)
 *   confidence < 0.70          -> "ask"     (hand the decision back to Dal)
 *
 * The thresholds are deliberately data, not magic numbers sprinkled around the
 * codebase: every caller reads them from here so a single edit re-tunes the
 * whole system.
 *
 * This module is pure — no I/O, no clock, no bus — so it stays trivially
 * testable and can be called from any layer.
 */

/** What the cognitive layer is allowed to do at a given confidence. */
export type ConfidenceStance = "act" | "verify" | "ask";

/** Tunable cut-points. `act` is exclusive (> act), `verify` is inclusive (>= verify). */
export type ConfidenceThresholds = {
  readonly act: number;
  readonly verify: number;
};

/** Defaults from the Cognitive Core spec. */
export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  act: 0.9,
  verify: 0.7,
};

/** One named contribution to an overall confidence score. */
export type ConfidenceSignal = {
  /** Short identifier, e.g. "memory.hit" or "model.selfReport". */
  readonly source: string;
  /** Signal value in [0,1]; values outside are clamped. */
  readonly value: number;
  /** Relative weight; non-finite or negative weights are ignored. */
  readonly weight?: number;
};

export type ConfidenceAssessment = {
  readonly confidence: number;
  readonly stance: ConfidenceStance;
  /** Human-readable justification, safe to surface to Dal or to a log. */
  readonly rationale: string;
  readonly thresholds: ConfidenceThresholds;
  readonly signals: ReadonlyArray<ConfidenceSignal>;
};

/** Clamp any number into [0,1]; non-finite input collapses to 0. */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Normalize thresholds so `verify` never exceeds `act`. */
export function normalizeThresholds(
  thresholds: Partial<ConfidenceThresholds> | undefined,
): ConfidenceThresholds {
  const act = clampConfidence(thresholds?.act ?? DEFAULT_CONFIDENCE_THRESHOLDS.act);
  const rawVerify = clampConfidence(thresholds?.verify ?? DEFAULT_CONFIDENCE_THRESHOLDS.verify);
  return { act, verify: Math.min(rawVerify, act) };
}

/** Map a bare confidence value onto a stance. */
export function stanceFor(
  confidence: number,
  thresholds: Partial<ConfidenceThresholds> = DEFAULT_CONFIDENCE_THRESHOLDS,
): ConfidenceStance {
  const t = normalizeThresholds(thresholds);
  const c = clampConfidence(confidence);
  if (c > t.act) {
    return "act";
  }
  if (c >= t.verify) {
    return "verify";
  }
  return "ask";
}

/**
 * Combine weighted signals into one confidence value.
 *
 * With no usable signals the result is 0 -> stance "ask", which is the safe
 * default: absence of evidence must never read as confidence.
 */
export function combineSignals(signals: ReadonlyArray<ConfidenceSignal>): number {
  let weighted = 0;
  let total = 0;
  for (const s of signals) {
    const weight = s.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    weighted += clampConfidence(s.value) * weight;
    total += weight;
  }
  return total > 0 ? clampConfidence(weighted / total) : 0;
}

/** Full assessment: combine signals, pick a stance, explain the outcome. */
export function assessConfidence(params: {
  readonly signals: ReadonlyArray<ConfidenceSignal>;
  readonly thresholds?: Partial<ConfidenceThresholds>;
  readonly subject?: string;
}): ConfidenceAssessment {
  const thresholds = normalizeThresholds(params.thresholds);
  const usable = params.signals.filter(
    (s) => Number.isFinite(s.weight ?? 1) && (s.weight ?? 1) > 0,
  );
  const confidence = combineSignals(usable);
  const stance = stanceFor(confidence, thresholds);
  const subject = params.subject?.trim() || "decision";
  const pct = (confidence * 100).toFixed(0);
  const detail =
    usable.length === 0
      ? "no usable signals"
      : usable.map((s) => `${s.source}=${clampConfidence(s.value).toFixed(2)}`).join(", ");
  const verb =
    stance === "act"
      ? "acting autonomously"
      : stance === "verify"
        ? "verifying before acting"
        : "asking Dal";
  return {
    confidence,
    stance,
    thresholds,
    signals: usable,
    rationale: `${subject}: confidence ${pct}% (${detail}) -> ${verb}`,
  };
}
