import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
} from "electron";
import path from "node:path";
import fs   from "node:fs";
import { loadConfig }             from "./config.js";
import { startGateway, stopGateway } from "./gateway-manager.js";

// ── Config ─────────────────────────────────────────────────────────────────

const config = loadConfig();

const rendererConfig = {
  authServiceUrl: config.authServiceUrl,
  gatewayUrl:     `ws://127.0.0.1:${config.gatewayPort}`,
  gatewayToken:   config.gatewayToken,
};

// ── Window ─────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function resolveUiPath(): string {
  // Production: extraResources bundled by electron-builder
  const resourcesPath = process.resourcesPath;
  const prodUi = path.join(resourcesPath, "ui", "index.html");
  if (fs.existsSync(prodUi)) return prodUi;

  // Development: built Vite output relative to monorepo root
  const devUi = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "Open_PC",
    "dist",
    "control-ui",
    "index.html",
  );
  if (fs.existsSync(devUi)) return devUi;

  throw new Error(
    `Lumina UI not found. Run 'pnpm ui:build' first.\n` +
    `Searched:\n  ${prodUi}\n  ${devUi}`,
  );
}

function resolveIconPath(): string | undefined {
  const icon = path.join(__dirname, "..", "assets", "icon.png");
  return fs.existsSync(icon) ? icon : undefined;
}

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = "dark";

  const win = new BrowserWindow({
    width:           1280,
    height:          820,
    minWidth:        900,
    minHeight:       600,
    show:            false,
    backgroundColor: "#0e1015",
    titleBarStyle:   process.platform === "darwin" ? "hiddenInset" : "default",
    icon:            resolveIconPath(),
    webPreferences: {
      preload:          path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      webSecurity:      true,
    },
  });

  // Open external links in the OS browser, not inside Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  return win;
}

// ── IPC handlers ───────────────────────────────────────────────────────────

// Synchronous — called by preload BEFORE page scripts run
ipcMain.on("get-config-sync", (event) => {
  event.returnValue = rendererConfig;
});

ipcMain.handle("get-version", () => app.getVersion());

ipcMain.on("quit", () => app.quit());

// ── App lifecycle ──────────────────────────────────────────────────────────

app.on("before-quit", () => {
  stopGateway();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) void launch();
});

async function launch(): Promise<void> {
  mainWindow = createWindow();

  // Start the Openclaw gateway before loading the UI
  try {
    await startGateway(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[main] Gateway start failed:", message);

    // mainWindow is guaranteed non-null here
    const { response } = await dialog.showMessageBox(mainWindow!, {
      type:    "warning",
      title:   "Lumina — Gateway not available",
      message: "Could not start the local AI gateway.",
      detail:
        `${message}\n\n` +
        "You can still sign in and use Lumina, but some AI capabilities may be limited. " +
        "Make sure the OpenClaw CLI is installed to enable full features.",
      buttons: ["Continue anyway", "Quit"],
    });

    if (response === 1) {
      app.quit();
      return;
    }
  }

  // Preload script runs before any page JS — config is already injected by then
  const uiPath = resolveUiPath();
  await mainWindow!.loadFile(uiPath);
}

app.whenReady()
  .then(() => void launch())
  .catch((err: unknown) => {
    console.error("[main] Fatal startup error:", err);
    process.exit(1);
  });
