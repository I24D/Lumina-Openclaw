import fs from "node:fs";
import path from "node:path";
import { saveConfig, type LuminaConfig } from "./config.js";
import type { RuntimePaths } from "./runtime-paths.js";

type JsonObject = Record<string, unknown>;
const LEGACY_LUMINA_PROVIDER_IDS = ["custom-i24d-whatsapp-ai-onrender-com"] as const;

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

function resolveManagedProviderIds(providerId: string): string[] {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "lumina") {
    return [normalized, ...LEGACY_LUMINA_PROVIDER_IDS];
  }
  return [normalized];
}

function createModelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function parseModelRef(modelRef: string): { providerId: string; modelId: string } | null {
  const trimmed = modelRef.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator >= trimmed.length - 1) {
    return null;
  }
  const providerId = trimmed.slice(0, separator).trim();
  const modelId = trimmed.slice(separator + 1).trim();
  if (!providerId || !modelId) {
    return null;
  }
  return { providerId, modelId };
}

function normalizeModelValue(modelValue: unknown): string | null {
  if (typeof modelValue !== "string") {
    return null;
  }
  const trimmed = modelValue.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = parseModelRef(trimmed);
  if (!parsed) {
    return trimmed;
  }
  const normalizedProviderId =
    parsed.providerId.trim().toLowerCase() === "custom-i24d-whatsapp-ai-onrender-com"
      ? "lumina"
      : parsed.providerId.trim().toLowerCase();
  return createModelRef(normalizedProviderId, parsed.modelId);
}

function readModelPrimaryValue(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeModelValue(value);
  }
  const object = asObject(value);
  return normalizeModelValue(object.primary);
}

function readModelFallbacks(value: unknown): string[] {
  const object = asObject(value);
  const fallbacks = Array.isArray(object.fallbacks) ? object.fallbacks : [];
  return fallbacks
    .map((entry) => normalizeModelValue(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function hasConfiguredModelRef(
  providers: JsonObject,
  modelAliases: JsonObject,
  modelValue: string,
): boolean {
  const normalizedModelValue = normalizeModelValue(modelValue);
  if (!normalizedModelValue) {
    return false;
  }
  if (modelAliases[normalizedModelValue] !== undefined) {
    return true;
  }
  const parsed = parseModelRef(normalizedModelValue);
  if (!parsed) {
    return false;
  }
  const provider = asObject(providers[parsed.providerId]);
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models.some((entry) => {
    const object = asObject(entry);
    return typeof object.id === "string" && object.id.trim().toLowerCase() === parsed.modelId.toLowerCase();
  });
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
  const managedProviderIds = resolveManagedProviderIds(config.providerId);
  const [providerId, ...legacyProviderIds] = managedProviderIds;
  for (const legacyProviderId of legacyProviderIds) {
    delete providers[legacyProviderId];
  }
  providers[providerId] = {
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
  const currentPrimaryModelValue = readModelPrimaryValue(defaults.model);
  const currentFallbacks = readModelFallbacks(defaults.model);
  const modelDefaults = asObject(defaults.model);
  const modelRef = createModelRef(providerId, config.modelId);
  const modelAliases = asObject(defaults.models);
  const managedModelRefs = new Set(
    managedProviderIds.map((managedProviderId) =>
      createModelRef(managedProviderId, config.modelId).toLowerCase(),
    ),
  );
  const preferredModelRef = normalizeModelValue(config.preferredModelRef) ?? modelRef;
  const currentPrimaryModelConfigured = Boolean(
    currentPrimaryModelValue &&
      !managedModelRefs.has(currentPrimaryModelValue.toLowerCase()) &&
      hasConfiguredModelRef(providers, modelAliases, currentPrimaryModelValue),
  );
  const resolvedPrimaryModelValue =
    currentPrimaryModelConfigured
      ? currentPrimaryModelValue
      : hasConfiguredModelRef(providers, modelAliases, preferredModelRef)
        ? preferredModelRef
        : modelRef;
  modelDefaults.primary = resolvedPrimaryModelValue;
  if (currentFallbacks.length > 0) {
    modelDefaults.fallbacks = currentFallbacks;
  }
  defaults.model = modelDefaults;
  const mergedAlias = Object.assign(
    {},
    ...managedProviderIds.map((managedProviderId) =>
      asObject(modelAliases[createModelRef(managedProviderId, config.modelId)]),
    ),
  );
  for (const legacyProviderId of legacyProviderIds) {
    delete modelAliases[createModelRef(legacyProviderId, config.modelId)];
  }
  modelAliases[modelRef] = {
    ...mergedAlias,
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
    version: 4,
    defaultTab: config.defaultTab,
    providerId,
    modelRef,
    preferredModelRef: resolvedPrimaryModelValue,
    updatedAt: new Date().toISOString(),
  };
  next.meta = meta;

  writeJson(config.openclawConfigPath, next);
}

export function persistPreferredModelSelection(config: LuminaConfig, modelRef: string): void {
  const normalizedModelRef = normalizeModelValue(modelRef);
  if (!normalizedModelRef) {
    throw new Error(`Invalid model reference: ${modelRef}`);
  }

  ensureDir(config.configDir);
  const existing = loadJson(config.openclawConfigPath);
  const next = { ...existing };
  const agents = asObject(next.agents);
  const defaults = asObject(agents.defaults);
  const currentFallbacks = readModelFallbacks(defaults.model);
  const modelDefaults = asObject(defaults.model);

  modelDefaults.primary = normalizedModelRef;
  if (currentFallbacks.length > 0) {
    modelDefaults.fallbacks = currentFallbacks;
  }
  defaults.model = modelDefaults;
  agents.defaults = defaults;
  next.agents = agents;

  const meta = asObject(next.meta);
  const bootstrapMeta = asObject(meta.luminaDesktopBootstrap);
  meta.luminaDesktopBootstrap = {
    ...bootstrapMeta,
    version: 4,
    preferredModelRef: modelDefaults.primary,
    preferredModelUpdatedAt: new Date().toISOString(),
  };
  next.meta = meta;

  writeJson(config.openclawConfigPath, next);
  config.preferredModelRef = normalizedModelRef;
  saveConfig({
    ...config,
    preferredModelRef: normalizedModelRef,
  });
}
