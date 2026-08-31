import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";

export const GOOGLE_REALTIME_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

export const GOOGLE_REALTIME_PROVIDER_CAPABILITIES = {
  transports: ["provider-websocket", "gateway-relay"],
  inputAudioFormats: [
    REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
    REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  ],
  outputAudioFormats: [
    REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
    REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  ],
  supportsBrowserSession: true,
  supportsBargeIn: true,
  handlesInputAudioBargeIn: true,
  supportsToolCalls: true,
  supportsVideoFrames: true,
  supportsSessionResumption: true,
} satisfies NonNullable<RealtimeVoiceProviderPlugin["capabilities"]>;
