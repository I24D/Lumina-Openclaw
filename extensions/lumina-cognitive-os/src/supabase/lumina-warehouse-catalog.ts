/**
 * Warehouse catalog tool: summarizes src/cuerpo/warehouses without loading its
 * modules, and can persist the summary as a Supabase state document.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { textOf } from "../shared/text.js";
import { jsonResult, ToolAuthorizationError, type AnyAgentTool } from "../shared/tool-result.js";
import { clampLimit, errorResult, type ToolDeps } from "./lumina-memory-tools.js";
import { readSupabaseJson, resolveSupabaseConfig, supabaseFetch } from "./supabase-client.js";

const DEFAULT_WAREHOUSES_PATH = "c:/I24D_WhatsApp/src/cuerpo/warehouses";
const WAREHOUSE_PARTITIONS = [
  ["1.1", "formal_sciences"],
  ["1.2", "natural_sciences"],
  ["1.3", "social_sciences"],
  ["1.4", "humanities"],
  ["1.5", "applied_sciences"],
  ["1.6", "arts"],
] as const;

function resolveHostPath(input: string): string {
  const normalized = input.replace(/\\/gu, "/");
  const drive = normalized.match(/^([a-zA-Z]):\/(.+)$/u);
  if (drive && process.platform !== "win32") {
    return `/mnt/${drive[1]?.toLowerCase()}/${drive[2]}`;
  }
  return path.resolve(input);
}

function listChildDirs(root: string, rel = "", limit = 40): string[] {
  const target = path.join(root, rel);
  try {
    return fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted((a, b) => a.localeCompare(b))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function buildWarehouseCatalog(rootInput: string, maxItems: number) {
  const root = resolveHostPath(rootInput);
  const exists = fs.existsSync(root);
  const warehouseA = WAREHOUSE_PARTITIONS.map(([folder, domain]) => {
    const repos = listChildDirs(root, path.join("warehouseA", folder), maxItems);
    return { folder, domain, repoCount: repos.length, sampleRepos: repos.slice(0, 12) };
  });
  const warehouseCodexRepos = listChildDirs(
    root,
    path.join("warehouseCodex", "down_repos"),
    maxItems,
  );
  return {
    generatedAt: new Date().toISOString(),
    root: rootInput,
    resolvedRoot: root,
    exists,
    recommendation:
      "Keep src/cuerpo/warehouses in place. Use Supabase as persistent memory and catalog/index only lightweight summaries for OpenClaw.",
    warehouseA,
    warehouseB: {
      topLevel: listChildDirs(root, "warehouseB", maxItems),
    },
    warehouseCodex: {
      topLevel: listChildDirs(root, "warehouseCodex", maxItems),
      downReposCount: warehouseCodexRepos.length,
      sampleRepos: warehouseCodexRepos.slice(0, 16),
    },
    shared: {
      files: exists
        ? ["index.ts", "shared/warehouseBase.ts", "shared/warehouseTypes.ts"].filter((file) =>
            fs.existsSync(path.join(root, file)),
          )
        : [],
    },
  };
}

export function createLuminaWarehouseCatalogTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_warehouse_catalog",
    label: "Lumina Warehouse Catalog",
    description:
      "Catalogs src/cuerpo/warehouses without loading local AI/cerebro modules. Optionally persists the catalog in Supabase state.",
    parameters: Type.Object({
      warehousesPath: Type.Optional(Type.String({ maxLength: 500 })),
      maxItems: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      writeToSupabase: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, rawParams) {
      // Narrowed once against this tool's schema; the tool runtime
      // validates the payload before execute() is ever called.
      const raw = rawParams as {
        warehousesPath?: string;
        maxItems?: number;
        writeToSupabase?: boolean;
      };
      try {
        const input = raw as {
          warehousesPath?: unknown;
          maxItems?: unknown;
          writeToSupabase?: boolean;
        };
        const cfg = resolveSupabaseConfig(deps);
        const root = textOf(input.warehousesPath, deps.warehousesPath ?? DEFAULT_WAREHOUSES_PATH);
        const catalog = buildWarehouseCatalog(root, clampLimit(input.maxItems, 40, 200));

        if (input.writeToSupabase === true) {
          if (!cfg.allowWrites) {
            throw new ToolAuthorizationError(
              "Supabase writes are disabled. Set LUMINA_SUPABASE_ALLOW_WRITES=true to persist the warehouse catalog.",
            );
          }
          const response = await supabaseFetch(
            cfg,
            "/rest/v1/lumina_state_documents?on_conflict=workspace_id,scope,document_key&select=workspace_id,scope,document_key,updated_at",
            {
              method: "POST",
              headers: { prefer: "resolution=merge-duplicates,return=representation" },
              body: JSON.stringify({
                workspace_id: "lumina",
                scope: "warehouse",
                document_key: "catalog",
                payload: catalog,
                updated_at: new Date().toISOString(),
              }),
              timeoutMs: 20_000,
            },
          );
          const parsed = await readSupabaseJson<unknown[]>(response);
          if (!parsed.ok) {
            return jsonResult({ ok: false, catalog, error: parsed.error, status: parsed.status });
          }
          return jsonResult({ ok: true, persisted: true, catalog, stateDocument: parsed.data });
        }

        return jsonResult({ ok: true, persisted: false, catalog });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
