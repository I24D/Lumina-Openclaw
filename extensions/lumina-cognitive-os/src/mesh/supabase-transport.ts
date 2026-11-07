import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readSupabaseJson,
  resolveSupabaseConfig,
  supabaseFetch,
  type SupabaseConfig,
  type SupabaseConfigOptions,
} from "../supabase/supabase-client.js";
import type { MeshTransport, MeshTransportResult } from "./dispatcher.js";
/**
 * supabase-transport.ts — The mesh carried by `public.lumina_events`, no DDL.
 *
 * This module owns one thing: the *projection* between a LUMINA-MESH envelope
 * and a row of the table that already exists. `envelope.ts` owns the contract,
 * `outbox.ts` owns what is due, `dispatcher.ts` owns retry and dead-lettering;
 * nothing here keeps state, starts a timer, or decides when to send. One
 * transport instance holds exactly one cached Supabase config.
 *
 * ## Why the envelope lives under one reserved context key
 *
 * Production `context` objects already use 31 distinct keys and `evidence` 15,
 * and none of them is `mesh`. Nesting the complete envelope under
 * `context.mesh` (`MESH_CONTEXT_KEY`) therefore collides with nothing, leaves
 * every existing reader working, and keeps `parseEnvelope` the single trust
 * boundary on the way back: a reader validates `context.mesh` once and then
 * treats it as internal data.
 *
 * The first-class columns (`origin`, `event_type`, `priority`, `topic`,
 * `observed_at`, `valid_until`, `source`) are a *derived projection* of that
 * envelope, not a second source of truth. They exist because they are the only
 * fields a PostgREST query can filter — and an operator can index — without the
 * DDL this module is forbidden to run. When the two ever disagree, the envelope
 * under `context.mesh` is authoritative.
 *
 * ## One row per (message, recipient)
 *
 * `lumina_events` has no unique constraint and its primary key is a random
 * uuid, so the database cannot collapse a duplicate: delivery is at-least-once
 * and `MeshInbox` is what makes a repeat harmless, keyed by `idempotency_key`.
 * Writing one row per recipient is what gives each delivery its own evidence
 * (`evidence.mesh_recipient`) instead of a shared row that no reader can
 * attribute.
 *
 * ## Refs, never payloads
 *
 * `evidence` carries the envelope hash, the recipient, the message id, the
 * idempotency key and — unchanged — the envelope's own `evidence_refs`. The
 * payload itself is never copied here, so an append-only event log never turns
 * into a second copy of private data.
 *
 * ## Polling is the only consumption path
 *
 * `lumina_events` is not in this project's Realtime publication (only
 * `lumina_tasks` and `lumina_task_events` are), so there is no push to
 * subscribe to. `readMeshEnvelopes` plus a `created_at` cursor is the whole
 * reader, and expiry filtering stays with its caller (`isEnvelopeExpired`),
 * which owns the clock.
 */
import {
  envelopeHash,
  isMeshParty,
  MESH_PROTOCOL,
  parseEnvelope,
  type MeshEnvelope,
  type MeshEnvelopeProblem,
  type MeshParty,
  type MeshPriority,
  type MeshRef,
} from "./envelope.js";

/** The single reserved `context` key that holds the whole envelope. */
export const MESH_CONTEXT_KEY = "mesh";

/** The existing table this transport writes to. No DDL is ever required. */
export const MESH_EVENTS_TABLE = "lumina_events";

/** Default transport name, also written to `source` so a row names its writer. */
export const SUPABASE_MESH_TRANSPORT_NAME = "mesh-supabase";

/** The injectable seam: `supabaseFetch` itself, so tests never touch the net. */
export type SupabaseFetchFn = typeof supabaseFetch;

/** What `evidence` holds: identifiers and hashes, never content. */
export type MeshEventEvidence = {
  readonly mesh_envelope_hash: string;
  readonly mesh_recipient: MeshParty;
  readonly mesh_message_id: string;
  readonly mesh_idempotency_key: string;
  /** The envelope's own references, passed through unchanged when present. */
  readonly mesh_evidence_refs?: readonly MeshRef[];
};

/** What `context` holds: the complete envelope under one reserved key. */
export type MeshEventContext = {
  readonly [MESH_CONTEXT_KEY]: MeshEnvelope;
};

/** One `lumina_events` row as this module writes it: the 13 columns, no more. */
export type MeshEventRow = {
  readonly origin: MeshParty;
  readonly event_type: string;
  readonly priority: MeshPriority;
  readonly topic: string;
  readonly observed_at: string;
  /** Null, not omitted: an absent expiry is a known absence of one. */
  readonly valid_until: string | null;
  readonly source: string;
  readonly related_task: string | null;
  readonly context: MeshEventContext;
  readonly evidence: MeshEventEvidence;
};

/**
 * Stores whose last segment names the task table. `related_task` is a bare
 * `uuid` column with no foreign key, so only a store that really identifies a
 * task may fill it.
 */
const TASK_REF_STORES = new Set(["lumina_tasks", "task", "tasks"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The task id for a payload reference, or null.
 *
 * Both halves matter: a ref into some other store is not a task, and a
 * non-uuid id fails the whole INSERT because the column is typed `uuid`. A
 * reference that is not provably both stays null rather than risking the row.
 */
function relatedTaskOf(ref: MeshRef | undefined): string | null {
  if (ref === undefined) {
    return null;
  }
  const store = ref.store.split(":").at(-1) ?? "";
  if (!TASK_REF_STORES.has(store)) {
    return null;
  }
  // Postgres stores uuids lowercase; normalizing keeps a read-back comparable.
  return UUID_RE.test(ref.id) ? ref.id.toLowerCase() : null;
}

/**
 * Projects one envelope and one recipient onto the row that gets written.
 *
 * Exported because it *is* the contract: a caller can see exactly what reaches
 * the table, and the tests assert this shape key by key rather than trusting a
 * mock of the HTTP call.
 */
export function projectEnvelopeRow(
  envelope: MeshEnvelope,
  recipient: MeshParty,
  source: string,
): MeshEventRow {
  const evidence: MeshEventEvidence = {
    mesh_envelope_hash: envelopeHash(envelope),
    mesh_recipient: recipient,
    mesh_message_id: envelope.message_id,
    mesh_idempotency_key: envelope.idempotency_key,
    ...(envelope.evidence_refs === undefined ? {} : { mesh_evidence_refs: envelope.evidence_refs }),
  };
  return {
    origin: envelope.origin,
    event_type: envelope.event_type,
    priority: envelope.priority,
    topic: envelope.topic,
    observed_at: envelope.created_at,
    valid_until: envelope.expires_at ?? null,
    source,
    related_task: relatedTaskOf(envelope.payload_ref),
    context: { [MESH_CONTEXT_KEY]: envelope },
    evidence,
  };
}

/** A resolved config, or the exact reason there is none. Never throws. */
export type MeshSupabaseConfigResult =
  | { readonly ok: true; readonly config: SupabaseConfig }
  | { readonly ok: false; readonly error: string };

/**
 * Non-throwing wrapper over `resolveSupabaseConfig`.
 *
 * Missing configuration is a permanent condition, not a failed attempt, so the
 * transport must report it as non-retryable instead of letting an exception
 * reach the dispatcher (which treats a throw as retryable on purpose). The
 * message names what is missing and never the value of anything.
 */
export function resolveMeshSupabaseConfig(
  options: SupabaseConfigOptions = {},
): MeshSupabaseConfigResult {
  try {
    return { ok: true, config: resolveSupabaseConfig(options) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `${SUPABASE_MESH_TRANSPORT_NAME} is not configured: ${reason}`,
    };
  }
}

export type SupabaseMeshTransportOptions = SupabaseConfigOptions & {
  /** A config resolved by the caller. Skips env resolution entirely. */
  readonly config?: SupabaseConfig;
  readonly fetchImpl?: SupabaseFetchFn;
  readonly timeoutMs?: number;
  /** Overrides the transport name, which is also the row's `source`. */
  readonly source?: string;
};

/** Statuses worth another attempt. Everything else is the server's verdict. */
function isRetryableStatus(status: number): boolean {
  // 408 and 429 are timing, 5xx is the server; a 4xx verdict will not change
  // by repeating the identical row.
  return status === 408 || status === 429 || status >= 500;
}

function failure(error: string, retryable: boolean): MeshTransportResult {
  return { ok: false, error, retryable };
}

/**
 * A thrown fetch error: a timeout or a dead socket, never the row's fault, so
 * always retryable. Shaped to spread into either result union.
 */
function classifyThrown(
  error: unknown,
  action: string,
): { readonly error: string; readonly retryable: true } {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);
  const kind = name === "AbortError" || name === "TimeoutError" ? "timed out" : "network error";
  return { error: `${action} ${kind}: ${detail}`, retryable: true };
}

function truncate(detail: string): string {
  return detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
}

/**
 * The mesh transport over `lumina_events`.
 *
 * The config is resolved on the first `send` and cached for the transport's
 * life: building a transport at plugin-registration time must not throw just
 * because `.env` is not readable yet, and a missing key must surface as a
 * reported delivery failure rather than a crash during routing.
 */
export function createSupabaseMeshTransport(
  options: SupabaseMeshTransportOptions = {},
): MeshTransport {
  const name = options.source ?? SUPABASE_MESH_TRANSPORT_NAME;
  const fetchImpl = options.fetchImpl ?? supabaseFetch;
  let resolved: MeshSupabaseConfigResult | undefined;

  return {
    name,
    async send(envelope: MeshEnvelope, recipient: MeshParty): Promise<MeshTransportResult> {
      resolved ??= options.config
        ? { ok: true, config: options.config }
        : resolveMeshSupabaseConfig(options);
      if (!resolved.ok) {
        return failure(resolved.error, false);
      }
      const config = resolved.config;
      if (!config.allowWrites) {
        // The operator's kill switch for every Supabase writer in this plugin;
        // honored here so a disabled mesh is loud instead of silently dropping.
        return failure(
          `${name} writes are disabled. Set LUMINA_SUPABASE_ALLOW_WRITES=true to enable.`,
          false,
        );
      }

      const row = projectEnvelopeRow(envelope, recipient, name);
      let response: Response;
      try {
        response = await fetchImpl(config, `/rest/v1/${MESH_EVENTS_TABLE}?select=id`, {
          method: "POST",
          // A one-row array, so the representation is always an array and
          // reading the new id back needs no shape branch.
          body: JSON.stringify([row]),
          headers: { prefer: "return=representation" },
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch (error) {
        return { ok: false, ...classifyThrown(error, `${MESH_EVENTS_TABLE} insert`) };
      }

      const body = await readSupabaseJson<ReadonlyArray<{ readonly id?: unknown }>>(response);
      if (!body.ok) {
        return failure(
          `${MESH_EVENTS_TABLE} insert failed (HTTP ${body.status}): ${truncate(body.error)}`,
          isRetryableStatus(body.status),
        );
      }
      const id = body.data[0]?.id;
      // The row landed either way: a representation this reader cannot use is
      // a lost convenience, never a failed delivery.
      return typeof id === "string" ? { ok: true, ref: id } : { ok: true };
    },
  };
}

/** A row that carried no usable envelope, with the row id so it can be read. */
export type MeshRowRejection = {
  /** The `lumina_events.id`, or an empty string when the row had none. */
  readonly id: string;
  readonly problems: readonly MeshEnvelopeProblem[];
};

export type ReadMeshEnvelopesResult =
  | {
      readonly ok: true;
      readonly envelopes: readonly MeshEnvelope[];
      readonly rejected: readonly MeshRowRejection[];
      /** The last row's `created_at`, verbatim, to pass back as `since`. */
      readonly cursor?: string;
    }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

export type ReadMeshEnvelopesOptions = {
  /** Only rows delivered to this party, matched on `evidence.mesh_recipient`. */
  readonly recipient?: MeshParty;
  /** Exclusive lower bound on `created_at`: the previous call's `cursor`. */
  readonly since?: string;
  readonly limit?: number;
  readonly fetchImpl?: SupabaseFetchFn;
  readonly timeoutMs?: number;
};

/**
 * Reads mesh rows oldest first, past a cursor, and validates each one.
 *
 * The filter is `context->mesh->>protocol`, which excludes every row the older
 * fire-and-forget emitter wrote (those have no `context.mesh` at all). If one
 * reaches this function anyway — a hand-written row, a future writer — it comes
 * back in `rejected` with the row id: a single bad row must never cost the
 * caller the whole page, because this is the only path by which messages
 * arrive.
 *
 * Takes a resolved config rather than reading the environment, so the reader
 * has no hidden I/O and a caller decides which project it is talking to.
 */
export async function readMeshEnvelopes(
  config: SupabaseConfig,
  options: ReadMeshEnvelopesOptions = {},
): Promise<ReadMeshEnvelopesResult> {
  // The untrusted inputs reach a URL, so both are checked once, here.
  if (options.recipient !== undefined && !isMeshParty(options.recipient)) {
    return { ok: false, error: "recipient must be a lowercase dashed agent id", retryable: false };
  }
  if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) {
    return { ok: false, error: "since must be a timestamp", retryable: false };
  }
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? config.maxRows)), config.maxRows);

  // Built by hand, not through URLSearchParams: PostgREST's JSON path operators
  // belong in the key and must stay literal. A party id is URL-safe by its own
  // validation; a timestamp carries `+00:00` from Postgres and is encoded.
  const filters = [
    "select=id,created_at,context",
    `context->${MESH_CONTEXT_KEY}->>protocol=eq.${MESH_PROTOCOL}`,
    ...(options.recipient === undefined
      ? []
      : [`evidence->>mesh_recipient=eq.${options.recipient}`]),
    ...(options.since === undefined ? [] : [`created_at=gt.${encodeURIComponent(options.since)}`]),
    "order=created_at.asc",
    `limit=${limit}`,
  ];

  const fetchImpl = options.fetchImpl ?? supabaseFetch;
  let response: Response;
  try {
    response = await fetchImpl(config, `/rest/v1/${MESH_EVENTS_TABLE}?${filters.join("&")}`, {
      method: "GET",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    return { ok: false, ...classifyThrown(error, `${MESH_EVENTS_TABLE} read`) };
  }

  const body = await readSupabaseJson<readonly unknown[]>(response);
  if (!body.ok) {
    return {
      ok: false,
      error: `${MESH_EVENTS_TABLE} read failed (HTTP ${body.status}): ${truncate(body.error)}`,
      retryable: isRetryableStatus(body.status),
    };
  }
  if (!Array.isArray(body.data)) {
    return { ok: false, error: `${MESH_EVENTS_TABLE} read returned a non-array`, retryable: false };
  }

  const envelopes: MeshEnvelope[] = [];
  const rejected: MeshRowRejection[] = [];
  let cursor: string | undefined;

  for (const row of body.data) {
    if (!isRecord(row)) {
      rejected.push({ id: "", problems: [{ field: "", reason: "row must be an object" }] });
      continue;
    }
    const id = typeof row.id === "string" ? row.id : "";
    if (typeof row.created_at === "string") {
      // Rows arrive ordered, so the last one seen is the cursor — advanced even
      // for a rejected row, or one bad row would be re-read forever.
      cursor = row.created_at;
    }
    const nested = isRecord(row.context) ? row.context[MESH_CONTEXT_KEY] : undefined;
    if (nested === undefined) {
      rejected.push({
        id,
        problems: [
          { field: `context.${MESH_CONTEXT_KEY}`, reason: "row carries no LUMINA-MESH envelope" },
        ],
      });
      continue;
    }
    const parsed = parseEnvelope(nested);
    if (parsed.ok) {
      envelopes.push(parsed.envelope);
    } else {
      rejected.push({ id, problems: parsed.problems });
    }
  }

  return { ok: true, envelopes, rejected, ...(cursor === undefined ? {} : { cursor }) };
}
