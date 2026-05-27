import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const renderPresetFile = path.join(desktopRoot, "config", "render-preset.json");
const outputDir = path.join(desktopRoot, "build");
const outputFile = path.join(outputDir, "lumina-defaults.json");

const renderPreset = JSON.parse(fs.readFileSync(renderPresetFile, "utf8"));

function readInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readString(name, fallback) {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

function readBool(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return fallback;
}

const embedRuntimeSecrets = readBool("LUMINA_EMBED_RUNTIME_SECRETS", false);
const i24dModelsBaseUrl = readString("LUMINA_I24D_BASE_URL", renderPreset.i24dModelsBaseUrl);
const remoteBrainUrl = readString(
  "LUMINA_REMOTE_BRAIN_URL",
  renderPreset.remoteBrainUrl ?? `${i24dModelsBaseUrl.replace(/\/$/, "")}/api/openclaw/brain/turn`,
);
const configuredI24dToken = process.env.LUMINA_I24D_TOKEN?.trim() ?? "";
const configuredRemoteBrainSecret =
  process.env.LUMINA_REMOTE_BRAIN_SECRET?.trim() ?? configuredI24dToken;
const bundledI24dToken = embedRuntimeSecrets ? configuredI24dToken : "";
const bundledRemoteBrainSecret = embedRuntimeSecrets ? configuredRemoteBrainSecret : "";
const defaultRemoteBrainEnabled =
  (typeof renderPreset.remoteBrainEnabled === "boolean"
    ? renderPreset.remoteBrainEnabled
    : Boolean(remoteBrainUrl && bundledRemoteBrainSecret)) &&
  Boolean(remoteBrainUrl && bundledRemoteBrainSecret);
const providerId = readString("LUMINA_PROVIDER_ID", renderPreset.providerId);
const modelId = readString("LUMINA_MODEL_ID", renderPreset.modelId);

const defaults = {
  authServiceUrl: readString("LUMINA_AUTH_URL", renderPreset.authServiceUrl),
  providerId,
  modelId,
  preferredModelRef: readString(
    "LUMINA_PREFERRED_MODEL_REF",
    renderPreset.preferredModelRef ?? `${providerId}/${modelId}`,
  ),
  modelName: readString("LUMINA_MODEL_NAME", renderPreset.modelName),
  modelContextWindow: readInt("LUMINA_MODEL_CONTEXT_WINDOW", renderPreset.modelContextWindow),
  modelMaxTokens: readInt("LUMINA_MODEL_MAX_TOKENS", renderPreset.modelMaxTokens),
  proxyPort: readInt("LUMINA_PROXY_PORT", renderPreset.proxyPort),
  gatewayPort: readInt("LUMINA_GATEWAY_PORT", renderPreset.gatewayPort),
  proxyApiKey: readString("LUMINA_PROXY_API_KEY", renderPreset.proxyApiKey),
  i24dModelsBaseUrl,
  i24dChatUrl: readString(
    "LUMINA_I24D_CHAT_URL",
    renderPreset.i24dChatUrl ?? `${i24dModelsBaseUrl.replace(/\/$/, "")}/v1/chat/completions`,
  ),
  i24dToken: bundledI24dToken,
  remoteBrainEnabled:
    readBool("LUMINA_REMOTE_BRAIN_ENABLED", defaultRemoteBrainEnabled) &&
    Boolean(remoteBrainUrl && bundledRemoteBrainSecret),
  remoteBrainUrl,
  remoteBrainSecret: bundledRemoteBrainSecret,
  remoteBrainTimeoutMs: readInt(
    "LUMINA_REMOTE_BRAIN_TIMEOUT_MS",
    renderPreset.remoteBrainTimeoutMs,
  ),
  remoteBrainMaxTurns: readInt("LUMINA_REMOTE_BRAIN_MAX_TURNS", renderPreset.remoteBrainMaxTurns),
  runtimeReleaseManifestUrl: readString(
    "LUMINA_RUNTIME_RELEASE_MANIFEST_URL",
    renderPreset.runtimeReleaseManifestUrl,
  ),
  runtimeReleaseChannel: readString(
    "LUMINA_RUNTIME_RELEASE_CHANNEL",
    renderPreset.runtimeReleaseChannel,
  ),
  skipOpenClawChannels: readBool(
    "LUMINA_SKIP_OPENCLAW_CHANNELS",
    renderPreset.skipOpenClawChannels,
  ),
  defaultTab: readString("LUMINA_DEFAULT_TAB", renderPreset.defaultTab),
  requireLuminaAuth: readBool("LUMINA_REQUIRE_AUTH", renderPreset.requireLuminaAuth),
  updateRepoOwner: readString("LUMINA_GITHUB_OWNER", renderPreset.updateRepoOwner),
  updateRepoName: readString("LUMINA_GITHUB_REPO", renderPreset.updateRepoName),
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");

console.log(`[lumina-defaults] Wrote ${outputFile}`);
