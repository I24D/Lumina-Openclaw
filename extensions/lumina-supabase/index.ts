/**
 * Lumina Supabase plugin entry.
 *
 * Registers both planes as agent tools:
 *   - data  (PostgREST)      → status, schema, query, mutate
 *   - admin (Management API) → arbitrary SQL/DDL, project lifecycle
 *
 * The admin tools are what let the agent create tables or wake a paused
 * project; PostgREST alone cannot do either.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createSupabaseAdminProjectTool,
  createSupabaseAdminSqlTool,
} from "./src/supabase-admin-tools.js";
import {
  createSupabaseMutateTool,
  createSupabaseQueryTool,
  createSupabaseSchemaTool,
  createSupabaseStatusTool,
} from "./src/supabase-tools.js";

type LuminaSupabaseConfig = {
  envPath?: string;
  schema?: string;
  maxRows?: number;
  allowWrites?: boolean;
  adminEnabled?: boolean;
};

function readConfig(raw: Record<string, unknown> | undefined): LuminaSupabaseConfig {
  const cfg = raw ?? {};
  return {
    envPath: typeof cfg.envPath === "string" ? cfg.envPath : undefined,
    schema: typeof cfg.schema === "string" ? cfg.schema : undefined,
    maxRows: typeof cfg.maxRows === "number" ? cfg.maxRows : undefined,
    allowWrites: typeof cfg.allowWrites === "boolean" ? cfg.allowWrites : undefined,
    adminEnabled: typeof cfg.adminEnabled === "boolean" ? cfg.adminEnabled : undefined,
  };
}

export default definePluginEntry({
  id: "lumina-supabase",
  name: "Lumina Supabase",
  description: "Supabase data and admin tools for Lumina.",
  register(api) {
    const cfg = readConfig(api.pluginConfig);

    const deps = {
      envPath: cfg.envPath ?? "c:/I24D_WhatsApp/.env",
      schema: cfg.schema,
      maxRows: cfg.maxRows,
      allowWrites: cfg.allowWrites,
    };

    api.registerTool(createSupabaseStatusTool(deps));
    api.registerTool(createSupabaseSchemaTool(deps));
    api.registerTool(createSupabaseQueryTool(deps));
    api.registerTool(createSupabaseMutateTool(deps));

    // Admin plane is opt-in: the token it needs is account-scoped, so it can
    // reach every project in the account, not just this one. Must be
    // explicitly enabled in plugin config (adminEnabled: true).
    if (cfg.adminEnabled === true) {
      const adminDeps = { envPath: deps.envPath };
      api.registerTool(createSupabaseAdminSqlTool(adminDeps));
      api.registerTool(createSupabaseAdminProjectTool(adminDeps));
    }

    const writesStatus =
      deps.allowWrites === true ? "enabled" : deps.allowWrites === false ? "disabled" : "from .env";

    api.logger.info(
      `[lumina-supabase] ready (schema=${deps.schema ?? "public"}, ` +
        `writes=${writesStatus}, ` +
        `admin=${cfg.adminEnabled === true ? "on" : "off"}).`,
    );
  },
});
