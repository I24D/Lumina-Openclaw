import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import renderPreset from "../config/render-preset.json" with { type: "json" };
import { resolveRuntimePaths } from "./runtime-paths.js";

const CONFIG_DIR = path.join(os.homedir(), ".lumina");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const OPENCLAW_CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");
const OPENCLAW_STATE_DIR = path.join(CONFIG_DIR, "openclaw-state");
const WORKSPACE_DIR = path.join(CONFIG_DIR, "workspace");
const CANONICAL_LUMINA_PROVIDER_ID = "lumina";
const LEGACY_LUMINA_PROVIDER_IDS = ["custom-i24d-whatsapp-ai-onrender-com"];
const DEFAULT_DESKTOP_TAB = "chat";

interface GeneratedDefaults {
  authServiceUrl?: string;
  providerId?: string;
  modelId?: string;
  preferredModelRef?: string;
  modelName?: string;
  modelContextWindow?: number;
  modelMaxTokens?: number;
  proxyPort?: number;
  gatewayPort?: number;
  proxyApiKey?: string;
  i24dModelsBaseUrl?: string;
  i24dChatUrl?: string;
  i24dToken?: string;
  remoteBrainEnabled?: boolean;
  remoteBrainUrl?: string;
  remoteBrainSecret?: string;
  remoteBrainTimeoutMs?: number;
  remoteBrainMaxTurns?: number;
  runtimeReleaseManifestUrl?: string;
  runtimeReleaseChannel?: string;
  skipOpenClawChannels?: boolean;
  defaultTab?: string;
  requireLuminaAuth?: boolean;
  updateRepoOwner?: string;
  updateRepoName?: string;
}

interface StoredLuminaConfig {
  gatewayToken?: string;
  gatewayPort?: number;
  proxyPort?: number;
  proxyApiKey?: string;
  authServiceUrl?: string;
  i24dChatUrl?: string;
  i24dModelsBaseUrl?: string;
  i24dToken?: string;
  remoteBrainEnabled?: boolean;
  remoteBrainUrl?: string;
  remoteBrainSecret?: string;
  remoteBrainTimeoutMs?: number;
  remoteBrainMaxTurns?: number;
  runtimeReleaseManifestUrl?: string;
  runtimeReleaseChannel?: string;
  skipOpenClawChannels?: boolean;
  providerId?: string;
  modelId?: string;
  preferredModelRef?: string;
  modelName?: string;
  modelContextWindow?: number;
  modelMaxTokens?: number;
  defaultTab?: string;
  requireLuminaAuth?: boolean;
  updateRepoOwner?: string;
  updateRepoName?: string;
}

export interface LuminaConfig {
  configDir: string;
  openclawConfigPath: string;
  openclawStateDir: string;
  workspaceDir: string;
  gatewayToken: string;
  gatewayPort: number;
  proxyPort: number;
  proxyApiKey: string;
  authServiceUrl: string;
  i24dChatUrl: string;
  i24dModelsBaseUrl: string;
  i24dToken: string;
  remoteBrainEnabled: boolean;
  remoteBrainUrl: string;
  remoteBrainSecret: string;
  remoteBrainTimeoutMs: number;
  remoteBrainMaxTurns: number;
  runtimeReleaseManifestUrl: string;
  runtimeReleaseChannel: string;
  skipOpenClawChannels: boolean;
  providerId: string;
  modelId: string;
  preferredModelRef: string;
  modelName: string;
  modelContextWindow: number;
  modelMaxTokens: number;
  defaultTab: string;
  requireLuminaAuth: boolean;
  updateRepoOwner: string;
  updateRepoName: string;
}

const DEFAULTS: Omit<LuminaConfig, "gatewayToken" | "i24dToken" | "remoteBrainSecret"> = {
  configDir: CONFIG_DIR,
  openclawConfigPath: OPENCLAW_CONFIG_FILE,
  openclawStateDir: OPENCLAW_STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  gatewayPort: renderPreset.gatewayPort,
  proxyPort: renderPreset.proxyPort,
  proxyApiKey: renderPreset.proxyApiKey,
  authServiceUrl: renderPreset.authServiceUrl,
  i24dChatUrl: renderPreset.i24dChatUrl,
  i24dModelsBaseUrl: renderPreset.i24dModelsBaseUrl,
  remoteBrainEnabled: false,
  remoteBrainUrl: renderPreset.remoteBrainUrl,
  remoteBrainTimeoutMs: renderPreset.remoteBrainTimeoutMs,
  remoteBrainMaxTurns: renderPreset.remoteBrainMaxTurns,
  runtimeReleaseManifestUrl: renderPreset.runtimeReleaseManifestUrl,
  runtimeReleaseChannel: renderPreset.runtimeReleaseChannel,
  skipOpenClawChannels: renderPreset.skipOpenClawChannels,
  providerId: CANONICAL_LUMINA_PROVIDER_ID,
  modelId: renderPreset.modelId,
  preferredModelRef: `${CANONICAL_LUMINA_PROVIDER_ID}/${renderPreset.modelId}`,
  modelName: renderPreset.modelName,
  modelContextWindow: renderPreset.modelContextWindow,
  modelMaxTokens: renderPreset.modelMaxTokens,
  defaultTab: DEFAULT_DESKTOP_TAB,
  requireLuminaAuth: renderPreset.requireLuminaAuth,
  updateRepoOwner: renderPreset.updateRepoOwner,
  updateRepoName: renderPreset.updateRepoName,
};

export function loadConfig(): LuminaConfig {
  const generatedDefaults = loadGeneratedDefaults();
  const storedConfig = loadStoredConfig();
  const currentOpenClawConfig = loadCurrentOpenClawConfig();
  const currentOpenClawModels = asObject(currentOpenClawConfig?.models);
  const currentOpenClawProviders = asObject(currentOpenClawModels?.providers);
  const currentOpenClawAgents = asObject(currentOpenClawConfig?.agents);
  const currentOpenClawDefaults = asObject(currentOpenClawAgents?.defaults);
  const currentOpenClawModelAliases = asObject(currentOpenClawDefaults?.models);
  const legacyConfig = loadLegacyOpenClawConfig();
  const storedModelName = normalizeModelName(storedConfig.modelName);
  const generatedModelName = normalizeModelName(generatedDefaults.modelName);
  const providerId =
    normalizeProviderIdValue(process.env.LUMINA_PROVIDER_ID) ??
    normalizeProviderIdValue(storedConfig.providerId) ??
    normalizeProviderIdValue(generatedDefaults.providerId) ??
    DEFAULTS.providerId;
  const modelId =
    readString(process.env.LUMINA_MODEL_ID) ??
    storedConfig.modelId ??
    generatedDefaults.modelId ??
    DEFAULTS.modelId;
  const managedModelRefs = new Set(
    resolveProviderLookupIds(providerId).map((candidateProviderId) =>
      createModelRef(candidateProviderId, modelId).toLowerCase(),
    ),
  );

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.mkdirSync(OPENCLAW_STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  } catch {
    // best-effort
  }

  const i24dModelsBaseUrl =
    readString(process.env.LUMINA_I24D_BASE_URL) ??
    storedConfig.i24dModelsBaseUrl ??
    generatedDefaults.i24dModelsBaseUrl ??
    DEFAULTS.i24dModelsBaseUrl;

  const i24dChatUrl =
    readString(process.env.LUMINA_I24D_CHAT_URL) ??
    storedConfig.i24dChatUrl ??
    generatedDefaults.i24dChatUrl ??
    joinUrlPath(i24dModelsBaseUrl, "/v1/chat/completions");

  const i24dToken =
    readString(process.env.LUMINA_I24D_TOKEN) ??
    generatedDefaults.i24dToken ??
    "";

  const remoteBrainUrl =
    readString(process.env.LUMINA_REMOTE_BRAIN_URL) ??
    storedConfig.remoteBrainUrl ??
    generatedDefaults.remoteBrainUrl ??
    joinUrlPath(i24dModelsBaseUrl, "/api/openclaw/brain/turn");

  const remoteBrainSecret =
    readString(process.env.LUMINA_REMOTE_BRAIN_SECRET) ??
    generatedDefaults.remoteBrainSecret ??
    "";

  const configuredRemoteBrainEnabled =
    readBool(process.env.LUMINA_REMOTE_BRAIN_ENABLED) ??
    storedConfig.remoteBrainEnabled ??
    generatedDefaults.remoteBrainEnabled;
  const inferredRemoteBrainEnabled = Boolean(remoteBrainUrl && remoteBrainSecret);
  const remoteBrainEnabled = Boolean(
    (configuredRemoteBrainEnabled ?? inferredRemoteBrainEnabled) && remoteBrainUrl && remoteBrainSecret,
  );
  const currentPreferredModelRef = readOpenClawPreferredModelRef(currentOpenClawConfig);
  const persistedPreferredModelRef =
    readString(process.env.LUMINA_PREFERRED_MODEL_REF) ??
    readString(storedConfig.preferredModelRef) ??
    readString(generatedDefaults.preferredModelRef) ??
    createModelRef(providerId, modelId);
  const preferredModelRef =
    currentPreferredModelRef &&
    !managedModelRefs.has(currentPreferredModelRef.toLowerCase()) &&
    hasConfiguredModelRef(
      currentOpenClawProviders,
      currentOpenClawModelAliases,
      currentPreferredModelRef,
    )
      ? currentPreferredModelRef
      : persistedPreferredModelRef;

  const config: LuminaConfig = {
    ...DEFAULTS,
    gatewayToken:
      readString(process.env.LUMINA_GATEWAY_TOKEN) ??
      storedConfig.gatewayToken ??
      readLegacyGatewayToken(legacyConfig) ??
      generateToken(),
    gatewayPort:
      readInt(process.env.LUMINA_GATEWAY_PORT) ??
      storedConfig.gatewayPort ??
      generatedDefaults.gatewayPort ??
      DEFAULTS.gatewayPort,
    proxyPort:
      readInt(process.env.LUMINA_PROXY_PORT) ??
      storedConfig.proxyPort ??
      generatedDefaults.proxyPort ??
      DEFAULTS.proxyPort,
    proxyApiKey:
      readString(process.env.LUMINA_PROXY_API_KEY) ??
      storedConfig.proxyApiKey ??
      generatedDefaults.proxyApiKey ??
      DEFAULTS.proxyApiKey,
    authServiceUrl:
      readString(process.env.LUMINA_AUTH_URL) ??
      storedConfig.authServiceUrl ??
      generatedDefaults.authServiceUrl ??
      DEFAULTS.authServiceUrl,
    i24dChatUrl,
    i24dModelsBaseUrl,
    i24dToken,
    remoteBrainEnabled,
    remoteBrainUrl,
    remoteBrainSecret,
    remoteBrainTimeoutMs:
      readInt(process.env.LUMINA_REMOTE_BRAIN_TIMEOUT_MS) ??
      storedConfig.remoteBrainTimeoutMs ??
      generatedDefaults.remoteBrainTimeoutMs ??
      DEFAULTS.remoteBrainTimeoutMs,
    remoteBrainMaxTurns:
      readInt(process.env.LUMINA_REMOTE_BRAIN_MAX_TURNS) ??
      storedConfig.remoteBrainMaxTurns ??
      generatedDefaults.remoteBrainMaxTurns ??
      DEFAULTS.remoteBrainMaxTurns,
    runtimeReleaseManifestUrl:
      readString(process.env.LUMINA_RUNTIME_RELEASE_MANIFEST_URL) ??
      generatedDefaults.runtimeReleaseManifestUrl ??
      storedConfig.runtimeReleaseManifestUrl ??
      DEFAULTS.runtimeReleaseManifestUrl,
    runtimeReleaseChannel:
      readString(process.env.LUMINA_RUNTIME_RELEASE_CHANNEL) ??
      generatedDefaults.runtimeReleaseChannel ??
      storedConfig.runtimeReleaseChannel ??
      DEFAULTS.runtimeReleaseChannel,
    skipOpenClawChannels:
      readBool(process.env.LUMINA_SKIP_OPENCLAW_CHANNELS) ??
      storedConfig.skipOpenClawChannels ??
      generatedDefaults.skipOpenClawChannels ??
      DEFAULTS.skipOpenClawChannels,
    providerId,
    modelId,
    preferredModelRef,
    modelName:
      readString(process.env.LUMINA_MODEL_NAME) ??
      storedModelName ??
      generatedModelName ??
      DEFAULTS.modelName,
    modelContextWindow:
      readInt(process.env.LUMINA_MODEL_CONTEXT_WINDOW) ??
      storedConfig.modelContextWindow ??
      generatedDefaults.modelContextWindow ??
      DEFAULTS.modelContextWindow,
    modelMaxTokens:
      readInt(process.env.LUMINA_MODEL_MAX_TOKENS) ??
      storedConfig.modelMaxTokens ??
      generatedDefaults.modelMaxTokens ??
      DEFAULTS.modelMaxTokens,
    defaultTab: normalizeDefaultTab(
      readString(process.env.LUMINA_DEFAULT_TAB) ??
        storedConfig.defaultTab ??
        generatedDefaults.defaultTab ??
        DEFAULTS.defaultTab,
    ),
    requireLuminaAuth:
      readBool(process.env.LUMINA_REQUIRE_AUTH) ??
      storedConfig.requireLuminaAuth ??
      generatedDefaults.requireLuminaAuth ??
      DEFAULTS.requireLuminaAuth,
    updateRepoOwner:
      readString(process.env.LUMINA_GITHUB_OWNER) ??
      storedConfig.updateRepoOwner ??
      generatedDefaults.updateRepoOwner ??
      DEFAULTS.updateRepoOwner,
    updateRepoName:
      readString(process.env.LUMINA_GITHUB_REPO) ??
      storedConfig.updateRepoName ??
      generatedDefaults.updateRepoName ??
      DEFAULTS.updateRepoName,
  };

  saveConfig(config);
  return config;
}

export function saveConfig(config: LuminaConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_FILE,
      `${JSON.stringify(
        {
          gatewayToken: config.gatewayToken,
          gatewayPort: config.gatewayPort,
          proxyPort: config.proxyPort,
          proxyApiKey: config.proxyApiKey,
          authServiceUrl: config.authServiceUrl,
          i24dChatUrl: config.i24dChatUrl,
          i24dModelsBaseUrl: config.i24dModelsBaseUrl,
          remoteBrainEnabled: config.remoteBrainEnabled,
          remoteBrainUrl: config.remoteBrainUrl,
          remoteBrainTimeoutMs: config.remoteBrainTimeoutMs,
          remoteBrainMaxTurns: config.remoteBrainMaxTurns,
          runtimeReleaseManifestUrl: config.runtimeReleaseManifestUrl,
          runtimeReleaseChannel: config.runtimeReleaseChannel,
          skipOpenClawChannels: config.skipOpenClawChannels,
          providerId: config.providerId,
          modelId: config.modelId,
          preferredModelRef: config.preferredModelRef,
          modelName: config.modelName,
          modelContextWindow: config.modelContextWindow,
          modelMaxTokens: config.modelMaxTokens,
          defaultTab: config.defaultTab,
          requireLuminaAuth: config.requireLuminaAuth,
          updateRepoOwner: config.updateRepoOwner,
          updateRepoName: config.updateRepoName,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (err) {
    console.error("[config] Failed to save config:", err);
  }
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function loadStoredConfig(): StoredLuminaConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as StoredLuminaConfig;
  } catch {
    return {};
  }
}

function loadGeneratedDefaults(): GeneratedDefaults {
  try {
    const runtimePaths = resolveRuntimePaths();
    if (!fs.existsSync(runtimePaths.defaultsFilePath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(runtimePaths.defaultsFilePath, "utf8")) as GeneratedDefaults;
  } catch {
    return {};
  }
}

function loadCurrentOpenClawConfig(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG_FILE)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadLegacyOpenClawConfig(): Record<string, unknown> | null {
  try {
    const legacyPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    if (!fs.existsSync(legacyPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readLegacyGatewayToken(config: Record<string, unknown> | null): string | null {
  const gateway = asObject(config?.gateway);
  const auth = asObject(gateway?.auth);
  return readStringValue(auth?.token);
}

function readLegacyI24dToken(
  config: Record<string, unknown> | null,
  providerId: string,
): string | null {
  const models = asObject(config?.models);
  const providers = asObject(models?.providers);
  for (const candidateProviderId of resolveProviderLookupIds(providerId)) {
    const provider = asObject(providers?.[candidateProviderId]);
    const token = readStringValue(provider?.apiKey);
    if (token) {
      return token;
    }
  }
  return null;
}

function readOpenClawPreferredModelRef(config: Record<string, unknown> | null): string | null {
  const agents = asObject(config?.agents);
  const defaults = asObject(agents?.defaults);
  return readModelPrimaryValue(defaults?.model);
}

function readModelPrimaryValue(value: unknown): string | null {
  if (typeof value === "string") {
    return readString(value);
  }
  const object = asObject(value);
  return readStringValue(object?.primary);
}

function parseModelRef(modelRef: string): { providerId: string; modelId: string } | null {
  const trimmed = modelRef.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator >= trimmed.length - 1) {
    return null;
  }
  const providerId = normalizeProviderIdValue(trimmed.slice(0, separator)) ?? "";
  const modelId = readString(trimmed.slice(separator + 1)) ?? "";
  if (!providerId || !modelId) {
    return null;
  }
  return { providerId, modelId };
}

function hasConfiguredModelRef(
  providers: Record<string, unknown> | null,
  modelAliases: Record<string, unknown> | null,
  modelRef: string,
): boolean {
  const normalizedModelRef = readString(modelRef);
  if (!normalizedModelRef) {
    return false;
  }
  if (modelAliases && modelAliases[normalizedModelRef] !== undefined) {
    return true;
  }
  const parsed = parseModelRef(normalizedModelRef);
  if (!parsed || !providers) {
    return false;
  }
  const provider = asObject(providers[parsed.providerId]);
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return models.some((entry) => {
    const object = asObject(entry);
    return typeof object?.id === "string" && object.id.trim().toLowerCase() === parsed.modelId.toLowerCase();
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(input: string | undefined): string | null {
  if (!input) {
    return null;
  }
  const value = input.trim();
  return value ? value : null;
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" ? readString(value) : null;
}

function normalizeDefaultTab(value: string | undefined): string {
  const trimmed = readString(value);
  if (!trimmed || trimmed === "instances") {
    return DEFAULT_DESKTOP_TAB;
  }
  return trimmed;
}

function readInt(input: string | undefined): number | null {
  if (!input) {
    return null;
  }
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) ? value : null;
}

function readBool(input: string | undefined): boolean | null {
  if (!input) {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizeProviderIdValue(input: string | undefined): string | null {
  const value = readString(input);
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (LEGACY_LUMINA_PROVIDER_IDS.includes(normalized)) {
    return CANONICAL_LUMINA_PROVIDER_ID;
  }
  return normalized;
}

function resolveProviderLookupIds(providerId: string): string[] {
  const normalized = normalizeProviderIdValue(providerId) ?? DEFAULTS.providerId;
  if (normalized === CANONICAL_LUMINA_PROVIDER_ID) {
    return [CANONICAL_LUMINA_PROVIDER_ID, ...LEGACY_LUMINA_PROVIDER_IDS];
  }
  return [normalized];
}

function normalizeModelName(input: string | undefined): string | null {
  const value = readString(input);
  if (!value) {
    return null;
  }
  return value === "I24D (Lumina)" ? "Lumina IA" : value;
}

function createModelRef(providerId: string, modelId: string): string {
  const normalizedProviderId = normalizeProviderIdValue(providerId) ?? readString(providerId) ?? "";
  const normalizedModelId = readString(modelId) ?? "";
  if (!normalizedProviderId || !normalizedModelId) {
    return "";
  }
  return `${normalizedProviderId}/${normalizedModelId}`;
}

function joinUrlPath(baseUrl: string, pathname: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBase) {
    return "";
  }
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${normalizedBase}${normalizedPath}`;
}
