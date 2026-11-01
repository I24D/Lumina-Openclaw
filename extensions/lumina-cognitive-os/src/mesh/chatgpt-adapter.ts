/**
 * chatgpt-adapter.ts — Reaching the ChatGPT/Lumina core from the mesh.
 *
 * Phase E of the mesh order, with its constraint stated plainly: "sin fingir
 * oyente persistente y sin contratar API/credenciales". So this module is
 * deliberately modest. It is a real, invocable transport over a route that
 * already exists, and it is explicit about the one thing it cannot do.
 *
 * ## There is no background listener, and this module cannot pretend otherwise
 *
 * Every route's `backgroundListener` field is the literal type `false`. No
 * configuration, no option and no caller can set it to anything else, so no
 * code built on this module can claim the ChatGPT session is listening to the
 * bus while nobody is looking. Inbound traffic only arrives when ChatGPT itself
 * calls the MCP server, which is a pull, not a subscription.
 *
 * ## The three routes that exist, and what each really is
 *
 * 1. `mcp-stdio` — `extensions/chatgpt-bridge/scripts/lumina-mcp-server.mjs`.
 *    ChatGPT desktop is the *caller*: it invokes tools against a fixed session.
 *    Inbound only. Nothing here can push through it.
 * 2. `cdp-voice-bridge` — the operator tool at
 *    `~/.claude/tools/lumina-voice/lumina-voice.ts`, which types into the
 *    LUMINA VOICE tab of the operator's signed-in browser over CDP. Outbound
 *    only, and it needs that browser to be running, so it is not autonomous.
 *    This is the route `createChatGptMeshTransport` drives.
 * 3. `legacy-cdp-relay` — the older `@OPENCLAW:` marker relay, shipped with
 *    `enabledByDefault: false`. Left described, not used.
 *
 * None of the three needs a new credential or costs anything, which is exactly
 * why they are the three on offer. An API route would need both, so it is not
 * built here and is not configurable into existence.
 *
 * ## Disabled until someone turns it on
 *
 * The transport refuses, non-retryably, unless a relay is supplied and
 * `enabled` is true. A refusal names what is missing. That keeps an unconfigured
 * mesh from silently dropping messages addressed to the core.
 */
import type { MeshTransport, MeshTransportResult } from "./dispatcher.js";
import type { MeshEnvelope, MeshParty } from "./envelope.js";

/** A route to the core, described honestly. */
export type ChatGptRoute = {
  readonly id: "mcp-stdio" | "cdp-voice-bridge" | "legacy-cdp-relay";
  readonly direction: "inbound-only" | "outbound-only" | "bidirectional";
  /** True when a person's signed-in session or app must be running. */
  readonly requiresHumanPresent: boolean;
  readonly requiresNewCredential: boolean;
  readonly costsMoney: boolean;
  /**
   * Always `false`, as a type. None of these routes subscribes to anything, and
   * this field exists so no caller can compile a claim that one does.
   */
  readonly backgroundListener: false;
  readonly enabledByDefault: boolean;
  readonly path: string;
  readonly detail: string;
};

export const CHATGPT_ROUTES: readonly ChatGptRoute[] = Object.freeze([
  Object.freeze({
    id: "mcp-stdio",
    direction: "inbound-only",
    requiresHumanPresent: true,
    requiresNewCredential: false,
    costsMoney: false,
    backgroundListener: false,
    enabledByDefault: false,
    path: "extensions/chatgpt-bridge/scripts/lumina-mcp-server.mjs",
    detail:
      "ChatGPT desktop calls tools against the fixed agent:main:chatgpt-voice session with external_user provenance. A pull, so the mesh cannot push through it.",
  }),
  Object.freeze({
    id: "cdp-voice-bridge",
    direction: "outbound-only",
    requiresHumanPresent: true,
    requiresNewCredential: false,
    costsMoney: false,
    backgroundListener: false,
    enabledByDefault: false,
    path: "~/.claude/tools/lumina-voice/lumina-voice.ts",
    detail:
      "Types into the LUMINA VOICE tab over CDP using the operator's already signed-in browser. Verifies the server copy of the message. Needs that browser alive.",
  }),
  Object.freeze({
    id: "legacy-cdp-relay",
    direction: "bidirectional",
    requiresHumanPresent: true,
    requiresNewCredential: false,
    costsMoney: false,
    backgroundListener: false,
    enabledByDefault: false,
    path: "extensions/chatgpt-bridge",
    detail:
      "The older @OPENCLAW: marker relay. Ships disabled and its selectors are stale; described for completeness, not driven by this module.",
  }),
] as const);

/** What the mesh can honestly say about receiving from the core. */
export function describeInboundCapability(): {
  readonly canReceiveUnattended: false;
  readonly reason: string;
  readonly routes: readonly ChatGptRoute[];
} {
  return {
    canReceiveUnattended: false,
    reason:
      "the only inbound route is the MCP server, which ChatGPT calls; nothing subscribes to lumina_events on the core's behalf, and lumina_events is not in the Realtime publication either",
    routes: CHATGPT_ROUTES.filter((route) => route.direction !== "outbound-only"),
  };
}

/** The outbound relay this transport drives. Injected, so tests spawn nothing. */
export type ChatGptRelay = {
  readonly name: string;
  /**
   * Delivers one plain-text message. `stored` reports whether the relay could
   * confirm the server kept it: the bridge's own local echo is not proof.
   */
  send(
    text: string,
  ): Promise<
    | { readonly ok: true; readonly stored: boolean }
    | { readonly ok: false; readonly error: string; readonly retryable: boolean }
  >;
};

export type ChatGptAdapterOptions = {
  /** Absent means the route is not wired, and every send is refused. */
  readonly relay?: ChatGptRelay;
  /** Must be explicitly true. Defaults to disabled. */
  readonly enabled?: boolean;
  /** Which party this transport serves. Defaults to the core. */
  readonly party?: MeshParty;
};

/**
 * Renders an envelope as the one line the relay will carry.
 *
 * Metadata only: topic, event type, priority, ids and reference hashes. The
 * payload is a reference this module never dereferences, so a relayed line can
 * never become a copy of private content in the chat transcript.
 */
export function renderEnvelopeForChatGpt(envelope: MeshEnvelope): string {
  const parts = [
    `[mesh] ${envelope.topic} / ${envelope.event_type} (p${envelope.priority})`,
    `from ${envelope.origin}`,
    `message ${envelope.message_id}`,
    `effect ${envelope.idempotency_key}`,
  ];
  if (envelope.payload_ref) {
    parts.push(`payload ${envelope.payload_ref.store}:${envelope.payload_ref.id}`);
  }
  const refs = (envelope.evidence_refs ?? []).map((ref) => `${ref.store}:${ref.id}`);
  if (refs.length > 0) {
    parts.push(`evidence ${refs.join(", ")}`);
  }
  if (envelope.authorization_ref) {
    parts.push(`authorization ${envelope.authorization_ref}`);
  }
  if (envelope.requires_ack) {
    parts.push("an ack is expected");
  }
  return parts.join(" | ");
}

/**
 * A `MeshTransport` for the ChatGPT/Lumina core over the existing CDP bridge.
 *
 * Refusals are deliberately non-retryable when they are configuration problems:
 * retrying a route that was never wired eight times only hides the reason.
 * A relay that reports a transport failure is retried, because the browser
 * coming back is a normal event.
 */
export function createChatGptMeshTransport(options: ChatGptAdapterOptions = {}): MeshTransport {
  const party = options.party ?? "chatgpt-lumina";
  const enabled = options.enabled === true;
  const relay = options.relay;
  return {
    name: `chatgpt:${relay?.name ?? "unconfigured"}`,
    async send(envelope, recipient): Promise<MeshTransportResult> {
      if (recipient !== party) {
        return {
          ok: false,
          error: `this transport serves ${party}, not ${recipient}`,
          retryable: false,
        };
      }
      if (!enabled) {
        return {
          ok: false,
          error:
            "the ChatGPT route is disabled; pass enabled: true and a relay to turn it on (no credential or spend is involved)",
          retryable: false,
        };
      }
      if (!relay) {
        return {
          ok: false,
          error: "the ChatGPT route is enabled but no relay was supplied",
          retryable: false,
        };
      }
      let result: Awaited<ReturnType<ChatGptRelay["send"]>>;
      try {
        result = await relay.send(renderEnvelopeForChatGpt(envelope));
      } catch (error) {
        return {
          ok: false,
          error: `${relay.name} threw: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        };
      }
      if (!result.ok) {
        return { ok: false, error: `${relay.name}: ${result.error}`, retryable: result.retryable };
      }
      if (!result.stored) {
        // The bubble appeared but the server did not keep it. Reporting this as
        // delivered is how a lost message gets recorded as sent; it is retried.
        return {
          ok: false,
          error: `${relay.name} could not confirm the server kept the message`,
          retryable: true,
        };
      }
      return { ok: true, ref: `chatgpt:${envelope.message_id}` };
    },
  };
}
