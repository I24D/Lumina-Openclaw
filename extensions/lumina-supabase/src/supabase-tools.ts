/**
 * Data-plane tools: rows in and out through PostgREST.
 *
 * Reads are always allowed. Writes need LUMINA_SUPABASE_ALLOW_WRITES=true, and
 * update/delete additionally need confirm=true because PostgREST applies them
 * to every row matching the filter (or to all rows when the filter is empty).
 */
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import {
  assertSupabaseIdentifier,
  getSupabaseProjectRef,
  readSupabaseJson,
  resolveSupabaseConfig,
  type SupabaseConfigOptions,
  supabaseFetch,
} from "./supabase-client.js";

type ToolDeps = SupabaseConfigOptions;

const FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "cs",
  "cd",
  "ov",
] as const;

const SELECT_RE = /^[A-Za-z0-9_*,.():! -]+$/u;
const ORDER_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:asc|desc))?(?:\.(?:nullsfirst|nullslast))?$/u;

function errorResult(err: unknown) {
  return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
}

function validateSelect(select: string): string {
  const trimmed = select.trim();
  if (!trimmed || trimmed.length > 600 || !SELECT_RE.test(trimmed)) {
    throw new Error("select must be a safe PostgREST select expression");
  }
  return trimmed;
}

function serializeScalar(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error("filter values must be strings, numbers, booleans or null");
}

/** Turns {column, op, value} into a PostgREST query-string pair. */
function serializeFilter(filter: {
  column?: string;
  op?: string;
  value?: unknown;
}): [string, string] {
  const column = filter.column?.trim();
  if (!column) {
    throw new Error("each filter needs a column");
  }
  assertSupabaseIdentifier(column, "filter column");
  const op = (filter.op ?? "eq") as (typeof FILTER_OPS)[number];
  if (!FILTER_OPS.includes(op)) {
    throw new Error(`filter op must be one of: ${FILTER_OPS.join(", ")}`);
  }
  if (op === "in") {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return [column, `in.(${values.map(serializeScalar).join(",")})`];
  }
  return [column, `${op}.${serializeScalar(filter.value)}`];
}

const FilterSchema = Type.Object(
  {
    column: Type.String({ description: "Column name." }),
    op: Type.Optional(
      Type.String({ description: `Operator: ${FILTER_OPS.join(", ")}. Default eq.` }),
    ),
    value: Type.Optional(Type.Unknown({ description: "Value to compare against." })),
  },
  { additionalProperties: false },
);

/** Connectivity and configuration check. Never prints the key. */
export function createSupabaseStatusTool(deps: ToolDeps) {
  return {
    name: "lumina_supabase_status",
    label: "Lumina Supabase Status",
    description:
      "Checks whether Lumina can reach Supabase with the credentials in c:/I24D_WhatsApp/.env. " +
      "Reports which key is in use, the schema and whether writes are enabled. Never prints the key.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      try {
        const cfg = resolveSupabaseConfig(deps);
        const response = await supabaseFetch(cfg, "/rest/v1/", {
          method: "GET",
          acceptOpenApi: true,
          timeoutMs: 10_000,
        });
        // With RLS enabled and no policies, the anon key sees zero rows and
        // reports no error at all — the failure looks like an empty database.
        const warning =
          cfg.keySource !== "SUPABASE_SERVICE_ROLE_KEY"
            ? `Using ${cfg.keySource}, not the service role. Under RLS this returns 0 rows everywhere ` +
              "without raising an error, which reads as an empty database. Set SUPABASE_SERVICE_ROLE_KEY."
            : undefined;
        return jsonResult({
          ok: response.ok,
          status: response.status,
          projectRef: getSupabaseProjectRef(cfg.url),
          schema: cfg.schema,
          keySource: cfg.keySource,
          allowWrites: cfg.allowWrites,
          maxRows: cfg.maxRows,
          warning,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

/** Lists tables and columns exposed by PostgREST. */
export function createSupabaseSchemaTool(deps: ToolDeps) {
  return {
    name: "lumina_supabase_schema",
    label: "Lumina Supabase Schema",
    description:
      "Lists the tables, views and RPC functions Supabase exposes, with their columns. " +
      "Use it before querying so column names are real rather than guessed.",
    parameters: Type.Object(
      { table: Type.Optional(Type.String({ description: "Only describe this table." })) },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      try {
        const cfg = resolveSupabaseConfig(deps);
        const response = await supabaseFetch(cfg, "/rest/v1/", {
          method: "GET",
          acceptOpenApi: true,
          timeoutMs: 20_000,
        });
        const parsed = await readSupabaseJson(response);
        if (!parsed.ok) {
          return jsonResult({ ok: false, status: parsed.status, error: parsed.error });
        }
        const schema = parsed.data as {
          paths?: Record<string, unknown>;
          definitions?: Record<string, { properties?: Record<string, unknown> }>;
        };

        const only = typeof rawParams.table === "string" ? rawParams.table.trim() : undefined;
        const names = Object.keys(schema.paths ?? {})
          .filter((p) => p !== "/")
          .map((p) => p.replace(/^\//u, ""));
        const definitions = schema.definitions ?? {};
        const tables = names
          .filter((n) => !n.startsWith("rpc/"))
          .filter((n) => !only || n === only)
          .map((n) => ({ table: n, columns: Object.keys(definitions[n]?.properties ?? {}) }));

        return jsonResult({
          ok: true,
          schema: cfg.schema,
          tables,
          rpcFunctions: names.filter((n) => n.startsWith("rpc/")).map((n) => n.slice(4)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

/** SELECT with filters, ordering and a hard row cap. */
export function createSupabaseQueryTool(deps: ToolDeps) {
  return {
    name: "lumina_supabase_query",
    label: "Lumina Supabase Query",
    description:
      "Reads rows from a Supabase table or view with optional filters, ordering and limit. " +
      "Row count is capped by LUMINA_SUPABASE_MAX_ROWS.",
    parameters: Type.Object(
      {
        table: Type.String({ description: "Table or view name." }),
        select: Type.Optional(Type.String({ description: "Columns to return. Default *." })),
        filters: Type.Optional(Type.Array(FilterSchema, { description: "Filters, ANDed." })),
        order: Type.Optional(Type.String({ description: "e.g. created_at.desc" })),
        limit: Type.Optional(Type.Integer({ description: "Max rows.", minimum: 1 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      try {
        const cfg = resolveSupabaseConfig(deps);
        const table = typeof rawParams.table === "string" ? rawParams.table.trim() : "";
        assertSupabaseIdentifier(table, "table");

        const params = new URLSearchParams();
        params.set(
          "select",
          validateSelect(typeof rawParams.select === "string" ? rawParams.select : "*"),
        );

        const filters = Array.isArray(rawParams.filters) ? rawParams.filters : [];
        for (const raw of filters) {
          const [key, value] = serializeFilter(raw as Record<string, unknown>);
          params.append(key, value);
        }

        if (typeof rawParams.order === "string" && rawParams.order.trim()) {
          const order = rawParams.order.trim();
          if (!ORDER_RE.test(order)) {
            throw new Error("order must look like column.asc or column.desc");
          }
          params.set("order", order);
        }

        const requested =
          typeof rawParams.limit === "number" && Number.isFinite(rawParams.limit)
            ? Math.trunc(rawParams.limit)
            : 50;
        const limit = Math.max(1, Math.min(requested, cfg.maxRows));
        params.set("limit", String(limit));

        const response = await supabaseFetch(cfg, `/rest/v1/${table}?${params.toString()}`, {
          method: "GET",
          timeoutMs: 30_000,
        });
        const parsed = await readSupabaseJson(response);
        if (!parsed.ok) {
          return jsonResult({ ok: false, status: parsed.status, error: parsed.error });
        }

        const rows: unknown[] = Array.isArray(parsed.data) ? parsed.data : [];
        return jsonResult({ ok: true, table, rowCount: rows.length, limit, rows });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

/** INSERT / UPSERT / UPDATE / DELETE, gated by allowWrites and confirm. */
export function createSupabaseMutateTool(deps: ToolDeps) {
  return {
    name: "lumina_supabase_mutate",
    label: "Lumina Supabase Mutate",
    description:
      "Writes to a Supabase table: insert, upsert, update or delete. " +
      "Requires LUMINA_SUPABASE_ALLOW_WRITES=true. update and delete also require confirm=true, " +
      "because they hit every row matching the filters — and every row in the table when filters are empty.",
    parameters: Type.Object(
      {
        table: Type.String({ description: "Target table." }),
        action: Type.String({ description: "insert | upsert | update | delete" }),
        rows: Type.Optional(Type.Array(Type.Unknown(), { description: "Rows for insert/upsert." })),
        values: Type.Optional(Type.Unknown({ description: "Column/value object for update." })),
        filters: Type.Optional(
          Type.Array(FilterSchema, { description: "Filters for update/delete." }),
        ),
        confirm: Type.Optional(Type.Boolean({ description: "Required for update and delete." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      try {
        const cfg = resolveSupabaseConfig(deps);
        if (!cfg.allowWrites) {
          return jsonResult({
            ok: false,
            refused: true,
            reason: "Writes are disabled. Set LUMINA_SUPABASE_ALLOW_WRITES=true to enable them.",
          });
        }

        const table = typeof rawParams.table === "string" ? rawParams.table.trim() : "";
        assertSupabaseIdentifier(table, "table");
        const action = typeof rawParams.action === "string" ? rawParams.action.trim() : "";
        if (!["insert", "upsert", "update", "delete"].includes(action)) {
          throw new Error("action must be insert, upsert, update or delete");
        }

        const needsConfirm = action === "update" || action === "delete";
        if (needsConfirm && rawParams.confirm !== true) {
          return jsonResult({
            ok: false,
            refused: true,
            reason: `${action} affects every matching row. Re-issue with confirm=true if intended.`,
          });
        }

        const params = new URLSearchParams();
        const filters = Array.isArray(rawParams.filters) ? rawParams.filters : [];
        for (const raw of filters) {
          const [key, value] = serializeFilter(raw as Record<string, unknown>);
          params.append(key, value);
        }

        const headers = new Headers({ prefer: "return=representation" });
        let method = "POST";
        let body: string | undefined;

        if (action === "insert" || action === "upsert") {
          const rows = Array.isArray(rawParams.rows) ? rawParams.rows : [];
          if (rows.length === 0) {
            throw new Error("rows is required for insert/upsert");
          }
          body = JSON.stringify(rows);
          if (action === "upsert") {
            headers.set("prefer", "return=representation,resolution=merge-duplicates");
          }
        } else if (action === "update") {
          if (!rawParams.values || typeof rawParams.values !== "object") {
            throw new Error("values is required for update");
          }
          method = "PATCH";
          body = JSON.stringify(rawParams.values);
        } else {
          method = "DELETE";
        }

        const suffix = params.toString();
        const response = await supabaseFetch(
          cfg,
          `/rest/v1/${table}${suffix ? `?${suffix}` : ""}`,
          { method, body, headers, timeoutMs: 30_000 },
        );
        const parsed = await readSupabaseJson(response);
        if (!parsed.ok) {
          return jsonResult({ ok: false, status: parsed.status, error: parsed.error });
        }

        const rows: unknown[] = Array.isArray(parsed.data) ? parsed.data : [];
        return jsonResult({
          ok: true,
          table,
          action,
          affected: rows.length,
          rows: rows.slice(0, 50),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
