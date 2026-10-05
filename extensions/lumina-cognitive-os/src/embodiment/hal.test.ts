/**
 * Tests for the hardware abstraction layer and the simulated robot.
 */
import { describe, expect, it } from "vitest";
import { validateTwin, type DigitalTwinDescription } from "./hal.js";
import { DESKTOP_ROBOT_TWIN, SimulatedRobot } from "./simulated-robot.js";

describe("validateTwin", () => {
  it("accepts the desktop robot's twin", () => {
    expect(validateTwin(DESKTOP_ROBOT_TWIN)).toEqual([]);
  });

  it("names every inconsistency a simulator would trip on", () => {
    const broken: DigitalTwinDescription = {
      ...DESKTOP_ROBOT_TWIN,
      massKg: 0,
      joints: [
        { name: "j", type: "revolute", parent: "base_link", child: "ghost_link" },
        {
          name: "k",
          type: "prismatic",
          parent: "base_link",
          child: "head_link",
          limits: { lower: 1, upper: 0, velocity: 1, effort: 1 },
        },
      ],
      actuators: [{ id: "arm", kind: "arm", joints: ["shoulder"] }],
      sensors: [{ id: "cam", kind: "camera", mountedOn: "nowhere" }],
    };
    expect(validateTwin(broken)).toEqual([
      "mass must be positive",
      "joint j refers to unknown link ghost_link",
      "joint j moves but has no limits",
      "joint k has inconsistent limits",
      "actuator arm drives unknown joint shoulder",
      "sensor cam is mounted on unknown link nowhere",
    ]);
  });
});

describe("SimulatedRobot", () => {
  it("reads its sensors only while they run", async () => {
    const robot = new SimulatedRobot({ now: () => 0, batteryPercent: 80 });
    const battery = robot.sensors().find((s) => s.kind === "battery");
    await expect(battery?.read()).rejects.toThrow(/stopped/u);
    await battery?.start();
    await expect(battery?.read()).resolves.toMatchObject({ value: 80, confidence: 1 });
  });

  it("refuses commands beyond the joint limits or the speed envelope", async () => {
    const robot = new SimulatedRobot();
    const head = robot.actuators().find((a) => a.kind === "head");
    const base = robot.actuators().find((a) => a.kind === "base");
    const limits = { maxSpeedMps: 0.25, maxForceN: 5 };

    await expect(head?.command({ pan: 3, tilt: 0 }, limits)).rejects.toThrow(/joint limits/u);
    await expect(base?.command({ dx: 1, dy: 0, speedMps: 1 }, limits)).rejects.toThrow(/exceeds/u);
    await head?.command({ pan: 0.5, tilt: 0.1 }, limits);
    expect(robot.telemetry().joints).toEqual({ head_pan: 0.5, head_tilt: 0.1 });
  });

  it("says it is a mock and stops every actuator on emergency stop", async () => {
    const robot = new SimulatedRobot();
    expect(robot.health().detail).toContain("MOCK");
    await robot.emergencyStop();
    expect(robot.telemetry()).toMatchObject({ mock: true, stops: 2 });
  });
});
