import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { resolveRuntimePaths } from "./runtime-paths.js";

const CONFIG_DIR = path.join(os.homedir(), ".lumina");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const OPENCLAW_CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");
const OPENCLAW_STATE_DIR = path.join(CONFIG_DIR, "openclaw-state");
const WORKSPACE_DIR = path.join(CONFIG_DIR, "workspace");

interface GeneratedDefaults {
  authServiceUrl?: string;
  providerId?: string;
  modelId?: string;
  modelName?: string;
  modelContextWindow?: number;
  modelMaxTokens?: number;
  proxyPort?: number;
  gatewayPort?: number;
  proxyApiKey?: string;
  i24dModelsBaseUrl?: string;
  i24dChatUrl?: string;
  i24dToken?: string;
  defaultTab?: string;
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
  providerId?: string;
  modelId?: string;
  modelName?: string;
  modelContextWindow?: number;
  modelMaxTokens?: number;
  defaultTab?: string;
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
  providerId: string;
  modelId: string;
  modelName: string;
  modelContextWindow: number;
  modelMaxTokens: number;
  defaultTab: string;
  updateRepoOwner: string;
  updateRepoName: string;
}

const DEFAULTS: Omit<LuminaConfig, "gatewayToken" | "i24dToken"> = {
  configDir: CONFIG_DIR,
  openclawConfigPath: OPENCLAW_CONFIG_FILE,
  openclawStateDir: OPENCLAW_STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  gatewayPort: 18789,
  proxyPort: 4321,
  proxyApiKey: "lumina-local-proxy",
  authServiceUrl: "https://lumina-auth.onrender.com",
  i24dChatUrl: "https://i24d-whatsapp-ai.onrender.com/v1/chat/completions",
  i24dModelsBaseUrl: "https://i24d-whatsapp-ai.onrender.com",
  providerId: "custom-i24d-whatsapp-ai-onrender-com",
  modelId: "I24D",
  modelName: "I24D (Lumina)",
  modelContextWindow: 16000,
  modelMaxTokens: 4096,
  defaultTab: "instances",
  updateRepoOwner: "I24D",
  updateRepoName: "Lumina-I24D",
};

export function loadConfig(): LuminaConfig {
  const generatedDefaults = loadGeneratedDefaults();
  const storedConfig = loadStoredConfig();
  const legacyConfig = loadLegacyOpenClawConfig();
  const providerId =
    readString(process.env.LUMINA_PROVIDER_ID) ??
    storedConfig.providerId ??
    generatedDefaults.providerId ??
    DEFAULTS.providerId;

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.mkdirSync(OPENCLAW_STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  } catch {
    // best-effort
  }

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
    i24dChatUrl:
      readString(process.env.LUMINA_I24D_CHAT_URL) ??
      storedConfig.i24dChatUrl ??
      generatedDefaults.i24dChatUrl ??
      DEFAULTS.i24dChatUrl,
    i24dModelsBaseUrl:
      readString(process.env.LUMINA_I24D_BASE_URL) ??
      storedConfig.i24dModelsBaseUrl ??
      generatedDefaults.i24dModelsBaseUrl ??
      DEFAULTS.i24dModelsBaseUrl,
    i24dToken:
      readString(process.env.LUMINA_I24D_TOKEN) ??
      storedConfig.i24dToken ??
      readLegacyI24dToken(legacyConfig, providerId) ??
      generatedDefaults.i24dToken ??
      "",
    providerId,
    modelId:
      readString(process.env.LUMINA_MODEL_ID) ??
      storedConfig.modelId ??
      generatedDefaults.modelId ??
      DEFAULTS.modelId,
    modelName:
      readString(process.env.LUMINA_MODEL_NAME) ??
      storedConfig.modelName ??
      generatedDefaults.modelName ??
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
    defaultTab:
      readString(process.env.LUMINA_DEFAULT_TAB) ??
      storedConfig.defaultTab ??
      generatedDefaults.defaultTab ??
      DEFAULTS.defaultTab,
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
          i24dToken: config.i24dToken,
          providerId: config.providerId,
          modelId: config.modelId,
          modelName: config.modelName,
          modelContextWindow: config.modelContextWindow,
          modelMaxTokens: config.modelMaxTokens,
          defaultTab: config.defaultTab,
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
  const provider = asObject(providers?.[providerId]);
  return readStringValue(provider?.apiKey);
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

function readInt(input: string | undefined): number | null {
  if (!input) {
    return null;
  }
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) ? value : null;
}
