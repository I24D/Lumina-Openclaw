type GatewayRequester = {
  request<T>(method: string, params?: unknown): Promise<T>;
};

// Whether Start Talk exists is a property of the host the Gateway runs on, so
// the answer is cached rather than asked again on every render. It is asked
// over the Control UI's own socket: this deployment authenticates that socket
// by tailnet identity, while an HTTP route would demand a bearer token the
// browser never stored, and every probe would come back 401.
let available: boolean | null = null;
let probe: Promise<void> | null = null;
// Bumped whenever the client changes so an answer already in flight for the
// previous gateway cannot land in the new one's slot.
let generation = 0;
let probedClient: GatewayRequester | null = null;

/**
 * What a microphone click reads synchronously; `null` until the first answer
 * arrives. The answer has to be known before the click, because choosing inside
 * an await spends the user activation the fallback window needs.
 */
export function isLuminaStartTalkAvailable(): boolean | null {
  return available;
}

/**
 * Asks the Gateway whether the Lumina Start Talk desktop app is installed on
 * its host. Safe to call from render: at most one request is in flight, and the
 * question is asked again only when the connection changes.
 */
export function primeLuminaStartTalk(client: GatewayRequester | null): void {
  if (!client) {
    return;
  }
  if (client !== probedClient) {
    // A new socket may reach a different host; the previous answer is not
    // evidence about this one.
    available = null;
    probedClient = client;
    generation += 1;
  } else if (probe || available !== null) {
    return;
  }
  const asked = generation;
  probe = client
    .request<{ available?: unknown }>("lumina.startTalk.status")
    .then((result) => {
      if (asked === generation) {
        available = result?.available === true;
      }
    })
    .catch(() => {
      // An unadvertised method or a dropped socket is not an answer; leave the
      // slot empty so the next render can ask again.
    })
    .finally(() => {
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
export async function launchLuminaStartTalk(client: GatewayRequester | null): Promise<boolean> {
  if (!client) {
    return false;
  }
  const asked = generation;
  try {
    const result = await client.request<{ opened?: unknown }>("lumina.startTalk.open");
    const opened = result?.opened === true;
    if (!opened && asked === generation) {
      // The app went missing since the probe; stop claiming this host has it.
      available = false;
    }
    return opened;
  } catch {
    return false;
  }
}
