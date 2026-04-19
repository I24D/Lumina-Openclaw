import fs   from "node:fs";
import path  from "node:path";
import os    from "node:os";
import crypto from "node:crypto";

const CONFIG_DIR  = path.join(os.homedir(), ".lumina");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface LuminaConfig {
  gatewayToken:  string;
  gatewayPort:   number;
  authServiceUrl: string;
  brainUrl:      string;
}

const DEFAULTS: Omit<LuminaConfig, "gatewayToken"> = {
  gatewayPort:    18789,
  authServiceUrl: "https://lumina-auth.onrender.com",
  brainUrl:       "https://lumina-brain.onrender.com",
};

export function loadConfig(): LuminaConfig {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    if (fs.existsSync(CONFIG_FILE)) {
      const raw    = fs.readFileSync(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<LuminaConfig>;
      return {
        ...DEFAULTS,
        gatewayToken: parsed.gatewayToken ?? generateToken(),
        ...parsed,
      };
    }

    const config: LuminaConfig = {
      ...DEFAULTS,
      gatewayToken: generateToken(),
    };

    saveConfig(config);
    return config;
  } catch {
    return { ...DEFAULTS, gatewayToken: generateToken() };
  }
}

export function saveConfig(config: LuminaConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.error("[config] Failed to save config:", err);
  }
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}
