import fs from "node:fs";
import path from "node:path";

declare const process: NodeJS.Process & { resourcesPath?: string };

export interface RuntimePaths {
  repoRoot: string;
  uiIndexPath: string;
  defaultsFilePath: string;
  openClawRoot: string;
  openClawEntryPath: string;
  openClawBundledPluginsDir: string;
  luminaPluginDir: string;
  proxyRoot: string;
  proxyEntryPath: string;
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function resolveRepoRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

export function resolveRuntimePaths(): RuntimePaths {
  const repoRoot = resolveRepoRoot();
  const resourcesRoot = process.resourcesPath ?? "";
  const packagedUiIndex = path.join(resourcesRoot, "ui", "index.html");

  if (resourcesRoot && fileExists(packagedUiIndex)) {
    const openClawRoot = path.join(resourcesRoot, "openclaw");
    return {
      repoRoot,
      uiIndexPath: packagedUiIndex,
      defaultsFilePath: path.join(resourcesRoot, "config", "lumina-defaults.json"),
      openClawRoot,
      openClawEntryPath: path.join(openClawRoot, "openclaw.mjs"),
      openClawBundledPluginsDir: path.join(openClawRoot, "dist-runtime", "extensions"),
      luminaPluginDir: path.join(openClawRoot, "dist-runtime", "extensions", "lumina-pc"),
      proxyRoot: path.join(resourcesRoot, "proxy"),
      proxyEntryPath: path.join(resourcesRoot, "proxy", "server.mjs"),
    };
  }

  const openClawRoot = path.join(repoRoot, "Open_PC");
  return {
    repoRoot,
    uiIndexPath: path.join(openClawRoot, "dist", "control-ui", "index.html"),
    defaultsFilePath: path.resolve(__dirname, "..", "build", "lumina-defaults.json"),
    openClawRoot,
    openClawEntryPath: path.join(openClawRoot, "openclaw.mjs"),
    openClawBundledPluginsDir: path.join(openClawRoot, "dist-runtime", "extensions"),
    luminaPluginDir: path.join(openClawRoot, "dist-runtime", "extensions", "lumina-pc"),
    proxyRoot: path.join(repoRoot, "tool-proxy"),
    proxyEntryPath: path.join(repoRoot, "tool-proxy", "server.mjs"),
  };
}
