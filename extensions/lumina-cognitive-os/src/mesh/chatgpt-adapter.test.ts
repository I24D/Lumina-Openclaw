/**
 * Tests for the ChatGPT adapter.
 *
 * The point of these is what the adapter refuses to claim: no route is a
 * background listener, nothing is enabled by default, and a message the server
 * did not keep is not delivered.
 */
import { describe, expect, it } from "vitest";
import {
  CHATGPT_ROUTES,
  createChatGptMeshTransport,
  describeInboundCapability,
  renderEnvelopeForChatGpt,
  type ChatGptRelay,
} from "./chatgpt-adapter.js";
import { createEnvelope, type MeshEnvelope } from "./envelope.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");

function envelope(overrides: { readonly requires_ack?: boolean } = {}): MeshEnvelope {
  return createEnvelope({
    origin: "openclaw-gateway",
    recipients: ["chatgpt-lumina"],
    topic: "mesh.report",
    event_type: "report.ready",
    priority: 3,
    nowMs: T0,
    message_id: "msg_fixed",
    correlation_id: "corr_fixed",
    payload_ref: { store: "supabase:shared-memory", id: "32ce3bcf", sha256: "a".repeat(64) },
    evidence_refs: [{ store: "file", id: "MESH.md" }],
    authorization_ref: "authz_dal_0001",
    ...(overrides.requires_ack === undefined ? {} : { requires_ack: overrides.requires_ack }),
  });
}

/** A relay whose outcome the test chooses, recording what it was asked to send. */
function fakeRelay(name = "fake-voice") {
  const sent: string[] = [];
  let next: Awaited<ReturnType<ChatGptRelay["send"]>> | (() => never) = { ok: true, stored: true };
  const relay: ChatGptRelay = {
    name,
    async send(text) {
      sent.push(text);
      // Copied to a local const: `next` is a `let` in the enclosing scope, so
      // TypeScript does not narrow it inside this nested function.
      const outcome = next;
      if (typeof outcome === "function") {
        outcome();
        throw new Error("the configured thrower returned instead of throwing");
      }
      return outcome;
    },
  };
  return {
    relay,
    sent,
    set(value: typeof next) {
      next = value;
    },
  };
}

describe("the routes it describes", () => {
  it("names the three that exist and no others", () => {
    expect(CHATGPT_ROUTES.map((route) => route.id)).toEqual([
      "mcp-stdio",
      "cdp-voice-bridge",
      "legacy-cdp-relay",
    ]);
  });

  it("says none of them is a background listener", () => {
    for (const route of CHATGPT_ROUTES) {
      expect(route.backgroundListener, route.id).toBe(false);
    }
  });

  it("says none of them needs a new credential or costs money", () => {
    for (const route of CHATGPT_ROUTES) {
      expect(route.requiresNewCredential, route.id).toBe(false);
      expect(route.costsMoney, route.id).toBe(false);
    }
  });

  it("says none of them is enabled by default", () => {
    for (const route of CHATGPT_ROUTES) {
      expect(route.enabledByDefault, route.id).toBe(false);
    }
  });

  it("says every one of them needs a person's session alive", () => {
    for (const route of CHATGPT_ROUTES) {
      expect(route.requiresHumanPresent, route.id).toBe(true);
    }
  });

  it("reports that the mesh cannot receive from the core unattended", () => {
    const inbound = describeInboundCapability();
    expect(inbound.canReceiveUnattended).toBe(false);
    expect(inbound.reason).toMatch(/ChatGPT calls/u);
    expect(inbound.reason).toMatch(/not in the Realtime publication/u);
    expect(inbound.routes.map((route) => route.id)).toEqual(["mcp-stdio", "legacy-cdp-relay"]);
  });
});

describe("renderEnvelopeForChatGpt", () => {
  it("carries metadata and references, never a payload body", () => {
    const line = renderEnvelopeForChatGpt(envelope());
    expect(line).toContain("[mesh] mesh.report / report.ready (p3)");
    expect(line).toContain("from openclaw-gateway");
    expect(line).toContain("message msg_fixed");
    expect(line).toContain("payload supabase:shared-memory:32ce3bcf");
    expect(line).toContain("evidence file:MESH.md");
    expect(line).toContain("authorization authz_dal_0001");
    // A reference, not its contents, and no hash dumped into the chat.
    expect(line).not.toContain("a".repeat(64));
  });

  it("mentions an expected ack only when one is expected", () => {
    expect(renderEnvelopeForChatGpt(envelope({ requires_ack: true }))).toContain(
      "an ack is expected",
    );
    expect(renderEnvelopeForChatGpt(envelope({ requires_ack: false }))).not.toContain(
      "an ack is expected",
    );
  });

  it("omits the optional parts when the envelope has none", () => {
    const bare = createEnvelope({
      origin: "muse",
      recipients: ["chatgpt-lumina"],
      topic: "review.verdict",
      event_type: "review.approved",
      priority: 2,
      nowMs: T0,
      message_id: "msg_bare",
      correlation_id: "corr_bare",
    });
    const line = renderEnvelopeForChatGpt(bare);
    expect(line).not.toContain("payload");
    expect(line).not.toContain("evidence");
    expect(line).not.toContain("authorization");
  });
});

describe("the transport", () => {
  it("refuses while disabled, and says how to turn it on", async () => {
    const transport = createChatGptMeshTransport();
    const result = await transport.send(envelope(), "chatgpt-lumina");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/disabled/u);
      expect(result.error).toMatch(/no credential or spend is involved/u);
    }
    expect(transport.name).toBe("chatgpt:unconfigured");
  });

  it("refuses when enabled with no relay", async () => {
    const result = await createChatGptMeshTransport({ enabled: true }).send(
      envelope(),
      "chatgpt-lumina",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no relay was supplied/u);
    }
  });

  it("refuses a recipient it does not serve", async () => {
    const relay = fakeRelay();
    const transport = createChatGptMeshTransport({ relay: relay.relay, enabled: true });
    const result = await transport.send(envelope(), "muse");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/serves chatgpt-lumina, not muse/u);
    }
    expect(relay.sent).toEqual([]);
  });

  it("delivers through the relay when wired, and names the route", async () => {
    const relay = fakeRelay();
    const transport = createChatGptMeshTransport({ relay: relay.relay, enabled: true });
    expect(transport.name).toBe("chatgpt:fake-voice");
    const result = await transport.send(envelope(), "chatgpt-lumina");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref).toBe("chatgpt:msg_fixed");
    }
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]).toContain("[mesh] mesh.report");
  });

  it("does not call a message delivered when the server did not keep it", async () => {
    // The bridge's local bubble is not proof: a chat that stopped persisting
    // shows the message and loses it on reload.
    const relay = fakeRelay();
    relay.set({ ok: true, stored: false });
    const result = await createChatGptMeshTransport({ relay: relay.relay, enabled: true }).send(
      envelope(),
      "chatgpt-lumina",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/could not confirm the server kept the message/u);
    }
  });

  it("passes a relay failure through with its own retry verdict", async () => {
    const relay = fakeRelay();
    relay.set({ ok: false, error: "browser not reachable", retryable: true });
    const retryable = await createChatGptMeshTransport({ relay: relay.relay, enabled: true }).send(
      envelope(),
      "chatgpt-lumina",
    );
    expect(retryable.ok).toBe(false);
    if (!retryable.ok) {
      expect(retryable.retryable).toBe(true);
      expect(retryable.error).toMatch(/fake-voice: browser not reachable/u);
    }

    relay.set({ ok: false, error: "refused to write over a draft", retryable: false });
    const terminal = await createChatGptMeshTransport({ relay: relay.relay, enabled: true }).send(
      envelope(),
      "chatgpt-lumina",
    );
    if (!terminal.ok) {
      expect(terminal.retryable).toBe(false);
    }
  });

  it("treats a relay that throws as retryable", async () => {
    const relay = fakeRelay();
    relay.set(() => {
      throw new Error("CDP port closed");
    });
    const result = await createChatGptMeshTransport({ relay: relay.relay, enabled: true }).send(
      envelope(),
      "chatgpt-lumina",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/fake-voice threw: CDP port closed/u);
    }
  });

  it("can serve another party when told to", async () => {
    const relay = fakeRelay();
    const transport = createChatGptMeshTransport({
      relay: relay.relay,
      enabled: true,
      party: "chatgpt-lumina-research",
    });
    expect((await transport.send(envelope(), "chatgpt-lumina")).ok).toBe(false);
    expect((await transport.send(envelope(), "chatgpt-lumina-research")).ok).toBe(true);
  });
});
