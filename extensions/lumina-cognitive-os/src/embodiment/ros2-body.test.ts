/**
 * Tests for the ROS 2 (rosbridge) body adapter against a fake transport.
 */
import { describe, expect, it, vi } from "vitest";
import { Ros2Body, type RosbridgeMessage, type RosbridgeTransport } from "./ros2-body.js";

class FakeRosbridge implements RosbridgeTransport {
  sent: RosbridgeMessage[] = [];
  connected = false;
  private listener: ((message: RosbridgeMessage) => void) | undefined;
  async open() {
    this.connected = true;
  }
  send(message: RosbridgeMessage) {
    this.sent.push(message);
  }
  on(listener: (message: RosbridgeMessage) => void) {
    this.listener = listener;
    return () => undefined;
  }
  close() {
    this.connected = false;
  }
  receive(message: RosbridgeMessage) {
    this.listener?.(message);
  }
  odom(x: number, y: number) {
    this.receive({
      op: "publish",
      topic: "/odom",
      msg: { pose: { pose: { position: { x, y } } } },
    });
  }
}

const LIMITS = { maxSpeedMps: 0.4, maxForceN: 20 };
const PLACES = { kitchen: [3, 1, 0], desk: [0, 0] } as const;

describe("Ros2Body", () => {
  it("advertises and subscribes once, then sends Nav2 a goal and waits for odometry", async () => {
    const ros = new FakeRosbridge();
    const body = new Ros2Body(ros, PLACES);
    const done = body.execute(
      { type: "navigate_to", targetId: "kitchen" },
      LIMITS,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(ros.sent.some((m) => m.topic === "/goal_pose")).toBe(true));
    expect(ros.sent.filter((m) => m.op === "subscribe").map((m) => m.topic)).toEqual([
      "/odom",
      "/lumina/intent_result",
    ]);
    ros.odom(2.9, 1.05);
    expect(await done).toEqual({ ok: true, detail: "Arrived at kitchen." });
    expect(body.placeId()).toBe("kitchen");
  });

  it("delegates other intents to the robot-side node and takes its answer", async () => {
    const ros = new FakeRosbridge();
    const body = new Ros2Body(ros, PLACES);
    const done = body.execute(
      { type: "look_at", targetId: "desk" },
      LIMITS,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(ros.sent.some((m) => m.topic === "/lumina/intent")).toBe(true));
    const published = ros.sent.find((m) => m.op === "publish" && m.topic === "/lumina/intent") as {
      msg: { data: string };
    };
    const { id } = JSON.parse(published.msg.data) as { id: string };
    ros.receive({
      op: "publish",
      topic: "/lumina/intent_result",
      msg: { data: JSON.stringify({ id, ok: true, detail: "Looking at the desk." }) },
    });
    expect(await done).toEqual({ ok: true, detail: "Looking at the desk." });
  });

  it("stops with zero velocity when interrupted, and refuses unknown places", async () => {
    const ros = new FakeRosbridge();
    const body = new Ros2Body(ros, PLACES);
    expect(
      await body.execute(
        { type: "navigate_to", targetId: "garden" },
        LIMITS,
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, detail: "No pose is configured for garden." });

    const controller = new AbortController();
    const done = body.execute(
      { type: "navigate_to", targetId: "kitchen" },
      LIMITS,
      controller.signal,
    );
    await vi.waitFor(() => expect(ros.sent.some((m) => m.topic === "/goal_pose")).toBe(true));
    controller.abort();
    expect(await done).toEqual({ ok: false, detail: "Interrupted; stopped." });
    expect(ros.sent.filter((m) => m.topic === "/cmd_vel").length).toBeGreaterThanOrEqual(3);
  });
});
