/**
 * Stable confidence/uncertainty contract and pure policy functions.
 *
 * It deliberately has no I/O and no dependency on cognition implementations.
 */
export type ConfidenceStance = "act" | "verify" | "ask";

export type ConfidenceThresholds = {
  readonly act: number;
  readonly verify: number;
};

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  act: 0.9,
  verify: 0.7,
};

export const PHYSICAL_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  act: 0.95,
  verify: 0.85,
};

export type ConfidenceSignal = {
  readonly source: string;
  readonly value: number;
  readonly weight?: number;
};

export type ConfidenceAssessment = {
  readonly confidence: number;
  readonly stance: ConfidenceStance;
  readonly rationale: string;
  readonly thresholds: ConfidenceThresholds;
  readonly signals: ReadonlyArray<ConfidenceSignal>;
};

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function normalizeThresholds(
  thresholds: Partial<ConfidenceThresholds> | undefined,
): ConfidenceThresholds {
  const act = clampConfidence(thresholds?.act ?? DEFAULT_CONFIDENCE_THRESHOLDS.act);
  const rawVerify = clampConfidence(thresholds?.verify ?? DEFAULT_CONFIDENCE_THRESHOLDS.verify);
  return { act, verify: Math.min(rawVerify, act) };
}

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

export type LowConfidenceResolution = "verify" | "observe_more" | "ask" | "abstain";

export type LowConfidenceContext = {
  readonly stance: ConfidenceStance;
  readonly canObserve: boolean;
  readonly canAsk: boolean;
};

export function resolveLowConfidence(
  context: LowConfidenceContext,
): LowConfidenceResolution | undefined {
  if (context.stance === "act") {
    return undefined;
  }
  if (context.stance === "verify") {
    return "verify";
  }
  if (context.canObserve) {
    return "observe_more";
  }
  return context.canAsk ? "ask" : "abstain";
}

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
