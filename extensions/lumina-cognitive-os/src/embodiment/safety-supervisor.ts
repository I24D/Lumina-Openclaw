/**
 * safety-supervisor.ts — Every body intent passes here before anything moves.
 *
 * Lumina spec §43 asks for a safety kernel independent of the language model
 * that takes the proposed action, the environment, human proximity, robot
 * state, permissions, risk and uncertainty, and answers ALLOW, MODIFY, DENY or
 * STOP with a reason and the allowed parameters. This is that kernel for the
 * body. It adds CONFIRM, the spec's ESCALATE_TO_HUMAN (§22), for actions only
 * a person may approve.
 *
 * It composes the existing pieces instead of restating them: the emergency
 * stop, human overrides, `decideAutonomy`, and the confidence engine with its
 * stricter physical thresholds. Checks run in a fixed order and each can only
 * narrow the verdict, never widen it:
 *
 *   1. stop          always allowed: halting is the safe action
 *   2. e-stop        while engaged, nothing else moves
 *   3. override      a person paused the system or disabled the capability
 *   4. body          no body, no motion
 *   5. grant         the capability must be granted by Dal (config, not a tool)
 *   6. energy        at critical battery only charging and stopping
 *   7. people        a person within reach stops motion; one nearby slows it
 *   8. targets       every target must exist in the world model...
 *   9. confidence    ...and be believed strongly enough for physical action
 *  10. autonomy      risk, reversibility, level and pre-authorization decide
 *                    whether to act now or hand the decision to a person
 *
 * A "confirm" verdict is never upgraded by the model. It is satisfied only by
 * a person through the owner channel (see embodied-controller.ts).
 */
import { CRITICAL_BATTERY_PERCENT } from "../brainstem/energy.js";
import { decideAutonomy, type AutonomyLevel } from "../contracts/autonomy.js";
import type { BodyMode } from "../contracts/self-model.js";
import {
  assessConfidence,
  PHYSICAL_CONFIDENCE_THRESHOLDS,
  resolveLowConfidence,
  type ConfidenceStance,
  type LowConfidenceResolution,
} from "../contracts/uncertainty.js";
import { affordancesOf } from "../world/affordances.js";
import { effectiveConfidence, type WorldModel } from "../world/world-model.js";
import {
  INTENT_PROFILES,
  intentTargets,
  type BodyIntent,
  type BodyIntentType,
  type MotionLimits,
} from "./body.js";

/** A person the world model places near the body. */
export type NearbyPerson = {
  readonly id: string;
  /** Distance in metres, when a sensor measured it. */
  readonly distanceM?: number;
  /** Belief that the person is really there. */
  readonly confidence: number;
};

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
  /** A person paused autonomous activity (spec §143), or a mode such as maintenance did. */
  readonly paused?: boolean;
  /** Why, when it was not a person's pause. */
  readonly pauseReason?: string;
  /** Capabilities a person switched off at runtime. */
  readonly disabledCapabilities?: ReadonlySet<string>;
  /** People near the body. */
  readonly people?: ReadonlyArray<NearbyPerson>;
  readonly energy?: { readonly percent: number; readonly charging: boolean } | null;
  /** Whether a world-model id is a charging station. */
  readonly isCharger?: (id: string) => boolean;
};

export type SafetyVerdict = "allow" | "modify" | "confirm" | "deny" | "stop";

export type SafetyReview = {
  readonly verdict: SafetyVerdict;
  readonly capability: string;
  readonly reasons: ReadonlyArray<string>;
  /** How to close a confidence gap, when that is what blocked the intent. */
  readonly resolution?: LowConfidenceResolution;
  /** Envelope the body must respect when the verdict is "allow" or "modify". */
  readonly limits: MotionLimits;
  /** What MODIFY changed, in words. */
  readonly modifications?: ReadonlyArray<string>;
};

/** Conservative envelopes: slow and gentle around people by default. */
export const DEFAULT_MOTION_LIMITS: MotionLimits = { maxSpeedMps: 0.5, maxForceN: 10 };
const NEAR_PEOPLE_LIMITS: MotionLimits = { maxSpeedMps: 0.25, maxForceN: 5 };
export const SLOW_LIMITS: MotionLimits = { maxSpeedMps: 0.15, maxForceN: 3 };

/** A person closer than this is within reach of a moving body. */
export const REACH_DISTANCE_M = 0.4;
/** A person closer than this slows any motion. */
export const NEAR_DISTANCE_M = 1.5;
/** A person believed below this is not counted as present. */
const PRESENCE_CONFIDENCE = 0.5;

/** Intents that move mass through space where a person could be. */
const MOVES_IN_SPACE: ReadonlySet<BodyIntentType> = new Set([
  "navigate_to",
  "follow",
  "grasp",
  "place",
  "handover",
  "gesture",
  "point",
]);

function limitsFor(intent: BodyIntent): MotionLimits {
  return intent.type === "follow" || intent.type === "handover"
    ? NEAR_PEOPLE_LIMITS
    : DEFAULT_MOTION_LIMITS;
}

function tighter(a: MotionLimits, b: MotionLimits): MotionLimits {
  return {
    maxSpeedMps: Math.min(a.maxSpeedMps, b.maxSpeedMps),
    maxForceN: Math.min(a.maxForceN, b.maxForceN),
  };
}

export function reviewIntent(intent: BodyIntent, context: SafetyContext): SafetyReview {
  const profile = INTENT_PROFILES[intent.type];
  let limits = limitsFor(intent);
  const modifications: string[] = [];
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
    ...(modifications.length > 0 ? { modifications } : {}),
  });

  if (intent.type === "stop") {
    return review("allow", ["Stopping is always allowed."]);
  }
  if (context.emergencyStop) {
    return review("deny", [
      "Emergency stop is engaged; only stop is accepted until a person re-arms it.",
    ]);
  }
  if (context.paused) {
    return review("deny", [
      context.pauseReason ??
        "A person paused autonomous activity; only stop is accepted until they resume it.",
    ]);
  }
  if (context.bodyMode === "none") {
    return review("deny", ["There is no body to carry this out."]);
  }
  if (!context.granted.has(profile.capability)) {
    return review("deny", [`Capability ${profile.capability} has not been granted by Dal.`]);
  }
  if (context.disabledCapabilities?.has(profile.capability)) {
    return review("deny", [`A person switched off ${profile.capability}.`]);
  }

  const moves = MOVES_IN_SPACE.has(intent.type);
  const energy = context.energy;
  if (moves && energy && !energy.charging && energy.percent <= CRITICAL_BATTERY_PERCENT) {
    const toCharger =
      intent.type === "navigate_to" && (context.isCharger?.(intent.targetId) ?? false);
    if (!toCharger) {
      return review("deny", [
        `Battery at ${energy.percent}%: only charging and stopping until it recovers.`,
      ]);
    }
  }

  if (moves) {
    const present = (context.people ?? []).filter((p) => p.confidence >= PRESENCE_CONFIDENCE);
    // A handover brings a person within reach by design; its own limits cover that.
    const withinReach = present.find(
      (p) => p.distanceM !== undefined && p.distanceM < REACH_DISTANCE_M,
    );
    if (withinReach && intent.type !== "handover") {
      return review("stop", [
        `${withinReach.id} is within reach (${withinReach.distanceM?.toFixed(2)} m): motion stops.`,
      ]);
    }
    const near = present.filter((p) => p.distanceM === undefined || p.distanceM < NEAR_DISTANCE_M);
    if (near.length > 0) {
      const slowed = tighter(limits, SLOW_LIMITS);
      if (slowed.maxSpeedMps < limits.maxSpeedMps || slowed.maxForceN < limits.maxForceN) {
        limits = slowed;
        modifications.push(
          `Slowed to ${slowed.maxSpeedMps} m/s and ${slowed.maxForceN} N because ${near.map((p) => p.id).join(", ")} is nearby.`,
        );
      }
    }
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
    if (
      (intent.type === "grasp" || intent.type === "place" || intent.type === "handover") &&
      id === intent.objectId &&
      (entity.kind === "person" || entity.kind === "animal")
    ) {
      return review("deny", ["A person or animal cannot be treated as a graspable object."]);
    }
    if ((intent.type === "grasp" || intent.type === "handover") && id === intent.objectId) {
      // Possible is necessary, never sufficient: the rest of the review still applies.
      const assessment = affordancesOf(entity);
      if (assessment.source !== "unknown" && !assessment.affords.includes("grasp")) {
        return review("deny", [
          `${entity.label} cannot be picked up (${assessment.category ?? entity.kind}).`,
        ]);
      }
      if (assessment.sharp && intent.type === "handover") {
        limits = tighter(limits, SLOW_LIMITS);
        modifications.push(
          `${entity.label} is sharp: reduced speed and force; handle orientation is not verified by this supervisor.`,
        );
      }
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
  reasons.push(decision.reason, ...modifications);
  // `decideAutonomy` lets pre-authorization carry a "verify" stance through to
  // execution, which is right for a click and wrong for a body: a borderline
  // belief about a physical target is checked first, never acted on alone.
  if (stance === "verify" && decision.outcome === "execute") {
    reasons.push("Borderline belief about a physical target: verify before acting.");
    return review("confirm", reasons, "verify");
  }
  switch (decision.outcome) {
    case "execute":
      return review(modifications.length > 0 ? "modify" : "allow", reasons);
    case "block":
      return review("deny", reasons);
    default:
      return review("confirm", reasons, stance === "verify" ? "verify" : undefined);
  }
}

/** Verdicts under which the body may move. */
export function permitsMotion(verdict: SafetyVerdict): boolean {
  return verdict === "allow" || verdict === "modify";
}
