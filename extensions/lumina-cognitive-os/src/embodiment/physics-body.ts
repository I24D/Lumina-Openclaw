import type { BodyMode } from "../contracts/self-model.js";
/**
 * physics-body.ts — A body adapter backed by a physics simulator (MuJoCo).
 *
 * M3GAN spec §16, §23, §59 and §60. The symbolic SimulatedBody teleports; this
 * one drives the `mujoco_body.py` sidecar, where a small mobile robot moves at
 * the speed the safety supervisor allowed, steers around people and obstacles,
 * stops on contact and grasps only what is within reach. It receives intents
 * the supervisor already reviewed, exactly like a real robot would; the
 * language model never reaches it. Stop always works: it is sent at once and
 * also aborts the running intent.
 */
import { newEntityId } from "../shared/ids.js";
import type { SidecarExit } from "../shared/ndjson-sidecar.js";
import type { BodyAdapter, BodyIntent, BodyOutcome, MotionLimits } from "./body.js";

export type PhysicsState = {
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
  readonly place: string | null;
  readonly holding: string | null;
};

export type PhysicsEvent =
  | {
      readonly kind: "start";
      readonly places: ReadonlyArray<string>;
      /** Object name to the place it starts at. */
      readonly objects: Readonly<Record<string, string>>;
      readonly people: ReadonlyArray<string>;
    }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly ok: boolean;
      readonly detail: string;
      readonly simSeconds: number;
      readonly state: PhysicsState;
    }
  | { readonly kind: "state"; readonly id: string; readonly state: PhysicsState }
  | { readonly kind: "error"; readonly atISO: string; readonly message: string };

export type PhysicsPort = {
  start(): { readonly ok: boolean; readonly error?: string };
  stop(): void;
  running(): boolean;
  send(command: Readonly<Record<string, unknown>>): boolean;
  on(listener: (event: PhysicsEvent | SidecarExit) => void): () => void;
};

export type SimulatedSighting = {
  readonly id: string;
  readonly kind: "room" | "object";
  readonly label: string;
  readonly placeId?: string;
};

const TIMEOUT_MS = 150_000;
const TARGET_FIELDS = ["targetId", "personId", "objectId", "onId"] as const;

export class PhysicsBody implements BodyAdapter {
  readonly id = "mujoco";
  readonly mode: BodyMode = "simulated";
  private state: PhysicsState | undefined;
  private names = new Set<string>();
  private readonly waiting = new Map<string, (outcome: BodyOutcome) => void>();
  private lastError: string | undefined;

  constructor(
    private readonly port: PhysicsPort,
    /** A person's or entity's name for an id, so "per_01..." reaches the simulator as "Dal". */
    private readonly nameOf: (id: string) => string | undefined = () => undefined,
    /** Feeds what the simulated sensors see into the world model. */
    private readonly observe: (sighting: SimulatedSighting) => void = () => undefined,
  ) {
    port.on((event) => {
      switch (event.kind) {
        case "start":
          this.names = new Set([...event.places, ...Object.keys(event.objects), ...event.people]);
          // What the simulated robot's sensors see goes into the world model like any sighting.
          for (const place of event.places) {
            this.observe({ id: place, kind: "room", label: place.replaceAll("_", " ") });
          }
          for (const [object, place] of Object.entries(event.objects)) {
            this.observe({ id: object, kind: "object", label: object, placeId: place });
          }
          break;
        case "result": {
          this.state = event.state;
          const resolve = this.waiting.get(event.id);
          this.waiting.delete(event.id);
          resolve?.({ ok: event.ok, detail: `${event.detail} (${event.simSeconds} s simulated)` });
          break;
        }
        case "state":
          this.state = event.state;
          break;
        case "error":
          this.lastError = event.message;
          break;
        case "exit":
          for (const [id, resolve] of this.waiting) {
            this.waiting.delete(id);
            resolve({ ok: false, detail: "The simulator stopped." });
          }
          break;
        default:
          break;
      }
    });
  }

  /** The simulator's name for an id the world model or the people registry uses. */
  private simName(id: string): string {
    if (this.names.has(id)) {
      return id;
    }
    const name = this.nameOf(id);
    const match = name
      ? [...this.names].find(
          (n) => n.toLowerCase() === name.trim().toLowerCase().replaceAll(" ", "_"),
        )
      : undefined;
    return match ?? id;
  }

  async execute(
    intent: BodyIntent,
    limits: MotionLimits,
    signal: AbortSignal,
  ): Promise<BodyOutcome> {
    if (signal.aborted) {
      return { ok: false, detail: "Interrupted before moving." };
    }
    if (!this.port.running()) {
      const started = this.port.start();
      if (!started.ok) {
        return { ok: false, detail: `The simulator did not start: ${started.error ?? "unknown"}` };
      }
    }
    const translated: Record<string, unknown> = { ...intent };
    for (const field of TARGET_FIELDS) {
      const value = translated[field];
      if (typeof value === "string") {
        translated[field] = this.simName(value);
      }
    }
    const id = newEntityId("move");
    const outcome = new Promise<BodyOutcome>((resolve) => {
      this.waiting.set(id, resolve);
      const timeout = setTimeout(() => {
        if (this.waiting.delete(id)) {
          void this.stop();
          resolve({ ok: false, detail: "The simulator did not answer in time; stopped." });
        }
      }, TIMEOUT_MS);
      timeout.unref?.();
      signal.addEventListener("abort", () => void this.stop(), { once: true });
    });
    if (!this.port.send({ cmd: "execute", id, intent: translated, limits })) {
      this.waiting.delete(id);
      return { ok: false, detail: "The simulator is not running." };
    }
    return outcome;
  }

  async stop(): Promise<void> {
    this.port.send({ cmd: "stop" });
  }

  placeId(): string | undefined {
    return this.state?.place ?? undefined;
  }

  /** Pose, place and grip as the simulator last reported them. */
  describe(): Record<string, unknown> {
    return {
      engine: "mujoco",
      running: this.port.running(),
      known: [...this.names],
      ...(this.state ? { state: this.state } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  dispose(): void {
    this.port.send({ cmd: "quit" });
    this.port.stop();
  }
}
