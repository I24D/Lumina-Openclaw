/**
 * sensor-sidecars.ts — The webcam and microphone sidecars, built from config.
 *
 * Both are off unless the plugin config turns them on (`cameraPerception`,
 * `voicePerception`); once on, each still runs only while its privacy state
 * is on. Model files live outside the repository, under the OpenClaw home, and
 * the sidecars download them on first use.
 */
import os from "node:os";
import path from "node:path";
import { NdjsonSidecar } from "../shared/ndjson-sidecar.js";
import type { FacesEvent } from "./camera-bridge.js";
import type { RecognitionSensors } from "./recognition.js";
import type { SharedSensorEvent } from "./sensor-bridge.js";
import type { SpeechEvent } from "./voice-bridge.js";

export type PerceptionSettings = {
  readonly camera: boolean;
  readonly cameraIndex: number;
  readonly cameraFps: number;
  readonly voice: boolean;
  readonly placeId?: string;
  readonly modelsDir: string;
};

const DEFAULT_MODELS_DIR = path.join(os.homedir(), ".openclaw", "models");

const finite = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

export function resolvePerceptionSettings(
  raw: Readonly<Record<string, unknown>>,
): PerceptionSettings {
  const placeId =
    typeof raw.perceptionPlaceId === "string" && raw.perceptionPlaceId.trim()
      ? raw.perceptionPlaceId.trim()
      : undefined;
  return {
    camera: raw.cameraPerception === true,
    cameraIndex: Math.round(finite(raw.cameraIndex, 0, 0, 16)),
    cameraFps: finite(raw.cameraFps, 1, 0.2, 5),
    voice: raw.voicePerception === true,
    modelsDir:
      typeof raw.perceptionModelsDir === "string" && raw.perceptionModelsDir.trim()
        ? raw.perceptionModelsDir.trim()
        : DEFAULT_MODELS_DIR,
    ...(placeId ? { placeId } : {}),
  };
}

export function createSensorSidecars(settings: PerceptionSettings): RecognitionSensors | undefined {
  if (!settings.camera && !settings.voice) {
    return undefined;
  }
  return {
    ...(settings.camera
      ? {
          camera: new NdjsonSidecar<FacesEvent | SharedSensorEvent>({
            name: "camera_perception",
            args: () => [
              "--camera",
              String(settings.cameraIndex),
              "--fps",
              String(settings.cameraFps),
              "--models-dir",
              path.join(settings.modelsDir, "opencv"),
            ],
          }),
        }
      : {}),
    ...(settings.voice
      ? {
          microphone: new NdjsonSidecar<SpeechEvent | SharedSensorEvent>({
            name: "voice_perception",
            args: () => ["--models-dir", path.join(settings.modelsDir, "voice")],
          }),
        }
      : {}),
    ...(settings.placeId ? { placeId: settings.placeId } : {}),
  };
}
