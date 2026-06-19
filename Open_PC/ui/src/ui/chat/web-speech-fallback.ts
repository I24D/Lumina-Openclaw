// Web Speech API fallback TTS.
//
// Why: lumina-voice sidecar uses an external TTS chain (ElevenLabs, etc.).
// If that fails or is unavailable, Lumina goes silent. This module is a
// last-resort fallback that uses the browser's built-in `speechSynthesis`.
//
// It is INTENTIONALLY simple — no streaming, no chunking, no SSML — because
// it should only fire when the primary chain didn't deliver audio.
//
// Activation:
// - `webSpeechFallback.enable()`: turn fallback on (manual toggle).
// - `webSpeechFallback.speakIfPrimaryFailed(text, source)`: called by realtime
//   talk flow when it detects no audio came through for the latest assistant
//   turn (timeout window).
//
// Voice selection: prefers a Spanish (es-*) voice when available, since
// Lumina defaults to Spanish.

type FallbackMode = "off" | "auto" | "always";

const STATE_KEY = "lumina:web-speech-fallback";

function loadMode(): FallbackMode {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw === "off" || raw === "auto" || raw === "always") return raw;
  } catch {
    /* ignore */
  }
  return "auto";
}

function saveMode(mode: FallbackMode) {
  try {
    localStorage.setItem(STATE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  // Prefer Spanish, then any default, then first.
  const spanish = voices.find((v) => v.lang.toLowerCase().startsWith("es"));
  if (spanish) return spanish;
  const def = voices.find((v) => v.default);
  if (def) return def;
  return voices[0] ?? null;
}

function isAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

let mode: FallbackMode = loadMode();
let recentlySpokenTexts = new Set<string>();
const RECENT_TTL_MS = 30_000;

function rememberSpoken(text: string) {
  recentlySpokenTexts.add(text);
  setTimeout(() => recentlySpokenTexts.delete(text), RECENT_TTL_MS);
}

function speakNow(text: string) {
  if (!isAvailable()) return;
  try {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    } else {
      utter.lang = "es-ES";
    }
    utter.rate = 1.0;
    utter.pitch = 1.0;
    utter.volume = 1.0;
    speechSynthesis.speak(utter);
    rememberSpoken(text);
  } catch (err) {
    console.warn("[lumina-web-speech] speak failed:", err);
  }
}

export const webSpeechFallback = {
  isAvailable,

  getMode(): FallbackMode {
    return mode;
  },

  setMode(next: FallbackMode) {
    mode = next;
    saveMode(next);
    if (next === "off" && isAvailable()) {
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
  },

  /**
   * Speak text immediately, regardless of mode. Used when the user explicitly
   * triggers it (button click) or when realtime talk reports an error.
   */
  speakNow(text: string) {
    const cleaned = text.trim();
    if (!cleaned) return;
    speakNow(cleaned);
  },

  /**
   * Speak the text only if (a) mode allows it, (b) we haven't recently spoken
   * the same text. `source` is informational for logging.
   *
   * - mode=off: never speaks
   * - mode=auto: speaks only when this function is called after a window of
   *   silence (caller is responsible for the timing decision)
   * - mode=always: speaks every call
   */
  speakIfAllowed(text: string, _source: "sidecar-timeout" | "sidecar-error" | "manual") {
    if (mode === "off") return;
    const cleaned = text.trim();
    if (!cleaned) return;
    if (recentlySpokenTexts.has(cleaned)) return;
    speakNow(cleaned);
  },

  /**
   * Cancel any in-flight utterance (e.g. when the user hits Stop).
   */
  stop() {
    if (!isAvailable()) return;
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  },
};

export type WebSpeechFallbackMode = FallbackMode;
