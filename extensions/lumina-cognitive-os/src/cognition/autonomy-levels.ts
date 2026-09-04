/**
 * autonomy-levels.ts — Levels L0..L5 and the gate that turns a proposed action
 * into one of: execute / propose / confirm / block.
 *
 * The plugin already owns *what is risky* (`risk/policies.ts` -> RiskTier) and
 * *what is permitted* (`governance/governance-policy.ts` -> GovernanceEngine).
 * This module owns the third axis the spec asks for: *how much initiative
 * Lumina may take* at all, and it composes the other two rather than
 * re-implementing them.
 *
 * Precedence is fixed and deliberate (spec rule 9):
 *
 *   safety  >  authorization  >  user goals  >  task goals
 *
 * So a CRITICAL action is never autonomous, at any level, at any confidence.
 * There is no "protect Dal at all costs" short-circuit (spec rule 10): the
 * escape hatch is always to hand the decision back, never to act harder.
 */

import type { RiskTier } from "../risk/policies.js";
import type { ConfidenceStance } from "./uncertainty.js";

/** Initiative ladder. Higher means more may happen without a prompt. */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const AUTONOMY_LEVELS: ReadonlyArray<{
  readonly level: AutonomyLevel;
  readonly id: string;
  readonly summary: string;
}> = [
  { level: 0, id: "chat", summary: "Conversation only; no tools." },
  { level: 1, id: "tools", summary: "Runs tools when asked, one step at a time." },
  { level: 2, id: "delegated", summary: "Carries out a delegated multi-step task on request." },
  { level: 3, id: "proactive", summary: "Notices events and proposes actions; still asks first." },
  { level: 4, id: "bounded", summary: "Acts alone inside pre-authorized, reversible territory." },
  { level: 5, id: "persistent", summary: "Runs continuously within standing permissions." },
];

/** What the governor concluded. */
export type AutonomyOutcome =
  /** Do it now, no prompt. */
  | "execute"
  /** Surface a suggestion Dal can accept; do nothing yet. */
  | "propose"
  /** Ask for an explicit yes before doing it. */
  | "confirm"
  /** Refuse at this level; not offered. */
  | "block";

export type AutonomyRequest = {
  readonly level: AutonomyLevel;
  readonly stance: ConfidenceStance;
  readonly riskTier: RiskTier;
  /** Can the effect be undone cheaply? Irreversible work never runs unattended. */
  readonly reversible: boolean;
  /** Dal has standing approval for exactly this kind of action. */
  readonly preAuthorized?: boolean;
  /** Short description used in the explanation. */
  readonly action?: string;
};

export type AutonomyDecision = {
  readonly outcome: AutonomyOutcome;
  readonly reason: string;
  readonly level: AutonomyLevel;
};

/** CRITICAL is never delegable; HIGH_RISK needs a human unless pre-authorized. */
function riskCeiling(tier: RiskTier): AutonomyOutcome {
  switch (tier) {
    case "CRITICAL":
      return "confirm";
    case "HIGH_RISK":
      return "confirm";
    case "WARNING":
      return "propose";
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

/** Pick the more conservative of two outcomes. */
function narrower(a: AutonomyOutcome, b: AutonomyOutcome): AutonomyOutcome {
  return ORDER[a] <= ORDER[b] ? a : b;
}

/** The most initiative a given level is ever allowed to take. */
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

/** Confidence stance mapped onto initiative. */
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

/**
 * Compose risk, authorization, level and confidence into one decision.
 *
 * Every axis can only ever *narrow* the outcome, so adding a constraint can
 * never make Lumina bolder — which is the property that makes this safe to
 * extend later.
 */
export function decideAutonomy(request: AutonomyRequest): AutonomyDecision {
  const label = request.action?.trim() || "action";

  // Safety first: a CRITICAL action is off the table for autonomous execution
  // no matter how confident we are or how high the level is.
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

  // Irreversible work is never done unattended, even when everything else says go.
  if (!request.reversible) {
    const capped = narrower(outcome, "confirm");
    if (capped !== outcome) {
      outcome = capped;
      driver = "irreversible effect";
    }
  }

  // Standing authorization can restore execution, but only for reversible work
  // that safety already cleared. It never overrides CRITICAL or irreversibility.
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
