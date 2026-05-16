export interface LuminaRendererConfig {
  authServiceUrl: string;
  gatewayUrl: string;
  gatewayToken: string;
  proxyUrl: string;
  defaultTab: string;
  requireLuminaAuth: boolean;
}

export interface LuminaDesktopCapabilities {
  quit: boolean;
  restart: boolean;
  checkForUpdates: boolean;
  installUpdate: boolean;
}

export interface LuminaDesktopUpdateStatus {
  supported: boolean;
  available: boolean;
  downloaded: boolean;
  currentVersion: string;
  latestVersion: string | null;
  scheduledRestart: boolean;
  message: string | null;
}

export interface LuminaDesktopBridge {
  shell: "tauri";
  config: LuminaRendererConfig;
  capabilities: LuminaDesktopCapabilities;
  getVersion: () => Promise<string>;
  savePreferredModel: (modelRef: string) => Promise<void>;
  quit: () => void;
  restart: () => void;
  checkForUpdates: () => Promise<LuminaDesktopUpdateStatus>;
  installUpdate: () => Promise<LuminaDesktopUpdateStatus>;
}

export function defaultUpdateStatus(currentVersion = ""): LuminaDesktopUpdateStatus {
  return {
    supported: false,
    available: false,
    downloaded: false,
    currentVersion,
    latestVersion: null,
    scheduledRestart: false,
    message: null,
  };
}

export function normalizeGatewayScope(gatewayUrl: string): string {
  const trimmed = gatewayUrl.trim();
  if (!trimmed) {
    return "default";
  }
  try {
    const parsed = new URL(trimmed);
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return trimmed;
  }
}

function loadStoredSettings(scopedKey: string, legacyKey: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(scopedKey) ?? localStorage.getItem(legacyKey);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isBackgroundSessionKey(value: unknown): boolean {
  const key = readString(value).trim().toLowerCase();
  return !key || key === "heartbeat" || key.startsWith("system:") || key.includes(":cron:");
}

function forceMainSessionForDesktopChat(
  settings: Record<string, unknown>,
  scopedGateway: string,
): void {
  if (isBackgroundSessionKey(settings.sessionKey)) {
    settings.sessionKey = "main";
  }
  if (isBackgroundSessionKey(settings.lastActiveSessionKey)) {
    settings.lastActiveSessionKey = "main";
  }

  const sessionsByGateway = asObject(settings.sessionsByGateway);
  const scopedSession = asObject(sessionsByGateway[scopedGateway]);
  if (isBackgroundSessionKey(scopedSession.sessionKey)) {
    scopedSession.sessionKey = "main";
  }
  if (isBackgroundSessionKey(scopedSession.lastActiveSessionKey)) {
    scopedSession.lastActiveSessionKey = "main";
  }
  sessionsByGateway[scopedGateway] = scopedSession;
  settings.sessionsByGateway = sessionsByGateway;
}

export function bootstrapRendererGlobals(
  windowObject: Window & typeof globalThis,
  config: LuminaRendererConfig,
): void {
  const target = windowObject as unknown as Record<string, unknown>;
  target.__LUMINA_AUTH_URL__ = config.authServiceUrl;
  target.__LUMINA_AUTH_REQUIRED__ = config.requireLuminaAuth;
  target.__LUMINA_DEFAULT_TAB__ = config.defaultTab;
  target.__OPENCLAW_CONTROL_UI_BASE_PATH__ = "/";

  try {
    const legacySettingsKey = "openclaw.control.settings.v1";
    const scopedGateway = normalizeGatewayScope(config.gatewayUrl);
    const scopedSettingsKey = `openclaw.control.settings.v1:${scopedGateway}`;
    const settings = loadStoredSettings(scopedSettingsKey, legacySettingsKey);
    settings.gatewayUrl = config.gatewayUrl;
    if (config.defaultTab === "chat") {
      forceMainSessionForDesktopChat(settings, scopedGateway);
    }
    localStorage.setItem(legacySettingsKey, JSON.stringify(settings));
    localStorage.setItem(scopedSettingsKey, JSON.stringify(settings));

    const legacyTokenKey = "openclaw.control.token.v1";
    const scopedTokenKey = `openclaw.control.token.v1:${scopedGateway}`;
    sessionStorage.setItem(legacyTokenKey, config.gatewayToken);
    sessionStorage.setItem(scopedTokenKey, config.gatewayToken);
  } catch {
    // Best-effort only. The UI can still fall back to manual connection.
  }
}
