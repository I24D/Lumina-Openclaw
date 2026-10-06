/**
 * simulated-robot.ts — A desktop robot that exists only in software (MOCK).
 *
 * Lumina spec §86 phase D (desktop robot) and §59 (every physical capability
 * runs in simulation first). This is a symbolic stand-in for the hardware
 * abstraction layer: a head with pan and tilt, a small wheeled base, a
 * battery, an IMU and a camera, with the twin description a simulator or a
 * URDF export would start from. It moves numbers, not motors, and says so.
 */
import type { MotionLimits } from "./body.js";
import type {
  Actuator,
  CalibrationResult,
  DigitalTwinDescription,
  HardwareHealth,
  RobotHardwareInterface,
  Sensor,
  SensorReading,
} from "./hal.js";

export const DESKTOP_ROBOT_TWIN: DigitalTwinDescription = Object.freeze({
  name: "lumina-desktop-robot",
  version: "0.1.0",
  dimensionsM: { height: 0.35, width: 0.22, depth: 0.22 },
  massKg: 1.8,
  links: ["base_link", "neck_link", "head_link"],
  joints: [
    {
      name: "head_pan",
      type: "revolute",
      parent: "base_link",
      child: "neck_link",
      limits: { lower: -1.57, upper: 1.57, velocity: 1, effort: 1.5 },
    },
    {
      name: "head_tilt",
      type: "revolute",
      parent: "neck_link",
      child: "head_link",
      limits: { lower: -0.5, upper: 0.6, velocity: 1, effort: 1 },
    },
  ],
  sensors: [
    { id: "camera0", kind: "camera", mountedOn: "head_link" },
    { id: "imu0", kind: "imu", mountedOn: "base_link" },
    { id: "battery0", kind: "battery", mountedOn: "base_link" },
  ],
  actuators: [
    { id: "head", kind: "head", joints: ["head_pan", "head_tilt"] },
    { id: "base", kind: "base", joints: [] },
  ],
  collision: [
    { link: "base_link", shape: "cylinder", sizeM: [0.11, 0.12] },
    { link: "head_link", shape: "sphere", sizeM: [0.08] },
  ],
}) as DigitalTwinDescription;

type HeadCommand = { readonly pan: number; readonly tilt: number };
type BaseCommand = { readonly dx: number; readonly dy: number; readonly speedMps: number };

const ok = (detail: string): HardwareHealth => ({ status: "ok", detail });

class SimulatedSensor<T> implements Sensor<T> {
  private running = false;
  constructor(
    readonly id: string,
    readonly kind: Sensor["kind"],
    private readonly sample: () => T,
    private readonly now: () => number,
  ) {}
  async start(): Promise<void> {
    this.running = true;
  }
  async stop(): Promise<void> {
    this.running = false;
  }
  health(): HardwareHealth {
    return this.running
      ? ok("simulated, running")
      : { status: "degraded", detail: "simulated, stopped" };
  }
  async read(): Promise<SensorReading<T>> {
    if (!this.running) {
      throw new Error(`${this.id} is stopped`);
    }
    return { atISO: new Date(this.now()).toISOString(), value: this.sample(), confidence: 1 };
  }
  async calibrate(): Promise<CalibrationResult> {
    return { ok: true, detail: "simulated sensor: nothing to calibrate" };
  }
}

export class SimulatedRobot implements RobotHardwareInterface {
  readonly id = "simulated-desktop-robot";
  readonly description = DESKTOP_ROBOT_TWIN;
  private head: HeadCommand = { pan: 0, tilt: 0 };
  private pose = { x: 0, y: 0 };
  private batteryPercent: number;
  private stopped = 0;
  private readonly sensorList: ReadonlyArray<Sensor>;
  private readonly actuatorList: ReadonlyArray<Actuator>;

  constructor(options: { readonly now?: () => number; readonly batteryPercent?: number } = {}) {
    const now = options.now ?? (() => Date.now());
    this.batteryPercent = options.batteryPercent ?? 100;
    this.sensorList = [
      new SimulatedSensor("battery0", "battery", () => this.batteryPercent, now),
      new SimulatedSensor("imu0", "imu", () => ({ roll: 0, pitch: 0, yaw: this.head.pan }), now),
      new SimulatedSensor(
        "camera0",
        "camera",
        () => ({ frame: "simulated", width: 640, height: 480 }),
        now,
      ),
    ];
    const joint = (name: string) => DESKTOP_ROBOT_TWIN.joints.find((j) => j.name === name)?.limits;
    const headActuator: Actuator<HeadCommand, HeadCommand> = {
      id: "head",
      kind: "head",
      state: () => ({ ...this.head }),
      command: async (cmd) => {
        const pan = joint("head_pan");
        const tilt = joint("head_tilt");
        if (
          !pan ||
          !tilt ||
          cmd.pan < pan.lower ||
          cmd.pan > pan.upper ||
          cmd.tilt < tilt.lower ||
          cmd.tilt > tilt.upper
        ) {
          throw new Error("head command outside joint limits");
        }
        this.head = { ...cmd };
      },
      stop: async () => {
        this.stopped++;
      },
      health: () => ok("simulated head"),
    };
    const baseActuator: Actuator<BaseCommand, { x: number; y: number }> = {
      id: "base",
      kind: "base",
      state: () => ({ ...this.pose }),
      command: async (cmd, limits: MotionLimits) => {
        if (cmd.speedMps > limits.maxSpeedMps) {
          throw new Error(
            `base speed ${cmd.speedMps} exceeds the allowed ${limits.maxSpeedMps} m/s`,
          );
        }
        this.pose = { x: this.pose.x + cmd.dx, y: this.pose.y + cmd.dy };
        this.batteryPercent = Math.max(0, this.batteryPercent - 0.1);
      },
      stop: async () => {
        this.stopped++;
      },
      health: () => ok("simulated base"),
    };
    this.actuatorList = [headActuator, baseActuator];
  }

  sensors(): ReadonlyArray<Sensor> {
    return this.sensorList;
  }

  actuators(): ReadonlyArray<Actuator> {
    return this.actuatorList;
  }

  async emergencyStop(): Promise<void> {
    await Promise.all(this.actuatorList.map((a) => a.stop()));
  }

  health(): HardwareHealth {
    return { status: "ok", detail: "MOCK: symbolic simulated robot, no physical hardware" };
  }

  /** Robot view for the dashboard (spec §70). */
  telemetry() {
    return {
      mock: true,
      pose: { ...this.pose },
      joints: { head_pan: this.head.pan, head_tilt: this.head.tilt },
      batteryPercent: Number(this.batteryPercent.toFixed(1)),
      stops: this.stopped,
      sensors: this.sensorList.map((s) => ({ id: s.id, kind: s.kind, ...s.health() })),
      actuators: this.actuatorList.map((a) => ({ id: a.id, kind: a.kind, ...a.health() })),
    };
  }
}
