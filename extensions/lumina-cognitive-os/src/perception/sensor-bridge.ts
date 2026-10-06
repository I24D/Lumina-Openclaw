import type { ThalamicRouter } from "../cognition/router/thalamic-router.js";
/**
 * sensor-bridge.ts — A recognizing sensor becomes part of Lumina's situation.
 *
 * M3GAN spec §7 and §8 (vision, audition), §89 (presence), §97 (privacy
 * states). Shared by the webcam (faces) and the microphone (voices): runs the
 * sensor's sidecar while its privacy state is on, and turns its readings into
 * ordinary events through the thalamic router:
 *   - a recognized person becomes a `world.observed` sighting (sensor
 *     evidence), so presence and the workspace see them;
 *   - an arrival becomes `person.detected`, a departure `person.left`;
 *   - someone without a consented template is "unknown person", nothing more.
 * Recognition uses only consented templates from the biometric gallery, and
 * enrolling someone needs their consent first.
 */
import type { CognitiveEvent } from "../contracts/attention.js";
import { m3ganEvent } from "../events/catalog.js";
import { newEntityId } from "../shared/ids.js";
import type { SidecarExit } from "../shared/ndjson-sidecar.js";
import type { BiometricGallery, BiometricModality, BiometricResult } from "../social/biometrics.js";
import type { PeopleRegistry } from "../social/people.js";
import { observedEvent } from "../world/world-perception.js";

/** Events every recognizing sidecar shares. */
export type SharedSensorEvent =
  | { readonly kind: "start"; readonly atISO: string }
  | {
      readonly kind: "enrolled";
      readonly requestId: string;
      readonly personId: string;
      readonly embedding: ReadonlyArray<number>;
    }
  | {
      readonly kind: "enroll_failed";
      readonly requestId: string;
      readonly personId: string;
      readonly reason: string;
    }
  | { readonly kind: "heartbeat"; readonly atISO: string }
  | { readonly kind: "error"; readonly atISO: string; readonly message: string };

/** The sidecar as a bridge needs it (NdjsonSidecar implements it). */
export type SensorPort<E> = {
  start(): { readonly ok: boolean; readonly error?: string };
  stop(): void;
  running(): boolean;
  send(command: Readonly<Record<string, unknown>>): boolean;
  on(listener: (event: E | SharedSensorEvent | SidecarExit) => void): () => void;
};

export type Recognition = { readonly personId: string; readonly similarity: number };

/** What one sensor reading means, whatever the sensor. */
export type SensorReading = {
  readonly atISO: string;
  readonly recognized: ReadonlyArray<Recognition>;
  readonly unknown: number;
  readonly unknownConfidence: number;
  /** Extra events the reading carries (e.g. `speech.detected`). */
  readonly extra?: ReadonlyArray<CognitiveEvent>;
};

export type SensorStatus = {
  readonly running: boolean;
  readonly allowed: boolean;
  readonly present: ReadonlyArray<{ readonly personId: string; readonly name: string }>;
  readonly unknown: number;
  readonly lastReadingAtISO?: string;
  readonly lastError?: string;
};

export type SensorBridge = {
  enroll(personId: string): Promise<BiometricResult>;
  forget(personId: string): number;
  /** Re-reads the privacy state and departures now. */
  refresh(): void;
  status(): SensorStatus;
  detach(): void;
};

const UNKNOWN_LABEL = "unknown person";

/** Recognizer similarity mapped to sensor confidence: always below certainty. */
const confidenceOf = (similarity: number) => Math.min(0.99, Math.max(0.5, 0.5 + similarity));

export function attachSensorBridge<E extends { readonly kind: string }>(deps: {
  readonly modality: BiometricModality;
  /** Event source; it must be one of the privacy layer's sources for this sensor. */
  readonly source: string;
  readonly port: SensorPort<E>;
  /** Maps a sensor-specific event to a reading, or undefined for anything else. */
  readonly read: (event: E) => SensorReading | undefined;
  readonly router: ThalamicRouter;
  readonly people: PeopleRegistry;
  readonly gallery: BiometricGallery;
  /** The sensor's privacy state, read each check: off stops the sidecar. */
  readonly allowed: () => boolean;
  readonly placeId?: string;
  readonly now?: () => number;
  /** Someone not sensed for this long has left. Default 30 s. */
  readonly leaveAfterMs?: number;
  /** How often the privacy state and departures are checked. Default 5 s. */
  readonly checkEveryMs?: number;
  readonly enrollTimeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}): SensorBridge {
  const now = deps.now ?? Date.now;
  const leaveAfterMs = deps.leaveAfterMs ?? 30_000;
  const placeId = deps.placeId ? { placeId: deps.placeId } : {};
  const lastSensed = new Map<string, number>();
  const pending = new Map<string, (result: BiometricResult) => void>();
  let unknown = 0;
  let lastReadingAtISO: string | undefined;
  let lastError: string | undefined;

  const pushGallery = () =>
    deps.port.send({
      cmd: "gallery",
      entries: deps.gallery
        .gallery(deps.modality)
        .map((g) => ({ personId: g.personId, embeddings: g.samples })),
    });

  const ingest = (event: CognitiveEvent) => {
    try {
      deps.router.ingest(event);
    } catch (error) {
      deps.onError?.(error);
    }
  };

  const onReading = (reading: SensorReading) => {
    lastReadingAtISO = reading.atISO;
    const atMs = now();
    for (const event of reading.extra ?? []) {
      ingest(event);
    }
    for (const { personId, similarity } of reading.recognized) {
      const person = deps.people.get(personId);
      if (!person) {
        continue;
      }
      const confidence = confidenceOf(similarity);
      ingest(
        observedEvent(
          deps.source,
          {
            id: person.worldEntityId ?? `person:${person.id}`,
            kind: "person",
            label: person.name,
            confidence,
            source: "sensor",
            ...(deps.placeId ? { position: { placeId: deps.placeId } } : {}),
          },
          reading.atISO,
        ),
      );
      const sensedBefore = lastSensed.get(person.id);
      if (sensedBefore === undefined || atMs - sensedBefore > leaveAfterMs) {
        ingest(
          m3ganEvent(
            deps.source,
            "person.detected",
            { personId: person.id, label: person.name, confidence, ...placeId },
            { atISO: reading.atISO },
          ),
        );
        deps.people.touch(person.id);
      }
      lastSensed.set(person.id, atMs);
    }
    if (reading.unknown > 0 && unknown === 0) {
      ingest(
        m3ganEvent(
          deps.source,
          "person.detected",
          { label: UNKNOWN_LABEL, confidence: reading.unknownConfidence, ...placeId },
          { atISO: reading.atISO },
        ),
      );
    }
    unknown = reading.unknown;
  };

  const settle = (requestId: string, result: BiometricResult) => {
    const resolve = pending.get(requestId);
    pending.delete(requestId);
    resolve?.(result);
  };

  const detachEvents = deps.port.on((event) => {
    switch (event.kind) {
      case "start":
        lastError = undefined;
        pushGallery();
        break;
      case "enrolled": {
        const enrolled = event as Extract<SharedSensorEvent, { kind: "enrolled" }>;
        const result = deps.gallery.add(enrolled.personId, deps.modality, enrolled.embedding);
        if (result.ok) {
          pushGallery();
        }
        settle(enrolled.requestId, result);
        break;
      }
      case "enroll_failed": {
        const failed = event as Extract<SharedSensorEvent, { kind: "enroll_failed" }>;
        settle(failed.requestId, { ok: false, reason: failed.reason });
        break;
      }
      case "error":
        lastError = (event as Extract<SharedSensorEvent, { kind: "error" }>).message;
        break;
      case "heartbeat":
        break;
      case "exit":
        for (const requestId of pending.keys()) {
          settle(requestId, { ok: false, reason: "The sensor stopped." });
        }
        break;
      default: {
        const reading = deps.read(event as E);
        if (reading) {
          onReading(reading);
        }
      }
    }
  });

  const check = () => {
    const allowed = deps.allowed();
    if (allowed && !deps.port.running()) {
      const started = deps.port.start();
      if (!started.ok) {
        lastError = started.error;
      }
    } else if (!allowed && deps.port.running()) {
      deps.port.stop();
    }
    const atMs = now();
    for (const [personId, sensedAt] of lastSensed) {
      if (atMs - sensedAt > leaveAfterMs) {
        lastSensed.delete(personId);
        ingest(m3ganEvent(deps.source, "person.left", { personId, ...placeId }));
      }
    }
  };
  check();
  const timer = setInterval(check, deps.checkEveryMs ?? 5_000);
  timer.unref?.();

  return {
    async enroll(personId) {
      if (!deps.people.canRecognize(personId, deps.modality)) {
        return {
          ok: false,
          reason: `${deps.modality} recognition needs the person's consent, granted by the owner in the M3GAN tab.`,
        };
      }
      if (!deps.allowed() || !deps.port.running()) {
        return { ok: false, reason: `The ${deps.source} is off.` };
      }
      const requestId = newEntityId("enroll");
      const result = new Promise<BiometricResult>((resolve) => {
        pending.set(requestId, resolve);
        const timeout = setTimeout(
          () => settle(requestId, { ok: false, reason: "Nothing usable was sensed in time." }),
          deps.enrollTimeoutMs ?? 20_000,
        );
        timeout.unref?.();
      });
      if (!deps.port.send({ cmd: "enroll", requestId, personId })) {
        settle(requestId, { ok: false, reason: `The ${deps.source} is not running.` });
      }
      return result;
    },
    refresh: check,
    forget(personId) {
      const removed = deps.gallery.remove(personId, deps.modality);
      if (removed > 0) {
        pushGallery();
      }
      return removed;
    },
    status() {
      return {
        running: deps.port.running(),
        allowed: deps.allowed(),
        present: [...lastSensed.keys()].map((personId) => ({
          personId,
          name: deps.people.get(personId)?.name ?? personId,
        })),
        unknown,
        ...(lastReadingAtISO ? { lastReadingAtISO } : {}),
        ...(lastError ? { lastError } : {}),
      };
    },
    detach() {
      clearInterval(timer);
      detachEvents();
      deps.port.stop();
    },
  };
}
