/**
 * safety-supervisor.ts — Every body intent passes here before anything moves.
 *
 * M3GAN spec §23 places a safety controller between the planners and the
 * motors; §20 forbids a model from granting itself permissions; §18 forbids
 * turning uncertain inferences into important physical actions. This module
 * enforces all three, and composes the existing pieces instead of restating
 * them: the emergency stop, `decideAutonomy`, and the confidence engine with
 * its stricter physical thresholds.
 *
 * Checks run in a fixed order and each can only narrow the verdict:
 *
 *   1. stop          always allowed: halting is the safe action
 *   2. e-stop        while engaged, nothing else moves
 *   3. body          no body, no motion
 *   4. grant         the capability must be granted by Dal (config, not a tool)
 *   5. targets       every target must exist in the world model...
 *   6. confidence    ...and be believed strongly enough for physical action
 *   7. autonomy      risk, reversibility, level and pre-authorization decide
 *                    whether to act now or hand the decision to Dal
 *
 * A "confirm" verdict is never upgraded by the model. Physical confirmation
 * needs a channel the model cannot forge (a button on the body, Dal's device);
 * until one exists, Dal widens autonomy through the level and the
 * pre-authorized capabilities in the plugin config.
 */
import { decideAutonomy, type AutonomyLevel } from "../cognition/autonomy-levels.js";
import type { BodyMode } from "../cognition/self/self-model.js";
import {
  assessConfidence,
  PHYSICAL_CONFIDENCE_THRESHOLDS,
  resolveLowConfidence,
  type ConfidenceStance,
  type LowConfidenceResolution,
} from "../cognition/uncertainty.js";
import { effectiveConfidence, type WorldModel } from "../world/world-model.js";
import { INTENT_PROFILES, intentTargets, type BodyIntent, type MotionLimits } from "./body.js";

export type SafetyContext = {
  readonly autonomyLevel: AutonomyLevel;
  readonly bodyMode: BodyMode;
  /** Capabilities Dal granted. Never writable by the model. */
  readonly granted: ReadonlySet<string>;
  /** Capabilities Dal lets run without asking (reversible, low risk only). */
  readonly preAuthorized: ReadonlySet<string>;
  readonly emergencyStop: boolean;
  readonly world?: WorldModel;
  /** A sensor can look again to raise confidence. */
  readonly canObserve: boolean;
  /** Someone is around to answer a question. */
  readonly canAsk: boolean;
  readonly nowMs: number;
};

export type SafetyVerdict = "allow" | "confirm" | "deny";

export type SafetyReview = {
  readonly verdict: SafetyVerdict;
  readonly capability: string;
  readonly reasons: ReadonlyArray<string>;
  /** How to close a confidence gap, when that is what blocked the intent. */
  readonly resolution?: LowConfidenceResolution;
  /** Envelope the body must respect when the verdict is "allow". */
  readonly limits: MotionLimits;
};

/** Conservative envelopes: slow and gentle around people by default. */
export const DEFAULT_MOTION_LIMITS: MotionLimits = { maxSpeedMps: 0.5, maxForceN: 10 };
const NEAR_PEOPLE_LIMITS: MotionLimits = { maxSpeedMps: 0.25, maxForceN: 5 };

function limitsFor(intent: BodyIntent): MotionLimits {
  return intent.type === "follow" || intent.type === "handover"
    ? NEAR_PEOPLE_LIMITS
    : DEFAULT_MOTION_LIMITS;
}

export function reviewIntent(intent: BodyIntent, context: SafetyContext): SafetyReview {
  const profile = INTENT_PROFILES[intent.type];
  const limits = limitsFor(intent);
  const review = (
    verdict: SafetyVerdict,
    reasons: string[],
    resolution?: LowConfidenceResolution,
  ): SafetyReview => ({
    verdict,
    capability: profile.capability,
    reasons,
    limits,
    ...(resolution ? { resolution } : {}),
  });

  if (intent.type === "stop") {
    return review("allow", ["Stopping is always allowed."]);
  }
  if (context.emergencyStop) {
    return review("deny", [
      "Emergency stop is engaged; only stop is accepted until Dal re-arms it.",
    ]);
  }
  if (context.bodyMode === "none") {
    return review("deny", ["There is no body to carry this out."]);
  }
  if (!context.granted.has(profile.capability)) {
    return review("deny", [`Capability ${profile.capability} has not been granted by Dal.`]);
  }

  // Targets: an intent about something the world model has never seen is a guess.
  let stance: ConfidenceStance = "act";
  const reasons: string[] = [];
  for (const id of intentTargets(intent)) {
    const entity = context.world?.get(id);
    if (!entity) {
      const resolution = resolveLowConfidence({
        stance: "ask",
        canObserve: context.canObserve,
        canAsk: context.canAsk,
      });
      return review("deny", [`Target ${id} is not in the world model.`], resolution);
    }
    if (!profile.needsConfidentTarget) {
      continue;
    }
    const assessment = assessConfidence({
      signals: [{ source: `world.${id}`, value: effectiveConfidence(entity, context.nowMs) }],
      thresholds: PHYSICAL_CONFIDENCE_THRESHOLDS,
      subject: `${intent.type} ${entity.label}`,
    });
    reasons.push(assessment.rationale);
    if (assessment.stance === "ask") {
      const resolution = resolveLowConfidence({
        stance: "ask",
        canObserve: context.canObserve,
        canAsk: context.canAsk,
      });
      return review(
        "deny",
        [...reasons, `Belief about ${entity.label} is too uncertain for physical action.`],
        resolution,
      );
    }
    if (assessment.stance === "verify") {
      stance = "verify";
    }
  }

  const decision = decideAutonomy({
    level: context.autonomyLevel,
    stance,
    riskTier: profile.riskTier,
    reversible: profile.reversible,
    preAuthorized: context.preAuthorized.has(profile.capability),
    action: intent.type,
  });
  reasons.push(decision.reason);
  // `decideAutonomy` lets pre-authorization carry a "verify" stance through to
  // execution, which is right for a click and wrong for a body: a borderline
  // belief about a physical target is checked first, never acted on alone.
  if (stance === "verify" && decision.outcome === "execute") {
    reasons.push("Borderline belief about a physical target: verify before acting.");
    return review("confirm", reasons, "verify");
  }
  switch (decision.outcome) {
    case "execute":
      return review("allow", reasons);
    case "block":
      return review("deny", reasons);
    default:
      return review("confirm", reasons, stance === "verify" ? "verify" : undefined);
  }
}
