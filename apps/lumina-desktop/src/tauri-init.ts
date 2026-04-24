type LuminaRendererConfig = {
  authServiceUrl: string;
  gatewayUrl: string;
  gatewayToken: string;
  defaultTab: string;
  requireLuminaAuth: boolean;
};

type LuminaDesktopCapabilities = {
  quit: boolean;
  restart: boolean;
  checkForUpdates: boolean;
  installUpdate: boolean;
};

type LuminaDesktopUpdateStatus = {
  supported: boolean;
  available: boolean;
  downloaded: boolean;
  currentVersion: string;
  latestVersion: string | null;
  scheduledRestart: boolean;
  message: string | null;
};

type TauriCoreApi = {
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

type LuminaTauriInitPayload = {
  rendererConfig?: unknown;
  capabilities?: unknown;
};

type LuminaWindow = Window &
  typeof globalThis & {
    __LUMINA__?: Record<string, unknown>;
    __LUMINA_TAURI_INIT__?: LuminaTauriInitPayload;
    __TAURI__?: {
      core?: TauriCoreApi;
    };
  };

const DEFAULT_CONFIG: LuminaRendererConfig = {
  authServiceUrl: "",
  gatewayUrl: "",
  gatewayToken: "",
  defaultTab: "instances",
  requireLuminaAuth: false,
};

const DEFAULT_CAPABILITIES: LuminaDesktopCapabilities = {
  quit: true,
  restart: true,
  checkForUpdates: false,
  installUpdate: false,
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeConfig(value: unknown): LuminaRendererConfig {
  const input = asObject(value);
  return {
    authServiceUrl: readString(input.authServiceUrl, DEFAULT_CONFIG.authServiceUrl),
    gatewayUrl: readString(input.gatewayUrl, DEFAULT_CONFIG.gatewayUrl),
    gatewayToken: readString(input.gatewayToken, DEFAULT_CONFIG.gatewayToken),
    defaultTab: readString(input.defaultTab, DEFAULT_CONFIG.defaultTab),
    requireLuminaAuth: readBoolean(
      input.requireLuminaAuth,
      DEFAULT_CONFIG.requireLuminaAuth,
    ),
  };
}

function normalizeCapabilities(value: unknown): LuminaDesktopCapabilities {
  const input = asObject(value);
  return {
    quit: readBoolean(input.quit, DEFAULT_CAPABILITIES.quit),
    restart: readBoolean(input.restart, DEFAULT_CAPABILITIES.restart),
    checkForUpdates: readBoolean(
      input.checkForUpdates,
      DEFAULT_CAPABILITIES.checkForUpdates,
    ),
    installUpdate: readBoolean(input.installUpdate, DEFAULT_CAPABILITIES.installUpdate),
  };
}

function defaultUpdateStatus(
  currentVersion = "",
  message: string | null = null,
): LuminaDesktopUpdateStatus {
  return {
    supported: false,
    available: false,
    downloaded: false,
    currentVersion,
    latestVersion: null,
    scheduledRestart: false,
    message,
  };
}

function normalizeGatewayScope(gatewayUrl: string): string {
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

function bootstrapRendererGlobals(windowObject: Window, config: LuminaRendererConfig): void {
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
    // Best-effort only.
  }
}

function installExternalNavigationBridge(
  luminaWindow: LuminaWindow,
  openExternal: (url: string) => Promise<unknown>,
): void {
  const originalOpen = luminaWindow.open ? luminaWindow.open.bind(luminaWindow) : null;
  luminaWindow.open = function openWindow(url, target, features) {
    if (typeof url === "string" && /^(https?:|mailto:)/i.test(url)) {
      void openExternal(url);
      return null;
    }
    return originalOpen ? originalOpen(url, target, features) : null;
  };

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || typeof anchor.href !== "string") {
        return;
      }
      if (!/^(https?:|mailto:)/i.test(anchor.href)) {
        return;
      }
      const currentOrigin = window.location.origin;
      if (/^https?:/i.test(anchor.href)) {
        try {
          if (new URL(anchor.href, window.location.href).origin === currentOrigin) {
            return;
          }
        } catch {
          // Fall through to external open.
        }
      }
      event.preventDefault();
      void openExternal(anchor.href);
    },
    true,
  );
}

(() => {
  const luminaWindow = window as LuminaWindow;
  const payload = luminaWindow.__LUMINA_TAURI_INIT__ ?? {};
  const config = Object.freeze(normalizeConfig(payload.rendererConfig));
  const capabilities = normalizeCapabilities(payload.capabilities);
  const shell = "tauri";
  const core = luminaWindow.__TAURI__?.core;
  const invoke = typeof core?.invoke === "function" ? core.invoke.bind(core) : null;

  bootstrapRendererGlobals(luminaWindow, config);

  const openExternal = (url: string): Promise<unknown> => {
    if (!invoke || !url) {
      return Promise.resolve();
    }
    return invoke("open_external", { url: String(url) });
  };

  const getVersion = (): Promise<string> =>
    invoke ? invoke<string>("get_version") : Promise.resolve("");

  const unsupportedUpdateStatus = async (message: string): Promise<LuminaDesktopUpdateStatus> =>
    defaultUpdateStatus(await getVersion(), message);

  luminaWindow.__LUMINA__ = Object.assign({}, luminaWindow.__LUMINA__ ?? {}, {
    shell,
    config,
    capabilities,
    getVersion,
    savePreferredModel: (modelRef: string): Promise<void> =>
      invoke ? invoke<void>("save_preferred_model", { modelRef }) : Promise.resolve(),
    quit: (): void => {
      if (invoke && capabilities.quit) {
        void invoke("quit_app");
      }
    },
    restart: (): void => {
      if (invoke && capabilities.restart) {
        void invoke("restart_app");
      }
    },
    checkForUpdates: (): Promise<LuminaDesktopUpdateStatus> => {
      if (!invoke || !capabilities.checkForUpdates) {
        return unsupportedUpdateStatus("Desktop updates are not configured in this Tauri build.");
      }
      return invoke<LuminaDesktopUpdateStatus>("check_for_updates");
    },
    installUpdate: (): Promise<LuminaDesktopUpdateStatus> => {
      if (!invoke || !capabilities.installUpdate) {
        return unsupportedUpdateStatus("Desktop updates are not configured in this Tauri build.");
      }
      return invoke<LuminaDesktopUpdateStatus>("install_update");
    },
  });

  installExternalNavigationBridge(luminaWindow, openExternal);
  delete luminaWindow.__LUMINA_TAURI_INIT__;
})();
