// Delivers read-aloud text into every live Start Talk session.
//
// The realtime relay already owns a "speak this exact answer" protocol, used by the
// Discord and meeting surfaces. Reusing it keeps the user's hard rule intact: the
// voice reads the delivered text in full instead of summarizing it.
import { relaySessions, type RelaySession } from "../../gateway/talk-realtime-relay-state.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildRealtimeVoiceSpeakExactMessage } from "../../talk/exact-speech-protocol.js";

const log = createSubsystemLogger("lumina/read-aloud");

const SURFACE_LABEL = "the person listening on Start Talk";

function isSessionConnected(session: RelaySession): boolean {
  try {
    // The facade throws until the provider bridge has been adopted; a session in
    // that window is not ready to be spoken to yet.
    return session.bridge.bridge.isConnected();
  } catch {
    return false;
  }
}

/**
 * True while the session is mid-answer.
 *
 * Pushing text in during playback would cut the voice off mid-sentence, so the
 * caller keeps the item queued and tries again on the next tick instead.
 */
function isSessionSpeaking(session: RelaySession): boolean {
  try {
    return session.harness.isOutputPlaybackWindowActive();
  } catch {
    return false;
  }
}

/** True when at least one Start Talk session can hear something right now. */
export function hasLiveTalkSession(): boolean {
  for (const session of relaySessions.values()) {
    if (isSessionConnected(session)) {
      return true;
    }
  }
  return false;
}

/**
 * Speaks `text` verbatim in every connected Talk session.
 *
 * Returns how many sessions accepted it. Zero means the voice is off, and the
 * caller drops the item rather than queueing stale news for the next session.
 */
export function speakToLiveTalkSessions(text: string): number {
  const message = buildRealtimeVoiceSpeakExactMessage({ text, surfaceLabel: SURFACE_LABEL });
  let delivered = 0;
  for (const session of relaySessions.values()) {
    if (!isSessionConnected(session) || isSessionSpeaking(session)) {
      continue;
    }
    try {
      session.bridge.sendUserMessage(message);
      delivered += 1;
    } catch (err: unknown) {
      log.debug(`read-aloud delivery failed session=${session.id}: ${formatErrorMessage(err)}`);
    }
  }
  return delivered;
}
