import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import "./ui/app.ts";
import { webSpeechFallback } from "./ui/chat/web-speech-fallback.ts";

// Expose Web Speech fallback globally for debug & for the realtime-talk
// pipeline to invoke when the sidecar fails. Safe no-op if speechSynthesis
// is not available in this WebView.
(window as unknown as { luminaWebSpeech?: typeof webSpeechFallback }).luminaWebSpeech =
  webSpeechFallback;

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

declare const OPENCLAW_CONTROL_UI_BUILD_ID: string | undefined;

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;

if (isProd && "serviceWorker" in navigator) {
  const swUrl = new URL("./sw.js", window.location.href);
  swUrl.searchParams.set("v", OPENCLAW_CONTROL_UI_BUILD_ID || "dev");
  void navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });
} else if (!isProd && "serviceWorker" in navigator) {
  // Unregister any leftover dev SW to avoid stale cache issues.
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
}
