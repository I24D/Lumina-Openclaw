import type { BodyMode } from "../contracts/self-model.js";
/**
 * ros2-body.ts — A body adapter that drives a ROS 2 robot through rosbridge.
 *
 * Lumina spec §24 (robotics middleware: ROS 2, Nav2, MoveIt) and §154 (embodied
 * simulation with Gazebo or Isaac). Speaks the rosbridge JSON protocol over a
 * WebSocket, so nothing ROS has to be installed on this machine:
 *   - navigate_to / follow: a goal pose on `/goal_pose` (Nav2's simple goal),
 *     arrival judged from `/odom`;
 *   - stop: a zero velocity on `/cmd_vel`, sent at once and repeated;
 *   - everything else (look_at, gesture, point, grasp, place, handover): the
 *     intent as JSON on `/lumina/intent`, answered on `/lumina/intent_result` by
 *     a node on the robot side; no answer in time means it did not happen.
 * Like every adapter it receives only intents the safety supervisor allowed,
 * and only in simulation: a physical robot needs hardware safety first.
 */
import { newEntityId } from "../shared/ids.js";
import type { BodyAdapter, BodyIntent, BodyOutcome, MotionLimits } from "./body.js";

export type RosbridgeMessage = Readonly<Record<string, unknown>>;

/** The WebSocket as the adapter needs it; tests use a fake. */
export type RosbridgeTransport = {
  open(): Promise<void>;
  send(message: RosbridgeMessage): void;
  on(listener: (message: RosbridgeMessage) => void): () => void;
  close(): void;
  readonly connected: boolean;
};

export type Ros2Places = Readonly<Record<string, readonly [number, number, number?]>>;

const ARRIVED_M = 0.25;
const NAV_TIMEOUT_MS = 180_000;
const INTENT_TIMEOUT_MS = 60_000;

/** rosbridge over the global WebSocket (Node 22+). */
export function websocketTransport(url: string): RosbridgeTransport {
  let socket: WebSocket | undefined;
  const listeners = new Set<(message: RosbridgeMessage) => void>();
  return {
    get connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
    open: () =>
      new Promise<void>((resolve, reject) => {
        if (socket?.readyState === WebSocket.OPEN) {
          resolve();
          return;
        }
        const next = new WebSocket(url);
        next.addEventListener("open", () => resolve(), { once: true });
        next.addEventListener("error", () => reject(new Error(`rosbridge unreachable at ${url}`)), {
          once: true,
        });
        next.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(String(event.data)) as RosbridgeMessage;
            for (const listener of listeners) {
              listener(message);
            }
          } catch {
            // Not rosbridge JSON; ignore.
          }
        });
        socket = next;
      }),
    send: (message) => socket?.send(JSON.stringify(message)),
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket?.close(),
  };
}

const quaternion = (yaw: number) => ({ x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) });

export class Ros2Body implements BodyAdapter {
  readonly id = "ros2";
  readonly mode: BodyMode = "simulated";
  private pose: { x: number; y: number } | undefined;
  private setup: Promise<void> | undefined;
  private readonly results = new Map<string, (outcome: BodyOutcome) => void>();
  private lastError: string | undefined;

  constructor(
    private readonly transport: RosbridgeTransport,
    private readonly places: Ros2Places,
    private readonly nameOf: (id: string) => string | undefined = () => undefined,
  ) {
    transport.on((message) => {
      if (message.op !== "publish") {
        return;
      }
      if (message.topic === "/odom") {
        const position = (
          message.msg as { pose?: { pose?: { position?: { x?: number; y?: number } } } }
        )?.pose?.pose?.position;
        if (typeof position?.x === "number" && typeof position.y === "number") {
          this.pose = { x: position.x, y: position.y };
        }
      } else if (message.topic === "/lumina/intent_result") {
        try {
          const result = JSON.parse(String((message.msg as { data?: unknown })?.data)) as {
            id?: string;
            ok?: boolean;
            detail?: string;
          };
          const resolve = result.id ? this.results.get(result.id) : undefined;
          if (result.id && resolve) {
            this.results.delete(result.id);
            resolve({ ok: result.ok === true, detail: result.detail ?? "The robot answered." });
          }
        } catch {
          // A result we cannot read is no result.
        }
      }
    });
  }

  private connect(): Promise<void> {
    this.setup ??= this.transport.open().then(() => {
      this.transport.send({ op: "advertise", topic: "/cmd_vel", type: "geometry_msgs/msg/Twist" });
      this.transport.send({
        op: "advertise",
        topic: "/goal_pose",
        type: "geometry_msgs/msg/PoseStamped",
      });
      this.transport.send({
        op: "advertise",
        topic: "/lumina/intent",
        type: "std_msgs/msg/String",
      });
      this.transport.send({
        op: "subscribe",
        topic: "/odom",
        type: "nav_msgs/msg/Odometry",
        throttle_rate: 200,
      });
      this.transport.send({
        op: "subscribe",
        topic: "/lumina/intent_result",
        type: "std_msgs/msg/String",
      });
    });
    this.setup.catch((error: unknown) => {
      this.setup = undefined;
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    return this.setup;
  }

  private placeOf(id: string): readonly [number, number, number?] | undefined {
    return (
      this.places[id] ??
      this.places[this.nameOf(id)?.trim().toLowerCase().replaceAll(" ", "_") ?? ""]
    );
  }

  async execute(
    intent: BodyIntent,
    limits: MotionLimits,
    signal: AbortSignal,
  ): Promise<BodyOutcome> {
    if (signal.aborted) {
      return { ok: false, detail: "Interrupted before moving." };
    }
    try {
      await this.connect();
    } catch {
      return {
        ok: false,
        detail: `No connection to the robot: ${this.lastError ?? "rosbridge unreachable"}.`,
      };
    }
    signal.addEventListener("abort", () => void this.stop(), { once: true });
    if (intent.type === "stop") {
      await this.stop();
      return { ok: true, detail: "Stopped." };
    }
    if (intent.type === "navigate_to") {
      return this.navigate(intent.targetId, signal);
    }
    return this.delegate(intent, limits, signal);
  }

  private async navigate(targetId: string, signal: AbortSignal): Promise<BodyOutcome> {
    const goal = this.placeOf(targetId);
    if (!goal) {
      return { ok: false, detail: `No pose is configured for ${targetId}.` };
    }
    const [x, y, yaw = 0] = goal;
    this.transport.send({
      op: "publish",
      topic: "/goal_pose",
      msg: {
        header: { frame_id: "map" },
        pose: { position: { x, y, z: 0 }, orientation: quaternion(yaw) },
      },
    });
    const started = Date.now();
    while (!signal.aborted && Date.now() - started < NAV_TIMEOUT_MS) {
      if (this.pose && Math.hypot(this.pose.x - x, this.pose.y - y) <= ARRIVED_M) {
        return { ok: true, detail: `Arrived at ${targetId}.` };
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    await this.stop();
    return { ok: false, detail: signal.aborted ? "Interrupted; stopped." : "Timed out; stopped." };
  }

  private delegate(
    intent: BodyIntent,
    limits: MotionLimits,
    signal: AbortSignal,
  ): Promise<BodyOutcome> {
    const id = newEntityId("intent");
    return new Promise<BodyOutcome>((resolve) => {
      const settle = (outcome: BodyOutcome) => {
        if (this.results.delete(id)) {
          resolve(outcome);
        }
      };
      this.results.set(id, resolve);
      const timeout = setTimeout(
        () => settle({ ok: false, detail: "The robot did not answer in time." }),
        INTENT_TIMEOUT_MS,
      );
      timeout.unref?.();
      signal.addEventListener(
        "abort",
        () => settle({ ok: false, detail: "Interrupted; stopped." }),
        {
          once: true,
        },
      );
      this.transport.send({
        op: "publish",
        topic: "/lumina/intent",
        msg: { data: JSON.stringify({ id, intent, limits }) },
      });
    });
  }

  async stop(): Promise<void> {
    const zero = { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 3; i++) {
      this.transport.send({ op: "publish", topic: "/cmd_vel", msg: zero });
    }
  }

  placeId(): string | undefined {
    const pose = this.pose;
    if (!pose) {
      return undefined;
    }
    let best: [string, number] | undefined;
    for (const [name, [x, y]] of Object.entries(this.places)) {
      const d = Math.hypot(pose.x - x, pose.y - y);
      if (d <= 0.6 && (!best || d < best[1])) {
        best = [name, d];
      }
    }
    return best?.[0];
  }

  describe(): Record<string, unknown> {
    return {
      engine: "ros2 (rosbridge)",
      connected: this.transport.connected,
      places: Object.keys(this.places),
      ...(this.pose ? { pose: this.pose } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  dispose(): void {
    void this.stop();
    this.transport.close();
  }
}
