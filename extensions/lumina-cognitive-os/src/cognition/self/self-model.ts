/**
 * self-model.ts — Live self-model derivation.
 *
 * Stable self-model types live in ../../contracts/self-model.ts so embodiment
 * and hardware layers do not depend upward on cognition/.
 */
import { LOW_BATTERY_PERCENT } from "../../brainstem/energy.js";
import type { SelfModel, SelfModelInput } from "../../contracts/self-model.js";

export {
  SENSOR_KINDS,
  type BodyMode,
  type SelfModel,
  type SelfModelInput,
  type SensorKind,
  type SensorStatus,
} from "../../contracts/self-model.js";

export const SELF_NATURE =
  "Artificial agent. Its internal states are functional (attention, priority, uncertainty, " +
  "confidence, task load, resource use); it makes no claim to consciousness or feelings.";

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

export function canUse(self: SelfModel, capability: string): boolean {
  return !self.body.emergencyStop && self.capabilities.includes(capability);
}
