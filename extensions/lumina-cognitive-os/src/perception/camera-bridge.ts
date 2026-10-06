/**
 * camera-bridge.ts — The webcam as one of Lumina's recognizing sensors.
 *
 * The `camera_perception.py` sidecar reports the faces it sees (OpenCV YuNet
 * detection, SFace recognition against consented templates) and the objects it
 * can name (YOLOX, COCO classes). Faces go through the shared sensor bridge;
 * objects become sightings in the world model, through the same router and its
 * privacy gate. Frames never leave the sidecar.
 */
import { coreEvent } from "../events/catalog.js";
import { estimateAffect, type AffectState } from "../social/affect.js";
import type { EntityKind, Observation } from "../world/world-model.js";
import { observedEvent } from "../world/world-perception.js";
import {
  attachSensorBridge,
  type SensorBridge,
  type SensorPort,
  type SharedSensorEvent,
} from "./sensor-bridge.js";

export type CameraFace = {
  readonly box: readonly [number, number, number, number];
  readonly score: number;
  readonly match: { readonly personId: string; readonly similarity: number } | null;
  /** Facial expression, only for someone recognized with consent. */
  readonly expression?: { readonly label: string; readonly score: number };
};

/** A person's body in view, with a rough (cautious) distance. */
export type CameraBody = {
  readonly score: number;
  readonly box: readonly [number, number, number, number];
  readonly distanceM: number;
};

export type FacesEvent = {
  readonly kind: "faces";
  readonly atISO: string;
  readonly faces: ReadonlyArray<CameraFace>;
};

export type CameraObject = {
  readonly label: string;
  readonly score: number;
  readonly box: readonly [number, number, number, number];
};

export type ObjectsEvent = {
  readonly kind: "objects";
  readonly atISO: string;
  readonly objects: ReadonlyArray<CameraObject>;
  readonly bodies?: ReadonlyArray<CameraBody>;
};

/** The detector that names objects; a named thing is recognized, not a knowledge gap. */
export const OBJECT_DETECTOR = "yolox-coco";

export type CameraEvent = FacesEvent | ObjectsEvent | SharedSensorEvent;
export type CameraPort = SensorPort<FacesEvent | ObjectsEvent>;
export type CameraBridge = SensorBridge & {
  /** People's bodies seen in the last seconds, for the body's safety supervisor (spec §118). */
  nearbyBodies(): ReadonlyArray<{
    readonly id: string;
    readonly confidence: number;
    readonly distanceM: number;
  }>;
};

/** How long a body sighting keeps a human zone in place. */
const BODY_FRESH_MS = 5_000;

/** The facial expression model's labels as the affect module's states. */
const EXPRESSION_STATES: Readonly<Record<string, AffectState>> = {
  angry: "angry",
  disgust: "frustrated",
  fearful: "anxious",
  happy: "happy",
  neutral: "neutral",
  sad: "sad",
};

type CameraDeps = Omit<
  Parameters<typeof attachSensorBridge<FacesEvent | ObjectsEvent>>[0],
  "modality" | "source" | "port" | "read"
> & { readonly camera: CameraPort };

/** COCO classes that are not plain objects; everything else is "object". */
const COCO_KINDS: Readonly<Record<string, EntityKind>> = {
  bird: "animal",
  cat: "animal",
  dog: "animal",
  horse: "animal",
  sheep: "animal",
  cow: "animal",
  elephant: "animal",
  bear: "animal",
  zebra: "animal",
  giraffe: "animal",
  bicycle: "vehicle",
  car: "vehicle",
  motorcycle: "vehicle",
  airplane: "vehicle",
  bus: "vehicle",
  train: "vehicle",
  truck: "vehicle",
  boat: "vehicle",
  bench: "furniture",
  chair: "furniture",
  couch: "furniture",
  bed: "furniture",
  "dining table": "furniture",
  toilet: "furniture",
  sink: "furniture",
  tv: "device",
  laptop: "device",
  mouse: "device",
  remote: "device",
  keyboard: "device",
  "cell phone": "device",
  microwave: "device",
  oven: "device",
  toaster: "device",
  refrigerator: "device",
  clock: "device",
  "hair drier": "device",
};

/** An object in view as a sighting: sensor evidence at the camera's place. */
export function objectSighting(object: CameraObject, placeId?: string): Observation {
  return {
    kind: COCO_KINDS[object.label] ?? "object",
    label: object.label,
    confidence: object.score,
    source: "sensor",
    properties: { detector: OBJECT_DETECTOR },
    ...(placeId ? { position: { placeId } } : {}),
  };
}

export function attachCamera(deps: CameraDeps): CameraBridge {
  const { camera, ...rest } = deps;
  // The sidecar runs only while the camera is allowed, and the router's privacy gate
  // still drops these sightings when Lumina is not remembering.
  const now = deps.now ?? Date.now;
  let bodies: { readonly atMs: number; readonly seen: ReadonlyArray<CameraBody> } = {
    atMs: 0,
    seen: [],
  };
  const offObjects = camera.on((event) => {
    if (event.kind !== "objects") {
      return;
    }
    bodies = { atMs: now(), seen: event.bodies ?? [] };
    for (const object of event.objects) {
      try {
        deps.router.ingest(
          observedEvent("camera", objectSighting(object, deps.placeId), event.atISO),
        );
      } catch (error) {
        deps.onError?.(error);
      }
    }
  });
  const bridge = attachSensorBridge<FacesEvent | ObjectsEvent>({
    ...rest,
    modality: "face",
    // One of the privacy layer's camera sources, so switching the camera off drops these events.
    source: "camera",
    port: camera,
    read: (event) => {
      if (event.kind !== "faces") {
        return undefined;
      }
      const unknown = event.faces.filter((f) => !f.match);
      // Affect only for someone recognized with consent, and only as an estimate.
      const extra = event.faces.flatMap((f) => {
        const state = f.expression ? EXPRESSION_STATES[f.expression.label] : undefined;
        if (!f.match || !f.expression || !state || state === "neutral") {
          return [];
        }
        const estimate = estimateAffect({
          face: { expression: state, confidence: f.expression.score },
        });
        return [
          coreEvent(
            "camera",
            "affect.estimated",
            {
              personId: f.match.personId,
              possibleState: estimate.possibleState,
              confidence: estimate.confidence,
              signals: [...estimate.signals],
            },
            { atISO: event.atISO },
          ),
        ];
      });
      return {
        atISO: event.atISO,
        recognized: event.faces.flatMap((f) => (f.match ? [f.match] : [])),
        unknown: unknown.length,
        unknownConfidence: unknown.length > 0 ? Math.max(...unknown.map((f) => f.score)) : 0,
        ...(extra.length > 0 ? { extra } : {}),
      };
    },
  });
  return {
    ...bridge,
    nearbyBodies: () =>
      now() - bodies.atMs <= BODY_FRESH_MS && deps.allowed()
        ? bodies.seen.map((body, index) => ({
            id: `body:${index}`,
            confidence: body.score,
            distanceM: body.distanceM,
          }))
        : [],
    detach: () => {
      offObjects();
      bridge.detach();
    },
  };
}
