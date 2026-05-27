interface LuminaDesktopRendererConfig {
  authServiceUrl: string;
  gatewayUrl: string;
  gatewayToken: string;
  proxyUrl: string;
  defaultTab: string;
  requireLuminaAuth: boolean;
}

interface LuminaDesktopCapabilities {
  quit: boolean;
  restart: boolean;
  checkForUpdates: boolean;
  installUpdate: boolean;
}

interface LuminaDesktopUpdateStatus {
  supported: boolean;
  available: boolean;
  downloaded: boolean;
  currentVersion: string;
  latestVersion: string | null;
  scheduledRestart: boolean;
  message: string | null;
}

interface LuminaCodeBridgeResponse {
  status: number;
  body: unknown;
}

interface LuminaDesktopBridge {
  shell: "tauri";
  config: LuminaDesktopRendererConfig;
  capabilities: LuminaDesktopCapabilities;
  getVersion: () => Promise<string>;
  savePreferredModel: (modelRef: string) => Promise<void>;
  luminaCodeRequest: (
    method: string,
    path: string,
    body?: string,
  ) => Promise<LuminaCodeBridgeResponse>;
  quit: () => void;
  restart: () => void;
  checkForUpdates: () => Promise<LuminaDesktopUpdateStatus>;
  installUpdate: () => Promise<LuminaDesktopUpdateStatus>;
}

declare global {
  interface Window {
    __LUMINA_AUTH_URL__?: string;
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
    __LUMINA_AUTH_REQUIRED__?: boolean;
    __LUMINA_DEFAULT_TAB__?: string;
    __LUMINA__?: LuminaDesktopBridge;
  }
}

export {};
