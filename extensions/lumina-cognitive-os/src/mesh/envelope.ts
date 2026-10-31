/**
 * envelope.ts — The LUMINA-MESH/1 message contract.
 *
 * One typed, versioned envelope carries every message between the three Lumina
 * agents: the ChatGPT/Lumina core, OpenClaw on the PC, and Muse in the cloud.
 * This module owns the contract and nothing else: no transport, no storage, no
 * clock of its own. Callers supply time and ids so tests are deterministic.
 *
 * What the envelope is NOT:
 *
 * - `origin` is a *claim*, not an identity. Authenticating it belongs to
 *   `authority.ts`; until that runs, treat `origin` as untrusted text (ADR 0006:
 *   untrusted content never executes). A message that says `origin: "dal"` grants
 *   nothing on its own.
 * - `payload_ref` and `evidence_refs` are references with hashes, never the
 *   payload. Sensitive content stays where it already lives; the mesh moves
 *   identifiers so an event log never becomes a copy of private data.
 *
 * Delivery semantics the contract commits to: **at least once**, with a logically
 * idempotent effect keyed by `idempotency_key`. End-to-end exactly-once is not
 * offered and must never be claimed; `inbox.ts` is what makes a repeated delivery
 * harmless.
 *
 * Version compatibility: `schema_version` is read before anything else, so an
 * older event stored before this module existed is recognized rather than
 * mis-parsed. `parseEnvelope` accepts version 1 and reports every other version
 * as an explicit, non-throwing failure.
 */
import { createHash } from "node:crypto";
import { newEntityId } from "../shared/ids.js";

/** The protocol name, stored on every envelope so a reader can tell what it is. */
export const MESH_PROTOCOL = "LUMINA-MESH";

/** The only schema version this module writes. Readers accept exactly this. */
export const MESH_SCHEMA_VERSION = 1;

/**
 * The bus priority scale, shared with `lumina_events.priority`.
 *
 * Six levels, matching the column's own constraint
 * (`lumina_events_priority_check: priority >= 1 AND priority <= 6`) and the
 * bus README: 1 noise, 2 normal, 3 relevant change, 4 error or risk,
 * 5 emergency, 6 a decision for Dal.
 *
 * The order that commissioned this module said 1-4. That is the narrower scale
 * the gateway's own emitter types (`src/lumina/cognitive-bus.ts`), not the bus
 * contract: production already holds `priority: 5` rows written by the Python
 * library (`contradiction.detected`, `safety.red_zone`). Validating 1-4 here
 * would reject live safety traffic, so the column's constraint wins.
 */
export type MeshPriority = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A party on the mesh: an agent id, lowercase and dashed. Kept open rather than
 * a closed union so a new agent does not need a contract change, and validated
 * so it can be used in a storage key and a URL query without escaping.
 */
export type MeshParty = string;

const PARTY_RE = /^[a-z][a-z0-9-]{1,38}$/u;

/**
 * Known parties, used by `authority.ts` for zone decisions, not for parsing.
 *
 * The first five are the origins `lumina_events` actually holds today; the last
 * two are the agents that write through this module. A party absent from this
 * list still parses — it simply has no authority mapping yet.
 */
export const KNOWN_MESH_PARTIES = Object.freeze([
  "openclaw-gateway",
  "openclaw",
  "openclaw-lumina",
  "muse",
  "model-router",
  "chatgpt-lumina",
  "claude-code",
] as const);

/** Whether `value` is shaped like a party id. Does not say it is authentic. */
export function isMeshParty(value: unknown): value is MeshParty {
  return typeof value === "string" && PARTY_RE.test(value);
}

/** A reference to content held elsewhere, identified and fingerprinted. */
export type MeshRef = {
  /** Where the content lives, e.g. `supabase:shared_memory`, `file`, `inline`. */
  readonly store: string;
  /** The id within that store. */
  readonly id: string;
  /** Lowercase hex SHA-256 of the referenced bytes, when the caller knows it. */
  readonly sha256?: string;
  /** Bytes referenced, when known. Lets a reader refuse an oversized fetch. */
  readonly bytes?: number;
};

const REF_STORE_RE = /^[a-z][a-z0-9:_-]{0,62}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
/**
 * A reference's id belongs to a foreign store, so a single character is
 * legitimate (a row keyed `7`). Mesh-minted ids keep the stricter `ID_RE`.
 */
const REF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * The LUMINA-MESH/1 envelope.
 *
 * Field names are snake_case because they are persisted as-is into
 * `lumina_events.context`, where PostgREST and SQL readers expect that shape.
 */
export type MeshEnvelope = {
  readonly protocol: typeof MESH_PROTOCOL;
  readonly schema_version: typeof MESH_SCHEMA_VERSION;
  /** Unique id of this message. The dedup key for readers and for ack rows. */
  readonly message_id: string;
  /** The long-running exchange this message belongs to. */
  readonly conversation_id: string;
  /** Shared by every message of one logical operation, across agents. */
  readonly correlation_id: string;
  /** The `message_id` that caused this one, when it was a reply or a follow-up. */
  readonly causation_id?: string;
  /** Claimed author. Authenticate with `authority.ts` before trusting it. */
  readonly origin: MeshParty;
  /** Intended readers. One ack row per entry; empty means a broadcast record. */
  readonly recipients: readonly MeshParty[];
  /** Routing subject, e.g. `task.handoff`, `review.verdict`. */
  readonly topic: string;
  /** What happened, e.g. `task.claimed`. Free text to stay compatible. */
  readonly event_type: string;
  readonly priority: MeshPriority;
  /** ISO-8601 UTC, supplied by the caller's clock. */
  readonly created_at: string;
  /** ISO-8601 UTC after which delivery is pointless and the message is dropped. */
  readonly expires_at?: string;
  /** Reference to the body. Never the body itself. */
  readonly payload_ref?: MeshRef;
  /** References backing the claim this message makes. */
  readonly evidence_refs?: readonly MeshRef[];
  /**
   * The key that makes a repeated delivery harmless. Two envelopes with the same
   * key describe the same intended effect and must produce exactly one.
   */
  readonly idempotency_key: string;
  /** The authorization this message acts under, checked in `authority.ts`. */
  readonly authorization_ref?: string;
  /** Whether the sender needs an ack before considering the message delivered. */
  readonly requires_ack: boolean;
};

const TOPIC_RE = /^[a-z][a-z0-9._-]{1,62}$/u;
const EVENT_TYPE_RE = /^[a-z][a-z0-9._-]{1,62}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** Hard ceiling on recipients, so one envelope cannot fan out without bound. */
export const MESH_MAX_RECIPIENTS = 16;

/** Hard ceiling on evidence references per envelope. */
export const MESH_MAX_EVIDENCE_REFS = 32;

/** A rejection: which field failed and why, for an event the reader can record. */
export type MeshEnvelopeProblem = {
  readonly field: string;
  readonly reason: string;
};

export type ParseEnvelopeResult =
  | { readonly ok: true; readonly envelope: MeshEnvelope }
  | { readonly ok: false; readonly problems: readonly MeshEnvelopeProblem[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkIsoUtc(
  value: unknown,
  field: string,
  problems: MeshEnvelopeProblem[],
): string | undefined {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) {
    problems.push({ field, reason: "must be an ISO-8601 UTC timestamp ending in Z" });
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) {
    problems.push({ field, reason: "is not a real date" });
    return undefined;
  }
  return value;
}

function parseRef(
  value: unknown,
  field: string,
  problems: MeshEnvelopeProblem[],
): MeshRef | undefined {
  if (!isRecord(value)) {
    problems.push({ field, reason: "must be an object" });
    return undefined;
  }
  const store = value.store;
  const id = value.id;
  if (typeof store !== "string" || !REF_STORE_RE.test(store)) {
    problems.push({ field: `${field}.store`, reason: "must be a lowercase store name" });
    return undefined;
  }
  if (typeof id !== "string" || !REF_ID_RE.test(id)) {
    problems.push({ field: `${field}.id`, reason: "must be a printable id of 1 to 128 chars" });
    return undefined;
  }
  const ref: { store: string; id: string; sha256?: string; bytes?: number } = { store, id };
  if (value.sha256 !== undefined) {
    if (typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256)) {
      problems.push({ field: `${field}.sha256`, reason: "must be lowercase hex SHA-256" });
      return undefined;
    }
    ref.sha256 = value.sha256;
  }
  if (value.bytes !== undefined) {
    if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
      problems.push({ field: `${field}.bytes`, reason: "must be a non-negative integer" });
      return undefined;
    }
    ref.bytes = value.bytes;
  }
  return ref;
}

/**
 * Validates an untrusted value as a LUMINA-MESH/1 envelope.
 *
 * This is the module's trust boundary: callers validate once here and then treat
 * the result as internal data, without re-validating or defensively copying it.
 * Every failure is reported, never thrown, so a bad message becomes a recorded
 * rejection instead of a crashed dispatcher.
 */
export function parseEnvelope(value: unknown): ParseEnvelopeResult {
  const problems: MeshEnvelopeProblem[] = [];
  if (!isRecord(value)) {
    return { ok: false, problems: [{ field: "", reason: "must be an object" }] };
  }

  // Version first: an envelope from a future writer is reported, not guessed at.
  if (value.protocol !== MESH_PROTOCOL) {
    problems.push({ field: "protocol", reason: `must be ${MESH_PROTOCOL}` });
  }
  if (value.schema_version !== MESH_SCHEMA_VERSION) {
    problems.push({
      field: "schema_version",
      reason: `this reader understands version ${MESH_SCHEMA_VERSION}, got ${String(value.schema_version)}`,
    });
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }

  for (const field of ["message_id", "conversation_id", "correlation_id", "idempotency_key"]) {
    const raw = value[field];
    if (typeof raw !== "string" || !ID_RE.test(raw)) {
      problems.push({ field, reason: "must be a printable id of 2 to 127 chars" });
    }
  }
  if (value.causation_id !== undefined) {
    if (typeof value.causation_id !== "string" || !ID_RE.test(value.causation_id)) {
      problems.push({ field: "causation_id", reason: "must be a printable id when present" });
    }
  }
  if (!isMeshParty(value.origin)) {
    problems.push({ field: "origin", reason: "must be a lowercase dashed agent id" });
  }
  if (!Array.isArray(value.recipients)) {
    problems.push({ field: "recipients", reason: "must be an array" });
  } else if (value.recipients.length > MESH_MAX_RECIPIENTS) {
    problems.push({
      field: "recipients",
      reason: `must hold at most ${MESH_MAX_RECIPIENTS} entries`,
    });
  } else if (!value.recipients.every((party) => isMeshParty(party))) {
    problems.push({ field: "recipients", reason: "every entry must be an agent id" });
  } else if (new Set(value.recipients).size !== value.recipients.length) {
    problems.push({ field: "recipients", reason: "must not repeat a recipient" });
  }
  if (typeof value.topic !== "string" || !TOPIC_RE.test(value.topic)) {
    problems.push({ field: "topic", reason: "must be a dotted lowercase subject" });
  }
  if (typeof value.event_type !== "string" || !EVENT_TYPE_RE.test(value.event_type)) {
    problems.push({ field: "event_type", reason: "must be a dotted lowercase event type" });
  }
  if (
    typeof value.priority !== "number" ||
    !Number.isInteger(value.priority) ||
    value.priority < 1 ||
    value.priority > 6
  ) {
    problems.push({ field: "priority", reason: "must be an integer from 1 to 6" });
  }
  const createdAt = checkIsoUtc(value.created_at, "created_at", problems);
  let expiresAt: string | undefined;
  if (value.expires_at !== undefined) {
    expiresAt = checkIsoUtc(value.expires_at, "expires_at", problems);
    if (createdAt && expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt)) {
      problems.push({ field: "expires_at", reason: "must be after created_at" });
    }
  }
  if (typeof value.requires_ack !== "boolean") {
    problems.push({ field: "requires_ack", reason: "must be a boolean" });
  }
  if (value.authorization_ref !== undefined) {
    if (typeof value.authorization_ref !== "string" || !ID_RE.test(value.authorization_ref)) {
      problems.push({ field: "authorization_ref", reason: "must be a printable id when present" });
    }
  }

  let payloadRef: MeshRef | undefined;
  if (value.payload_ref !== undefined) {
    payloadRef = parseRef(value.payload_ref, "payload_ref", problems);
  }
  let evidenceRefs: MeshRef[] | undefined;
  if (value.evidence_refs !== undefined) {
    if (!Array.isArray(value.evidence_refs)) {
      problems.push({ field: "evidence_refs", reason: "must be an array" });
    } else if (value.evidence_refs.length > MESH_MAX_EVIDENCE_REFS) {
      problems.push({
        field: "evidence_refs",
        reason: `must hold at most ${MESH_MAX_EVIDENCE_REFS} entries`,
      });
    } else {
      const parsed = value.evidence_refs.map((ref, index) =>
        parseRef(ref, `evidence_refs[${index}]`, problems),
      );
      if (parsed.every((ref): ref is MeshRef => ref !== undefined)) {
        evidenceRefs = parsed;
      }
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  const envelope: MeshEnvelope = {
    protocol: MESH_PROTOCOL,
    schema_version: MESH_SCHEMA_VERSION,
    message_id: value.message_id as string,
    conversation_id: value.conversation_id as string,
    correlation_id: value.correlation_id as string,
    ...(value.causation_id === undefined ? {} : { causation_id: value.causation_id as string }),
    origin: value.origin as MeshParty,
    recipients: Object.freeze([...(value.recipients as MeshParty[])]),
    topic: value.topic as string,
    event_type: value.event_type as string,
    priority: value.priority as MeshPriority,
    created_at: createdAt as string,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    ...(payloadRef === undefined ? {} : { payload_ref: payloadRef }),
    ...(evidenceRefs === undefined ? {} : { evidence_refs: Object.freeze(evidenceRefs) }),
    idempotency_key: value.idempotency_key as string,
    ...(value.authorization_ref === undefined
      ? {}
      : { authorization_ref: value.authorization_ref as string }),
    requires_ack: value.requires_ack as boolean,
  };
  return { ok: true, envelope };
}

/** What a caller supplies; the contract fields it does not have to repeat. */
export type NewEnvelopeInput = {
  readonly origin: MeshParty;
  readonly recipients: readonly MeshParty[];
  readonly topic: string;
  readonly event_type: string;
  readonly priority: MeshPriority;
  /** Milliseconds since the epoch, from the caller's clock. */
  readonly nowMs: number;
  readonly conversation_id?: string;
  readonly correlation_id?: string;
  readonly causation_id?: string;
  readonly ttlMs?: number;
  readonly payload_ref?: MeshRef;
  readonly evidence_refs?: readonly MeshRef[];
  /** Supply one when the effect's identity is known; otherwise it is derived. */
  readonly idempotency_key?: string;
  readonly authorization_ref?: string;
  readonly requires_ack?: boolean;
  /** Supply the message id in tests; otherwise a ULID-backed id is minted. */
  readonly message_id?: string;
};

/**
 * Builds a valid envelope, deriving what the caller left out.
 *
 * An omitted `idempotency_key` is derived from the fields that define the
 * intended effect — origin, recipients, topic, event type, payload reference and
 * correlation id — so that a sender retrying the same intent after a crash
 * produces the same key and the receiver applies one effect. It deliberately
 * excludes `message_id` and `created_at`: a retry is a new message about the same
 * effect.
 *
 * Throws only on programmer error (a field this module itself built wrong), which
 * is why the result is not a union: a caller that gets an exception here has a
 * bug, not a bad message.
 */
export function createEnvelope(input: NewEnvelopeInput): MeshEnvelope {
  const createdAt = new Date(input.nowMs).toISOString();
  const messageId = input.message_id ?? newEntityId("msg", input.nowMs);
  const correlationId = input.correlation_id ?? messageId;
  const conversationId = input.conversation_id ?? correlationId;
  const candidate: Record<string, unknown> = {
    protocol: MESH_PROTOCOL,
    schema_version: MESH_SCHEMA_VERSION,
    message_id: messageId,
    conversation_id: conversationId,
    correlation_id: correlationId,
    ...(input.causation_id === undefined ? {} : { causation_id: input.causation_id }),
    origin: input.origin,
    recipients: [...input.recipients],
    topic: input.topic,
    event_type: input.event_type,
    priority: input.priority,
    created_at: createdAt,
    ...(input.ttlMs === undefined
      ? {}
      : { expires_at: new Date(input.nowMs + input.ttlMs).toISOString() }),
    ...(input.payload_ref === undefined ? {} : { payload_ref: input.payload_ref }),
    ...(input.evidence_refs === undefined ? {} : { evidence_refs: [...input.evidence_refs] }),
    ...(input.authorization_ref === undefined
      ? {}
      : { authorization_ref: input.authorization_ref }),
    requires_ack: input.requires_ack ?? false,
  };
  candidate.idempotency_key =
    input.idempotency_key ??
    deriveIdempotencyKey({
      origin: input.origin,
      recipients: input.recipients,
      topic: input.topic,
      event_type: input.event_type,
      correlation_id: correlationId,
      payload_ref: input.payload_ref,
    });

  const parsed = parseEnvelope(candidate);
  if (!parsed.ok) {
    const detail = parsed.problems.map((p) => `${p.field || "<root>"}: ${p.reason}`).join("; ");
    throw new Error(`createEnvelope built an invalid envelope: ${detail}`);
  }
  return parsed.envelope;
}

/** The fields that define one intended effect, for key derivation. */
export type IdempotencyInput = {
  readonly origin: MeshParty;
  readonly recipients: readonly MeshParty[];
  readonly topic: string;
  readonly event_type: string;
  readonly correlation_id: string;
  readonly payload_ref?: MeshRef;
};

/**
 * A stable key for one intended effect: `imk_` plus 32 hex of SHA-256 over the
 * canonical form of the defining fields. Recipients are sorted so the order a
 * caller happened to list them in does not change the effect's identity.
 */
export function deriveIdempotencyKey(input: IdempotencyInput): string {
  const canonical = canonicalJson({
    origin: input.origin,
    recipients: input.recipients.toSorted(),
    topic: input.topic,
    event_type: input.event_type,
    correlation_id: input.correlation_id,
    payload_ref: input.payload_ref ?? null,
  });
  return `imk_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped, arrays kept in
 * order. Used for hashing, so two structurally equal values always hash alike.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      const entry = value[key];
      if (entry !== undefined) {
        out[key] = canonicalize(entry);
      }
    }
    return out;
  }
  return value;
}

/**
 * The envelope's content hash: `sha256:` plus 64 hex over its canonical form.
 * Recorded as evidence that a stored or relayed copy is byte-identical in
 * meaning to what the sender built.
 */
export function envelopeHash(envelope: MeshEnvelope): string {
  return `sha256:${createHash("sha256").update(canonicalJson(envelope)).digest("hex")}`;
}

/** Whether `envelope` is past its own expiry at `nowMs`. */
export function isEnvelopeExpired(envelope: MeshEnvelope, nowMs: number): boolean {
  return envelope.expires_at !== undefined && Date.parse(envelope.expires_at) <= nowMs;
}
