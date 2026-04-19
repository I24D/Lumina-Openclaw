import fs from "node:fs";
import path from "node:path";
import type { LuminaConfig } from "./config.js";
import type { RuntimePaths } from "./runtime-paths.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function loadJson(filePath: string): JsonObject {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    return asObject(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return {};
  }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath: string, value: JsonObject): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function bootstrapLuminaRuntime(config: LuminaConfig, paths: RuntimePaths): void {
  ensureDir(config.configDir);
  ensureDir(config.openclawStateDir);
  ensureDir(config.workspaceDir);

  const existing = loadJson(config.openclawConfigPath);
  const next = { ...existing };

  const gateway = asObject(next.gateway);
  gateway.mode = "local";
  gateway.port = config.gatewayPort;
  gateway.bind = "loopback";
  gateway.auth = {
    ...asObject(gateway.auth),
    mode: "token",
    token: config.gatewayToken,
  };
  gateway.controlUi = {
    ...asObject(gateway.controlUi),
    allowInsecureAuth: true,
  };
  next.gateway = gateway;

  const tools = asObject(next.tools);
  if (typeof tools.profile !== "string" || !tools.profile.trim()) {
    tools.profile = "coding";
  }
  next.tools = tools;

  const session = asObject(next.session);
  if (typeof session.dmScope !== "string" || !session.dmScope.trim()) {
    session.dmScope = "per-channel-peer";
  }
  next.session = session;

  const models = asObject(next.models);
  models.mode = typeof models.mode === "string" ? models.mode : "merge";
  const providers = asObject(models.providers);
  providers[config.providerId] = {
    baseUrl: `http://127.0.0.1:${config.proxyPort}/v1`,
    api: "openai-completions",
    apiKey: config.proxyApiKey,
    models: [
      {
        id: config.modelId,
        name: config.modelName,
        contextWindow: config.modelContextWindow,
        maxTokens: config.modelMaxTokens,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        reasoning: false,
      },
    ],
  };
  models.providers = providers;
  next.models = models;

  const agents = asObject(next.agents);
  const defaults = asObject(agents.defaults);
  defaults.workspace = config.workspaceDir;
  const modelDefaults = asObject(defaults.model);
  if (typeof modelDefaults.primary !== "string" || !modelDefaults.primary.trim()) {
    modelDefaults.primary = `${config.providerId}/${config.modelId}`;
  }
  defaults.model = modelDefaults;
  const modelAliases = asObject(defaults.models);
  const modelKey = `${config.providerId}/${config.modelId}`;
  modelAliases[modelKey] = {
    ...asObject(modelAliases[modelKey]),
    alias: config.modelId,
  };
  defaults.models = modelAliases;
  agents.defaults = defaults;
  next.agents = agents;

  const plugins = asObject(next.plugins);
  const entries = asObject(plugins.entries);
  const luminaEntry = asObject(entries["lumina-pc"]);
  if (luminaEntry.enabled === undefined) {
    luminaEntry.enabled = true;
  }
  entries["lumina-pc"] = luminaEntry;
  const browserEntry = asObject(entries.browser);
  if (browserEntry.enabled === undefined) {
    browserEntry.enabled = true;
  }
  entries.browser = browserEntry;
  plugins.entries = entries;

  const load = asObject(plugins.load);
  const existingPaths = Array.isArray(load.paths)
    ? load.paths.filter((value): value is string => typeof value === "string")
    : [];
  load.paths = [
    ...existingPaths.filter((entry) => !entry.toLowerCase().includes("lumina-pc")),
    paths.luminaPluginDir,
  ];
  plugins.load = load;
  next.plugins = plugins;

  const meta = asObject(next.meta);
  meta.luminaDesktopBootstrap = {
    version: 1,
    defaultTab: config.defaultTab,
    updatedAt: new Date().toISOString(),
  };
  next.meta = meta;

  writeJson(config.openclawConfigPath, next);
}
