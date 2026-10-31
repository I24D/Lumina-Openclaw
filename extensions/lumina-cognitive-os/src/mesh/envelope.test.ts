/**
 * Tests for the LUMINA-MESH/1 envelope contract.
 *
 * These prove the contract's invariants at its own boundary: what a reader
 * accepts, what it refuses without throwing, and that an idempotency key names
 * an *effect* rather than a message.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  deriveIdempotencyKey,
  envelopeHash,
  isEnvelopeExpired,
  isMeshParty,
  MESH_MAX_EVIDENCE_REFS,
  MESH_MAX_RECIPIENTS,
  MESH_PROTOCOL,
  MESH_SCHEMA_VERSION,
  parseEnvelope,
  type MeshEnvelope,
  type NewEnvelopeInput,
} from "./envelope.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

function input(overrides: Partial<NewEnvelopeInput> = {}): NewEnvelopeInput {
  return {
    origin: "chatgpt-lumina",
    recipients: ["openclaw-gateway", "muse"],
    topic: "task.handoff",
    event_type: "task.assigned",
    priority: 3,
    nowMs: NOW,
    message_id: "msg_fixed_0001",
    correlation_id: "corr_0001",
    ...overrides,
  };
}

describe("createEnvelope", () => {
  it("fills the contract fields the caller left out", () => {
    const envelope = createEnvelope(input());
    expect(envelope.protocol).toBe(MESH_PROTOCOL);
    expect(envelope.schema_version).toBe(MESH_SCHEMA_VERSION);
    expect(envelope.created_at).toBe("2026-10-31T12:00:00.000Z");
    expect(envelope.conversation_id).toBe("corr_0001");
    expect(envelope.requires_ack).toBe(false);
    expect(envelope.idempotency_key).toMatch(/^imk_[0-9a-f]{32}$/u);
  });

  it("mints a sortable message id when the caller gives none", () => {
    const envelope = createEnvelope({ ...input(), message_id: undefined });
    expect(envelope.message_id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/u);
    // With no correlation id either, the message is its own correlation root.
    const root = createEnvelope({
      ...input(),
      message_id: undefined,
      correlation_id: undefined,
    });
    expect(root.correlation_id).toBe(root.message_id);
    expect(root.conversation_id).toBe(root.message_id);
  });

  it("turns a ttl into an expiry after created_at", () => {
    const envelope = createEnvelope(input({ ttlMs: 60_000 }));
    expect(envelope.expires_at).toBe("2026-10-31T12:01:00.000Z");
    expect(isEnvelopeExpired(envelope, NOW)).toBe(false);
    expect(isEnvelopeExpired(envelope, NOW + 59_999)).toBe(false);
    expect(isEnvelopeExpired(envelope, NOW + 60_000)).toBe(true);
  });

  it("never expires without a ttl", () => {
    expect(isEnvelopeExpired(createEnvelope(input()), NOW + 10 ** 12)).toBe(false);
  });

  it("refuses to build an envelope it could not parse back", () => {
    expect(() => createEnvelope(input({ topic: "Not A Topic" }))).toThrow(
      /invalid envelope.*topic/iu,
    );
  });
});

describe("deriveIdempotencyKey", () => {
  const effect = {
    origin: "chatgpt-lumina",
    recipients: ["openclaw-gateway", "muse"],
    topic: "task.handoff",
    event_type: "task.assigned",
    correlation_id: "corr_0001",
  } as const;

  it("is stable across a retry that mints a new message id and time", () => {
    const first = createEnvelope({ ...input(), message_id: "msg_a", nowMs: NOW });
    const retry = createEnvelope({ ...input(), message_id: "msg_b", nowMs: NOW + 90_000 });
    expect(retry.message_id).not.toBe(first.message_id);
    expect(retry.created_at).not.toBe(first.created_at);
    expect(retry.idempotency_key).toBe(first.idempotency_key);
  });

  it("ignores the order the caller listed recipients in", () => {
    expect(deriveIdempotencyKey({ ...effect, recipients: ["muse", "openclaw-gateway"] })).toBe(
      deriveIdempotencyKey(effect),
    );
  });

  it("changes when the intended effect changes", () => {
    const base = deriveIdempotencyKey(effect);
    expect(deriveIdempotencyKey({ ...effect, topic: "task.other" })).not.toBe(base);
    expect(deriveIdempotencyKey({ ...effect, event_type: "task.cancelled" })).not.toBe(base);
    expect(deriveIdempotencyKey({ ...effect, origin: "muse" })).not.toBe(base);
    expect(deriveIdempotencyKey({ ...effect, correlation_id: "corr_0002" })).not.toBe(base);
    expect(deriveIdempotencyKey({ ...effect, recipients: ["muse"] })).not.toBe(base);
    expect(
      deriveIdempotencyKey({ ...effect, payload_ref: { store: "supabase:tasks", id: "t1" } }),
    ).not.toBe(base);
  });

  it("keeps a caller-supplied key untouched", () => {
    expect(createEnvelope(input({ idempotency_key: "imk_mine" })).idempotency_key).toBe("imk_mine");
  });
});

describe("parseEnvelope", () => {
  const valid = createEnvelope(input({ ttlMs: 60_000, requires_ack: true }));

  it("round-trips an envelope through JSON", () => {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip IS the contract under test: the envelope crosses PostgREST as JSON, and structuredClone would not exercise that.
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(valid)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope).toEqual(valid);
    }
  });

  it("reports a future schema version instead of guessing at it", () => {
    const parsed = parseEnvelope({ ...valid, schema_version: 2 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems).toEqual([
        { field: "schema_version", reason: "this reader understands version 1, got 2" },
      ]);
    }
  });

  it("reports a foreign protocol, so an old lumina_events row is not misread", () => {
    // Rows the gateway's fire-and-forget emitter wrote have no protocol field.
    const legacy = { origin: "openclaw-gateway", event_type: "gateway.started", priority: 3 };
    const parsed = parseEnvelope(legacy);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems.map((p) => p.field)).toContain("protocol");
    }
  });

  it("collects every bad field at once and never throws", () => {
    const parsed = parseEnvelope({
      protocol: MESH_PROTOCOL,
      schema_version: MESH_SCHEMA_VERSION,
      message_id: "",
      conversation_id: "c",
      correlation_id: "corr_0001",
      origin: "Not A Party",
      recipients: "muse",
      topic: "",
      event_type: "",
      priority: 9,
      created_at: "yesterday",
      idempotency_key: "k",
      requires_ack: "yes",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems.map((p) => p.field).toSorted()).toEqual(
        [
          "conversation_id",
          "created_at",
          "event_type",
          "idempotency_key",
          "message_id",
          "origin",
          "priority",
          "recipients",
          "requires_ack",
          "topic",
        ].toSorted(),
      );
    }
  });

  it("accepts the full 1-6 priority scale the column allows", () => {
    // Regression: validating 1-4 (as the commissioning order said) rejected the
    // priority-5 safety events `lumina_events` already holds in production.
    for (const priority of [1, 2, 3, 4, 5, 6]) {
      const parsed = parseEnvelope({ ...valid, priority });
      expect(parsed.ok, `priority ${priority}`).toBe(true);
    }
    for (const priority of [0, 7, -1, 2.5, "3", null]) {
      const parsed = parseEnvelope({ ...valid, priority });
      expect(parsed.ok, `priority ${String(priority)}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.problems[0]?.reason).toMatch(/1 to 6/u);
      }
    }
  });

  it("refuses an expiry that is not after creation", () => {
    const parsed = parseEnvelope({ ...valid, expires_at: valid.created_at });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems).toEqual([
        { field: "expires_at", reason: "must be after created_at" },
      ]);
    }
  });

  it("refuses a repeated or oversized recipient list", () => {
    const repeated = parseEnvelope({ ...valid, recipients: ["muse", "muse"] });
    expect(repeated.ok).toBe(false);
    const tooMany = parseEnvelope({
      ...valid,
      recipients: Array.from({ length: MESH_MAX_RECIPIENTS + 1 }, (_, i) => `agent-${i}`),
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.problems[0]?.reason).toMatch(/at most 16/u);
    }
  });

  it("accepts a broadcast record with no recipients", () => {
    expect(parseEnvelope({ ...valid, recipients: [] }).ok).toBe(true);
  });

  it("requires references to be identified, and hashes to be real hashes", () => {
    expect(parseEnvelope({ ...valid, payload_ref: { store: "supabase:tasks" } }).ok).toBe(false);
    expect(parseEnvelope({ ...valid, payload_ref: { store: "Bad Store", id: "x" } }).ok).toBe(
      false,
    );
    expect(
      parseEnvelope({ ...valid, payload_ref: { store: "file", id: "x", sha256: "nope" } }).ok,
    ).toBe(false);
    expect(
      parseEnvelope({
        ...valid,
        payload_ref: { store: "file", id: "x", sha256: "a".repeat(64), bytes: 10 },
      }).ok,
    ).toBe(true);
  });

  it("caps evidence references", () => {
    const refs = Array.from({ length: MESH_MAX_EVIDENCE_REFS + 1 }, (_, i) => ({
      store: "supabase:lumina-events",
      id: `e${i}`,
    }));
    expect(parseEnvelope({ ...valid, evidence_refs: refs }).ok).toBe(false);
  });

  it("refuses a non-object", () => {
    for (const bad of [null, undefined, 7, "x", []]) {
      expect(parseEnvelope(bad).ok).toBe(false);
    }
  });
});

describe("isMeshParty", () => {
  it("accepts agent ids and refuses anything that would need escaping", () => {
    expect(isMeshParty("chatgpt-lumina")).toBe(true);
    expect(isMeshParty("muse")).toBe(true);
    expect(isMeshParty("Dal")).toBe(false);
    expect(isMeshParty("a")).toBe(false);
    expect(isMeshParty("has space")).toBe(false);
    expect(isMeshParty("semi;colon")).toBe(false);
    expect(isMeshParty(42)).toBe(false);
  });
});

describe("canonicalJson and envelopeHash", () => {
  it("sorts keys and drops undefined so equal values hash alike", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("keeps array order, which carries meaning", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });

  it("hashes an envelope to a stable digest", () => {
    const envelope = createEnvelope(input());
    const hash = envelopeHash(envelope);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Re-reading the same envelope through JSON must not change its hash.
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- same reason: this asserts the hash survives a real JSON round trip.
    const reparsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(envelopeHash(reparsed.envelope)).toBe(hash);
    }
  });

  it("changes the hash when any field changes", () => {
    const envelope = createEnvelope(input());
    const tampered: MeshEnvelope = { ...envelope, priority: 4 };
    expect(envelopeHash(tampered)).not.toBe(envelopeHash(envelope));
  });
});
