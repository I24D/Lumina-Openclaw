export interface LuminaRendererConfig {
  authServiceUrl: string;
  gatewayUrl: string;
  gatewayToken: string;
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
