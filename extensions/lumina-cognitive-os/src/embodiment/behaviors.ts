/**
 * behaviors.ts — Reusable behaviors composed from body intents.
 *
 * M3GAN spec §34: follow_person, come_here, wait, look_at, find_object,
 * bring_object, charge, greet_person... A behavior is only a plan of intents;
 * it gains no authority by being a behavior. Every intent still goes through
 * the embodied controller and its safety supervisor, one at a time, and the
 * run stops at the first intent that is not carried out (refused, stopped, or
 * waiting for a person's confirmation), so a behavior can never push past a
 * "no".
 *
 * bring_object follows the handover protocol of spec §120: approach, present,
 * detect the grasp, release gradually, verify. Approach is a navigate_to; the
 * other four are the contract of the `handover` intent, which a body adapter
 * must implement (the simulated body does so symbolically).
 */
import type { WorldModel } from "../world/world-model.js";
import type { BodyIntent } from "./body.js";
import type { EmbodiedController, EmbodiedResult } from "./embodied-controller.js";

export const BEHAVIOR_NAMES = [
  "look_at",
  "come_here",
  "follow_person",
  "find_object",
  "bring_object",
  "greet_person",
  "charge",
  "wait",
  "stop",
] as const;
export type BehaviorName = (typeof BEHAVIOR_NAMES)[number];

/** Steps a body adapter performs inside a `handover` intent (spec §120). */
export const HANDOVER_PROTOCOL = Object.freeze([
  "approach",
  "present",
  "detect_grasp",
  "release_gradually",
  "verify",
] as const);

export type BehaviorArgs = {
  readonly targetId?: string;
  readonly personId?: string;
  readonly objectId?: string;
  /** For find_object: the object's name when its id is unknown. */
  readonly label?: string;
};

export type BehaviorPlan = {
  readonly name: BehaviorName;
  readonly steps: ReadonlyArray<{ readonly intent: BodyIntent; readonly why: string }>;
};

export type BehaviorPlanResult =
  | { readonly ok: true; readonly plan: BehaviorPlan }
  | { readonly ok: false; readonly reason: string; readonly resolution?: "observe_more" | "ask" };

export type BehaviorRun = {
  readonly plan: BehaviorPlan;
  readonly results: ReadonlyArray<EmbodiedResult>;
  readonly completed: boolean;
  /** Index of the step that stopped the run, when it did not complete. */
  readonly stoppedAt?: number;
  /** Set when the run waits for a person to confirm a step. */
  readonly pendingId?: string;
};

function need(value: string | undefined, what: string): string {
  if (!value?.trim()) {
    throw new Error(`${what} is required for this behavior`);
  }
  return value.trim();
}

/** Turn a behavior request into a plan of intents. Pure, apart from reading the world. */
export function planBehavior(
  name: BehaviorName,
  args: BehaviorArgs,
  world: WorldModel,
): BehaviorPlanResult {
  try {
    switch (name) {
      case "stop":
        return {
          ok: true,
          plan: { name, steps: [{ intent: { type: "stop" }, why: "halt all motion" }] },
        };
      case "wait":
        return { ok: true, plan: { name, steps: [] } };
      case "look_at": {
        const targetId = need(args.targetId, "targetId");
        return {
          ok: true,
          plan: {
            name,
            steps: [{ intent: { type: "look_at", targetId }, why: "turn attention to it" }],
          },
        };
      }
      case "come_here": {
        const personId = need(args.personId, "personId");
        return {
          ok: true,
          plan: {
            name,
            steps: [
              {
                intent: { type: "look_at", targetId: personId },
                why: "confirm where the person is",
              },
              { intent: { type: "navigate_to", targetId: personId }, why: "go to the person" },
            ],
          },
        };
      }
      case "follow_person": {
        const personId = need(args.personId, "personId");
        return {
          ok: true,
          plan: {
            name,
            steps: [{ intent: { type: "follow", personId }, why: "keep a safe distance behind" }],
          },
        };
      }
      case "greet_person": {
        const personId = need(args.personId, "personId");
        return {
          ok: true,
          plan: {
            name,
            steps: [
              { intent: { type: "look_at", targetId: personId }, why: "face the person" },
              { intent: { type: "gesture", name: "wave" }, why: "greet" },
            ],
          },
        };
      }
      case "find_object": {
        const where = world.whereIs(args.objectId ?? need(args.label, "objectId or label"));
        if (!where) {
          return { ok: false, reason: "The object is not in the world model.", resolution: "ask" };
        }
        const placeId = where.entity.position?.placeId;
        const steps: Array<{ intent: BodyIntent; why: string }> = [];
        if (where.stale && placeId) {
          steps.push({
            intent: { type: "navigate_to", targetId: placeId },
            why: "go where it was last seen",
          });
        }
        steps.push({ intent: { type: "look_at", targetId: where.entity.id }, why: "look for it" });
        return { ok: true, plan: { name, steps } };
      }
      case "bring_object": {
        const objectId = need(args.objectId, "objectId");
        const personId = need(args.personId, "personId");
        return {
          ok: true,
          plan: {
            name,
            steps: [
              { intent: { type: "navigate_to", targetId: objectId }, why: "go to the object" },
              { intent: { type: "grasp", objectId }, why: "pick it up" },
              {
                intent: { type: "navigate_to", targetId: personId },
                why: "approach the person (handover: approach)",
              },
              {
                intent: { type: "handover", objectId, personId },
                why: `hand it over: ${HANDOVER_PROTOCOL.slice(1).join(", ")}`,
              },
            ],
          },
        };
      }
      case "charge": {
        const charger = world.query({ property: { key: "charger", value: true }, limit: 1 })[0];
        if (!charger) {
          return { ok: false, reason: "No charging station is known.", resolution: "ask" };
        }
        return {
          ok: true,
          plan: {
            name,
            steps: [
              {
                intent: { type: "navigate_to", targetId: charger.entity.id },
                why: "go to the charger",
              },
            ],
          },
        };
      }
      default:
        return { ok: false, reason: `Unknown behavior ${String(name)}.` };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Carry out a plan through the controller, stopping at the first step not carried out. */
export async function runBehavior(
  plan: BehaviorPlan,
  controller: EmbodiedController,
  options: { readonly signal?: AbortSignal } = {},
): Promise<BehaviorRun> {
  const results: EmbodiedResult[] = [];
  for (const [index, step] of plan.steps.entries()) {
    if (options.signal?.aborted) {
      return { plan, results, completed: false, stoppedAt: index };
    }
    const result = await controller.request(step.intent, {
      requestedBy: `behavior:${plan.name}`,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    results.push(result);
    if (result.pendingId) {
      return { plan, results, completed: false, stoppedAt: index, pendingId: result.pendingId };
    }
    if (!result.outcome?.ok) {
      return { plan, results, completed: false, stoppedAt: index };
    }
  }
  return { plan, results, completed: true };
}
