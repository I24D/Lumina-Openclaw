import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
} from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { startGateway, stopGateway } from "./gateway-manager.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const config = loadConfig();
const runtimePaths = resolveRuntimePaths();
let updateCheckTimer: NodeJS.Timeout | null = null;

const rendererConfig = {
  authServiceUrl: config.authServiceUrl,
  gatewayUrl: `ws://127.0.0.1:${config.gatewayPort}`,
  gatewayToken: config.gatewayToken,
};

let mainWindow: BrowserWindow | null = null;

function resolveUiPath(): string {
  if (fs.existsSync(runtimePaths.uiIndexPath)) {
    return runtimePaths.uiIndexPath;
  }
  throw new Error(
    `Lumina UI not found. Run 'pnpm ui:build' first.\nSearched:\n  ${runtimePaths.uiIndexPath}`,
  );
}

function resolveIconPath(): string | undefined {
  const icon = path.join(__dirname, "..", "assets", "icon.png");
  return fs.existsSync(icon) ? icon : undefined;
}

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = "dark";

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0e1015",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    icon: resolveIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });

  window.on("closed", () => {
    mainWindow = null;
  });

  return window;
}

ipcMain.on("get-config-sync", (event) => {
  event.returnValue = rendererConfig;
});

ipcMain.handle("get-version", () => app.getVersion());
ipcMain.on("quit", () => app.quit());

app.on("before-quit", () => {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  stopGateway();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    void launch();
  }
});

function setupAutoUpdates(): void {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    console.error("[updates] Auto-update failed:", err);
  });

  autoUpdater.on("update-downloaded", async () => {
    if (!mainWindow) {
      autoUpdater.quitAndInstall();
      return;
    }

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Lumina update ready",
      message: "A new Lumina desktop update has been downloaded.",
      detail: "Restart the app now to finish installing the update.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  void autoUpdater.checkForUpdatesAndNotify();
  updateCheckTimer = setInterval(() => {
    void autoUpdater.checkForUpdatesAndNotify();
  }, 6 * 60 * 60 * 1000);
}

async function launch(): Promise<void> {
  mainWindow = createWindow();

  try {
    await startGateway(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[main] Runtime start failed:", message);

    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Lumina â€” Runtime not available",
      message: "Could not start the bundled Lumina runtime.",
      detail:
        `${message}\n\n` +
        "Lumina packages its local runtime automatically. Review the error details and try launching the app again.",
      buttons: ["Quit"],
    });

    app.quit();
    return;
  }

  await mainWindow.loadFile(resolveUiPath());
  setupAutoUpdates();
}

app.whenReady()
  .then(() => void launch())
  .catch((err: unknown) => {
    console.error("[main] Fatal startup error:", err);
    process.exit(1);
  });
