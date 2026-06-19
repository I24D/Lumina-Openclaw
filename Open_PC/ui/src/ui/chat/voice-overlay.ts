// Voice Overlay — full-screen immersive UI when realtime Talk is active.
// Replaces the slim talk-status strip with an animated orb, status label,
// last transcript, and a prominent Stop button. Inspired by Jarvis-style
// voice assistants but built on top of Lumina's existing realtime-talk state.
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import type { RealtimeTalkStatus } from "./realtime-talk-shared.ts";
import { webSpeechFallback } from "./web-speech-fallback.ts";
import { renderLuminaMascot } from "./lumina-mascot.ts";
import {
  MascotLifelikeController,
  type MascotControllerState,
} from "./mascot-lifelike-controller.ts";

// ─── Phase 5: lifelike controller singleton ──────────────────────────
// Stored module-side so successive overlay renders reuse the same loop
// instead of starting/stopping rAF on every re-render. The hook below
// keeps the controller's state in sync with the realtime status.
let lifelikeController: MascotLifelikeController | null = null;
let lifelikeStageEl: HTMLElement | null = null;

function syncMascotController(stage: HTMLElement | null, state: MascotControllerState): void {
  if (stage === null) {
    if (lifelikeController !== null) {
      lifelikeController.stop();
      lifelikeController = null;
    }
    lifelikeStageEl = null;
    return;
  }
  if (lifelikeController === null || lifelikeStageEl !== stage) {
    if (lifelikeController !== null) lifelikeController.stop();
    lifelikeController = new MascotLifelikeController({ target: stage });
    lifelikeController.start();
    stage.setAttribute("data-lifelike", "on");
    lifelikeStageEl = stage;
  }
  lifelikeController.setState(state);
}

function teardownMascotController(): void {
  if (lifelikeController !== null) {
    lifelikeController.stop();
    lifelikeController = null;
  }
  if (lifelikeStageEl !== null) {
    lifelikeStageEl.removeAttribute("data-lifelike");
    lifelikeStageEl = null;
  }
}

/**
 * Public hook for the realtime talk layer: pass it a MediaStream (the
 * Gemini Live audio track) or an HTMLAudioElement once you have one and
 * the lip sync will switch from synthetic to real amplitude. Calling
 * with `null` reverts to synthetic.
 */
export function attachVoiceOverlayAudio(source: MediaStream | HTMLAudioElement | null): void {
  if (lifelikeController === null) return;
  if (source === null) {
    lifelikeController.detachAudio();
  } else {
    lifelikeController.attachAudio(source);
  }
}

/**
 * Preferred path for Gemini Live / PCM streams: pass the AudioContext that
 * the PCM output queue is already using. Returns an AnalyserNode the
 * caller must connect its source(s) to in parallel with the destination
 * (e.g. via RealtimeTalkPcmOutputQueue.setAnalyserTap). Returns null when
 * the overlay isn't mounted yet — caller can retry on the next play tick.
 */
export function attachVoiceOverlayAnalyser(audioContext: AudioContext): AnalyserNode | null {
  if (lifelikeController === null) return null;
  return lifelikeController.attachAnalyser(audioContext);
}

export type VoiceOverlayProps = {
  active: boolean;
  status?: RealtimeTalkStatus;
  detail?: string | null;
  transcript?: string | null;
  conversation?: ReadonlyArray<{ role: string; text: string; partial?: boolean }>;
  assistantName?: string;
  onClose: () => void;
};

// Map realtime status → orb visual state.
type OrbState = "connecting" | "listening" | "thinking" | "speaking" | "idle";

function resolveOrbState(status: RealtimeTalkStatus | undefined): OrbState {
  switch (status) {
    case "connecting":
      return "connecting";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "listening":
      return "listening";
    case "idle":
    case "error":
    case undefined:
    default:
      return "idle";
  }
}

function resolveStatusLabel(state: OrbState, detail?: string | null): string {
  if (detail && detail.trim()) return detail.trim();
  switch (state) {
    case "connecting":
      return "Conectando…";
    case "listening":
      return "Escuchando…";
    case "thinking":
      return "Pensando…";
    case "speaking":
      return "Hablando…";
    case "idle":
    default:
      return "En espera";
  }
}

function resolveLastSpoken(
  conversation: VoiceOverlayProps["conversation"],
  fallback?: string | null,
): { role: "user" | "assistant"; text: string } | null {
  if (!conversation || conversation.length === 0) {
    if (fallback && fallback.trim()) {
      return { role: "user", text: fallback.trim() };
    }
    return null;
  }
  // Walk from end to find the latest non-empty entry.
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const entry = conversation[i];
    const text = (entry.text ?? "").trim();
    if (!text) continue;
    const role: "user" | "assistant" = entry.role === "assistant" ? "assistant" : "user";
    return { role, text };
  }
  return null;
}

export function renderVoiceOverlay(props: VoiceOverlayProps) {
  if (!props.active) {
    // When talk closes/stops, cancel any browser fallback TTS in flight.
    webSpeechFallback.stop();
    teardownMascotController();
    return nothing;
  }
  const state = resolveOrbState(props.status);
  const label = resolveStatusLabel(state, props.detail);
  const lastSpoken = resolveLastSpoken(props.conversation, props.transcript);
  const assistantName = props.assistantName || "Lumina";

  // Use a ref-like callback on the stage to (re)attach the lifelike controller
  // each render. Cheap when the stage element is the same instance.
  const stageRef = (el: Element | undefined): void => {
    if (el instanceof HTMLElement) syncMascotController(el, state);
  };

  return html`
    <div
      class="lumina-voice-overlay lumina-voice-overlay--${state}"
      role="dialog"
      aria-label=${t("chat.composer.talkTranscript")}
      aria-modal="false"
    >
      <div class="lumina-voice-overlay__backdrop" @click=${props.onClose}></div>
      <div class="lumina-voice-overlay__panel">
        <button
          class="lumina-voice-overlay__close"
          type="button"
          @click=${props.onClose}
          title=${t("chat.composer.stopTalk")}
          aria-label=${t("chat.composer.stopTalk")}
        >
          ${icons.x}
        </button>

        <div class="lumina-voice-overlay__mascot-wrap" aria-hidden="true">
          <div
            class="lumina-voice-overlay__mascot-stage"
            ${ref(stageRef)}
          >
            ${renderLuminaMascot({ width: 240, height: 280 })}
          </div>
          <div class="lumina-voice-overlay__waveform" aria-hidden="true">
            ${Array.from({ length: 24 }).map(
              (_, i) =>
                html`<span
                  class="lumina-voice-overlay__wave-bar"
                  style="--i:${i}"
                ></span>`,
            )}
          </div>
        </div>

        <div class="lumina-voice-overlay__meta">
          <div class="lumina-voice-overlay__assistant">${assistantName}</div>
          <div class="lumina-voice-overlay__status">${label}</div>
        </div>

        ${lastSpoken
          ? html`
              <div
                class="lumina-voice-overlay__bubble lumina-voice-overlay__bubble--${lastSpoken.role}"
              >
                <div class="lumina-voice-overlay__bubble-who">
                  ${lastSpoken.role === "assistant" ? assistantName : "Tú"}
                </div>
                <div class="lumina-voice-overlay__bubble-text">${lastSpoken.text}</div>
              </div>
            `
          : nothing}

        <button
          class="lumina-voice-overlay__stop"
          type="button"
          @click=${props.onClose}
          aria-label=${t("chat.composer.stopTalk")}
        >
          ${icons.stop}
          <span>${t("chat.composer.stopTalk")}</span>
        </button>
      </div>
    </div>
  `;
}
