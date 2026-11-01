/**
 * Tests for the `lumina_events` mesh transport.
 *
 * Every test here names the contract it pins: the projection onto the 13
 * existing columns (key by key, because that row is the wire format), the
 * retryable/permanent split that decides a retry from a dead letter, and the
 * polling reader's promise that one bad row never costs the caller the page.
 *
 * No network, no `.env`, no timers: `supabaseFetch` is injected, the config is
 * a synthetic fixture, and the only clock is the fixed `T0` the envelopes are
 * built from. The one test that must see real env resolution stubs the
 * variables empty and points the loader at a path that does not exist.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseConfig } from "../supabase/supabase-client.js";
import {
  createEnvelope,
  envelopeHash,
  parseEnvelope,
  type MeshEnvelope,
  type MeshParty,
  type MeshRef,
} from "./envelope.js";
import {
  createSupabaseMeshTransport,
  readMeshEnvelopes,
  SUPABASE_MESH_TRANSPORT_NAME,
  type SupabaseFetchFn,
} from "./supabase-transport.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const TASK_UUID = "7e1a4d2c-9b3f-4c5a-8d6e-1f2a3b4c5d6e";
const PROOF_SHA = "a".repeat(64);

/** A synthetic project and key: this suite never holds a real credential. */
const CONFIG: SupabaseConfig = {
  url: "https://project-ref.supabase.co",
  key: "synthetic-test-key",
  keySource: "SUPABASE_SERVICE_ROLE_KEY",
  schema: "public",
  maxRows: 100,
  allowWrites: true,
};

function envelope(
  overrides: {
    readonly ttlMs?: number;
    readonly payload_ref?: MeshRef;
    readonly evidence_refs?: readonly MeshRef[];
    readonly message_id?: string;
  } = {},
): MeshEnvelope {
  return createEnvelope({
    origin: "chatgpt-lumina",
    recipients: ["openclaw-gateway", "muse"],
    topic: "task.handoff",
    event_type: "task.assigned",
    priority: 3,
    nowMs: T0,
    conversation_id: "conv-mesh-1",
    correlation_id: "corr-mesh-1",
    message_id: overrides.message_id ?? "msg-mesh-1",
    requires_ack: true,
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
    ...(overrides.payload_ref === undefined ? {} : { payload_ref: overrides.payload_ref }),
    ...(overrides.evidence_refs === undefined ? {} : { evidence_refs: overrides.evidence_refs }),
  });
}

type FetchInit = NonNullable<Parameters<SupabaseFetchFn>[2]>;

/** Records what the module would send and answers with what the test chooses. */
function recorder(respond: (path: string, index: number) => Response) {
  const calls: Array<{ readonly path: string; readonly init: FetchInit }> = [];
  const fetchImpl: SupabaseFetchFn = async (_config, path, init) => {
    const index = calls.length;
    calls.push({ path, init: init ?? {} });
    return respond(path, index);
  };
  return { fetchImpl, calls };
}

/** Each call needs its own Response: a body can only be read once. */
function created(ids: readonly string[] = ["row-1"]): () => Response {
  return () =>
    new Response(JSON.stringify(ids.map((id) => ({ id }))), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
}

function sentRow(init: FetchInit): Record<string, unknown> {
  const body = init.body;
  if (typeof body !== "string") {
    throw new Error("the transport must send a JSON string body");
  }
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("the transport must send a one-row array");
  }
  return parsed[0] as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createSupabaseMeshTransport", () => {
  it("projects the whole envelope under context.mesh and onto the filterable columns", async () => {
    const env = envelope({
      ttlMs: 300_000,
      payload_ref: { store: "supabase:lumina_tasks", id: TASK_UUID },
      evidence_refs: [{ store: "file", id: "proof.txt", sha256: PROOF_SHA, bytes: 12 }],
    });
    const { fetchImpl, calls } = recorder(created(["row-created"]));
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    const result = await transport.send(env, "openclaw-gateway");

    expect(result).toEqual({ ok: true, ref: "row-created" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/rest/v1/lumina_events?select=id");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ prefer: "return=representation" });
    expect(sentRow(calls[0]!.init)).toEqual({
      origin: "chatgpt-lumina",
      event_type: "task.assigned",
      priority: 3,
      topic: "task.handoff",
      observed_at: "2026-10-31T12:00:00.000Z",
      valid_until: "2026-10-31T12:05:00.000Z",
      source: SUPABASE_MESH_TRANSPORT_NAME,
      related_task: TASK_UUID,
      context: { mesh: env },
      evidence: {
        mesh_envelope_hash: envelopeHash(env),
        mesh_recipient: "openclaw-gateway",
        mesh_message_id: "msg-mesh-1",
        mesh_idempotency_key: env.idempotency_key,
        mesh_evidence_refs: [{ store: "file", id: "proof.txt", sha256: PROOF_SHA, bytes: 12 }],
      },
    });
  });

  it("writes one row per recipient, each carrying its own delivery evidence", async () => {
    const env = envelope();
    const { fetchImpl, calls } = recorder(created(["row-a"]));
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    await transport.send(env, "openclaw-gateway");
    await transport.send(env, "muse");

    expect(calls).toHaveLength(2);
    const recipients = calls.map((call) => {
      const evidence = sentRow(call.init).evidence as Record<string, unknown>;
      return evidence.mesh_recipient;
    });
    expect(recipients).toEqual(["openclaw-gateway", "muse"]);
    // The envelope itself is identical in both rows: same message, same effect.
    expect(sentRow(calls[0]!.init).context).toEqual(sentRow(calls[1]!.init).context);
  });

  it("leaves valid_until null when the envelope has no expiry", async () => {
    const { fetchImpl, calls } = recorder(created());
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    await transport.send(envelope(), "muse");

    const row = sentRow(calls[0]!.init);
    expect(row.valid_until).toBeNull();
    expect(row.context).toEqual({ mesh: expect.objectContaining({ protocol: "LUMINA-MESH" }) });
  });

  it("omits mesh_evidence_refs when the envelope carries none", async () => {
    const { fetchImpl, calls } = recorder(created());
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    await transport.send(envelope(), "muse");

    expect(sentRow(calls[0]!.init).evidence).toEqual({
      mesh_envelope_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      mesh_recipient: "muse",
      mesh_message_id: "msg-mesh-1",
      mesh_idempotency_key: expect.stringMatching(/^imk_[0-9a-f]{32}$/u),
    });
  });

  it("fills related_task only for a task reference whose id is a real uuid", async () => {
    const { fetchImpl, calls } = recorder(created());
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    await transport.send(
      envelope({ payload_ref: { store: "supabase:lumina_tasks", id: TASK_UUID } }),
      "muse",
    );
    // A task reference that is not a uuid: the column is `uuid`, so a bad value
    // would fail the whole INSERT.
    await transport.send(
      envelope({ payload_ref: { store: "supabase:lumina_tasks", id: "task-42" } }),
      "muse",
    );
    // A uuid in some other store is not a task id.
    await transport.send(
      envelope({ payload_ref: { store: "supabase:shared_memory", id: TASK_UUID } }),
      "muse",
    );
    // No payload reference at all.
    await transport.send(envelope(), "muse");

    expect(calls.map((call) => sentRow(call.init).related_task)).toEqual([
      TASK_UUID,
      null,
      null,
      null,
    ]);
  });

  it("still reports success when the representation carries no usable id", async () => {
    const { fetchImpl } = recorder(
      () => new Response("[]", { status: 201, headers: { "content-type": "application/json" } }),
    );
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    expect(await transport.send(envelope(), "muse")).toEqual({ ok: true });
  });

  it("treats 429 and 5xx as retryable, and a PostgREST verdict as permanent", async () => {
    const statuses = [429, 503, 400, 404, 409, 422, 401, 403];
    const { fetchImpl } = recorder(
      (_path, index) => new Response("postgrest says no", { status: statuses[index] ?? 500 }),
    );
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    const retryable: boolean[] = [];
    for (const status of statuses) {
      const result = await transport.send(envelope(), "muse");
      expect(result.ok, `HTTP ${status}`).toBe(false);
      retryable.push(result.ok ? false : result.retryable);
    }

    expect(retryable).toEqual([true, true, false, false, false, false, false, false]);
  });

  it("names the failing status in the error it reports", async () => {
    const { fetchImpl } = recorder(
      () => new Response('{"code":"42703","message":"column x does not exist"}', { status: 400 }),
    );
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    const result = await transport.send(envelope(), "muse");

    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: expect.stringContaining("lumina_events insert failed (HTTP 400)"),
    });
  });

  it("treats an aborted request as retryable", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const fetchImpl: SupabaseFetchFn = async () => {
      throw abort;
    };
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    expect(await transport.send(envelope(), "muse")).toEqual({
      ok: false,
      retryable: true,
      error: expect.stringContaining("timed out"),
    });
  });

  it("treats a dead socket as retryable", async () => {
    const fetchImpl: SupabaseFetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    expect(await transport.send(envelope(), "muse")).toEqual({
      ok: false,
      retryable: true,
      error: expect.stringContaining("network error"),
    });
  });

  it("reports absent configuration as permanent, naming what is missing", async () => {
    // getLuminaEnvVar reads process.env before the file, so both are emptied.
    for (const name of [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_ANON_KEY",
      "SUPABASE_KEY",
    ]) {
      vi.stubEnv(name, "");
    }
    const { fetchImpl, calls } = recorder(created());
    const transport = createSupabaseMeshTransport({
      envPath: "C:/I24D_WhatsApp/openclaw-main/no-such-file.env",
      fetchImpl,
    });

    const result = await transport.send(envelope(), "muse");

    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: expect.stringContaining("Missing SUPABASE_URL"),
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses permanently while the operator's write switch is off", async () => {
    const { fetchImpl, calls } = recorder(created());
    const transport = createSupabaseMeshTransport({
      config: { ...CONFIG, allowWrites: false },
      fetchImpl,
    });

    const result = await transport.send(envelope(), "muse");

    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: expect.stringContaining("LUMINA_SUPABASE_ALLOW_WRITES"),
    });
    expect(calls).toHaveLength(0);
  });

  it("round-trips: what the row would carry parses back into the same envelope", async () => {
    const env = envelope({
      ttlMs: 60_000,
      payload_ref: { store: "supabase:lumina_tasks", id: TASK_UUID },
      evidence_refs: [{ store: "file", id: "run.log", bytes: 4 }],
    });
    const { fetchImpl, calls } = recorder(created());
    const transport = createSupabaseMeshTransport({ config: CONFIG, fetchImpl });

    await transport.send(env, "openclaw-gateway");

    const context = sentRow(calls[0]!.init).context as Record<string, unknown>;
    const parsed = parseEnvelope(context.mesh);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.envelope : undefined).toEqual(env);
    expect(parsed.ok ? envelopeHash(parsed.envelope) : "").toBe(envelopeHash(env));
  });
});

/** Builds the row shape the reader selects: id, created_at, context. */
function readRow(id: string, createdAt: string, context: unknown): Record<string, unknown> {
  return { id, created_at: createdAt, context };
}

function rowsResponse(rows: readonly unknown[]): () => Response {
  return () =>
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("readMeshEnvelopes", () => {
  it("filters on the reserved context key, orders oldest first, and bounds the page", async () => {
    const { fetchImpl, calls } = recorder(rowsResponse([]));

    const result = await readMeshEnvelopes(CONFIG, {
      fetchImpl,
      recipient: "openclaw-gateway",
      since: "2026-10-31T12:00:00.123456+00:00",
      limit: 10,
    });

    expect(result).toEqual({ ok: true, envelopes: [], rejected: [] });
    expect(calls[0]?.path).toBe(
      "/rest/v1/lumina_events?select=id,created_at,context" +
        "&context->mesh->>protocol=eq.LUMINA-MESH" +
        "&evidence->>mesh_recipient=eq.openclaw-gateway" +
        "&created_at=gt.2026-10-31T12%3A00%3A00.123456%2B00%3A00" +
        "&order=created_at.asc&limit=10",
    );
  });

  it("clamps the page size to the config's maxRows", async () => {
    const { fetchImpl, calls } = recorder(rowsResponse([]));

    await readMeshEnvelopes({ ...CONFIG, maxRows: 25 }, { fetchImpl, limit: 500 });

    expect(calls[0]?.path).toContain("&limit=25");
    expect(calls[0]?.path).not.toContain("created_at=gt.");
  });

  it("keeps a valid row and reports a legacy row without tumbling the read", async () => {
    const env = envelope();
    const { fetchImpl } = recorder(
      rowsResponse([
        readRow("row-mesh", "2026-10-31T12:00:00.100000+00:00", { mesh: env }),
        // Exactly what the old fire-and-forget emitter wrote: no `mesh` key.
        readRow("row-legacy", "2026-10-31T12:00:00.200000+00:00", {
          task: "old",
          notes: "written before the mesh existed",
        }),
      ]),
    );

    const result = await readMeshEnvelopes(CONFIG, { fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toEqual([env]);
    expect(result.rejected).toEqual([
      {
        id: "row-legacy",
        problems: [{ field: "context.mesh", reason: "row carries no LUMINA-MESH envelope" }],
      },
    ]);
    // The cursor passes the bad row too, or it would be re-read forever.
    expect(result.cursor).toBe("2026-10-31T12:00:00.200000+00:00");
  });

  it("rejects an unparseable envelope with the row id and every problem", async () => {
    const env = envelope();
    const { fetchImpl } = recorder(
      rowsResponse([
        readRow("row-future", "2026-10-31T12:00:01.000000+00:00", {
          mesh: { ...env, schema_version: 2 },
        }),
      ]),
    );

    const result = await readMeshEnvelopes(CONFIG, { fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.id).toBe("row-future");
    expect(result.rejected[0]?.problems.map((problem) => problem.field)).toEqual([
      "schema_version",
    ]);
  });

  it("refuses a recipient that is not an agent id, before any request", async () => {
    const { fetchImpl, calls } = recorder(rowsResponse([]));

    const result = await readMeshEnvelopes(CONFIG, {
      fetchImpl,
      recipient: "Bad Party&limit=1" as MeshParty,
    });

    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: "recipient must be a lowercase dashed agent id",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a cursor that is not a timestamp, before any request", async () => {
    const { fetchImpl, calls } = recorder(rowsResponse([]));

    const result = await readMeshEnvelopes(CONFIG, { fetchImpl, since: "yesterday" });

    expect(result).toEqual({ ok: false, retryable: false, error: "since must be a timestamp" });
    expect(calls).toHaveLength(0);
  });

  it("classifies a read failure the same way a write failure is classified", async () => {
    const { fetchImpl } = recorder(
      (_path, index) => new Response("upstream down", { status: index === 0 ? 503 : 404 }),
    );

    const retryableRead = await readMeshEnvelopes(CONFIG, { fetchImpl });
    const permanentRead = await readMeshEnvelopes(CONFIG, { fetchImpl });

    expect(retryableRead).toEqual({
      ok: false,
      retryable: true,
      error: expect.stringContaining("lumina_events read failed (HTTP 503)"),
    });
    expect(permanentRead).toEqual({
      ok: false,
      retryable: false,
      error: expect.stringContaining("lumina_events read failed (HTTP 404)"),
    });
  });
});
