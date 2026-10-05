/**
 * predict.ts — Think before moving: what an intent would likely do.
 *
 * M3GAN spec §16: before an important action, predict(action, world_state)
 * returns the expected outcome, possible failures, uncertainty and risk. This
 * is the symbolic version: it reads the world model and the safety review the
 * supervisor would give right now, and lists the failure modes each kind of
 * intent is known for. A physics simulator (MuJoCo, Isaac Sim, Gazebo) plugs
 * in later behind the same shape.
 */
import type { RiskTier } from "../risk/policies.js";
import { effectiveConfidence, STALE_BELOW, type WorldModel } from "../world/world-model.js";
import { INTENT_PROFILES, intentTargets, type BodyIntent } from "./body.js";
import type { SafetyReview, SafetyVerdict } from "./safety-supervisor.js";

export type Prediction = {
  readonly intent: BodyIntent;
  readonly expectedOutcome: string;
  readonly possibleFailures: ReadonlyArray<string>;
  /** 1 minus the weakest belief the intent depends on, in [0,1]. */
  readonly uncertainty: number;
  readonly risk: RiskTier;
  /** What the safety supervisor would decide right now. */
  readonly verdict: SafetyVerdict;
  readonly simulated: "symbolic";
};

const KNOWN_FAILURES: Readonly<Record<BodyIntent["type"], ReadonlyArray<string>>> = {
  stop: [],
  look_at: ["the target is out of view or occluded"],
  gesture: ["someone steps into the gesture's reach"],
  point: ["the target is out of view", "the person misreads what is pointed at"],
  navigate_to: ["the path is blocked", "the map is out of date", "a person walks into the path"],
  follow: ["the person is lost from view", "the person moves faster than the speed limit allows"],
  grasp: [
    "the object is not where it is believed to be",
    "the object slips",
    "a similar object is taken instead",
  ],
  place: ["the surface is occupied or unstable", "the object is released too early"],
  handover: ["the person is not ready to take it", "the object is dropped during release"],
};

function describe(intent: BodyIntent, label: (id: string) => string): string {
  switch (intent.type) {
    case "stop":
      return "All motion halts.";
    case "look_at":
      return `The head turns toward ${label(intent.targetId)}.`;
    case "gesture":
      return `The body performs the "${intent.name}" gesture.`;
    case "point":
      return `The body points at ${label(intent.targetId)}.`;
    case "navigate_to":
      return `The body arrives at ${label(intent.targetId)}.`;
    case "follow":
      return `The body keeps a safe distance behind ${label(intent.personId)}.`;
    case "grasp":
      return `${label(intent.objectId)} is held.`;
    case "place":
      return `${label(intent.objectId)} rests on ${label(intent.onId)}.`;
    case "handover":
      return `${label(intent.personId)} holds ${label(intent.objectId)}.`;
    default:
      return "Unknown intent.";
  }
}

export function predict(
  intent: BodyIntent,
  context: { readonly review: SafetyReview; readonly world?: WorldModel; readonly nowMs: number },
): Prediction {
  const label = (id: string) => context.world?.get(id)?.label ?? id;
  const failures = [...KNOWN_FAILURES[intent.type]];
  let weakest = 1;
  for (const id of intentTargets(intent)) {
    const entity = context.world?.get(id);
    if (!entity) {
      weakest = 0;
      failures.unshift(`${id} is not in the world model at all`);
      continue;
    }
    const confidence = effectiveConfidence(entity, context.nowMs);
    weakest = Math.min(weakest, confidence);
    if (confidence < STALE_BELOW) {
      failures.unshift(
        `the belief about ${entity.label} is stale (${confidence.toFixed(2)}): look again first`,
      );
    }
  }
  if (context.review.verdict !== "allow" && context.review.verdict !== "modify") {
    failures.unshift(
      `safety would ${context.review.verdict}: ${context.review.reasons[0] ?? ""}`.trim(),
    );
  }
  return {
    intent,
    expectedOutcome: describe(intent, label),
    possibleFailures: failures,
    uncertainty: Number((1 - weakest).toFixed(3)),
    risk: INTENT_PROFILES[intent.type].riskTier,
    verdict: context.review.verdict,
    simulated: "symbolic",
  };
}
