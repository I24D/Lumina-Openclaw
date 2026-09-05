// Gateway RPC handlers for the Lumina Start Talk desktop voice UI.
// The microphone reaches these over the Control UI's authenticated socket: in a
// token-auth deployment reached through `tailscale serve`, the socket is
// authenticated by tailnet identity while plain HTTP routes still demand a
// bearer token the browser never stored. Riding the socket is what makes the
// button work in every session rather than only where a token was typed once.
import {
  launchLuminaStartTalk,
  luminaStartTalkAvailability,
} from "../../lumina/start-talk/launch.js";
import type { GatewayRequestHandlers } from "./types.js";

export const luminaHandlers: GatewayRequestHandlers = {
  "lumina.startTalk.status": async ({ respond }) => {
    respond(true, luminaStartTalkAvailability());
  },
  "lumina.startTalk.open": async ({ respond }) => {
    const launch = launchLuminaStartTalk();
    respond(
      true,
      launch.status === "launched" ? { opened: true } : { opened: false, reason: launch.reason },
    );
  },
};
