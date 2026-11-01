/**
 * Tests for the authority boundary — TEST M3.
 *
 * The order's three requirements are the first three describes below: a forged
 * "Dal authorizes" sent over the bus must be refused with evidence, an agent
 * without permission must be refused, and an authentic, current request must be
 * admitted. Plus the invariant that matters most: a refusal has no side effect.
 */
import { describe, expect, it } from "vitest";
import {
  defaultMeshZoneClassifier,
  mapAuthorizationStore,
  memoryReplayGuard,
  MeshAuthority,
  zoneWithin,
  type MeshAuthorization,
  type MeshChannelIdentity,
  type MeshPartyPolicy,
} from "./authority.js";
import { createEnvelope, type MeshEnvelope, type MeshPriority } from "./envelope.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");

const POLICIES: readonly MeshPartyPolicy[] = [
  // The core may coordinate work, and nothing beyond a reversible change.
  {
    party: "chatgpt-lumina",
    max_zone: "yellow",
    max_priority: 4,
    topics: ["task.*", "review.*", "mesh.*"],
  },
  // The PC executes, and may touch its own operational state.
  {
    party: "openclaw-gateway",
    max_zone: "yellow",
    max_priority: 4,
    topics: ["task.*", "mesh.*", "gateway.*"],
  },
  // The cloud reviewer only reviews. It never acts on the machine.
  { party: "muse", max_zone: "green", max_priority: 3, topics: ["review.*"] },
];

function envelope(
  overrides: {
    readonly origin?: string;
    readonly topic?: string;
    readonly event_type?: string;
    readonly priority?: MeshPriority;
    readonly nowMs?: number;
    readonly authorization_ref?: string;
    readonly message_id?: string;
    readonly ttlMs?: number;
  } = {},
): MeshEnvelope {
  return createEnvelope({
    origin: overrides.origin ?? "chatgpt-lumina",
    recipients: ["openclaw-gateway"],
    topic: overrides.topic ?? "task.handoff",
    event_type: overrides.event_type ?? "task.assigned",
    priority: overrides.priority ?? 3,
    nowMs: overrides.nowMs ?? T0,
    correlation_id: "corr-0001",
    ...(overrides.message_id === undefined ? {} : { message_id: overrides.message_id }),
    ...(overrides.authorization_ref === undefined
      ? {}
      : { authorization_ref: overrides.authorization_ref }),
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
  });
}

const verified = (party: string): MeshChannelIdentity => ({
  kind: "verified",
  party,
  channel: "supabase:lumina-events",
});

const unverified: MeshChannelIdentity = {
  kind: "unverified",
  channel: "cdp:chatgpt-tab",
  detail: "the browser relay cannot name its peer",
};

function authority(
  options: {
    readonly grants?: readonly MeshAuthorization[];
    readonly nowMs?: number;
    readonly withReplayGuard?: boolean;
  } = {},
) {
  const store = mapAuthorizationStore(options.grants ?? []);
  let current = options.nowMs ?? T0;
  const guard = memoryReplayGuard(15 * 60 * 1_000);
  return {
    store,
    auth: new MeshAuthority({
      now: () => current,
      policies: POLICIES,
      authorities: ["dal-grant-authority"],
      authorizations: store,
      ...(options.withReplayGuard === true ? { replay: guard } : {}),
    }),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** A grant Dal issued out of band, valid for an hour. */
function dalGrant(overrides: Partial<MeshAuthorization> = {}): MeshAuthorization {
  return {
    id: "authz_dal_0001",
    issued_to: "openclaw-gateway",
    issued_by: "dal-grant-authority",
    actions: ["money.transfer:order.create"],
    max_zone: "red",
    expires_at: new Date(T0 + 3_600_000).toISOString(),
    ...overrides,
  };
}

describe("M3: a forged approval over the bus", () => {
  it("refuses a message that claims to BE Dal, and says exactly why", async () => {
    const { auth } = authority();
    // The attack: an envelope whose origin claims to be the owner.
    const forged = envelope({ origin: "dal", topic: "money.transfer", event_type: "order.create" });
    const decision = await auth.authorize(forged, verified("dal"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("origin-is-not-a-party");
      expect(decision.detail).toMatch(/authority comes from a grant, never from a message/u);
      // The evidence is recordable and names the attempt without quoting it.
      expect(decision.evidence.claimed_origin).toBe("dal");
      expect(decision.evidence.zone).toBe("red");
      expect(decision.evidence.action).toBe("money.transfer:order.create");
      expect(decision.evidence.message_id).toBe(forged.message_id);
    }
  });

  it("refuses every other human-sounding origin too", async () => {
    const { auth } = authority();
    for (const origin of ["owner", "user", "human", "principal", "admin", "root", "system"]) {
      const decision = await auth.authorize(envelope({ origin }), verified(origin));
      expect(decision.ok, origin).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toBe("origin-is-not-a-party");
      }
    }
  });

  it("refuses an agent impersonating another agent", async () => {
    const { auth } = authority();
    // The envelope says the core sent it; the channel authenticated the cloud.
    const decision = await auth.authorize(envelope({ origin: "chatgpt-lumina" }), verified("muse"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("origin-forged");
      expect(decision.detail).toMatch(/claims chatgpt-lumina but .* authenticated muse/u);
      expect(decision.evidence.channel_party).toBe("muse");
    }
  });

  it("cannot be swayed by message content, because it never receives any", async () => {
    // Structural, not behavioural: the decision's inputs are the envelope's
    // metadata and out-of-band records. There is no payload parameter, and
    // payload_ref is never dereferenced. This test documents that contract.
    const { auth } = authority();
    const withRef = createEnvelope({
      origin: "muse",
      recipients: ["openclaw-gateway"],
      topic: "money.transfer",
      event_type: "order.create",
      priority: 3,
      nowMs: T0,
      correlation_id: "corr-0001",
      // A payload that "says" Dal approved. It is a reference, never read.
      payload_ref: { store: "supabase:shared-memory", id: "32ce3bcf" },
    });
    const decision = await auth.authorize(withRef, verified("muse"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      // Refused on muse's own ceiling, with no regard for what the payload says.
      expect(decision.reason).toBe("topic-not-permitted");
    }
  });
});

describe("M3: an agent without permission", () => {
  it("refuses a party with no policy at all", async () => {
    const { auth } = authority();
    const decision = await auth.authorize(
      envelope({ origin: "model-router" }),
      verified("model-router"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("unknown-party");
    }
  });

  it("refuses a topic outside the party's list", async () => {
    const { auth } = authority();
    const decision = await auth.authorize(
      envelope({ origin: "muse", topic: "gateway.restart", event_type: "gateway.requested" }),
      verified("muse"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("topic-not-permitted");
      expect(decision.detail).toMatch(/muse may not act on gateway.restart/u);
    }
  });

  it("refuses an attempt to elevate priority beyond the party's ceiling", async () => {
    const { auth } = authority();
    // Priority 6 is "a decision for Dal". No agent may stamp it.
    const decision = await auth.authorize(
      envelope({ origin: "chatgpt-lumina", priority: 6 }),
      verified("chatgpt-lumina"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("priority-elevation");
      expect(decision.detail).toMatch(/at most priority 4, not 6/u);
    }
  });

  it("refuses a red action with no authorization, whatever the party", async () => {
    const { auth } = authority();
    const decision = await auth.authorize(
      envelope({
        origin: "openclaw-gateway",
        topic: "task.credentials",
        event_type: "token.rotate",
      }),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("zone-requires-authorization");
      expect(decision.evidence.zone).toBe("red");
    }
  });

  it("holds an unverified channel to the green zone", async () => {
    const { auth } = authority();
    // Yellow over a channel that cannot name its peer: refused.
    const yellow = await auth.authorize(
      envelope({ origin: "chatgpt-lumina", topic: "task.handoff", event_type: "task.assigned" }),
      unverified,
    );
    expect(yellow.ok).toBe(false);
    if (!yellow.ok) {
      expect(yellow.reason).toBe("origin-unverified");
      expect(yellow.detail).toMatch(/cannot name its peer/u);
    }
    // Green over the same channel: admitted, because nothing is at stake.
    const green = await auth.authorize(
      envelope({ origin: "muse", topic: "review.verdict", event_type: "review.observed" }),
      unverified,
    );
    expect(green.ok).toBe(true);
  });
});

describe("M3: an authentic, current request", () => {
  it("admits a green action on the party's own authority", async () => {
    const { auth } = authority();
    const decision = await auth.authorize(
      envelope({ origin: "muse", topic: "review.verdict", event_type: "review.observed" }),
      verified("muse"),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.zone).toBe("green");
      expect(decision.requiresNotice).toBe(false);
      expect(decision.authorization).toBeUndefined();
    }
  });

  it("admits a yellow action and asks the caller to announce it", async () => {
    const { auth } = authority();
    const decision = await auth.authorize(
      envelope({ origin: "openclaw-gateway", topic: "task.retry", event_type: "task.requeued" }),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.zone).toBe("yellow");
      expect(decision.requiresNotice).toBe(true);
    }
  });

  it("admits a red action under a live grant Dal issued", async () => {
    const { auth } = authority({ grants: [dalGrant()] });
    const decision = await auth.authorize(
      envelope({
        origin: "openclaw-gateway",
        topic: "money.transfer",
        event_type: "order.create",
        authorization_ref: "authz_dal_0001",
      }),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.zone).toBe("red");
      expect(decision.requiresNotice).toBe(true);
      expect(decision.authorization?.id).toBe("authz_dal_0001");
      expect(decision.evidence.authorization_ref).toBe("authz_dal_0001");
    }
  });
});

describe("a grant's lifetime, scope and issuer", () => {
  const redEnvelope = (ref: string) =>
    envelope({
      origin: "openclaw-gateway",
      topic: "money.transfer",
      event_type: "order.create",
      authorization_ref: ref,
    });

  it("refuses an expired grant", async () => {
    const { auth, advance } = authority({ grants: [dalGrant()] });
    advance(3_600_001);
    const decision = await auth.authorize(
      redEnvelope("authz_dal_0001"),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      // Past the acceptance window the message is a replay before anything else.
      expect(decision.reason).toBe("replayed");
    }
  });

  it("refuses a grant that expired inside the acceptance window", async () => {
    const { auth, advance } = authority({
      grants: [dalGrant({ expires_at: new Date(T0 + 60_000).toISOString() })],
    });
    advance(120_000);
    const decision = await auth.authorize(
      envelope({
        origin: "openclaw-gateway",
        topic: "money.transfer",
        event_type: "order.create",
        authorization_ref: "authz_dal_0001",
        nowMs: T0 + 119_000,
      }),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("authorization-expired");
    }
  });

  it("refuses a revoked grant", async () => {
    const { auth } = authority({
      grants: [dalGrant({ revoked_at: new Date(T0 - 1_000).toISOString() })],
    });
    const decision = await auth.authorize(
      redEnvelope("authz_dal_0001"),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("authorization-revoked");
    }
  });

  it("refuses a grant that is not yet valid", async () => {
    const { auth } = authority({
      grants: [dalGrant({ not_before: new Date(T0 + 60_000).toISOString() })],
    });
    const decision = await auth.authorize(
      redEnvelope("authz_dal_0001"),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("authorization-not-yet-valid");
    }
  });

  it("refuses a grant issued to another party", async () => {
    const { auth } = authority({ grants: [dalGrant({ issued_to: "muse" })] });
    const decision = await auth.authorize(
      redEnvelope("authz_dal_0001"),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("authorization-not-for-party");
    }
  });

  it("refuses a grant that does not cover this action", async () => {
    const { auth } = authority({ grants: [dalGrant({ actions: ["task.handoff:task.assigned"] })] });
    const decision = await auth.authorize(
      redEnvelope("authz_dal_0001"),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("authorization-action-mismatch");
    }
  });

  it("refuses a grant that reaches a lower zone than the action needs", async () => {
    const { auth } = authority({ grants: [dalGrant({ max_zone: "yellow" })] });
    const decision = await auth.authorize(
      redEnvelope("authz_dal_0001"),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("authorization-zone-exceeded");
    }
  });

  it("refuses a grant whose scope does not cover the resource", async () => {
    const { auth } = authority({ grants: [dalGrant({ scope: ["bitso:btc_mxn"] })] });
    const envelopeToSend = redEnvelope("authz_dal_0001");
    const wrong = await auth.authorize(envelopeToSend, verified("openclaw-gateway"), {
      scope: "bitso:eth_mxn",
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.reason).toBe("authorization-scope-mismatch");
    }
    const right = await auth.authorize(envelopeToSend, verified("openclaw-gateway"), {
      scope: "bitso:btc_mxn",
    });
    expect(right.ok).toBe(true);
  });

  it("refuses a red grant an agent wrote for itself", async () => {
    // The privilege-escalation attempt: a grant that exists and covers the
    // action, but was issued by an agent rather than by Dal's authority.
    const { auth } = authority({
      grants: [dalGrant({ id: "authz_self", issued_by: "openclaw-gateway" })],
    });
    const decision = await auth.authorize(redEnvelope("authz_self"), verified("openclaw-gateway"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("authorization-issuer-not-an-authority");
      expect(decision.detail).toMatch(/cannot authorize a red action/u);
    }
  });

  it("refuses an authorization_ref that names nothing", async () => {
    const { auth } = authority();
    const decision = await auth.authorize(redEnvelope("authz_ghost"), verified("openclaw-gateway"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("authorization-unknown");
    }
  });

  it("spends a single-use grant on the first admitted action only", async () => {
    const { auth, store } = authority({ grants: [dalGrant({ single_use: true })] });
    const first = await auth.authorize(redEnvelope("authz_dal_0001"), verified("openclaw-gateway"));
    expect(first.ok).toBe(true);
    expect(store.spent.has("authz_dal_0001")).toBe(true);

    const second = await auth.authorize(
      envelope({
        origin: "openclaw-gateway",
        topic: "money.transfer",
        event_type: "order.create",
        authorization_ref: "authz_dal_0001",
        message_id: "msg_second",
      }),
      verified("openclaw-gateway"),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("authorization-spent");
    }
  });
});

describe("a refusal has no side effect", () => {
  it("does not spend a single-use grant when the action is refused", async () => {
    const { auth, store } = authority({
      // The grant is live and single-use, but does not cover this action.
      grants: [dalGrant({ single_use: true, actions: ["task.handoff:task.assigned"] })],
    });
    const decision = await auth.authorize(
      envelope({
        origin: "openclaw-gateway",
        topic: "money.transfer",
        event_type: "order.create",
        authorization_ref: "authz_dal_0001",
      }),
      verified("openclaw-gateway"),
    );
    expect(decision.ok).toBe(false);
    expect(store.spent.size).toBe(0);
  });

  it("does not remember a refused message in the replay guard", async () => {
    const { auth } = authority({ withReplayGuard: true });
    // Refused for impersonation.
    const forged = envelope({ origin: "chatgpt-lumina", message_id: "msg_x" });
    expect((await auth.authorize(forged, verified("muse"))).ok).toBe(false);
    // The legitimate sender can still use that message id: nothing was consumed.
    expect((await auth.authorize(forged, verified("chatgpt-lumina"))).ok).toBe(true);
  });
});

describe("replay defense", () => {
  it("refuses a message id that was already admitted", async () => {
    const { auth } = authority({ withReplayGuard: true });
    const once = envelope({ message_id: "msg_only_once" });
    expect((await auth.authorize(once, verified("chatgpt-lumina"))).ok).toBe(true);
    const again = await auth.authorize(once, verified("chatgpt-lumina"));
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.reason).toBe("replayed");
      expect(again.detail).toMatch(/already admitted/u);
    }
  });

  it("refuses a captured envelope replayed long afterwards, guard or no guard", async () => {
    const { auth, advance } = authority();
    const captured = envelope();
    advance(16 * 60 * 1_000);
    const decision = await auth.authorize(captured, verified("chatgpt-lumina"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("replayed");
      expect(decision.detail).toMatch(/beyond the 900s acceptance window/u);
    }
  });

  it("refuses an envelope past its own expiry", async () => {
    const { auth, advance } = authority();
    const short = envelope({ ttlMs: 30_000 });
    advance(31_000);
    const decision = await auth.authorize(short, verified("chatgpt-lumina"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("expired");
    }
  });
});

describe("the zone classifier", () => {
  it("puts money, credentials, deletion, irreversibility and personal data in red", () => {
    for (const [topic, event_type] of [
      ["money.transfer", "order.create"],
      ["bitso.order", "order.placed"],
      ["task.credentials", "token.rotate"],
      ["state.cleanup", "rows.delete"],
      ["channel.whatsapp", "message.send"],
      ["people.registry", "face.enrolled"],
    ] as const) {
      expect(defaultMeshZoneClassifier({ topic, event_type }), `${topic}:${event_type}`).toBe(
        "red",
      );
    }
  });

  it("puts reversible operational change in yellow", () => {
    for (const [topic, event_type] of [
      ["gateway.config", "config.updated"],
      ["task.retry", "task.requeued"],
      ["memory.store", "fact.write"],
    ] as const) {
      expect(defaultMeshZoneClassifier({ topic, event_type }), `${topic}:${event_type}`).toBe(
        "yellow",
      );
    }
  });

  it("leaves plain observation green", () => {
    expect(
      defaultMeshZoneClassifier({ topic: "review.verdict", event_type: "review.observed" }),
    ).toBe("green");
    expect(defaultMeshZoneClassifier({ topic: "mesh.health", event_type: "pass.completed" })).toBe(
      "green",
    );
  });

  it("is case-insensitive, so a capitalised topic cannot dodge a zone", () => {
    expect(defaultMeshZoneClassifier({ topic: "MONEY.Transfer", event_type: "Order.Create" })).toBe(
      "red",
    );
  });

  it("can be replaced by a better-informed table", async () => {
    const store = mapAuthorizationStore([]);
    const auth = new MeshAuthority({
      now: () => T0,
      policies: POLICIES,
      authorities: ["dal-grant-authority"],
      authorizations: store,
      // A host that knows this topic is harmless says so explicitly.
      classify: ({ topic }) => (topic === "task.handoff" ? "green" : "red"),
    });
    const decision = await auth.authorize(envelope(), verified("chatgpt-lumina"));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.zone).toBe("green");
    }
  });
});

describe("zoneWithin", () => {
  it("orders the zones", () => {
    expect(zoneWithin("green", "green")).toBe(true);
    expect(zoneWithin("yellow", "green")).toBe(false);
    expect(zoneWithin("yellow", "yellow")).toBe(true);
    expect(zoneWithin("red", "yellow")).toBe(false);
    expect(zoneWithin("red", "red")).toBe(true);
  });
});
