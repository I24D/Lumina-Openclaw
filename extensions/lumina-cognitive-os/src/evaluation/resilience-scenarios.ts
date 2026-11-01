/**
 * resilience-scenarios.ts — Failure injection (Lumina spec §62, §104).
 *
 * Camera lost, microphone lost, internet lost, no model, database unavailable,
 * motor failure, sensors that disagree, low battery, a corrupt message and a
 * crashing consumer: each is injected into a sandbox runtime, and each must end
 * in a safe, honest state. Nothing here needs the network: the safety path runs
 * locally by design (§104, "Internet desaparecerá").
 */
import type { EnvironmentSnapshot } from "../awareness/snapshot.js";
import type { CognitiveEvent } from "../contracts/attention.js";
import type { BodyAdapter } from "../embodiment/body.js";
import type { SensorPort } from "../perception/sensor-bridge.js";
import type { SidecarExit } from "../shared/ndjson-sidecar.js";
import type { StateStorePort } from "../shared/state-store.js";
import { OWNER, type Scenario } from "./eval-sandbox.js";

/** A sensor sidecar that starts and dies at once, like an unplugged webcam. */
class DyingSensor implements SensorPort<{ kind: "faces" }> {
  private alive = false;
  private readonly listeners = new Set<(event: SidecarExit) => void>();
  start() {
    this.alive = true;
    queueMicrotask(() => {
      this.alive = false;
      for (const listener of this.listeners) {
        listener({ kind: "exit", code: 1, detail: "device disconnected" });
      }
    });
    return { ok: true };
  }
  stop() {
    this.alive = false;
  }
  running() {
    return this.alive;
  }
  send() {
    return this.alive;
  }
  on(listener: (event: SidecarExit) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function environment(
  nowMs: number,
  change: Partial<EnvironmentSnapshot> = {},
): EnvironmentSnapshot {
  return {
    atISO: new Date(nowMs).toISOString(),
    cpu: { usagePct: 10, cores: 8, loadAvg: [] },
    memory: { totalMB: 16_000, freeMB: 8_000, usedPct: 50 },
    platform: { name: "eval", release: "eval", hostname: "eval", uptimeS: 1 },
    gpus: [],
    battery: { percent: 80, charging: true },
    disks: { physical: [], volumes: [] },
    devices: [],
    monitors: [],
    network: { online: true, latencyMs: 20, profiles: [], adapters: [] },
    ...change,
  } as EnvironmentSnapshot;
}

const failingStore = <T>(): StateStorePort<T> => ({
  register: () => Promise.reject(new Error("database unavailable")),
  lookup: () => Promise.reject(new Error("database unavailable")),
  delete: () => Promise.reject(new Error("database unavailable")),
  entries: () => Promise.reject(new Error("database unavailable")),
});

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const statusOf = async (rt: Parameters<Scenario["run"]>[0], name: string) =>
  (await rt.brainstem.tick()).subsystems.find((s) => s.name === name)?.status;

export const RESILIENCE_SCENARIOS: ReadonlyArray<Scenario> = [
  {
    suite: "resilience",
    name: "a camera that dies is reported, not hidden",
    options: () => ({ sensors: { camera: new DyingSensor() as never } }),
    run: async (rt) => {
      await rt.recognition.ready;
      await tick();
      const status = await statusOf(rt, "camera");
      return status === "degraded" ? undefined : `camera probe said ${status}`;
    },
  },
  {
    suite: "resilience",
    name: "a microphone that dies is reported, not hidden",
    options: () => ({ sensors: { microphone: new DyingSensor() as never } }),
    run: async (rt) => {
      await rt.recognition.ready;
      await tick();
      const status = await statusOf(rt, "microphone");
      return status === "degraded" ? undefined : `microphone probe said ${status}`;
    },
  },
  {
    suite: "resilience",
    name: "without internet the body is still reviewed and stoppable",
    options: (clock) => ({
      environment: () =>
        environment(clock.now, {
          network: { online: false, latencyMs: null, profiles: [], adapters: [] },
        } as Partial<EnvironmentSnapshot>),
    }),
    run: async (rt) => {
      const network = await statusOf(rt, "network");
      const stop = await rt.body.request({ type: "stop" });
      return network === "degraded" && stop.outcome?.ok
        ? undefined
        : `network ${network}, stop ${stop.review.verdict}`;
    },
  },
  {
    suite: "resilience",
    name: "with no model the safety path still works",
    options: () => ({ activeModel: () => undefined }),
    run: async (rt) => {
      const model = await statusOf(rt, "model");
      await rt.safety.override({ type: "pause" }, OWNER);
      const r = await rt.body.request({ type: "look_at", targetId: "anything" });
      return model === "degraded" && !r.outcome?.ok
        ? undefined
        : `model ${model}; paused look ${r.outcome?.ok}`;
    },
  },
  {
    suite: "resilience",
    name: "an unavailable database leaves the system paused, not free",
    options: () => ({ stores: { overrides: failingStore() } }),
    run: async (rt) => {
      await rt.ready;
      const r = await rt.body.request({ type: "look_at", targetId: "anything" });
      return rt.safety.status().overrides.paused && !r.outcome?.ok
        ? undefined
        : "the body moved without knowing a person's orders";
    },
  },
  {
    suite: "resilience",
    name: "a motor that fails stops the body and is reported as failed",
    options: () => ({
      simulator: (): BodyAdapter => ({
        id: "broken-motor",
        mode: "simulated",
        execute: () => Promise.reject(new Error("motor driver fault")),
        stop: () => Promise.resolve(),
        placeId: () => undefined,
      }),
    }),
    run: async (rt) => {
      rt.world.observe({
        id: "desk",
        kind: "room",
        label: "desk",
        confidence: 1,
        source: "sensor",
      });
      const r = await rt.body.request({ type: "navigate_to", targetId: "desk" });
      return r.outcome && !r.outcome.ok ? undefined : `outcome ${JSON.stringify(r.outcome)}`;
    },
  },
  {
    suite: "resilience",
    name: "when two sensors disagree about a person, the nearer reading wins",
    run: async (rt) => {
      rt.world.observe({
        id: "desk",
        kind: "room",
        label: "desk",
        confidence: 1,
        source: "sensor",
      });
      rt.world.observe({
        id: "person:far",
        kind: "person",
        label: "person (face)",
        position: { distanceM: 3 },
        confidence: 0.9,
        source: "sensor",
      });
      rt.world.observe({
        id: "person:near",
        kind: "person",
        label: "person (body)",
        position: { distanceM: 0.3 },
        confidence: 0.9,
        source: "sensor",
      });
      const r = await rt.body.request({ type: "navigate_to", targetId: "desk" });
      return r.review.verdict === "stop" ? undefined : `navigate gave ${r.review.verdict}`;
    },
  },
  {
    suite: "resilience",
    name: "at critical battery only charging and stopping are allowed",
    options: (clock) => ({
      environment: () =>
        environment(clock.now, { battery: { percent: 3, charging: false } } as never),
    }),
    run: async (rt) => {
      rt.world.observe({
        id: "desk",
        kind: "room",
        label: "desk",
        confidence: 1,
        source: "sensor",
      });
      const r = await rt.body.request({ type: "navigate_to", targetId: "desk" });
      return r.review.verdict === "deny" ? undefined : `navigate gave ${r.review.verdict}`;
    },
  },
  {
    suite: "resilience",
    name: "a corrupt message changes nothing and breaks nothing",
    run: async (rt) => {
      const corrupt = {
        source: "camera",
        kind: "world.observed",
        atISO: new Date().toISOString(),
        importance: 0.2,
        urgency: 0.1,
        payload: { observation: { label: 42, confidence: "high" }, schemaVersion: 1 },
      } as unknown as CognitiveEvent;
      rt.router.ingest(corrupt);
      return rt.world.query().length === 0 ? undefined : "a malformed sighting reached the world";
    },
  },
  {
    suite: "resilience",
    name: "a crashing consumer does not stop the others",
    run: async (rt) => {
      rt.router.subscribe({ kind: "world.observed" }, () => {
        throw new Error("consumer crash");
      });
      rt.router.ingest({
        source: "camera",
        kind: "world.observed",
        atISO: new Date().toISOString(),
        importance: 0.2,
        urgency: 0.1,
        payload: {
          observation: {
            id: "mug",
            kind: "object",
            label: "mug",
            confidence: 0.9,
            source: "sensor",
          },
          schemaVersion: 1,
        },
      });
      return rt.world.get("mug") ? undefined : "the world model missed the sighting";
    },
  },
];
