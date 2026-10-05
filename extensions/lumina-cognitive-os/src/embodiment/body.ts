import type { BodyMode } from "../cognition/self/self-model.js";
/**
 * body.ts — The contract between cognition and a body.
 *
 * M3GAN spec §23: high-level cognition and motion control are separate, and
 * the language model never emits PWM, current, torque or any direct motor
 * command. This file is where that rule becomes a type: the only thing
 * cognition can hand a body is a `BodyIntent` ("go to the kitchen", "look at
 * Dal", "pick up the cup"). Turning an intent into trajectories, joint targets
 * and motor commands happens behind `BodyAdapter`, in a behavior/motion stack
 * (ROS 2 nodes, a simulator, firmware) that this layer never sees.
 *
 * Two adapters ship today:
 *
 *   NullBody       the truth on a desktop: there is no body, nothing moves
 *   SimulatedBody  a symbolic stand-in for tests and for exercising the whole
 *                  perceive -> decide -> act path before hardware exists
 *
 * A physical robot or an Isaac Sim / MuJoCo / Gazebo bridge is a third
 * adapter implementing the same interface.
 */
import type { RiskTier } from "../risk/policies.js";

export type BodyIntent =
  | { readonly type: "stop" }
  | { readonly type: "look_at"; readonly targetId: string }
  | { readonly type: "gesture"; readonly name: string }
  | { readonly type: "point"; readonly targetId: string }
  | { readonly type: "navigate_to"; readonly targetId: string }
  | { readonly type: "follow"; readonly personId: string }
  | { readonly type: "grasp"; readonly objectId: string }
  | { readonly type: "place"; readonly objectId: string; readonly onId: string }
  | { readonly type: "handover"; readonly objectId: string; readonly personId: string };

export type BodyIntentType = BodyIntent["type"];

export const BODY_INTENT_TYPES: ReadonlyArray<BodyIntentType> = [
  "stop",
  "look_at",
  "gesture",
  "point",
  "navigate_to",
  "follow",
  "grasp",
  "place",
  "handover",
];

/** Static facts about each intent that safety review relies on. */
export type IntentProfile = {
  /** Capability Dal must grant before this intent may run at all (spec §20). */
  readonly capability: string;
  readonly riskTier: RiskTier;
  readonly reversible: boolean;
  /** Acting on a stale or uncertain belief about the target would be unsafe. */
  readonly needsConfidentTarget: boolean;
};

export const INTENT_PROFILES: Readonly<Record<BodyIntentType, IntentProfile>> = {
  // Stopping is the safe action: it is never gated, never needs a grant.
  stop: {
    capability: "robot.stop",
    riskTier: "SAFE",
    reversible: true,
    needsConfidentTarget: false,
  },
  // Looking at something uncertain is how confidence is raised, so no floor.
  look_at: {
    capability: "robot.look",
    riskTier: "SAFE",
    reversible: true,
    needsConfidentTarget: false,
  },
  gesture: {
    capability: "robot.gesture",
    riskTier: "SAFE",
    reversible: true,
    needsConfidentTarget: false,
  },
  point: {
    capability: "robot.gesture",
    riskTier: "SAFE",
    reversible: true,
    needsConfidentTarget: true,
  },
  navigate_to: {
    capability: "robot.navigate",
    riskTier: "WARNING",
    reversible: true,
    needsConfidentTarget: true,
  },
  follow: {
    capability: "robot.navigate",
    riskTier: "WARNING",
    reversible: true,
    needsConfidentTarget: true,
  },
  grasp: {
    capability: "robot.grasp",
    riskTier: "HIGH_RISK",
    reversible: true,
    needsConfidentTarget: true,
  },
  place: {
    capability: "robot.grasp",
    riskTier: "HIGH_RISK",
    reversible: true,
    needsConfidentTarget: true,
  },
  // Contact with a person's hands: never unattended.
  handover: {
    capability: "robot.handover",
    riskTier: "HIGH_RISK",
    reversible: false,
    needsConfidentTarget: true,
  },
};

/** Every capability a body intent can require, for grants and documentation. */
export const BODY_CAPABILITIES: ReadonlyArray<string> = [
  ...new Set(Object.values(INTENT_PROFILES).map((p) => p.capability)),
];

/** World-model ids an intent depends on. */
export function intentTargets(intent: BodyIntent): ReadonlyArray<string> {
  switch (intent.type) {
    case "look_at":
    case "point":
    case "navigate_to":
      return [intent.targetId];
    case "follow":
      return [intent.personId];
    case "grasp":
      return [intent.objectId];
    case "place":
      return [intent.objectId, intent.onId];
    case "handover":
      return [intent.objectId, intent.personId];
    default:
      return [];
  }
}

/** The envelope a body must stay inside while carrying out an allowed intent. */
export type MotionLimits = {
  readonly maxSpeedMps: number;
  readonly maxForceN: number;
};

export type BodyOutcome = {
  readonly ok: boolean;
  readonly detail: string;
};

export interface BodyAdapter {
  readonly id: string;
  readonly mode: BodyMode;
  /** Carry out an intent the safety supervisor already allowed, within `limits`. */
  execute(intent: BodyIntent, limits: MotionLimits, signal: AbortSignal): Promise<BodyOutcome>;
  /** Halt all motion now. Must be safe to call at any time, any number of times. */
  stop(): Promise<void>;
  /** Symbolic place of the body, when it has one. */
  placeId(): string | undefined;
}

/** A desktop has no body. Saying so is the honest default. */
export class NullBody implements BodyAdapter {
  readonly id = "none";
  readonly mode: BodyMode = "none";

  async execute(): Promise<BodyOutcome> {
    return { ok: false, detail: "There is no body to carry this out." };
  }

  async stop(): Promise<void> {}

  placeId(): string | undefined {
    return undefined;
  }
}

/**
 * A symbolic body: tracks where it is and what it holds, resolving targets to
 * places through `resolvePlace` (normally the world model). It moves nothing,
 * so its outcomes are predictions; the self model says as much.
 */
export class SimulatedBody implements BodyAdapter {
  readonly id = "simulated";
  readonly mode: BodyMode = "simulated";
  private place: string | undefined;
  private holding: string | undefined;
  private stops = 0;

  constructor(
    private readonly resolvePlace: (id: string) => string | undefined,
    startPlaceId?: string,
  ) {
    this.place = startPlaceId;
  }

  async execute(
    intent: BodyIntent,
    _limits: MotionLimits,
    signal: AbortSignal,
  ): Promise<BodyOutcome> {
    if (signal.aborted) {
      return { ok: false, detail: "Interrupted before moving." };
    }
    switch (intent.type) {
      case "navigate_to":
      case "follow": {
        const id = intent.type === "follow" ? intent.personId : intent.targetId;
        // A room or location is itself a place; anything else is reached where it is.
        const destination = this.resolvePlace(id) ?? id;
        this.place = destination;
        return { ok: true, detail: `Now at ${destination}.` };
      }
      case "grasp":
        if (this.holding) {
          return { ok: false, detail: `Already holding ${this.holding}.` };
        }
        this.holding = intent.objectId;
        return { ok: true, detail: `Holding ${intent.objectId}.` };
      case "place":
      case "handover":
        if (this.holding !== intent.objectId) {
          return { ok: false, detail: `Not holding ${intent.objectId}.` };
        }
        this.holding = undefined;
        return {
          ok: true,
          detail:
            intent.type === "place"
              ? `Placed ${intent.objectId} on ${intent.onId}.`
              : `Handed ${intent.objectId} to ${intent.personId}.`,
        };
      default:
        return { ok: true, detail: `Simulated ${intent.type}.` };
    }
  }

  async stop(): Promise<void> {
    this.stops++;
  }

  placeId(): string | undefined {
    return this.place;
  }

  /** What the simulated hand holds; for tests and the self model. */
  held(): string | undefined {
    return this.holding;
  }

  stopCount(): number {
    return this.stops;
  }
}
