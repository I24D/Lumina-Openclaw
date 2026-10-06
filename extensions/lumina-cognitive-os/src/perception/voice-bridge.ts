/**
 * voice-bridge.ts — The microphone as one of Lumina's recognizing sensors.
 *
 * The `voice_perception.py` sidecar cuts speech with a voice activity detector
 * and identifies the speaker against consented voice templates (WeSpeaker via
 * sherpa-onnx). It never transcribes and never keeps audio; this maps each
 * stretch of speech onto the shared sensor bridge as a `speech.detected` event,
 * plus a sighting of the speaker when one was recognized.
 */
import { coreEvent } from "../events/catalog.js";
import {
  attachSensorBridge,
  type SensorBridge,
  type SensorPort,
  type SharedSensorEvent,
} from "./sensor-bridge.js";

export type SpeechEvent = {
  readonly kind: "speech";
  readonly atISO: string;
  readonly durationMs: number;
  readonly match: { readonly personId: string; readonly similarity: number } | null;
};

export type VoiceEvent = SpeechEvent | SharedSensorEvent;
export type VoicePort = SensorPort<SpeechEvent>;

/** One of the privacy layer's microphone sources, so muting the microphone drops these events. */
const SOURCE = "microphone";

type VoiceDeps = Omit<
  Parameters<typeof attachSensorBridge<SpeechEvent>>[0],
  "modality" | "source" | "port" | "read"
> & { readonly microphone: VoicePort };

export function attachVoice(deps: VoiceDeps): SensorBridge {
  const { microphone, ...rest } = deps;
  return attachSensorBridge<SpeechEvent>({
    // A speaker who falls silent has not left the room; give silence longer than sight.
    leaveAfterMs: 120_000,
    ...rest,
    modality: "voice",
    source: SOURCE,
    port: microphone,
    read: (event) => {
      if (event.kind !== "speech") {
        return undefined;
      }
      const confidence = event.match ? Math.min(0.99, 0.5 + event.match.similarity) : 0.5;
      return {
        atISO: event.atISO,
        recognized: event.match ? [event.match] : [],
        unknown: event.match ? 0 : 1,
        unknownConfidence: 0.5,
        extra: [
          coreEvent(
            SOURCE,
            "speech.detected",
            {
              confidence,
              durationMs: event.durationMs,
              ...(event.match ? { speakerId: event.match.personId } : {}),
            },
            { atISO: event.atISO },
          ),
        ],
      };
    },
  });
}
