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

export function openDetachedTalkWindow(): boolean {
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
