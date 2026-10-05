/**
 * self-model.ts — What Lumina knows about itself, stated honestly.
 *
 * M3GAN spec §12: a computational representation of the system's own name,
 * capabilities, sensors, tools, body, energy, active model, limits, current
 * tasks and functional state. It is what lets Lumina answer "can you do X?"
 * from fact rather than from a guess, and what keeps a planner from proposing
 * a grasp to a system with no hands.
 *
 * Two rules shape it:
 *
 *   Derived, not stored.  The self model is rebuilt from the live sources
 *                         (awareness, kill switch, body adapter, goals, router)
 *                         every time, so it cannot drift from reality.
 *
 *   No overclaiming.      States are functional (attention, load, uncertainty,
 *                         confidence). Consciousness and feelings are not
 *                         technical facts the system can demonstrate, so the
 *                         model never asserts them.
 */
import type { AutonomyLevel } from "../autonomy-levels.js";

export const SELF_NATURE =
  "Artificial agent. Its internal states are functional (attention, priority, uncertainty, " +
  "confidence, task load, resource use); it makes no claim to consciousness or feelings.";

export type BodyMode = "none" | "simulated" | "physical";

export const SENSOR_KINDS = [
  "camera",
  "microphone",
  "depth",
  "touch",
  "proximity",
  "imu",
  "force",
  "joint_position",
  "temperature",
  "environmental",
  "chemical",
  "screen",
  "battery",
] as const;
export type SensorKind = (typeof SENSOR_KINDS)[number];

export type SensorStatus = {
  readonly id: string;
  readonly kind: SensorKind;
  readonly available: boolean;
  readonly detail?: string;
};

export type SelfModelInput = {
  readonly name: string;
  readonly atISO: string;
  readonly body: {
    readonly mode: BodyMode;
    readonly adapterId: string;
    /** Symbolic place of the body in the world model, when known. */
    readonly placeId?: string;
  };
  readonly emergencyStop: boolean;
  readonly sensors: ReadonlyArray<SensorStatus>;
  /** Tools and granted capabilities the agent can actually use. */
  readonly capabilities: ReadonlyArray<string>;
  readonly battery: { readonly percent: number; readonly charging: boolean } | null;
  readonly activeModel?: string;
  readonly autonomyLevel: AutonomyLevel;
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly score: number;
  }>;
  readonly attentionTarget?: string;
  readonly pendingEvents: number;
};

export type SelfModel = {
  readonly name: string;
  readonly nature: string;
  readonly atISO: string;
  readonly body: SelfModelInput["body"] & { readonly emergencyStop: boolean };
  readonly sensors: ReadonlyArray<SensorStatus>;
  readonly capabilities: ReadonlyArray<string>;
  readonly energy: { readonly batteryPercent: number | null; readonly charging: boolean | null };
  readonly activeModel: string | null;
  readonly autonomyLevel: AutonomyLevel;
  readonly limitations: ReadonlyArray<string>;
  readonly currentTasks: SelfModelInput["tasks"];
  readonly functionalState: {
    readonly attentionTarget: string | null;
    readonly pendingEvents: number;
    readonly openTasks: number;
  };
};

/** Battery level under which the self model flags energy as a limitation. */
export const LOW_BATTERY_PERCENT = 20;

function deriveLimitations(input: SelfModelInput): string[] {
  const out: string[] = [];
  if (input.emergencyStop) {
    out.push(
      "Emergency stop engaged: all autonomous and physical action is frozen until Dal re-arms it.",
    );
  }
  if (input.body.mode === "none") {
    out.push("No physical body: cannot move, look around, grasp, carry or navigate.");
  } else if (input.body.mode === "simulated") {
    out.push(
      "Body is simulated: physical outcomes are predictions, not effects in the real world.",
    );
  }
  const missing = input.sensors.filter((s) => !s.available).map((s) => s.kind);
  if (missing.length > 0) {
    out.push(`Unavailable sensors: ${[...new Set(missing)].join(", ")}.`);
  }
  if (input.battery && !input.battery.charging && input.battery.percent <= LOW_BATTERY_PERCENT) {
    out.push(`Battery at ${input.battery.percent}% and not charging.`);
  }
  if (input.autonomyLevel <= 2) {
    out.push(
      `Autonomy L${input.autonomyLevel}: acts only on request and asks before anything with effects.`,
    );
  }
  if (!input.activeModel) {
    out.push("No language model reported as active: reasoning may be unavailable.");
  }
  return out;
}

/** Assemble the self model from live facts. Pure: same input, same output. */
export function buildSelfModel(input: SelfModelInput): SelfModel {
  return {
    name: input.name,
    nature: SELF_NATURE,
    atISO: input.atISO,
    body: { ...input.body, emergencyStop: input.emergencyStop },
    sensors: input.sensors,
    capabilities: [...new Set(input.capabilities)].toSorted(),
    energy: {
      batteryPercent: input.battery?.percent ?? null,
      charging: input.battery?.charging ?? null,
    },
    activeModel: input.activeModel ?? null,
    autonomyLevel: input.autonomyLevel,
    limitations: deriveLimitations(input),
    currentTasks: input.tasks,
    functionalState: {
      attentionTarget: input.attentionTarget ?? null,
      pendingEvents: input.pendingEvents,
      openTasks: input.tasks.length,
    },
  };
}

/** Whether the self model says a capability is usable right now. */
export function canUse(self: SelfModel, capability: string): boolean {
  return !self.body.emergencyStop && self.capabilities.includes(capability);
}
