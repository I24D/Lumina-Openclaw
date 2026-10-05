/**
 * Stable autonomy contract and pure governor.
 *
 * Dal's 2026-10-05 operating model maps routine SAFE work to Green,
 * WARNING work to Yellow (act and surface a notice), and HIGH_RISK/CRITICAL
 * work to Red (a person decides). Physical safety remains an independent,
 * stricter supervisor.
 */
import type { ConfidenceStance } from "./uncertainty.js";

export type AutonomyRiskTier = "SAFE" | "WARNING" | "HIGH_RISK" | "CRITICAL";
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const AUTONOMY_LEVELS: ReadonlyArray<{
  readonly level: AutonomyLevel;
  readonly id: string;
  readonly summary: string;
}> = [
  { level: 0, id: "chat", summary: "Conversation only; no tools." },
  { level: 1, id: "tools", summary: "Runs tools when asked, one step at a time." },
  { level: 2, id: "delegated", summary: "Carries out a delegated multi-step task on request." },
  { level: 3, id: "proactive", summary: "Notices events and proposes actions." },
  { level: 4, id: "bounded", summary: "Acts alone inside bounded, reversible territory." },
  { level: 5, id: "persistent", summary: "Runs continuously within standing permissions." },
];

export type AutonomyOutcome = "execute" | "propose" | "confirm" | "block";

export type AutonomyRequest = {
  readonly level: AutonomyLevel;
  readonly stance: ConfidenceStance;
  readonly riskTier: AutonomyRiskTier;
  readonly reversible: boolean;
  readonly preAuthorized?: boolean;
  readonly action?: string;
};

export type AutonomyDecision = {
  readonly outcome: AutonomyOutcome;
  readonly reason: string;
  readonly level: AutonomyLevel;
};

function riskCeiling(tier: AutonomyRiskTier): AutonomyOutcome {
  switch (tier) {
    case "CRITICAL":
    case "HIGH_RISK":
      return "confirm";
    case "WARNING":
    case "SAFE":
      return "execute";
    default:
      return "confirm";
  }
}

const ORDER: Record<AutonomyOutcome, number> = {
  block: 0,
  confirm: 1,
  propose: 2,
  execute: 3,
};

function narrower(a: AutonomyOutcome, b: AutonomyOutcome): AutonomyOutcome {
  return ORDER[a] <= ORDER[b] ? a : b;
}

function levelCeiling(level: AutonomyLevel): AutonomyOutcome {
  if (level <= 0) {
    return "block";
  }
  if (level <= 2) {
    return "confirm";
  }
  if (level === 3) {
    return "propose";
  }
  return "execute";
}

function stanceCeiling(stance: ConfidenceStance): AutonomyOutcome {
  switch (stance) {
    case "act":
      return "execute";
    case "verify":
      return "propose";
    default:
      return "confirm";
  }
}

export function decideAutonomy(request: AutonomyRequest): AutonomyDecision {
  const label = request.action?.trim() || "action";

  let outcome = riskCeiling(request.riskTier);
  let driver = `risk ${request.riskTier}`;

  const byLevel = levelCeiling(request.level);
  if (ORDER[byLevel] < ORDER[outcome]) {
    outcome = byLevel;
    driver = `autonomy L${request.level}`;
  }

  const byStance = stanceCeiling(request.stance);
  if (ORDER[byStance] < ORDER[outcome]) {
    outcome = byStance;
    driver = `confidence "${request.stance}"`;
  }

  if (!request.reversible) {
    const capped = narrower(outcome, "confirm");
    if (capped !== outcome) {
      outcome = capped;
      driver = "irreversible effect";
    }
  }

  if (
    request.preAuthorized === true &&
    request.reversible &&
    request.riskTier !== "CRITICAL" &&
    request.riskTier !== "HIGH_RISK" &&
    request.level >= 4 &&
    request.stance !== "ask"
  ) {
    return {
      outcome: "execute",
      level: request.level,
      reason: `${label}: pre-authorized reversible ${request.riskTier} action at L${request.level} -> execute`,
    };
  }

  return {
    outcome,
    level: request.level,
    reason: `${label}: ${outcome} (narrowed by ${driver})`,
  };
}
