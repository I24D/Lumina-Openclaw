/**
 * Tests for the microphone bridge: tone and anonymous voices, affect only with consent,
 * sounds and hazards, and on-demand transcription.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ThalamicRouter } from "../cognition/router/thalamic-router.js";
import type { CognitiveEvent } from "../contracts/attention.js";
import { payloadOf } from "../events/catalog.js";
import type { SidecarExit } from "../shared/ndjson-sidecar.js";
import { BiometricGallery } from "../social/biometrics.js";
import { PeopleRegistry } from "../social/people.js";
import {
  attachVoice,
  voiceSignals,
  type VoiceBridge,
  type VoiceEvent,
  type VoicePort,
} from "./voice-bridge.js";

const OWNER = { channel: "owner", actor: "test" } as const;

class FakeMicrophone implements VoicePort {
  isRunning = false;
  sent: Array<Readonly<Record<string, unknown>>> = [];
  private readonly listeners = new Set<(event: VoiceEvent | SidecarExit) => void>();
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
  on(listener: (event: VoiceEvent | SidecarExit) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: VoiceEvent | SidecarExit) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const bridges: VoiceBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) {
    bridge.detach();
  }
});

const setup = () => {
  const people = new PeopleRegistry();
  const dal = people.remember({ name: "Dal" }, OWNER);
  if (!dal.ok) {
    throw new Error("setup");
  }
  people.setConsent(dal.person.id, { voiceRecognition: true }, OWNER);
  const router = new ThalamicRouter();
  const events: CognitiveEvent[] = [];
  router.subscribe({}, ({ event }) => events.push(event));
  const microphone = new FakeMicrophone();
  const bridge = attachVoice({
    microphone,
    router,
    people,
    gallery: new BiometricGallery({ people }),
    allowed: () => true,
    checkEveryMs: 60_000,
  });
  bridges.push(bridge);
  return { dal: dal.person, microphone, bridge, events };
};

const ISO = "2026-10-06T12:00:00.000Z";
const LOUD = { loudnessDb: -8, pitchHz: 220, pitchVar: 0.3 };

describe("voice bridge", () => {
  it("passes tone and an anonymous tag on, and estimates affect only for a consented voice", () => {
    const { dal, microphone, events } = setup();
    microphone.emit({
      kind: "speech",
      atISO: ISO,
      durationMs: 1500,
      match: null,
      voiceTag: "voice-1",
      prosody: LOUD,
    });
    microphone.emit({
      kind: "speech",
      atISO: ISO,
      durationMs: 1500,
      match: { personId: dal.id, similarity: 0.8 },
      voiceTag: null,
      prosody: LOUD,
    });
    const speech = events.flatMap((e) => payloadOf(e, "speech.detected") ?? []);
    expect(speech[0]).toMatchObject({ voiceTag: "voice-1", prosody: LOUD });
    const affect = events.flatMap((e) => payloadOf(e, "affect.estimated") ?? []);
    expect(affect).toHaveLength(1);
    expect(affect[0]).toMatchObject({ personId: dal.id, possibleState: "angry" });
    expect(affect[0]?.confidence).toBeLessThanOrEqual(0.75);
    expect(voiceSignals(LOUD).energy).toBe(1);
  });

  it("reports sounds, and a dangerous one as a hazard that never reaches certainty", () => {
    const { microphone, events } = setup();
    microphone.emit({
      kind: "sound",
      atISO: ISO,
      label: "Doorbell",
      score: 0.8,
      hazard: null,
      severity: null,
    });
    microphone.emit({
      kind: "sound",
      atISO: ISO,
      label: "Smoke detector, smoke alarm",
      score: 0.95,
      hazard: "smoke alarm",
      severity: "high",
    });
    expect(events.flatMap((e) => payloadOf(e, "sound.detected")?.label ?? [])).toEqual([
      "Doorbell",
      "Smoke detector, smoke alarm",
    ]);
    const danger = events.flatMap((e) => payloadOf(e, "danger.detected") ?? []);
    expect(danger).toEqual([
      { hazard: "smoke alarm", severity: "high", confidence: 0.7, schemaVersion: 1 },
    ]);
  });

  it("transcribes the next utterance on request, and only while the microphone runs", async () => {
    const { microphone, bridge } = setup();
    microphone.stop();
    expect(await bridge.transcribe("en", 1_000)).toEqual({
      ok: false,
      reason: "The microphone is off.",
    });
    microphone.start();
    const pending = bridge.transcribe("en", 1_000);
    const request = microphone.sent.find((c) => c.cmd === "transcribe");
    microphone.emit({
      kind: "transcribed",
      requestId: String(request?.requestId),
      text: "I am thirty years old",
      durationMs: 1800,
    });
    expect(await pending).toEqual({ ok: true, text: "I am thirty years old", durationMs: 1800 });
  });
});
