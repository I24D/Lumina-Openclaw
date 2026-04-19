import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const outputDir = path.join(desktopRoot, "build");
const outputFile = path.join(outputDir, "lumina-defaults.json");

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

const i24dModelsBaseUrl = readString(
  "LUMINA_I24D_BASE_URL",
  "https://i24d-whatsapp-ai.onrender.com",
);

const defaults = {
  authServiceUrl: readString("LUMINA_AUTH_URL", "https://lumina-auth.onrender.com"),
  providerId: readString("LUMINA_PROVIDER_ID", "custom-i24d-whatsapp-ai-onrender-com"),
  modelId: readString("LUMINA_MODEL_ID", "I24D"),
  modelName: readString("LUMINA_MODEL_NAME", "I24D (Lumina)"),
  modelContextWindow: readInt("LUMINA_MODEL_CONTEXT_WINDOW", 16000),
  modelMaxTokens: readInt("LUMINA_MODEL_MAX_TOKENS", 4096),
  proxyPort: readInt("LUMINA_PROXY_PORT", 4321),
  gatewayPort: readInt("LUMINA_GATEWAY_PORT", 18789),
  proxyApiKey: readString("LUMINA_PROXY_API_KEY", "lumina-local-proxy"),
  i24dModelsBaseUrl,
  i24dChatUrl: readString(
    "LUMINA_I24D_CHAT_URL",
    `${i24dModelsBaseUrl.replace(/\/$/, "")}/v1/chat/completions`,
  ),
  i24dToken: process.env.LUMINA_I24D_TOKEN?.trim() ?? "",
  defaultTab: readString("LUMINA_DEFAULT_TAB", "instances"),
  updateRepoOwner: readString("LUMINA_GITHUB_OWNER", "I24D"),
  updateRepoName: readString("LUMINA_GITHUB_REPO", "Lumina-I24D"),
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");

console.log(`[lumina-defaults] Wrote ${outputFile}`);
