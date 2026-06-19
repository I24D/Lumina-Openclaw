import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { saveConfig, type LuminaConfig } from "./config.js";
import type { RuntimePaths } from "./runtime-paths.js";

type JsonObject = Record<string, unknown>;
const ACTIVATION_DEFAULTS_VERSION = 4;
const DEFAULT_LUMINA_CHAT_MODEL_ID = "gpt-5.5";
const LEGACY_LUMINA_PROVIDER_IDS = ["custom-i24d-whatsapp-ai-onrender-com"] as const;
const OLLAMA_CLOUD_MODEL_TEMPLATES: JsonObject[] = [
  {
    id: "minimax-m3",
    name: "MiniMax M3",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoning: true,
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "minimax-m2.1",
    name: "MiniMax M2.1",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
  },
  {
    id: "minimax-m2",
    name: "MiniMax M2",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "nemotron-3-ultra",
    name: "NVIDIA Nemotron 3 Ultra",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "nemotron-3-super",
    name: "NVIDIA Nemotron 3 Super",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "nemotron-3-nano:30b",
    name: "NVIDIA Nemotron 3 Nano 30B",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "gemma4:31b",
    name: "Google Gemma 4 31B",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text", "image", "audio"],
    reasoning: true,
  },
  {
    id: "gemma3:27b",
    name: "Google Gemma 3 27B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
  },
  {
    id: "gemma3:12b",
    name: "Google Gemma 3 12B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
  },
  {
    id: "gemma3:4b",
    name: "Google Gemma 3 4B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
  },
  {
    id: "qwen3.5:397b",
    name: "Alibaba Qwen3.5 397B",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoning: true,
  },
  {
    id: "qwen3-coder-next",
    name: "Alibaba Qwen3 Coder Next",
    contextWindow: 262144,
    maxTokens: 32768,
    input: ["text"],
  },
  {
    id: "qwen3-coder:480b",
    name: "Alibaba Qwen3 Coder 480B",
    contextWindow: 262144,
    maxTokens: 32768,
    input: ["text"],
  },
  {
    id: "qwen3-vl:235b-instruct",
    name: "Alibaba Qwen3 VL 235B Instruct",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoning: true,
  },
  {
    id: "qwen3-vl:235b",
    name: "Alibaba Qwen3 VL 235B",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoning: true,
  },
  {
    id: "qwen3-next:80b",
    name: "Alibaba Qwen3 Next 80B",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "glm-5.1",
    name: "Z.ai GLM 5.1",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "glm-5",
    name: "Z.ai GLM 5",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "glm-4.7",
    name: "Z.ai GLM 4.7",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "glm-4.6",
    name: "Z.ai GLM 4.6",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "deepseek-v3.1:671b",
    name: "DeepSeek V3.1 671B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "kimi-k2.6",
    name: "Moonshot Kimi K2.6",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoning: true,
  },
  {
    id: "kimi-k2.5",
    name: "Moonshot Kimi K2.5",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoning: true,
  },
  {
    id: "kimi-k2-thinking",
    name: "Moonshot Kimi K2 Thinking",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "kimi-k2:1t",
    name: "Moonshot Kimi K2 1T",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
  },
  {
    id: "gpt-oss:120b",
    name: "OpenAI GPT OSS 120B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "gpt-oss:20b",
    name: "OpenAI GPT OSS 20B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "gemini-3-flash-preview",
    name: "Google Gemini 3 Flash Preview",
    contextWindow: 1048576,
    maxTokens: 65536,
    input: ["text", "image"],
    reasoning: true,
  },
  {
    id: "ministral-3:14b",
    name: "Mistral Ministral 3 14B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
  },
  {
    id: "ministral-3:8b",
    name: "Mistral Ministral 3 8B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
  },
  {
    id: "ministral-3:3b",
    name: "Mistral Ministral 3 3B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
  },
  {
    id: "mistral-large-3:675b",
    name: "Mistral Large 3 675B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
  },
  {
    id: "devstral-2:123b",
    name: "Mistral Devstral 2 123B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
  },
  {
    id: "devstral-small-2:24b",
    name: "Mistral Devstral Small 2 24B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
  },
  {
    id: "cogito-2.1:671b",
    name: "Essential Cogito 2.1 671B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
    reasoning: true,
  },
  {
    id: "rnj-1:8b",
    name: "Essential RNJ 1 8B",
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text"],
  },
];
const VALID_OPENCLAW_MODEL_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
  "azure-openai-responses",
]);
const DEPRECATED_MODEL_API_RENAMES = new Map([["google-gemini", "google-generative-ai"]]);
// OpenClaw v2026.5.22 rejects "document" and legacy "pdf" model input declarations.
const VALID_OPENCLAW_MODEL_INPUTS = new Set(["text", "image", "audio", "video"]);

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

function generateRuntimeSecret(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(32).toString("base64url")}`;
}

function sanitizeHooksConfig(config: JsonObject, gatewayToken: string): void {
  const hooks = asObject(config.hooks);
  if (hooks.enabled !== true) {
    return;
  }
  const hooksToken = typeof hooks.token === "string" ? hooks.token.trim() : "";
  const normalizedGatewayToken = gatewayToken.trim();
  if (!hooksToken || (normalizedGatewayToken && hooksToken === normalizedGatewayToken)) {
    hooks.token = generateRuntimeSecret("lumina-hook");
    config.hooks = hooks;
  }
}

function normalizeModelInputs(value: unknown): string[] {
  const result: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalizedEntry = entry === "pdf" ? "document" : entry;
      if (
        typeof normalizedEntry === "string" &&
        VALID_OPENCLAW_MODEL_INPUTS.has(normalizedEntry) &&
        !result.includes(normalizedEntry)
      ) {
        result.push(normalizedEntry);
      }
    }
  }
  return result.length > 0 ? result : ["text"];
}

function sanitizeModelTemplate(model: JsonObject): JsonObject {
  return {
    ...model,
    input: normalizeModelInputs(model.input),
  };
}

function sanitizeModelTemplates(models: unknown): JsonObject[] {
  if (!Array.isArray(models)) {
    return [];
  }
  return models.map((entry) => sanitizeModelTemplate(asObject(entry)));
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

function mergeProviderTemplateModels(provider: JsonObject, template: JsonObject): JsonObject {
  const existingModels = sanitizeModelTemplates(provider.models);
  const templateModels = sanitizeModelTemplates(template.models);
  const mergedModels: JsonObject[] = [...existingModels];
  const indexById = new Map<string, number>();

  for (const [index, entry] of mergedModels.entries()) {
    const model = asObject(entry);
    if (typeof model.id === "string" && model.id.trim()) {
      indexById.set(model.id.trim().toLowerCase(), index);
    }
  }

  for (const entry of templateModels) {
    const templateModel = asObject(entry);
    if (typeof templateModel.id !== "string" || !templateModel.id.trim()) {
      continue;
    }
    const key = templateModel.id.trim().toLowerCase();
    const existingIndex = indexById.get(key);
    if (existingIndex === undefined) {
      indexById.set(key, mergedModels.length);
      mergedModels.push(templateModel);
      continue;
    }
    mergedModels[existingIndex] = sanitizeModelTemplate({
      ...templateModel,
      ...asObject(mergedModels[existingIndex]),
    });
  }

  return {
    ...provider,
    models: sanitizeModelTemplates(mergedModels),
  };
}

function dedupeModelTemplates(models: JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  const result: JsonObject[] = [];
  for (const model of models) {
    const id = typeof model.id === "string" ? model.id.trim().toLowerCase() : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(sanitizeModelTemplate(model));
  }
  return result;
}

function normalizeProviderTemplateApi(provider: JsonObject, template: JsonObject): JsonObject {
  const api = typeof provider.api === "string" ? provider.api.trim() : "";
  const renamedApi = DEPRECATED_MODEL_API_RENAMES.get(api);
  let normalizedProvider = provider;
  if (renamedApi) {
    normalizedProvider = {
      ...normalizedProvider,
      api: renamedApi,
    };
  } else if (!VALID_OPENCLAW_MODEL_APIS.has(api)) {
    normalizedProvider = {
      ...normalizedProvider,
      api: template.api,
    };
  }
  if (typeof normalizedProvider.baseUrl !== "string" || !normalizedProvider.baseUrl.trim()) {
    normalizedProvider = {
      ...normalizedProvider,
      baseUrl: template.baseUrl,
    };
  }
  return mergeProviderTemplateModels(normalizedProvider, template);
}

function normalizeManagedProxyProvider(provider: JsonObject, template: JsonObject): JsonObject {
  return mergeProviderTemplateModels(
    {
      ...provider,
      baseUrl: template.baseUrl,
      api: template.api,
      apiKey: template.apiKey,
    },
    template,
  );
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
    return (
      typeof object.id === "string" &&
      object.id.trim().toLowerCase() === parsed.modelId.toLowerCase()
    );
  });
}

export function bootstrapLuminaRuntime(config: LuminaConfig, paths: RuntimePaths): void {
  ensureDir(config.configDir);
  ensureDir(config.openclawStateDir);
  ensureDir(config.workspaceDir);

  const existing = loadJson(config.openclawConfigPath);
  const next = { ...existing };
  const shouldApplyActivationDefaults =
    !Number.isFinite(config.activationDefaultsVersion) ||
    config.activationDefaultsVersion < ACTIVATION_DEFAULTS_VERSION;

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
    enabled: true,
    allowInsecureAuth: true,
  };
  next.gateway = gateway;
  sanitizeHooksConfig(next, config.gatewayToken);

  const tools = asObject(next.tools);
  if (shouldApplyActivationDefaults || typeof tools.profile !== "string" || !tools.profile.trim()) {
    tools.profile = "full";
  }
  const execTools = asObject(tools.exec);
  if (shouldApplyActivationDefaults || typeof execTools.host !== "string" || !execTools.host.trim()) {
    execTools.host = "gateway";
  }
  if (
    shouldApplyActivationDefaults ||
    typeof execTools.security !== "string" ||
    !execTools.security.trim()
  ) {
    execTools.security = "full";
  }
  if (shouldApplyActivationDefaults || typeof execTools.ask !== "string" || !execTools.ask.trim()) {
    execTools.ask = "off";
  }
  tools.exec = execTools;
  const fsTools = asObject(tools.fs);
  if (shouldApplyActivationDefaults || typeof fsTools.workspaceOnly !== "boolean") {
    fsTools.workspaceOnly = false;
  }
  tools.fs = fsTools;
  next.tools = tools;

  const session = asObject(next.session);
  if (typeof session.dmScope !== "string" || !session.dmScope.trim()) {
    session.dmScope = "per-channel-peer";
  }
  next.session = session;

  const models = asObject(next.models);
  // Lumina supplies the usable desktop catalog through its proxy.
  models.mode = "replace";
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
    models: dedupeModelTemplates([
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
      {
        id: DEFAULT_LUMINA_CHAT_MODEL_ID,
        name: "OpenAI GPT-5.5 via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5.4-pro",
        name: "OpenAI GPT-5.4 Pro via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5.4",
        name: "OpenAI GPT-5.4 via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5.4-mini",
        name: "OpenAI GPT-5.4 Mini via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5.2",
        name: "OpenAI GPT-5.2 via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5.2-pro",
        name: "OpenAI GPT-5.2 Pro via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5.2-codex",
        name: "OpenAI GPT-5.2 Codex via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5.1",
        name: "OpenAI GPT-5.1 via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5",
        name: "OpenAI GPT-5 via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5-mini",
        name: "OpenAI GPT-5 Mini via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-5-nano",
        name: "OpenAI GPT-5 Nano via Lumina",
        contextWindow: 400000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gpt-4.1",
        name: "OpenAI GPT-4.1 via Lumina",
        contextWindow: 1047576,
        maxTokens: 32768,
        input: ["text", "image"],
      },
      {
        id: "gpt-4.1-mini",
        name: "OpenAI GPT-4.1 Mini via Lumina",
        contextWindow: 1047576,
        maxTokens: 32768,
        input: ["text", "image"],
      },
      {
        id: "gpt-4.1-nano",
        name: "OpenAI GPT-4.1 Nano via Lumina",
        contextWindow: 1047576,
        maxTokens: 32768,
        input: ["text", "image"],
      },
      {
        id: "gpt-4o",
        name: "OpenAI GPT-4o via Lumina",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text", "image"],
      },
      {
        id: "gpt-4o-mini",
        name: "OpenAI GPT-4o Mini via Lumina",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text", "image"],
      },
      {
        id: "o3",
        name: "OpenAI o3 via Lumina",
        contextWindow: 200000,
        maxTokens: 100000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "o4-mini",
        name: "OpenAI o4 Mini via Lumina",
        contextWindow: 200000,
        maxTokens: 100000,
        input: ["text"],
        reasoning: true,
      },
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7 via Lumina",
        contextWindow: 200000,
        maxTokens: 32000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6 via Lumina",
        contextWindow: 200000,
        maxTokens: 32000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-opus-4-5-20251101",
        name: "Claude Opus 4.5 via Lumina",
        contextWindow: 200000,
        maxTokens: 32000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5 via Lumina",
        contextWindow: 200000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5 via Lumina",
        contextWindow: 200000,
        maxTokens: 8192,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-opus-4-1-20250805",
        name: "Claude Opus 4.1 via Lumina",
        contextWindow: 200000,
        maxTokens: 32000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4 via Lumina",
        contextWindow: 200000,
        maxTokens: 32000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4 via Lumina",
        contextWindow: 200000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-3-7-sonnet-20250219",
        name: "Claude Sonnet 3.7 via Lumina",
        contextWindow: 200000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude Sonnet 3.5 via Lumina",
        contextWindow: 200000,
        maxTokens: 8192,
        input: ["text", "image"],
      },
      {
        id: "claude-3-5-haiku-20241022",
        name: "Claude Haiku 3.5 via Lumina",
        contextWindow: 200000,
        maxTokens: 8192,
        input: ["text", "image"],
      },
      {
        id: "gemini-2.5-pro-preview-06-05",
        name: "Google Gemini 2.5 Pro Preview via Lumina",
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image", "audio", "video", "document"],
        reasoning: true,
      },
      {
        id: "gemini-3.1-pro-preview",
        name: "Google Gemini 3.1 Pro Preview via Lumina",
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image", "audio", "video", "document"],
        reasoning: true,
      },
      {
        id: "gemini-3-flash-preview",
        name: "Google Gemini 3 Flash Preview via Lumina",
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image", "audio", "video", "document"],
        reasoning: true,
      },
      {
        id: "gemini-3-pro-preview",
        name: "Google Gemini 3 Pro Preview via Lumina",
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image", "audio", "video", "document"],
        reasoning: true,
      },
      {
        id: "gemini-2.5-pro",
        name: "Google Gemini 2.5 Pro via Lumina",
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image", "audio", "video", "document"],
        reasoning: true,
      },
      {
        id: "gemini-2.5-flash",
        name: "Google Gemini 2.5 Flash via Lumina",
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image", "audio", "video", "document"],
        reasoning: true,
      },
      {
        id: "gemini-2.5-flash-lite",
        name: "Google Gemini 2.5 Flash-Lite via Lumina",
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image", "audio", "video", "document"],
        reasoning: true,
      },
      {
        id: "gemini-2.5-flash-image",
        name: "Google Gemini 2.5 Flash Image via Lumina",
        contextWindow: 1048576,
        maxTokens: 32768,
        input: ["text", "image"],
        reasoning: true,
      },
      {
        id: "gemini-2.0-flash",
        name: "Google Gemini 2.0 Flash via Lumina",
        contextWindow: 1048576,
        maxTokens: 8192,
        input: ["text", "image", "audio", "video"],
      },
      {
        id: "gemini-2.0-flash-lite",
        name: "Google Gemini 2.0 Flash-Lite via Lumina",
        contextWindow: 1048576,
        maxTokens: 8192,
        input: ["text", "image", "audio", "video"],
      },
      {
        id: "gemini-1.5-pro",
        name: "Google Gemini 1.5 Pro via Lumina",
        contextWindow: 1048576,
        maxTokens: 8192,
        input: ["text", "image", "audio", "video"],
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro via Lumina",
        contextWindow: 64000,
        maxTokens: 8192,
        input: ["text"],
        reasoning: true,
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash via Lumina",
        contextWindow: 64000,
        maxTokens: 8192,
        input: ["text"],
        reasoning: true,
      },
      {
        id: "deepseek-v3.1",
        name: "DeepSeek V3.1 via Lumina",
        contextWindow: 64000,
        maxTokens: 8192,
        input: ["text"],
        reasoning: true,
      },
      {
        id: "deepseek-r1-0528",
        name: "DeepSeek R1 via Lumina",
        contextWindow: 64000,
        maxTokens: 8192,
        input: ["text"],
        reasoning: true,
      },
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat via Lumina",
        contextWindow: 64000,
        maxTokens: 8192,
        input: ["text"],
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner via Lumina",
        contextWindow: 64000,
        maxTokens: 8192,
        input: ["text"],
        reasoning: true,
      },
      ...OLLAMA_CLOUD_MODEL_TEMPLATES,
    ]),
  };
  const providerTemplates: Array<[string, JsonObject]> = [
    [
      "openai",
      {
        baseUrl: `http://127.0.0.1:${config.proxyPort}/v1`,
        api: "openai-completions",
        apiKey: config.proxyApiKey,
        models: [
          {
            id: "gpt-5.5",
            name: "OpenAI GPT-5.5",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5.4-pro",
            name: "OpenAI GPT-5.4 Pro",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5.4",
            name: "OpenAI GPT-5.4",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5.4-mini",
            name: "OpenAI GPT-5.4 Mini",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5.2",
            name: "OpenAI GPT-5.2",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5.2-pro",
            name: "OpenAI GPT-5.2 Pro",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5.2-codex",
            name: "OpenAI GPT-5.2 Codex",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5.1",
            name: "OpenAI GPT-5.1",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5",
            name: "OpenAI GPT-5",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5-mini",
            name: "OpenAI GPT-5 Mini",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-5-nano",
            name: "OpenAI GPT-5 Nano",
            contextWindow: 400000,
            maxTokens: 128000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gpt-4.1",
            name: "OpenAI GPT-4.1",
            contextWindow: 1047576,
            maxTokens: 32768,
            input: ["text", "image"],
          },
          {
            id: "gpt-4.1-mini",
            name: "OpenAI GPT-4.1 Mini",
            contextWindow: 1047576,
            maxTokens: 32768,
            input: ["text", "image"],
          },
          {
            id: "gpt-4.1-nano",
            name: "OpenAI GPT-4.1 Nano",
            contextWindow: 1047576,
            maxTokens: 32768,
            input: ["text", "image"],
          },
          {
            id: "gpt-4o",
            name: "OpenAI GPT-4o",
            contextWindow: 128000,
            maxTokens: 16384,
            input: ["text", "image"],
          },
          {
            id: "gpt-4o-mini",
            name: "OpenAI GPT-4o Mini",
            contextWindow: 128000,
            maxTokens: 16384,
            input: ["text", "image"],
          },
          {
            id: "o3",
            name: "OpenAI o3",
            contextWindow: 200000,
            maxTokens: 100000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "o4-mini",
            name: "OpenAI o4 Mini",
            contextWindow: 200000,
            maxTokens: 100000,
            input: ["text"],
            reasoning: true,
          },
        ],
      },
    ],
    [
      "anthropic",
      {
        baseUrl: `http://127.0.0.1:${config.proxyPort}/v1`,
        api: "openai-completions",
        apiKey: config.proxyApiKey,
        models: [
          {
            id: "claude-opus-4-7",
            name: "Anthropic Claude Opus 4.7",
            contextWindow: 200000,
            maxTokens: 32000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-opus-4-6",
            name: "Anthropic Claude Opus 4.6",
            contextWindow: 200000,
            maxTokens: 32000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-opus-4-5-20251101",
            name: "Anthropic Claude Opus 4.5",
            contextWindow: 200000,
            maxTokens: 32000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-sonnet-4-5-20250929",
            name: "Anthropic Claude Sonnet 4.5",
            contextWindow: 200000,
            maxTokens: 64000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-haiku-4-5-20251001",
            name: "Anthropic Claude Haiku 4.5",
            contextWindow: 200000,
            maxTokens: 8192,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-opus-4-1-20250805",
            name: "Anthropic Claude Opus 4.1",
            contextWindow: 200000,
            maxTokens: 32000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-opus-4-20250514",
            name: "Anthropic Claude Opus 4",
            contextWindow: 200000,
            maxTokens: 32000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-sonnet-4-20250514",
            name: "Anthropic Claude Sonnet 4",
            contextWindow: 200000,
            maxTokens: 64000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-3-7-sonnet-20250219",
            name: "Anthropic Claude Sonnet 3.7",
            contextWindow: 200000,
            maxTokens: 64000,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "claude-3-5-sonnet-20241022",
            name: "Anthropic Claude Sonnet 3.5",
            contextWindow: 200000,
            maxTokens: 8192,
            input: ["text", "image"],
          },
          {
            id: "claude-3-5-haiku-20241022",
            name: "Anthropic Claude Haiku 3.5",
            contextWindow: 200000,
            maxTokens: 8192,
            input: ["text", "image"],
          },
        ],
      },
    ],
    [
      "ollama-cloud",
      {
        baseUrl: `http://127.0.0.1:${config.proxyPort}/v1`,
        api: "openai-completions",
        apiKey: config.proxyApiKey,
        models: OLLAMA_CLOUD_MODEL_TEMPLATES,
      },
    ],
    [
      "gemini",
      {
        baseUrl: `http://127.0.0.1:${config.proxyPort}/v1`,
        api: "openai-completions",
        apiKey: config.proxyApiKey,
        models: [
          {
            id: "gemini-2.5-pro-preview-06-05",
            name: "Google Gemini 2.5 Pro Preview",
            contextWindow: 1048576,
            maxTokens: 65536,
            input: ["text", "image", "audio", "video", "document"],
            reasoning: true,
          },
          {
            id: "gemini-3.1-pro-preview",
            name: "Google Gemini 3.1 Pro Preview",
            contextWindow: 1048576,
            maxTokens: 65536,
            input: ["text", "image", "audio", "video", "document"],
            reasoning: true,
          },
          {
            id: "gemini-3-flash-preview",
            name: "Google Gemini 3 Flash Preview",
            contextWindow: 1048576,
            maxTokens: 65536,
            input: ["text", "image", "audio", "video", "document"],
            reasoning: true,
          },
          {
            id: "gemini-3-pro-preview",
            name: "Google Gemini 3 Pro Preview",
            contextWindow: 1048576,
            maxTokens: 65536,
            input: ["text", "image", "audio", "video", "document"],
            reasoning: true,
          },
          {
            id: "gemini-2.5-pro",
            name: "Google Gemini 2.5 Pro",
            contextWindow: 1048576,
            maxTokens: 65536,
            input: ["text", "image", "audio", "video", "document"],
            reasoning: true,
          },
          {
            id: "gemini-2.5-flash",
            name: "Google Gemini 2.5 Flash",
            contextWindow: 1048576,
            maxTokens: 65536,
            input: ["text", "image", "audio", "video", "document"],
            reasoning: true,
          },
          {
            id: "gemini-2.5-flash-lite",
            name: "Google Gemini 2.5 Flash-Lite",
            contextWindow: 1048576,
            maxTokens: 65536,
            input: ["text", "image", "audio", "video", "document"],
            reasoning: true,
          },
          {
            id: "gemini-2.5-flash-image",
            name: "Google Gemini 2.5 Flash Image",
            contextWindow: 1048576,
            maxTokens: 32768,
            input: ["text", "image"],
            reasoning: true,
          },
          {
            id: "gemini-2.0-flash",
            name: "Google Gemini 2.0 Flash",
            contextWindow: 1048576,
            maxTokens: 8192,
            input: ["text", "image", "audio", "video"],
          },
          {
            id: "gemini-2.0-flash-lite",
            name: "Google Gemini 2.0 Flash-Lite",
            contextWindow: 1048576,
            maxTokens: 8192,
            input: ["text", "image", "audio", "video"],
          },
          {
            id: "gemini-1.5-pro",
            name: "Google Gemini 1.5 Pro",
            contextWindow: 1048576,
            maxTokens: 8192,
            input: ["text", "image", "audio", "video"],
          },
        ],
      },
    ],
    [
      "deepseek",
      {
        baseUrl: `http://127.0.0.1:${config.proxyPort}/v1`,
        api: "openai-completions",
        apiKey: config.proxyApiKey,
        models: [
          {
            id: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            contextWindow: 64000,
            maxTokens: 8192,
            input: ["text"],
            reasoning: true,
          },
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            contextWindow: 64000,
            maxTokens: 8192,
            input: ["text"],
            reasoning: true,
          },
          {
            id: "deepseek-v3.1",
            name: "DeepSeek V3.1",
            contextWindow: 64000,
            maxTokens: 8192,
            input: ["text"],
            reasoning: true,
          },
          {
            id: "deepseek-r1-0528",
            name: "DeepSeek R1",
            contextWindow: 64000,
            maxTokens: 8192,
            input: ["text"],
            reasoning: true,
          },
          {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            contextWindow: 64000,
            maxTokens: 8192,
            input: ["text"],
          },
          {
            id: "deepseek-reasoner",
            name: "DeepSeek Reasoner",
            contextWindow: 64000,
            maxTokens: 8192,
            input: ["text"],
            reasoning: true,
          },
        ],
      },
    ],
  ];
  for (const [templateProviderId, template] of providerTemplates) {
    const existingProvider = asObject(providers[templateProviderId]);
    providers[templateProviderId] = normalizeManagedProxyProvider(existingProvider, template);
  }
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
  modelAliases[createModelRef(providerId, DEFAULT_LUMINA_CHAT_MODEL_ID)] ??= {};
  const managedModelRefs = new Set(
    managedProviderIds.map((managedProviderId) =>
      createModelRef(managedProviderId, config.modelId).toLowerCase(),
    ),
  );
  const preferredModelRef = shouldApplyActivationDefaults
    ? createModelRef(providerId, DEFAULT_LUMINA_CHAT_MODEL_ID)
    : (normalizeModelValue(config.preferredModelRef) ?? modelRef);
  const currentPrimaryModelConfigured = Boolean(
    currentPrimaryModelValue &&
    !managedModelRefs.has(currentPrimaryModelValue.toLowerCase()) &&
    hasConfiguredModelRef(providers, modelAliases, currentPrimaryModelValue),
  );
  const resolvedPrimaryModelValue = currentPrimaryModelConfigured
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
  const sandbox = asObject(defaults.sandbox);
  sandbox.mode = "off";
  sandbox.sessionToolsVisibility ??= "all";
  defaults.sandbox = sandbox;
  agents.defaults = defaults;
  next.agents = agents;

  const cron = asObject(next.cron);
  if (shouldApplyActivationDefaults || cron.enabled === undefined) {
    cron.enabled = true;
  }
  next.cron = cron;

  const canvasHost = asObject(next.canvasHost);
  if (shouldApplyActivationDefaults || canvasHost.enabled === undefined) {
    canvasHost.enabled = true;
  }
  next.canvasHost = canvasHost;

  const plugins = asObject(next.plugins);
  const entries = asObject(plugins.entries);
  const luminaEntry = asObject(entries["lumina-pc"]);
  if (shouldApplyActivationDefaults || luminaEntry.enabled === undefined) {
    luminaEntry.enabled = true;
  }
  const luminaPluginConfig = asObject(luminaEntry.config);
  if (shouldApplyActivationDefaults || luminaPluginConfig.enabled === undefined) {
    luminaPluginConfig.enabled = true;
  }
  if (shouldApplyActivationDefaults || luminaPluginConfig.heartbeatEnabled === undefined) {
    luminaPluginConfig.heartbeatEnabled = true;
  }
  if (
    shouldApplyActivationDefaults ||
    typeof luminaPluginConfig.heartbeatIntervalMs !== "number" ||
    !Number.isFinite(luminaPluginConfig.heartbeatIntervalMs) ||
    luminaPluginConfig.heartbeatIntervalMs <= 0
  ) {
    luminaPluginConfig.heartbeatIntervalMs = 30_000;
  }
  if (shouldApplyActivationDefaults || luminaPluginConfig.shellApprovalRequired === undefined) {
    luminaPluginConfig.shellApprovalRequired = false;
  }
  luminaEntry.config = luminaPluginConfig;
  entries["lumina-pc"] = luminaEntry;
  const luminaMemoryEntry = asObject(entries["lumina-memory"]);
  if (shouldApplyActivationDefaults || luminaMemoryEntry.enabled === undefined) {
    luminaMemoryEntry.enabled = true;
  }
  const luminaMemoryConfig = asObject(luminaMemoryEntry.config);
  if (shouldApplyActivationDefaults || luminaMemoryConfig.enabled === undefined) {
    luminaMemoryConfig.enabled = true;
  }
  luminaMemoryEntry.config = luminaMemoryConfig;
  entries["lumina-memory"] = luminaMemoryEntry;

  const luminaObservationEntry = asObject(entries["lumina-observation"]);
  if (shouldApplyActivationDefaults || luminaObservationEntry.enabled === undefined) {
    luminaObservationEntry.enabled = true;
  }
  const luminaObservationConfig = asObject(luminaObservationEntry.config);
  if (shouldApplyActivationDefaults || luminaObservationConfig.enabled === undefined) {
    luminaObservationConfig.enabled = true;
  }
  const luminaNarrationConfig = asObject(luminaObservationConfig.narration);
  if (shouldApplyActivationDefaults || luminaNarrationConfig.enabled === undefined) {
    luminaNarrationConfig.enabled = false;
  }
  luminaObservationConfig.narration = luminaNarrationConfig;
  luminaObservationEntry.config = luminaObservationConfig;
  entries["lumina-observation"] = luminaObservationEntry;

  const luminaPresenceEntry = asObject(entries["lumina-presence"]);
  if (shouldApplyActivationDefaults || luminaPresenceEntry.enabled === undefined) {
    luminaPresenceEntry.enabled = true;
  }
  const luminaPresenceConfig = asObject(luminaPresenceEntry.config);
  if (shouldApplyActivationDefaults || luminaPresenceConfig.enabled === undefined) {
    luminaPresenceConfig.enabled = true;
  }
  const luminaInitiativeConfig = asObject(luminaPresenceConfig.initiative);
  if (shouldApplyActivationDefaults || luminaInitiativeConfig.enabled === undefined) {
    luminaInitiativeConfig.enabled = true;
  }
  if (shouldApplyActivationDefaults || luminaInitiativeConfig.defaultSessionKey === undefined) {
    luminaInitiativeConfig.defaultSessionKey = "agent:main:main";
  }
  luminaPresenceConfig.initiative = luminaInitiativeConfig;
  luminaPresenceEntry.config = luminaPresenceConfig;
  entries["lumina-presence"] = luminaPresenceEntry;
  const browserEntry = asObject(entries.browser);
  if (shouldApplyActivationDefaults || browserEntry.enabled === undefined) {
    browserEntry.enabled = true;
  }
  entries.browser = browserEntry;
  const memoryEntry = asObject(entries["memory-core"]);
  if (shouldApplyActivationDefaults || memoryEntry.enabled === undefined) {
    memoryEntry.enabled = true;
  }
  const memoryConfig = asObject(memoryEntry.config);
  // OpenClaw v2026.5.22 handles dreaming internally and rejects this legacy config block.
  delete memoryConfig.dreaming;
  if (Object.keys(memoryConfig).length > 0) {
    memoryEntry.config = memoryConfig;
  } else {
    delete memoryEntry.config;
  }
  entries["memory-core"] = memoryEntry;
  plugins.entries = entries;

  const load = asObject(plugins.load);
  const existingPaths = Array.isArray(load.paths)
    ? load.paths.filter((value): value is string => typeof value === "string")
    : [];
  const luminaPluginDir = path.resolve(paths.luminaPluginDir).toLowerCase();
  const retainedLoadPaths = existingPaths.filter((entry) => {
    const normalized = path.resolve(entry).toLowerCase();
    return !normalized.includes("lumina-pc") && normalized !== luminaPluginDir;
  });
  if (retainedLoadPaths.length > 0) {
    load.paths = retainedLoadPaths;
    plugins.load = load;
  } else {
    delete plugins.load;
  }
  next.plugins = plugins;

  // Remove legacy key that violates openclaw's config schema.
  const meta = asObject(next.meta);
  delete meta.luminaDesktopBootstrap;
  if (Object.keys(meta).length > 0) {
    next.meta = meta;
  } else {
    delete next.meta;
  }

  writeJson(config.openclawConfigPath, next);
  if (shouldApplyActivationDefaults) {
    config.activationDefaultsVersion = ACTIVATION_DEFAULTS_VERSION;
    config.preferredModelRef = resolvedPrimaryModelValue ?? modelRef;
    saveConfig(config);
  }
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
  delete meta.luminaDesktopBootstrap;
  if (Object.keys(meta).length > 0) {
    next.meta = meta;
  } else {
    delete next.meta;
  }

  writeJson(config.openclawConfigPath, next);
  config.preferredModelRef = normalizedModelRef;
  saveConfig({
    ...config,
    preferredModelRef: normalizedModelRef,
  });
}
