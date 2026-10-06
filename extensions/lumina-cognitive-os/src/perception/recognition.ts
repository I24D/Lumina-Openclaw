import type { Probe, ProbeResult } from "../brainstem/brainstem.js";
/**
 * recognition.ts — Who Lumina sees and hears, assembled in one place.
 *
 * Owns the consented biometric gallery and the two recognizing sensors (the
 * webcam and the microphone). Each sensor runs only while its privacy state is
 * on and follows a person's switch at once; templates exist only with consent
 * and are deleted when consent is revoked or the person is forgotten.
 */
import type { ThalamicRouter } from "../cognition/router/thalamic-router.js";
import type { PrivacyState } from "../privacy/privacy-state.js";
import type { StateStorePort } from "../shared/state-store.js";
import {
  BiometricGallery,
  type BiometricModality,
  type BiometricRecord,
  type BiometricResult,
} from "../social/biometrics.js";
import type { PeopleRegistry } from "../social/people.js";
import { attachCamera, type CameraBridge, type CameraPort } from "./camera-bridge.js";
import type { SensorStatus } from "./sensor-bridge.js";
import { attachVoice, type Transcript, type VoiceBridge, type VoicePort } from "./voice-bridge.js";

export type RecognitionSensors = {
  readonly camera?: CameraPort;
  readonly microphone?: VoicePort;
  /** Where the sensors are, for sightings (e.g. "desk"). */
  readonly placeId?: string;
};

export type RecognitionStatus = {
  readonly camera?: SensorStatus;
  readonly microphone?: SensorStatus;
  readonly templates: ReturnType<BiometricGallery["summary"]>;
};

export type Recognition = {
  readonly gallery: BiometricGallery;
  readonly ready: Promise<void>;
  enroll(personId: string, modality: BiometricModality): Promise<BiometricResult>;
  /** Deletes templates (one modality or all) and stops matching them at once. */
  forget(personId: string, modality?: BiometricModality): number;
  /** Re-reads the privacy states now instead of at the next check. */
  refresh(): void;
  status(): RecognitionStatus;
  /** Bodies the camera sees right now, as human zones for the body (spec §118). */
  nearbyBodies(): ReturnType<CameraBridge["nearbyBodies"]>;
  /** The words of the next utterance, for pronunciation practice. */
  transcribe(language: string, timeoutMs?: number): Promise<Transcript>;
  probes(): ReadonlyArray<Probe>;
  dispose(): void;
};

function sensorHealth(
  label: string,
  configured: boolean,
  status: SensorStatus | undefined,
): ProbeResult {
  if (!configured) {
    return { status: "absent", detail: `No ${label} configured.` };
  }
  if (!status) {
    return { status: "ok", detail: `${label} starting: loading consented templates.` };
  }
  if (!status.allowed) {
    return { status: "ok", detail: `${label} off by a person's privacy choice.` };
  }
  if (!status.running) {
    return {
      status: "degraded",
      detail: `${label} allowed but not running${status.lastError ? `: ${status.lastError}` : "."}`,
      recommendation: `Check the ${label} and its Python sidecar.`,
    };
  }
  return {
    status: "ok",
    detail: `${label} on; ${status.present.length} recognized, ${status.unknown} unknown${
      status.lastReadingAtISO ? `; last reading ${status.lastReadingAtISO}` : ""
    }.`,
  };
}

export function createRecognition(deps: {
  readonly people: PeopleRegistry;
  readonly router: ThalamicRouter;
  readonly privacy: () => PrivacyState;
  readonly sensors?: RecognitionSensors;
  readonly store?: StateStorePort<BiometricRecord>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly checkEveryMs?: number;
}): Recognition {
  const gallery = new BiometricGallery({
    people: deps.people,
    ...(deps.store ? { store: deps.store } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.onError ? { onError: deps.onError } : {}),
  });
  const common = {
    router: deps.router,
    people: deps.people,
    gallery,
    ...(deps.sensors?.placeId ? { placeId: deps.sensors.placeId } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.onError ? { onError: deps.onError } : {}),
    ...(deps.checkEveryMs ? { checkEveryMs: deps.checkEveryMs } : {}),
  };
  const bridges: { face?: CameraBridge; voice?: VoiceBridge } = {};
  // Sensors start only after stored templates load, so the first gallery sent is complete.
  const ready = gallery.ready.then(() => {
    if (deps.sensors?.camera) {
      bridges.face = attachCamera({
        ...common,
        camera: deps.sensors.camera,
        allowed: () => deps.privacy().camera,
      });
    }
    if (deps.sensors?.microphone) {
      bridges.voice = attachVoice({
        ...common,
        microphone: deps.sensors.microphone,
        allowed: () => deps.privacy().microphone,
      });
    }
  });

  return {
    gallery,
    ready,
    async enroll(personId, modality) {
      await ready;
      const bridge = bridges[modality];
      return bridge
        ? bridge.enroll(personId)
        : {
            ok: false,
            reason: `No ${modality === "face" ? "camera" : "microphone"} is configured.`,
          };
    },
    forget(personId, modality) {
      let removed = 0;
      for (const m of modality ? [modality] : (["face", "voice"] as const)) {
        removed += bridges[m]?.forget(personId) ?? gallery.remove(personId, m);
      }
      return removed;
    },
    refresh() {
      bridges.face?.refresh();
      bridges.voice?.refresh();
    },
    nearbyBodies: () => bridges.face?.nearbyBodies() ?? [],
    transcribe: (language, timeoutMs) =>
      bridges.voice
        ? bridges.voice.transcribe(language, timeoutMs)
        : Promise.resolve({ ok: false, reason: "No microphone is configured." }),
    status() {
      return {
        ...(bridges.face ? { camera: bridges.face.status() } : {}),
        ...(bridges.voice ? { microphone: bridges.voice.status() } : {}),
        templates: gallery.summary(),
      };
    },
    probes() {
      return [
        {
          name: "camera",
          critical: false,
          check: () =>
            sensorHealth("camera", Boolean(deps.sensors?.camera), bridges.face?.status()),
        },
        {
          name: "microphone",
          critical: false,
          check: () =>
            sensorHealth("microphone", Boolean(deps.sensors?.microphone), bridges.voice?.status()),
        },
      ];
    },
    dispose() {
      bridges.face?.detach();
      bridges.voice?.detach();
    },
  };
}
