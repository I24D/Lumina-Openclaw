/**
 * hal.ts — The hardware abstraction layer a physical body plugs into.
 *
 * M3GAN spec §83 (RobotHardwareInterface: connect different robots without
 * rewriting the brain), §84 (Sensor: start, stop, health, read, calibrate),
 * §85 (Actuator: state, command, stop, health; low-level commands stay out of
 * the language model), §60 (digital twin: dimensions, joints, limits, mass,
 * sensors, actuators, collision geometry) and §131–§132 (vision-language-action
 * and embodied foundation models go below safety and above the motion
 * controller).
 *
 * Status: INTERFACE ONLY, plus a symbolic simulated robot (simulated-robot.ts,
 * MOCK). No physical hardware is connected. These types are consumed by
 * BodyAdapter implementations, never by cognition or agent tools: nothing that
 * a model can call ever receives an Actuator.
 */
import type { HealthStatus } from "../brainstem/brainstem.js";
import type { SensorKind } from "../contracts/self-model.js";
import type { BodyIntent, MotionLimits } from "./body.js";

export type HardwareHealth = { readonly status: HealthStatus; readonly detail: string };

export type SensorReading<T> = {
  readonly atISO: string;
  readonly value: T;
  /** How much the reading can be trusted, in [0,1]. */
  readonly confidence: number;
};

export type CalibrationResult = { readonly ok: boolean; readonly detail: string };

export interface Sensor<T = unknown> {
  readonly id: string;
  readonly kind: SensorKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): HardwareHealth;
  read(): Promise<SensorReading<T>>;
  calibrate(): Promise<CalibrationResult>;
}

export const ACTUATOR_KINDS = ["base", "arm", "hand", "head", "face", "speaker"] as const;
export type ActuatorKind = (typeof ACTUATOR_KINDS)[number];

export interface Actuator<Command = unknown, State = unknown> {
  readonly id: string;
  readonly kind: ActuatorKind;
  state(): State;
  /** Carried out within `limits`; an implementation must refuse anything beyond them. */
  command(command: Command, limits: MotionLimits): Promise<void>;
  stop(): Promise<void>;
  health(): HardwareHealth;
}

export type JointType = "revolute" | "prismatic" | "continuous" | "fixed";

export type TwinJoint = {
  readonly name: string;
  readonly type: JointType;
  readonly parent: string;
  readonly child: string;
  /** Radians or metres; velocity per second; effort in N or N·m. */
  readonly limits?: {
    readonly lower: number;
    readonly upper: number;
    readonly velocity: number;
    readonly effort: number;
  };
};

/** A virtual description of the body (spec §60); URDF/SDF export comes with ROS 2. */
export type DigitalTwinDescription = {
  readonly name: string;
  readonly version: string;
  readonly dimensionsM: { readonly height: number; readonly width: number; readonly depth: number };
  readonly massKg: number;
  readonly links: ReadonlyArray<string>;
  readonly joints: ReadonlyArray<TwinJoint>;
  readonly sensors: ReadonlyArray<{
    readonly id: string;
    readonly kind: SensorKind;
    readonly mountedOn: string;
  }>;
  readonly actuators: ReadonlyArray<{
    readonly id: string;
    readonly kind: ActuatorKind;
    readonly joints: ReadonlyArray<string>;
  }>;
  readonly collision: ReadonlyArray<{
    readonly link: string;
    readonly shape: "box" | "cylinder" | "sphere";
    readonly sizeM: ReadonlyArray<number>;
  }>;
};

export interface RobotHardwareInterface {
  readonly id: string;
  readonly description: DigitalTwinDescription;
  sensors(): ReadonlyArray<Sensor>;
  actuators(): ReadonlyArray<Actuator>;
  /** Cut motion now: the hardware-level stop, independent of every planner. */
  emergencyStop(): Promise<void>;
  health(): HardwareHealth;
}

/**
 * A future VLA or embodied foundation model (spec §131, §132). It proposes
 * intents; it never touches actuators, and every proposal still goes through
 * the embodied controller and its safety supervisor.
 */
export interface EmbodiedModelAdapter {
  readonly id: string;
  readonly capabilities: ReadonlyArray<"navigation" | "manipulation" | "whole_body">;
  propose(goal: string, signal: AbortSignal): Promise<ReadonlyArray<BodyIntent>>;
}

/** Problems that would make a twin unsafe or meaningless to simulate. Empty means valid. */
export function validateTwin(twin: DigitalTwinDescription): ReadonlyArray<string> {
  const problems: string[] = [];
  const links = new Set(twin.links);
  const joints = new Set<string>();
  if (twin.massKg <= 0) {
    problems.push("mass must be positive");
  }
  for (const [axis, value] of Object.entries(twin.dimensionsM)) {
    if (!(value > 0)) {
      problems.push(`dimension ${axis} must be positive`);
    }
  }
  for (const joint of twin.joints) {
    if (joints.has(joint.name)) {
      problems.push(`joint ${joint.name} is defined twice`);
    }
    joints.add(joint.name);
    for (const end of [joint.parent, joint.child]) {
      if (!links.has(end)) {
        problems.push(`joint ${joint.name} refers to unknown link ${end}`);
      }
    }
    const l = joint.limits;
    if (joint.type !== "fixed" && joint.type !== "continuous" && !l) {
      problems.push(`joint ${joint.name} moves but has no limits`);
    }
    if (l && (l.lower >= l.upper || l.velocity <= 0 || l.effort <= 0)) {
      problems.push(`joint ${joint.name} has inconsistent limits`);
    }
  }
  for (const actuator of twin.actuators) {
    for (const j of actuator.joints) {
      if (!joints.has(j)) {
        problems.push(`actuator ${actuator.id} drives unknown joint ${j}`);
      }
    }
  }
  for (const sensor of twin.sensors) {
    if (!links.has(sensor.mountedOn)) {
      problems.push(`sensor ${sensor.id} is mounted on unknown link ${sensor.mountedOn}`);
    }
  }
  for (const shape of twin.collision) {
    if (!links.has(shape.link)) {
      problems.push(`collision shape refers to unknown link ${shape.link}`);
    }
  }
  return problems;
}
