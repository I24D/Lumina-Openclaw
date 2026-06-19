import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const process: NodeJS.Process & { resourcesPath?: string };

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface RuntimePaths {
  repoRoot: string;
  runtimeRoot: string;
  uiIndexPath: string;
  defaultsFilePath: string;
  nodeRuntimePath: string;
  runtimeManagerBinaryPath: string;
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

function stripWindowsExtendedLengthPrefix(value: string): string {
  if (process.platform !== "win32") {
    return value;
  }
  if (value.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  }
  if (value.startsWith("\\\\?\\")) {
    return value.slice("\\\\?\\".length);
  }
  return value;
}

function normalizeRuntimePath(value: string): string {
  if (!value) {
    return value;
  }
  return path.normalize(stripWindowsExtendedLengthPrefix(value));
}

function normalizeRuntimePaths(paths: RuntimePaths): RuntimePaths {
  return {
    repoRoot: normalizeRuntimePath(paths.repoRoot),
    runtimeRoot: normalizeRuntimePath(paths.runtimeRoot),
    uiIndexPath: normalizeRuntimePath(paths.uiIndexPath),
    defaultsFilePath: normalizeRuntimePath(paths.defaultsFilePath),
    nodeRuntimePath: normalizeRuntimePath(paths.nodeRuntimePath),
    runtimeManagerBinaryPath: normalizeRuntimePath(paths.runtimeManagerBinaryPath),
    openClawRoot: normalizeRuntimePath(paths.openClawRoot),
    openClawEntryPath: normalizeRuntimePath(paths.openClawEntryPath),
    openClawBundledPluginsDir: normalizeRuntimePath(paths.openClawBundledPluginsDir),
    luminaPluginDir: normalizeRuntimePath(paths.luminaPluginDir),
    proxyRoot: normalizeRuntimePath(paths.proxyRoot),
    proxyEntryPath: normalizeRuntimePath(paths.proxyEntryPath),
  };
}

function isPackagedResourceRoot(rootPath: string): boolean {
  return (
    fileExists(path.join(rootPath, "desktop-shell", "tauri-bridge.js")) &&
    fileExists(path.join(rootPath, "openclaw", "openclaw.mjs"))
  );
}

function resolveRepoRoot(): string {
  const resourcesRoot = process.env.LUMINA_RESOURCE_ROOT?.trim() || process.resourcesPath || "";
  if (resourcesRoot && isPackagedResourceRoot(resourcesRoot)) {
    return normalizeRuntimePath(path.resolve(resourcesRoot));
  }
  const explicitRepoRoot = process.env.LUMINA_REPO_ROOT?.trim();
  if (explicitRepoRoot && fileExists(explicitRepoRoot)) {
    return normalizeRuntimePath(path.resolve(explicitRepoRoot));
  }
  if (resourcesRoot && fileExists(resourcesRoot)) {
    return normalizeRuntimePath(path.resolve(resourcesRoot));
  }
  return normalizeRuntimePath(path.resolve(moduleDir, "..", "..", ".."));
}

function resolveRuntimeManagerBinaryPath(repoRoot: string, resourcesRoot: string): string {
  const explicitPath = process.env.LUMINA_RUNTIME_MANAGER_BINARY?.trim();
  const binaryName = process.platform === "win32" ? "lumina-bootstrapper.exe" : "lumina-bootstrapper";
  const packagedPath = resourcesRoot ? path.join(resourcesRoot, "runtime-tools", binaryName) : "";
  const candidates = [
    ...(isPackagedResourceRoot(resourcesRoot)
      ? [packagedPath, explicitPath ?? ""]
      : [explicitPath ?? "", packagedPath]),
    path.resolve(moduleDir, "..", "build", "runtime-tools", binaryName),
    path.join(repoRoot, "rust", "lumina-bootstrapper", "target", "release", binaryName),
    path.join(repoRoot, "rust", "lumina-bootstrapper", "target", "debug", binaryName),
  ];
  return candidates.find((candidate) => candidate && fileExists(candidate)) ?? "";
}

function readBootstrapStateRuntimeRoot(): string {
  const disabled = (process.env.LUMINA_USE_EXTERNAL_RUNTIME ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(disabled)) {
    return "";
  }

  const explicitRoot = process.env.LUMINA_RUNTIME_ROOT?.trim();
  if (explicitRoot && fileExists(path.join(explicitRoot, "bundle.manifest.json"))) {
    return explicitRoot;
  }

  const statePath = path.join(os.homedir(), ".lumina", "runtime-manager", "state.json");
  try {
    if (!fileExists(statePath)) {
      return "";
    }
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      activeRelease?: { runtimeRoot?: string };
    };
    const runtimeRoot = state.activeRelease?.runtimeRoot?.trim();
    if (!runtimeRoot) {
      return "";
    }
    return fileExists(path.join(runtimeRoot, "bundle.manifest.json")) ? runtimeRoot : "";
  } catch {
    return "";
  }
}

function resolveBundledNodePath(rootPath: string): string {
  const candidates =
    process.platform === "win32"
      ? [path.join(rootPath, "node.exe"), path.join(rootPath, "node", "node.exe")]
      : [path.join(rootPath, "node"), path.join(rootPath, "bin", "node")];

  return candidates.find((candidate) => fileExists(candidate)) ?? "";
}

function resolveOpenClawPluginDirs(openClawRoot: string): {
  bundledPluginsDir: string;
  luminaPluginDir: string;
} {
  const candidates = [
    path.join(openClawRoot, "dist-runtime", "extensions"),
    path.join(openClawRoot, "dist", "extensions"),
    path.join(openClawRoot, "extensions"),
  ];
  const bundledPluginsDir =
    candidates.find((candidate) => fileExists(candidate)) ?? candidates[1];
  return {
    bundledPluginsDir,
    luminaPluginDir: path.join(bundledPluginsDir, "lumina-pc"),
  };
}

function resolvePackagedUiIndex(resourcesRoot: string): string {
  const candidates = [
    path.join(resourcesRoot, "ui", "index.html"),
    path.join(resourcesRoot, "openclaw", "dist", "control-ui", "index.html"),
  ];
  return candidates.find((candidate) => fileExists(candidate)) ?? candidates[0];
}

export function resolveRuntimePaths(): RuntimePaths {
  const repoRoot = resolveRepoRoot();
  const externalRuntimeRoot = readBootstrapStateRuntimeRoot();
  const resourcesRoot = normalizeRuntimePath(
    process.env.LUMINA_RESOURCE_ROOT?.trim() || process.resourcesPath || "",
  );
  const runtimeManagerBinaryPath = resolveRuntimeManagerBinaryPath(repoRoot, resourcesRoot);
  if (externalRuntimeRoot) {
    const openClawRoot = path.join(externalRuntimeRoot, "openclaw");
    const pluginDirs = resolveOpenClawPluginDirs(openClawRoot);
    return normalizeRuntimePaths({
      repoRoot,
      runtimeRoot: externalRuntimeRoot,
      uiIndexPath: path.join(externalRuntimeRoot, "ui", "index.html"),
      defaultsFilePath: path.join(externalRuntimeRoot, "config", "lumina-defaults.json"),
      nodeRuntimePath: resolveBundledNodePath(path.join(externalRuntimeRoot, "node")),
      runtimeManagerBinaryPath,
      openClawRoot,
      openClawEntryPath: path.join(openClawRoot, "openclaw.mjs"),
      openClawBundledPluginsDir: pluginDirs.bundledPluginsDir,
      luminaPluginDir: pluginDirs.luminaPluginDir,
      proxyRoot: path.join(externalRuntimeRoot, "proxy"),
      proxyEntryPath: path.join(externalRuntimeRoot, "proxy", "server.mjs"),
    });
  }
  const packagedUiIndex = resolvePackagedUiIndex(resourcesRoot);

  if (resourcesRoot && fileExists(packagedUiIndex)) {
    const openClawRoot = path.join(resourcesRoot, "openclaw");
    const pluginDirs = resolveOpenClawPluginDirs(openClawRoot);
    return normalizeRuntimePaths({
      repoRoot,
      runtimeRoot: resourcesRoot,
      uiIndexPath: packagedUiIndex,
      defaultsFilePath: path.join(resourcesRoot, "config", "lumina-defaults.json"),
      nodeRuntimePath: resolveBundledNodePath(path.join(resourcesRoot, "node")),
      runtimeManagerBinaryPath,
      openClawRoot,
      openClawEntryPath: path.join(openClawRoot, "openclaw.mjs"),
      openClawBundledPluginsDir: pluginDirs.bundledPluginsDir,
      luminaPluginDir: pluginDirs.luminaPluginDir,
      proxyRoot: path.join(resourcesRoot, "proxy"),
      proxyEntryPath: path.join(resourcesRoot, "proxy", "server.mjs"),
    });
  }

  const openClawRoot = path.join(repoRoot, "Open_PC");
  const pluginDirs = resolveOpenClawPluginDirs(openClawRoot);
  return normalizeRuntimePaths({
    repoRoot,
    runtimeRoot: repoRoot,
    uiIndexPath: path.join(openClawRoot, "dist", "control-ui", "index.html"),
    defaultsFilePath: path.resolve(moduleDir, "..", "build", "lumina-defaults.json"),
    nodeRuntimePath: resolveBundledNodePath(path.resolve(moduleDir, "..", "build", "runtime-node")),
    runtimeManagerBinaryPath,
    openClawRoot,
    openClawEntryPath: path.join(openClawRoot, "openclaw.mjs"),
    openClawBundledPluginsDir: pluginDirs.bundledPluginsDir,
    luminaPluginDir: pluginDirs.luminaPluginDir,
    proxyRoot: path.join(repoRoot, "tool-proxy"),
    proxyEntryPath: path.join(repoRoot, "tool-proxy", "server.mjs"),
  });
}
