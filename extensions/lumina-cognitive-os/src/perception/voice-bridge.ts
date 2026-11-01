/**
 * voice-bridge.ts — The microphone as one of Lumina's recognizing sensors.
 *
 * The `voice_perception.py` sidecar cuts speech with a voice activity detector
 * and identifies the speaker against consented voice templates (WeSpeaker via
 * sherpa-onnx). This maps what it hears onto the router, through the privacy
 * gate like every microphone event:
 *   - each stretch of speech becomes `speech.detected`, with its tone and, for
 *     an unknown voice, an anonymous tag that only tells voices apart;
 *   - for a speaker recognized with consent, the tone also gives an affect
 *     estimate (`affect.estimated`), never a fact;
 *   - sounds that matter become `sound.detected`, and a dangerous one (smoke
 *     alarm, glass breaking, a scream) also `danger.detected`;
 *   - on request, the words of the next utterance (pronunciation practice).
 * Audio never leaves the sidecar.
 */
import { coreEvent } from "../events/catalog.js";
import { newEntityId } from "../shared/ids.js";
import { estimateAffect } from "../social/affect.js";
import {
  attachSensorBridge,
  type SensorBridge,
  type SensorPort,
  type SharedSensorEvent,
} from "./sensor-bridge.js";

export type Prosody = {
  readonly loudnessDb: number;
  readonly pitchHz: number;
  readonly pitchVar: number;
};

export type SpeechEvent = {
  readonly kind: "speech";
  readonly atISO: string;
  readonly durationMs: number;
  readonly match: { readonly personId: string; readonly similarity: number } | null;
  readonly voiceTag?: string | null;
  readonly prosody?: Prosody;
};

export type SoundEvent = {
  readonly kind: "sound";
  readonly atISO: string;
  readonly label: string;
  readonly score: number;
  readonly hazard: string | null;
  readonly severity: "low" | "moderate" | "high" | "critical" | null;
};

export type TranscriptEvent =
  | {
      readonly kind: "transcribed";
      readonly requestId: string;
      readonly text: string;
      readonly durationMs: number;
    }
  | { readonly kind: "transcribe_failed"; readonly requestId: string; readonly reason: string };

type VoiceSidecarEvent = SpeechEvent | SoundEvent | TranscriptEvent;
export type VoiceEvent = VoiceSidecarEvent | SharedSensorEvent;
export type VoicePort = SensorPort<VoiceSidecarEvent>;

export type Transcript =
  | { readonly ok: true; readonly text: string; readonly durationMs: number }
  | { readonly ok: false; readonly reason: string };

export type VoiceBridge = SensorBridge & {
  /** The words of the next utterance, for pronunciation practice. */
  transcribe(language: string, timeoutMs?: number): Promise<Transcript>;
};

/** One of the privacy layer's microphone sources, so muting the microphone drops these events. */
const SOURCE = "microphone";
/** Audio-only danger evidence never reaches certainty. */
const HEARD_DANGER_CEILING = 0.7;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Tone as the affect module reads it: loudness and pitch movement in [0,1]. */
export function voiceSignals(prosody: Prosody) {
  return {
    energy: clamp01((prosody.loudnessDb + 50) / 40),
    pitchVariance: clamp01(prosody.pitchVar / 0.3),
  };
}

type VoiceDeps = Omit<
  Parameters<typeof attachSensorBridge<VoiceSidecarEvent>>[0],
  "modality" | "source" | "port" | "read"
> & { readonly microphone: VoicePort };

export function attachVoice(deps: VoiceDeps): VoiceBridge {
  const { microphone, ...rest } = deps;
  const waiting = new Map<string, (transcript: Transcript) => void>();
  const ingest = (event: Parameters<typeof deps.router.ingest>[0]) => {
    try {
      deps.router.ingest(event);
    } catch (error) {
      deps.onError?.(error);
    }
  };
  // Sounds and transcripts are not readings about people: they bypass the recognition path.
  const offExtra = microphone.on((event) => {
    if (event.kind === "sound") {
      ingest(
        coreEvent(
          SOURCE,
          "sound.detected",
          {
            label: event.label,
            score: event.score,
            ...(event.hazard ? { hazard: event.hazard } : {}),
          },
          { atISO: event.atISO },
        ),
      );
      if (event.hazard && event.severity) {
        ingest(
          coreEvent(
            SOURCE,
            "danger.detected",
            {
              hazard: event.hazard,
              severity: event.severity,
              confidence: Math.min(HEARD_DANGER_CEILING, event.score),
              ...(deps.placeId ? { placeId: deps.placeId } : {}),
            },
            { atISO: event.atISO },
          ),
        );
      }
    } else if (event.kind === "transcribed" || event.kind === "transcribe_failed") {
      const resolve = waiting.get(event.requestId);
      waiting.delete(event.requestId);
      resolve?.(
        event.kind === "transcribed"
          ? { ok: true, text: event.text, durationMs: event.durationMs }
          : { ok: false, reason: event.reason },
      );
    }
  });
  const bridge = attachSensorBridge<VoiceSidecarEvent>({
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
      const extra = [
        coreEvent(
          SOURCE,
          "speech.detected",
          {
            confidence,
            durationMs: event.durationMs,
            ...(event.match ? { speakerId: event.match.personId } : {}),
            ...(event.voiceTag ? { voiceTag: event.voiceTag } : {}),
            ...(event.prosody ? { prosody: event.prosody } : {}),
          },
          { atISO: event.atISO },
        ),
      ];
      // Affect only for someone recognized with consent, and only as an estimate.
      if (event.match && event.prosody) {
        const estimate = estimateAffect({ voice: voiceSignals(event.prosody) });
        if (estimate.possibleState !== "neutral") {
          extra.push(
            coreEvent(
              SOURCE,
              "affect.estimated",
              {
                personId: event.match.personId,
                possibleState: estimate.possibleState,
                confidence: estimate.confidence,
                signals: [...estimate.signals],
              },
              { atISO: event.atISO },
            ),
          );
        }
      }
      return {
        atISO: event.atISO,
        recognized: event.match ? [event.match] : [],
        unknown: event.match ? 0 : 1,
        unknownConfidence: 0.5,
        extra,
      };
    },
  });
  return {
    ...bridge,
    transcribe: (language, timeoutMs = 30_000) => {
      if (!microphone.running()) {
        return Promise.resolve({ ok: false, reason: "The microphone is off." });
      }
      const requestId = newEntityId("transcribe");
      return new Promise<Transcript>((resolve) => {
        waiting.set(requestId, resolve);
        const timer = setTimeout(() => {
          if (waiting.delete(requestId)) {
            resolve({ ok: false, reason: "Nothing was heard in time." });
          }
        }, timeoutMs);
        timer.unref?.();
        if (!microphone.send({ cmd: "transcribe", requestId, language })) {
          waiting.delete(requestId);
          resolve({ ok: false, reason: "The microphone is not running." });
        }
      });
    },
    detach: () => {
      offExtra();
      for (const resolve of waiting.values()) {
        resolve({ ok: false, reason: "The microphone stopped." });
      }
      waiting.clear();
      bridge.detach();
    },
  };
}
