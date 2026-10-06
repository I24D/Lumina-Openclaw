/**
 * Stable self-model leaf types shared by cognition, embodiment and hardware.
 */
import type { AutonomyLevel } from "./autonomy.js";

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
    readonly placeId?: string;
  };
  readonly emergencyStop: boolean;
  readonly sensors: ReadonlyArray<SensorStatus>;
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
  /** The interaction mode (child, companion, maintenance) and what it asks of Lumina. */
  readonly interactionMode?: { readonly mode: string; readonly guidance: string };
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
  readonly interactionMode: string;
  readonly limitations: ReadonlyArray<string>;
  readonly currentTasks: SelfModelInput["tasks"];
  readonly functionalState: {
    readonly attentionTarget: string | null;
    readonly pendingEvents: number;
    readonly openTasks: number;
  };
};
