import { contextBridge, ipcRenderer } from "electron";

interface LuminaConfig {
  authServiceUrl: string;
  gatewayUrl:     string;
  gatewayToken:   string;
}

// Fetch config synchronously from main process BEFORE any page script runs.
// This is the correct Electron pattern — preload runs before the renderer's JS.
const config = ipcRenderer.sendSync("get-config-sync") as LuminaConfig;

// Inject globals that the Lumina UI reads at boot time
(window as unknown as Record<string, unknown>)["__LUMINA_AUTH_URL__"]              = config.authServiceUrl;
(window as unknown as Record<string, unknown>)["__OPENCLAW_CONTROL_UI_BASE_PATH__"] = "/";

// Pre-populate Openclaw settings in localStorage/sessionStorage so the user
// never sees the gateway URL/token config screen — it's all pre-wired.
try {
  const SETTINGS_KEY  = "openclaw.control.settings.v1";
  const raw           = localStorage.getItem(SETTINGS_KEY);
  const settings      = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  settings["gatewayUrl"] = config.gatewayUrl;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  const TOKEN_KEY = `openclaw.control.token.v1:${config.gatewayUrl}`;
  sessionStorage.setItem(TOKEN_KEY, config.gatewayToken);
} catch {
  // best-effort — localStorage may be unavailable in some contexts
}

// Expose a safe IPC bridge for the renderer
contextBridge.exposeInMainWorld("__LUMINA__", {
  config:     config,
  getVersion: (): Promise<string> => ipcRenderer.invoke("get-version"),
  quit:       (): void => { ipcRenderer.send("quit"); },
});
