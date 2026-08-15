/**
 * Admin-plane tools: DDL and project lifecycle via the Supabase Management API.
 *
 * PostgREST cannot run DDL, so this is the only way for the agent to create
 * tables, apply migrations or wake a paused project. The Personal Access Token
 * it uses is account-scoped, which is exactly why every destructive statement
 * is gated behind an explicit confirm flag.
 */
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import {
  type EnvOptions,
  readSupabaseJson,
  resolveSupabaseAdminConfig,
  supabaseAdminFetch,
} from "./supabase-client.js";

type AdminDeps = EnvOptions;

/** Irreversible no matter how they are scoped. */
const ALWAYS_DESTRUCTIVE_RE =
  /\b(drop\s+(table|schema|database|column|view|materialized\s+view|function|index|type|policy|trigger|extension|sequence)|truncate|reset\s+all)\b/iu;

/** ALTER ... DROP COLUMN / DROP CONSTRAINT and friends. */
const ALTER_DROP_RE = /\balter\s+\w+\b[^;]*\bdrop\b/iu;

/** Row writes; destructive only when unscoped, so they are checked per statement. */
const ROW_WRITE_RE = /\b(delete\s+from|update)\b/iu;

function errorResult(err: unknown) {
  return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/gu, " ").replace(/\/\*[\s\S]*?\*\//gu, " ");
}

/**
 * True when any single statement would destroy data or structure.
 *
 * Evaluated per statement on purpose: in `delete from a; select 1 where x`,
 * a whole-string WHERE check would mask the unscoped delete.
 */
export function isDestructiveSql(sql: string): boolean {
  return stripComments(sql)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .some((statement) => {
      if (ALWAYS_DESTRUCTIVE_RE.test(statement) || ALTER_DROP_RE.test(statement)) return true;
      return ROW_WRITE_RE.test(statement) && !/\bwhere\b/iu.test(statement);
    });
}

/** Runs arbitrary SQL, including DDL, against the project database. */
export function createSupabaseAdminSqlTool(deps: AdminDeps) {
  return {
    name: "lumina_supabase_admin_sql",
    label: "Lumina Supabase Admin SQL",
    description:
      "Runs SQL against Supabase through the Management API, including DDL that PostgREST cannot do: " +
      "CREATE/ALTER/DROP TABLE, indexes, functions, RLS policies and migrations. " +
      "Destructive statements (DROP, TRUNCATE, DELETE/UPDATE without WHERE) are refused unless confirm=true. " +
      "Requires SUPABASE_ACCESS_TOKEN in c:/I24D_WhatsApp/.env. Never prints the token.",
    parameters: Type.Object(
      {
        sql: Type.String({
          description: "SQL to execute. Multiple statements separated by ; are allowed.",
          minLength: 1,
          maxLength: 100_000,
        }),
        confirm: Type.Optional(
          Type.Boolean({
            description:
              "Required (true) for destructive statements: DROP, TRUNCATE, or DELETE/UPDATE without WHERE.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      try {
        const sql = typeof rawParams.sql === "string" ? rawParams.sql.trim() : "";
        if (!sql) return jsonResult({ ok: false, error: "sql is required" });

        const confirm = rawParams.confirm === true;
        if (isDestructiveSql(sql) && !confirm) {
          return jsonResult({
            ok: false,
            refused: true,
            reason:
              "This statement is destructive (DROP / TRUNCATE / unscoped DELETE or UPDATE). " +
              "Re-issue with confirm=true if that is genuinely intended.",
          });
        }

        const cfg = resolveSupabaseAdminConfig(deps);
        const response = await supabaseAdminFetch(
          cfg,
          `/v1/projects/${cfg.projectRef}/database/query`,
          { method: "POST", body: JSON.stringify({ query: sql }), timeoutMs: 120_000 },
        );
        const parsed = await readSupabaseJson<unknown>(response);
        if (!parsed.ok) {
          return jsonResult({ ok: false, status: parsed.status, error: parsed.error });
        }
        const rows = Array.isArray(parsed.data) ? parsed.data : [];
        return jsonResult({
          ok: true,
          projectRef: cfg.projectRef,
          destructive: isDestructiveSql(sql),
          rowCount: rows.length,
          rows: rows.slice(0, 200),
          truncated: rows.length > 200,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

/** Reads project status and can wake a paused project. */
export function createSupabaseAdminProjectTool(deps: AdminDeps) {
  return {
    name: "lumina_supabase_admin_project",
    label: "Lumina Supabase Project",
    description:
      "Reads Supabase project status (ACTIVE_HEALTHY, INACTIVE/paused, COMING_UP) and can restore a paused " +
      "project. A paused project drops its API DNS, so every data tool fails with a name-resolution error " +
      "until it is restored. Requires SUPABASE_ACCESS_TOKEN.",
    parameters: Type.Object(
      {
        restore: Type.Optional(
          Type.Boolean({
            description:
              "Restore the project if it is paused. Takes a few minutes; poll status afterwards.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      try {
        const cfg = resolveSupabaseAdminConfig(deps);

        if (rawParams.restore === true) {
          const restore = await supabaseAdminFetch(cfg, `/v1/projects/${cfg.projectRef}/restore`, {
            method: "POST",
            body: JSON.stringify({}),
            timeoutMs: 60_000,
          });
          if (!restore.ok) {
            const text = await restore.text().catch(() => "");
            return jsonResult({
              ok: false,
              status: restore.status,
              error: text.slice(0, 1_000) || restore.statusText,
            });
          }
        }

        const response = await supabaseAdminFetch(cfg, `/v1/projects/${cfg.projectRef}`, {
          method: "GET",
          timeoutMs: 30_000,
        });
        const parsed = await readSupabaseJson<{
          name?: string;
          status?: string;
          region?: string;
          database?: { host?: string; version?: string };
        }>(response);
        if (!parsed.ok) {
          return jsonResult({ ok: false, status: parsed.status, error: parsed.error });
        }
        return jsonResult({
          ok: true,
          projectRef: cfg.projectRef,
          name: parsed.data.name,
          status: parsed.data.status,
          region: parsed.data.region,
          databaseHost: parsed.data.database?.host,
          postgresVersion: parsed.data.database?.version,
          restoreRequested: rawParams.restore === true,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
