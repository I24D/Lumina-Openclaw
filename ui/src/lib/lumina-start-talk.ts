import { readAvatarGatewayContext, registerAvatarGatewayReset } from "./identity-avatar-context.ts";

const PROBE_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 10_000;

// Whether Start Talk exists is a property of the host the Gateway runs on, so
// the answer is cached per gateway context and dropped when the UI switches
// gateways. Only a definitive answer is cached: an unreachable gateway leaves
// the slot empty so the next attempt asks again.
let available: boolean | null = null;
let probe: Promise<void> | null = null;
// Bumped on every gateway switch so an answer that was already in flight for
// the previous gateway cannot land in the new one's slot.
let generation = 0;

registerAvatarGatewayReset(() => {
  available = null;
  probe = null;
  generation += 1;
});

function gatewayRequest(method: "GET" | "POST", timeoutMs: number): Promise<Response> {
  const { origin, authHeader } = readAvatarGatewayContext();
  return fetch(`${origin ?? ""}/lumina/start-talk`, {
    method,
    credentials: "include",
    ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * What a microphone click reads synchronously; `null` while the first probe is
 * still in flight. The answer has to be known before the click, because
 * choosing inside an await spends the user activation the fallback window
 * needs.
 */
export function isLuminaStartTalkAvailable(): boolean | null {
  return available;
}

/**
 * Asks the Gateway once whether the Lumina Start Talk desktop app is installed
 * on its host. Safe to call from render: the answer is cached and concurrent
 * callers share one request.
 */
export function primeLuminaStartTalk(): void {
  if (available !== null || probe) {
    return;
  }
  const asked = generation;
  probe = (async () => {
    try {
      const response = await gatewayRequest("GET", PROBE_TIMEOUT_MS);
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { available?: unknown };
      if (asked === generation) {
        available = body?.available === true;
      }
    } catch {
      // Not an answer, just an unreachable gateway — stay unknown and retry.
    }
  })().finally(() => {
    if (asked === generation) {
      probe = null;
    }
  });
}

/**
 * Hands voice off to the Lumina Start Talk desktop app.
 *
 * Start Talk is the voice UI of the Lumina family, so every session's
 * microphone opens it rather than the browser Talk window. Only the Gateway can
 * start a local process; `false` means this host could not, and the caller
 * keeps the built-in behaviour.
 */
export async function launchLuminaStartTalk(): Promise<boolean> {
  const asked = generation;
  try {
    const response = await gatewayRequest("POST", LAUNCH_TIMEOUT_MS);
    if (response.status === 503) {
      // The app went missing since the probe; stop claiming this host has it.
      if (asked === generation) {
        available = false;
      }
      return false;
    }
    return response.ok;
  } catch {
    return false;
  }
}
