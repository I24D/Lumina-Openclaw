import {
  isLuminaStartTalkAvailable,
  launchLuminaStartTalk,
  primeLuminaStartTalk,
} from "../../lib/lumina-start-talk.ts";
import {
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../lib/open-external-url.ts";

type DetachedTalkAutostartState = {
  connected: boolean;
  realtimeTalkSession: unknown;
  realtimeTalkActive: boolean;
  sessionKey: string;
  toggleRealtimeTalk: () => void | Promise<void>;
};

function currentBrowserUrl(): URL | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return new URL(window.location.href);
  } catch {
    return null;
  }
}

export function isDetachedTalkWindow(): boolean {
  return currentBrowserUrl()?.searchParams.get("talk") === "1";
}

function shouldAutostartDetachedTalk(): boolean {
  return currentBrowserUrl()?.searchParams.get("autostart") === "1";
}

function openDetachedTalkWindow(): boolean {
  const url = currentBrowserUrl();
  if (!url || typeof window === "undefined") {
    return false;
  }
  url.searchParams.set("talk", "1");
  url.searchParams.set("autostart", "1");
  const safeUrl = resolveSafeExternalUrl(url.toString(), window.location.href);
  if (!safeUrl) {
    return false;
  }
  const opened = reserveExternalWindowForDeferredNavigation();
  if (opened) {
    opened.location.href = safeUrl;
    opened.focus();
    return true;
  }
  window.location.assign(safeUrl);
  return true;
}

/**
 * Asks ahead of the click whether this Gateway's host can run Start Talk. The
 * answer is cached after one round trip, so this is safe to call from render —
 * and it has to be known before the tap, because `openVoiceUi` cannot await.
 */
export function primeVoiceUi(talkWindow: boolean): void {
  if (!talkWindow) {
    primeLuminaStartTalk();
  }
}

/**
 * Opens the voice UI for a microphone tap.
 *
 * Start Talk is the voice UI of the Lumina family, so it wins on any host that
 * has it, in every session. The choice is synchronous on purpose: deciding
 * inside an await would spend the click's user activation, and the fallback
 * would then navigate this tab instead of opening its own window. A host
 * without Start Talk — or a probe that has not answered yet — keeps the
 * built-in detached Talk window.
 */
export function openVoiceUi(): void {
  if (isLuminaStartTalkAvailable() !== true) {
    openDetachedTalkWindow();
    return;
  }
  void launchLuminaStartTalk().then((opened) => {
    if (!opened) {
      openDetachedTalkWindow();
    }
  });
}

export class DetachedTalkAutostartController {
  private startedSessionKey: string | null = null;

  sync(
    state: DetachedTalkAutostartState,
    talkWindow: boolean,
    currentState: () => DetachedTalkAutostartState | null | undefined,
  ): void {
    if (!talkWindow || !shouldAutostartDetachedTalk()) {
      this.startedSessionKey = null;
      return;
    }
    if (!state.connected || state.realtimeTalkSession || state.realtimeTalkActive) {
      return;
    }
    if (this.startedSessionKey === state.sessionKey) {
      return;
    }
    this.startedSessionKey = state.sessionKey;
    queueMicrotask(() => {
      if (
        currentState() !== state ||
        !isDetachedTalkWindow() ||
        !state.connected ||
        state.realtimeTalkSession ||
        state.realtimeTalkActive
      ) {
        return;
      }
      void state.toggleRealtimeTalk();
    });
  }
}
