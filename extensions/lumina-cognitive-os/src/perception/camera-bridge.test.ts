/**
 * Tests for the webcam bridge: consented recognition, arrivals and departures, privacy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThalamicRouter } from "../cognition/router/thalamic-router.js";
import type { CognitiveEvent } from "../contracts/attention.js";
import type { SidecarExit } from "../shared/ndjson-sidecar.js";
import { BiometricGallery } from "../social/biometrics.js";
import { PeopleRegistry } from "../social/people.js";
import { knowledgeGap } from "../world/curiosity.js";
import { WorldModel } from "../world/world-model.js";
import {
  attachCamera,
  objectSighting,
  type CameraBridge,
  type CameraEvent,
  type CameraPort,
} from "./camera-bridge.js";

const OWNER = { channel: "owner", actor: "test" } as const;

class FakeCamera implements CameraPort {
  isRunning = false;
  sent: Array<Readonly<Record<string, unknown>>> = [];
  private readonly listeners = new Set<(event: CameraEvent | SidecarExit) => void>();
  start() {
    this.isRunning = true;
    return { ok: true };
  }
  stop() {
    this.isRunning = false;
  }
  running() {
    return this.isRunning;
  }
  send(command: Readonly<Record<string, unknown>>) {
    this.sent.push(command);
    return this.isRunning;
  }
  on(listener: (event: CameraEvent | SidecarExit) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: CameraEvent | SidecarExit) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const bridges: CameraBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) {
    bridge.detach();
  }
  vi.useRealTimers();
});

const setup = (allowed = { value: true }) => {
  let clock = Date.parse("2026-10-05T20:00:00.000Z");
  const people = new PeopleRegistry({ now: () => clock });
  const dal = people.remember({ name: "Dal" }, OWNER);
  if (!dal.ok) {
    throw new Error("setup");
  }
  people.setConsent(dal.person.id, { faceRecognition: true }, OWNER);
  const gallery = new BiometricGallery({ people, now: () => clock });
  const router = new ThalamicRouter();
  const events: CognitiveEvent[] = [];
  router.subscribe({}, ({ event }) => events.push(event));
  const camera = new FakeCamera();
  const bridge = attachCamera({
    camera,
    router,
    people,
    gallery,
    allowed: () => allowed.value,
    now: () => clock,
    checkEveryMs: 60_000,
    enrollTimeoutMs: 1_000,
  });
  bridges.push(bridge);
  return {
    camera,
    bridge,
    people,
    gallery,
    events,
    dalId: dal.person.id,
    advance: (ms: number) => {
      clock += ms;
    },
    at: () => new Date(clock).toISOString(),
  };
};

describe("camera bridge", () => {
  it("starts with the camera allowed and enrolls a consenting person from one face", async () => {
    const { camera, bridge, gallery, dalId } = setup();
    expect(camera.running()).toBe(true);

    const pending = bridge.enroll(dalId);
    const request = camera.sent.find((c) => c.cmd === "enroll");
    camera.emit({
      kind: "enrolled",
      requestId: String(request?.requestId),
      personId: dalId,
      embedding: [0.6, 0.8],
    });

    expect(await pending).toEqual({ ok: true, samples: 1 });
    expect(gallery.gallery("face")).toEqual([{ personId: dalId, samples: [[0.6, 0.8]] }]);
    expect(camera.sent.at(-1)).toMatchObject({ cmd: "gallery" });
  });

  it("refuses to enroll someone without face-recognition consent", async () => {
    const { bridge, people } = setup();
    const cady = people.remember({ name: "Cady" }, OWNER);
    if (!cady.ok) {
      throw new Error("setup");
    }
    expect(await bridge.enroll(cady.person.id)).toMatchObject({ ok: false });
  });

  it("turns a recognized face into a sighting and an arrival, and reports the departure", () => {
    vi.useFakeTimers();
    const { camera, events, dalId, at, advance } = setup();
    camera.emit({
      kind: "faces",
      atISO: at(),
      faces: [{ box: [0, 0, 10, 10], score: 0.95, match: { personId: dalId, similarity: 0.6 } }],
    });
    expect(events.map((e) => e.kind)).toEqual(["world.observed", "person.detected"]);
    expect(events[1]?.payload).toMatchObject({ personId: dalId, label: "Dal" });

    // Seen again soon: a sighting, not a second arrival.
    camera.emit({
      kind: "faces",
      atISO: at(),
      faces: [{ box: [0, 0, 10, 10], score: 0.95, match: { personId: dalId, similarity: 0.6 } }],
    });
    expect(events.filter((e) => e.kind === "person.detected")).toHaveLength(1);

    advance(31_000);
    vi.advanceTimersByTime(60_000);
    expect(events.at(-1)).toMatchObject({ kind: "person.left", payload: { personId: dalId } });
  });

  it("calls a face without a consented template only 'unknown person'", () => {
    const { camera, events, at } = setup();
    camera.emit({
      kind: "faces",
      atISO: at(),
      faces: [{ box: [0, 0, 10, 10], score: 0.9, match: null }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ label: "unknown person", confidence: 0.9 });
    expect(events[0]?.payload).not.toHaveProperty("personId");
  });

  it("forgets a face template and stops matching it", async () => {
    const { camera, bridge, gallery, dalId } = setup();
    gallery.add(dalId, "face", [1, 0]);
    expect(bridge.forget(dalId)).toBe(1);
    expect(gallery.gallery("face")).toEqual([]);
    expect(camera.sent.at(-1)).toEqual({ cmd: "gallery", entries: [] });
  });
});

describe("objects in view", () => {
  it("become sightings in the world model, with animals and furniture kept apart", () => {
    const people = new PeopleRegistry();
    const gallery = new BiometricGallery({ people });
    const router = new ThalamicRouter();
    const world = new WorldModel();
    const sightings: CognitiveEvent[] = [];
    router.subscribe({ kind: "world.observed" }, ({ event }) => sightings.push(event));
    const camera = new FakeCamera();
    const bridge = attachCamera({
      camera,
      router,
      people,
      gallery,
      allowed: () => true,
      placeId: "desk",
      checkEveryMs: 60_000,
    });
    bridges.push(bridge);
    camera.emit({
      kind: "objects",
      atISO: "2026-10-06T08:00:00.000Z",
      objects: [
        { label: "cup", score: 0.8, box: [0, 0, 10, 10] },
        { label: "dog", score: 0.7, box: [0, 0, 10, 10] },
        { label: "chair", score: 0.6, box: [0, 0, 10, 10] },
      ],
    });
    expect(
      sightings.map(
        (e) => (e.payload as { observation: { label: string; kind: string } }).observation,
      ),
    ).toMatchObject([
      { label: "cup", kind: "object", source: "sensor", position: { placeId: "desk" } },
      { label: "dog", kind: "animal" },
      { label: "chair", kind: "furniture" },
    ]);
    // Detached, the bridge stops turning objects into sightings.
    bridges.splice(bridges.indexOf(bridge), 1);
    bridge.detach();
    camera.emit({
      kind: "objects",
      atISO: "2026-10-06T08:00:05.000Z",
      objects: [{ label: "book", score: 0.9, box: [0, 0, 1, 1] }],
    });
    expect(sightings).toHaveLength(3);
    // A thing the detector named is recognized: it is not a knowledge gap.
    const result = world.observe(
      objectSighting({ label: "potted plant", score: 0.9, box: [0, 0, 1, 1] }),
    );
    expect(knowledgeGap(result, sightings[0] as CognitiveEvent)).toBeUndefined();
  });
});

describe("faces and bodies", () => {
  it("estimates affect only for a consented face, and keeps bodies as fresh human zones", () => {
    let clock = Date.parse("2026-10-06T08:00:00.000Z");
    const people = new PeopleRegistry({ now: () => clock });
    const dal = people.remember({ name: "Dal" }, OWNER);
    if (!dal.ok) {
      throw new Error("setup");
    }
    const router = new ThalamicRouter();
    const events: CognitiveEvent[] = [];
    router.subscribe({ kind: "affect.estimated" }, ({ event }) => events.push(event));
    const camera = new FakeCamera();
    const bridge = attachCamera({
      camera,
      router,
      people,
      gallery: new BiometricGallery({ people, now: () => clock }),
      allowed: () => true,
      now: () => clock,
      checkEveryMs: 60_000,
    });
    bridges.push(bridge);
    camera.emit({
      kind: "faces",
      atISO: "2026-10-06T08:00:00.000Z",
      faces: [
        {
          box: [0, 0, 10, 10],
          score: 0.95,
          match: { personId: dal.person.id, similarity: 0.6 },
          expression: { label: "sad", score: 0.9 },
        },
        {
          box: [0, 0, 10, 10],
          score: 0.9,
          match: null,
          expression: { label: "angry", score: 0.9 },
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ personId: dal.person.id, possibleState: "sad" });
    camera.emit({
      kind: "objects",
      atISO: "2026-10-06T08:00:01.000Z",
      objects: [],
      bodies: [{ score: 0.9, box: [0, 0, 100, 300], distanceM: 1.2 }],
    });
    expect(bridge.nearbyBodies()).toEqual([{ id: "body:0", confidence: 0.9, distanceM: 1.2 }]);
    clock += 10_000;
    expect(bridge.nearbyBodies()).toEqual([]);
  });
});
