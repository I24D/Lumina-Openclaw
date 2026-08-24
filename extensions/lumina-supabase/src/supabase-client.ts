/**
 * Supabase connection layer for the Lumina plugin.
 *
 * Two independent planes, because Supabase exposes them separately:
 *
 *   - Data plane   → PostgREST (`/rest/v1/`) authenticated with an API key.
 *                    Rows in, rows out. It cannot run DDL.
 *   - Admin plane  → Management API (`api.supabase.com`) authenticated with a
 *                    Personal Access Token. This is the only way to run DDL
 *                    (CREATE/ALTER/DROP) or to restore a paused project.
 *
 * Credentials come from the shared .env at c:/I24D_WhatsApp/.env; no key is
 * ever echoed back to the agent.
 */
import { readFileSync } from "node:fs";

const DEFAULT_ENV_PATH = "c:/I24D_WhatsApp/.env";
const DEFAULT_SCHEMA = "public";
const DEFAULT_MAX_ROWS = 100;
const HARD_MAX_ROWS = 500;

export const SUPABASE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type SupabaseKeySource = "SUPABASE_SERVICE_ROLE_KEY" | "SUPABASE_ANON_KEY" | "SUPABASE_KEY";

export type EnvOptions = {
  readonly envPath?: string;
};

export type SupabaseConfig = {
  readonly url: string;
  readonly key: string;
  readonly keySource: SupabaseKeySource;
  readonly schema: string;
  readonly maxRows: number;
  readonly allowWrites: boolean;
};

export type SupabaseAdminConfig = {
  readonly token: string;
  readonly projectRef: string;
};

export type SupabaseConfigOptions = EnvOptions & {
  readonly schema?: string;
  readonly maxRows?: number;
  readonly allowWrites?: boolean;
};

export type SupabaseFetchOptions = RequestInit & {
  readonly timeoutMs?: number;
  readonly acceptOpenApi?: boolean;
};

let envCache: { path: string; values: Record<string, string> } | null = null;

/** Parses the shared .env once and memoises it per path. */
function loadEnvFile(envPath: string): Record<string, string> {
  if (envCache?.path === envPath) {
    return envCache.values;
  }
  const values: Record<string, string> = {};
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
  } catch {
    // Missing .env is not fatal: process.env may still carry the values.
  }
  envCache = { path: envPath, values };
  return values;
}

/** process.env wins over the .env file so a shell override always applies. */
export function getEnvVar(name: string, opts: EnvOptions = {}): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess.length > 0) {
    return fromProcess;
  }
  const value = loadEnvFile(opts.envPath ?? DEFAULT_ENV_PATH)[name];
  return value && value.length > 0 ? value : undefined;
}

export function assertSupabaseIdentifier(value: string, label: string): void {
  if (!SUPABASE_IDENTIFIER_RE.test(value)) {
    throw new Error(`${label} must be a simple PostgreSQL identifier`);
  }
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseMaxRows(value: number | string | undefined): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : DEFAULT_MAX_ROWS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_ROWS;
  }
  return Math.min(Math.trunc(parsed), HARD_MAX_ROWS);
}

export function getSupabaseProjectRef(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const first = host.split(".")[0];
    return first && first !== "localhost" ? first : host;
  } catch {
    return null;
  }
}

/** Resolves data-plane config (PostgREST). */
export function resolveSupabaseConfig(options: SupabaseConfigOptions = {}): SupabaseConfig {
  const url = getEnvVar("SUPABASE_URL", options);
  if (!url) {
    throw new Error("Missing SUPABASE_URL in c:/I24D_WhatsApp/.env");
  }

  const candidates: Array<[SupabaseKeySource, string | undefined]> = [
    ["SUPABASE_SERVICE_ROLE_KEY", getEnvVar("SUPABASE_SERVICE_ROLE_KEY", options)],
    ["SUPABASE_ANON_KEY", getEnvVar("SUPABASE_ANON_KEY", options)],
    ["SUPABASE_KEY", getEnvVar("SUPABASE_KEY", options)],
  ];
  const selected = candidates.find(([, value]) => typeof value === "string" && value.length > 0);
  if (!selected?.[1]) {
    throw new Error("Missing Supabase API key in c:/I24D_WhatsApp/.env");
  }

  const schema =
    options.schema ??
    getEnvVar("LUMINA_SUPABASE_SCHEMA", options) ??
    getEnvVar("SUPABASE_SCHEMA", options) ??
    DEFAULT_SCHEMA;
  assertSupabaseIdentifier(schema, "schema");

  return {
    url: normalizeUrl(url),
    key: selected[1],
    keySource: selected[0],
    schema,
    maxRows: parseMaxRows(options.maxRows ?? getEnvVar("LUMINA_SUPABASE_MAX_ROWS", options)),
    allowWrites:
      options.allowWrites ??
      parseBoolean(getEnvVar("LUMINA_SUPABASE_ALLOW_WRITES", options), false),
  };
}

/**
 * Resolves admin-plane config (Management API).
 *
 * The project ref is derived from SUPABASE_URL when not set explicitly, so the
 * usual case needs only SUPABASE_ACCESS_TOKEN.
 */
export function resolveSupabaseAdminConfig(options: EnvOptions = {}): SupabaseAdminConfig {
  const token = getEnvVar("SUPABASE_ACCESS_TOKEN", options);
  if (!token) {
    throw new Error(
      "Missing SUPABASE_ACCESS_TOKEN. Create a Personal Access Token at " +
        "https://supabase.com/dashboard/account/tokens and add it to c:/I24D_WhatsApp/.env",
    );
  }
  const explicitRef = getEnvVar("SUPABASE_PROJECT_REF", options);
  const url = getEnvVar("SUPABASE_URL", options);
  const projectRef = explicitRef ?? (url ? getSupabaseProjectRef(url) : null);
  if (!projectRef) {
    throw new Error("Cannot determine project ref: set SUPABASE_PROJECT_REF or SUPABASE_URL");
  }
  return { token, projectRef };
}

/** Data-plane request against PostgREST. */
export async function supabaseFetch(
  config: SupabaseConfig,
  path: string,
  options: SupabaseFetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const headers = new Headers(options.headers);
    headers.set("apikey", config.key);
    headers.set("authorization", `Bearer ${config.key}`);
    headers.set("accept", options.acceptOpenApi ? "application/openapi+json" : "application/json");
    if (!headers.has("content-type") && options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    headers.set("accept-profile", config.schema);
    headers.set("content-profile", config.schema);

    const target = `${config.url}${path.startsWith("/") ? path : `/${path}`}`;
    return await fetch(target, {
      ...options,
      headers,
      signal: options.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Admin-plane request against the Management API. */
export async function supabaseAdminFetch(
  config: SupabaseAdminConfig,
  path: string,
  options: SupabaseFetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${config.token}`);
    headers.set("accept", "application/json");
    if (!headers.has("content-type") && options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const target = `https://api.supabase.com${path.startsWith("/") ? path : `/${path}`}`;
    return await fetch(target, {
      ...options,
      headers,
      signal: options.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reads a Supabase REST response body. `data` stays `unknown`: the payload is
 * whatever PostgREST returned, so each caller asserts the shape it expects at
 * its own site rather than having this reader hand back an unchecked cast.
 */
export async function readSupabaseJson(
  response: Response,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      error: text.slice(0, 2_000) || response.statusText || `HTTP ${response.status}`,
    };
  }
  try {
    return { ok: true, data: await response.json() };
  } catch (err) {
    return {
      ok: false,
      status: response.status,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
