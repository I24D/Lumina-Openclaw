#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  createBundleEntry,
  ensureDirectory,
  readJsonFile,
  validateBundleManifest,
  writeJsonFile,
} from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const openClawRoot = path.join(repoRoot, "Open_PC");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const toolProxyRoot = path.join(repoRoot, "tool-proxy");
const bundleManifestPath = path.join(desktopRoot, "build", "openclaw-bundle.json");
const canonicalBundleRoot = path.join(desktopRoot, "build", "runtime-bundle");
const canonicalBundlePayloadRoot = path.join(canonicalBundleRoot, "payload");
const canonicalBundleManifestPath = path.join(canonicalBundleRoot, "bundle.manifest.json");
const runtimeNodeDir = path.join(desktopRoot, "build", "runtime-node");
const stagedOpenClawDir = path.join(desktopRoot, "build", "openclaw-deploy");
const packagedOpenClawDir = path.join(desktopRoot, "build", "openclaw-package");
const deployStampPath = path.join(desktopRoot, "build", "openclaw-deploy-stamp.json");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const desktopPackageJsonPath = path.join(desktopRoot, "package.json");
const tauriConfigPath = path.join(desktopRoot, "src-tauri", "tauri.conf.json");
const openClawPackageJsonPath = path.join(openClawRoot, "package.json");

const cliArgs = new Set(process.argv.slice(2));
const forceRuntimeBuild =
  cliArgs.has("--build-openclaw") || process.env.LUMINA_FORCE_OPENCLAW_BUILD === "1";
const forceDeployRefresh =
  cliArgs.has("--refresh-openclaw-deploy") || process.env.LUMINA_FORCE_OPENCLAW_DEPLOY === "1";
const skipRuntimeBuild =
  cliArgs.has("--skip-openclaw-build") || process.env.LUMINA_SKIP_OPENCLAW_BUILD === "1";
const skipUiBuild =
  cliArgs.has("--skip-ui-build") || process.env.LUMINA_SKIP_OPENCLAW_UI_BUILD === "1";

function log(message) {
  process.stdout.write(`[lumina-desktop] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[lumina-desktop] ${message}\n`);
  process.exit(1);
}

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    fail(`Missing ${label}: ${targetPath}`);
  }
}

function readPackageJson(targetPath) {
  return readJsonFile(targetPath);
}

function copyFileToStage(sourcePath, targetPath) {
  ensureExists(sourcePath, "bundle source file");
  const sourceStats = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, sourceStats.mode);
}

function copyDirToStage(sourceDir, targetDir) {
  ensureExists(sourceDir, "bundle source directory");
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

function syncDirToStage(sourceDir, targetDir) {
  ensureExists(sourceDir, "bundle source directory");

  if (process.platform === "win32") {
    fs.mkdirSync(targetDir, { recursive: true });
    const result = spawnSync("robocopy", [
      sourceDir,
      targetDir,
      "/MIR",
      "/NFL",
      "/NDL",
      "/NJH",
      "/NJS",
      "/NP",
      "/R:1",
      "/W:1",
    ], {
      stdio: "inherit",
      env: process.env,
    });

    if (result.error) {
      fail(`Failed to sync ${sourceDir} -> ${targetDir} with robocopy: ${result.error.message}`);
    }

    if ((result.status ?? 16) > 7) {
      fail(`robocopy exited with code ${result.status ?? 16} while syncing ${sourceDir}`);
    }
    return;
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  copyDirToStage(sourceDir, targetDir);
}

function copyPathResolvingSymlinks(sourcePath, targetPath, ancestors = new Set()) {
  const sourceLstat = fs.lstatSync(sourcePath);
  const resolvedSourcePath = sourceLstat.isSymbolicLink()
    ? fs.realpathSync(sourcePath)
    : sourcePath;
  const sourceStats = sourceLstat.isSymbolicLink() ? fs.statSync(resolvedSourcePath) : sourceLstat;

  if (sourceStats.isDirectory()) {
    const realDirectoryPath = fs.realpathSync(resolvedSourcePath);
    if (ancestors.has(realDirectoryPath)) {
      fail(`Detected a cyclic symbolic link while materializing ${sourcePath}`);
    }

    fs.mkdirSync(targetPath, { recursive: true });
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(realDirectoryPath);
    const entries = fs
      .readdirSync(resolvedSourcePath, { withFileTypes: true })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      copyPathResolvingSymlinks(
        path.join(resolvedSourcePath, entry.name),
        path.join(targetPath, entry.name),
        nextAncestors,
      );
    }
    return;
  }

  if (!sourceStats.isFile()) {
    fail(`Unsupported staged runtime entry type: ${sourcePath}`);
  }

  copyFileToStage(resolvedSourcePath, targetPath);
}

function removeDistPluginNodeModulesSymlinks(rootDir) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return 0;
  }

  let removed = 0;
  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Ignore missing or unreadable paths so bundle prep can continue.
    }
  }

  return removed;
}

function sanitizeOpenClawSourceRuntimeOverlays() {
  const removedCount =
    removeDistPluginNodeModulesSymlinks(path.join(openClawRoot, "dist")) +
    removeDistPluginNodeModulesSymlinks(path.join(openClawRoot, "dist-runtime"));
  if (removedCount > 0) {
    log(`Removed ${removedCount} stale OpenClaw runtime overlay node_modules symlinks.`);
  }
}

function run(command, args, cwd) {
  log(`Running: ${command} ${args.join(" ")}`);
  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
          ["/d", "/c", command, ...args],
          {
            cwd,
            stdio: "inherit",
            env: process.env,
          },
        )
      : spawnSync(command, args, {
          cwd,
          stdio: "inherit",
          env: process.env,
        });

  if (result.error) {
    fail(`Failed to start ${command}: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    fail(`${command} exited with code ${result.status ?? 1}`);
  }
}

function createEmptyCanonicalBundle() {
  fs.rmSync(canonicalBundleRoot, { recursive: true, force: true });
  ensureDirectory(canonicalBundlePayloadRoot);
}

function buildCanonicalRuntimeBundle() {
  createEmptyCanonicalBundle();

  copyFileToStage(
    defaultsFilePath,
    path.join(canonicalBundlePayloadRoot, "config", "lumina-defaults.json"),
  );
  syncDirToStage(runtimeNodeDir, path.join(canonicalBundlePayloadRoot, "node"));
  const canonicalOpenClawDir = path.join(canonicalBundlePayloadRoot, "openclaw");
  syncDirToStage(stagedOpenClawDir, canonicalOpenClawDir);
  fs.rmSync(path.join(canonicalOpenClawDir, "dist", "control-ui"), {
    recursive: true,
    force: true,
  });
  syncDirToStage(
    path.join(stagedOpenClawDir, "dist", "control-ui"),
    path.join(canonicalBundlePayloadRoot, "ui"),
  );
  copyFileToStage(
    proxyEntryPath,
    path.join(canonicalBundlePayloadRoot, "proxy", "server.mjs"),
  );
  copyFileToStage(
    proxyConfigPath,
    path.join(canonicalBundlePayloadRoot, "proxy", "proxy-config.json"),
  );

  log(`Prepared canonical runtime bundle payload: ${canonicalBundleRoot}`);
}

function writeCanonicalBundleManifest() {
  const desktopPackageJson = readPackageJson(desktopPackageJsonPath);
  const tauriConfig = readJsonFile(tauriConfigPath);
  const openClawPackageJson = readPackageJson(openClawPackageJsonPath);
  const appId =
    typeof tauriConfig.identifier === "string" && tauriConfig.identifier.trim().length > 0
      ? tauriConfig.identifier
      : "ai.lumina.desktop";
  const productName =
    typeof tauriConfig.productName === "string" && tauriConfig.productName.trim().length > 0
      ? tauriConfig.productName
      : "Lumina OpenClaw";

  const manifest = {
    $schema: "../../schemas/lumina-desktop-bundle.schema.json",
    schemaVersion: BUNDLE_MANIFEST_SCHEMA_VERSION,
    bundleId: "lumina-openclaw-desktop",
    bundleKind: "desktop-runtime",
    bundleVersion: desktopPackageJson.version,
    createdAt: new Date().toISOString(),
    channel: process.env.LUMINA_RELEASE_CHANNEL ?? "stable",
    platform: process.platform,
    arch: process.arch,
    product: {
      appId,
      productName,
      vendor: desktopPackageJson.author ?? "I24D",
    },
    source: {
      desktopPackageName: desktopPackageJson.name,
      desktopPackageVersion: desktopPackageJson.version,
      openClawPackageName: openClawPackageJson.name,
      openClawVersion: openClawPackageJson.version,
      hostNodeVersion: process.versions.node,
      lockfileSha256: computeDeploySignature(),
    },
    install: {
      payloadRoot: "payload",
      copyMode: "merge-contents-of-payload-root",
      launchStrategy: "desktop-runtime-bundle",
    },
    launch: {
      defaultsFile: "config/lumina-defaults.json",
      nodeExecutable: process.platform === "win32" ? "node/node.exe" : "node/node",
      openClawEntry: "openclaw/openclaw.mjs",
      uiIndex: "ui/index.html",
      proxyEntry: "proxy/server.mjs",
    },
    entries: [
      createBundleEntry({
        id: "defaults",
        kind: "config",
        bundleRelativePath: "payload/config/lumina-defaults.json",
        installRelativePath: "config/lumina-defaults.json",
        sourcePath: defaultsFilePath,
      }),
      createBundleEntry({
        id: "runtime-node",
        kind: "runtime",
        bundleRelativePath: "payload/node",
        installRelativePath: "node",
        sourcePath: runtimeNodeDir,
        executable: true,
      }),
      createBundleEntry({
        id: "openclaw-runtime",
        kind: "content",
        bundleRelativePath: "payload/openclaw",
        installRelativePath: "openclaw",
        sourcePath: packagedOpenClawDir,
      }),
      createBundleEntry({
        id: "openclaw-ui",
        kind: "ui",
        bundleRelativePath: "payload/ui",
        installRelativePath: "ui",
        sourcePath: path.join(packagedOpenClawDir, "dist", "control-ui"),
      }),
      createBundleEntry({
        id: "proxy-runtime",
        kind: "service",
        bundleRelativePath: "payload/proxy/server.mjs",
        installRelativePath: "proxy/server.mjs",
        sourcePath: proxyEntryPath,
      }),
      createBundleEntry({
        id: "proxy-config",
        kind: "config",
        bundleRelativePath: "payload/proxy/proxy-config.json",
        installRelativePath: "proxy/proxy-config.json",
        sourcePath: proxyConfigPath,
      }),
    ],
  };

  validateBundleManifest(manifest);
  writeJsonFile(canonicalBundleManifestPath, manifest);
  log(`Wrote canonical bundle manifest: ${canonicalBundleManifestPath}`);
  return manifest;
}

function writeLegacyBundleSummary(manifest) {
  const hostNodeExecutable = fs.realpathSync(process.execPath);
  const bundledNodeExecutable = path.join(runtimeNodeDir, path.basename(hostNodeExecutable));

  const summary = {
    preparedAt: new Date().toISOString(),
    desktopRoot,
    openClawRoot,
    stagedOpenClawDir,
    canonicalBundleRoot,
    canonicalBundleManifestPath,
    bundle: {
      bundleId: manifest.bundleId,
      bundleVersion: manifest.bundleVersion,
      platform: manifest.platform,
      arch: manifest.arch,
    },
    hostNodeVersion: process.versions.node,
    assets: {
      bundledNodeExecutable,
      uiIndex: path.join(stagedOpenClawDir, "dist", "control-ui", "index.html"),
      stagedOpenClawEntry: path.join(stagedOpenClawDir, "openclaw.mjs"),
      stagedOpenClawPackageJson: path.join(stagedOpenClawDir, "package.json"),
      stagedOpenClawAssetsDir: path.join(stagedOpenClawDir, "assets"),
      stagedOpenClawDistDir: path.join(stagedOpenClawDir, "dist"),
      stagedOpenClawSkillsDir: path.join(stagedOpenClawDir, "skills"),
      stagedOpenClawScriptsDir: path.join(stagedOpenClawDir, "scripts"),
      proxyEntry: proxyEntryPath,
      proxyConfig: proxyConfigPath,
    },
  };

  writeJsonFile(bundleManifestPath, summary);
  log(`Wrote legacy bundle summary: ${bundleManifestPath}`);
}

function prepareBundledNodeRuntime() {
  const hostNodeExecutable = fs.realpathSync(process.execPath);
  const targetPath = path.join(runtimeNodeDir, path.basename(hostNodeExecutable));

  fs.mkdirSync(runtimeNodeDir, { recursive: true });
  fs.copyFileSync(hostNodeExecutable, targetPath);
  fs.chmodSync(targetPath, fs.statSync(hostNodeExecutable).mode);
  log(`Bundled host Node.js runtime v${process.versions.node}: ${targetPath}`);
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function computeDeploySignature() {
  return crypto
    .createHash("sha256")
    .update(readFileIfExists(path.join(openClawRoot, "package.json")))
    .update("\n---lockfile---\n")
    .update(readFileIfExists(path.join(openClawRoot, "pnpm-lock.yaml")))
    .digest("hex");
}

function loadDeployStamp() {
  try {
    return JSON.parse(fs.readFileSync(deployStampPath, "utf8"));
  } catch {
    return null;
  }
}

function saveDeployStamp(signature) {
  fs.mkdirSync(path.dirname(deployStampPath), { recursive: true });
  fs.writeFileSync(
    deployStampPath,
    `${JSON.stringify({ signature, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function normalizePnpmPath(value) {
  return value.replaceAll("/", "\\").toLowerCase();
}

function productionInstallMetadataIsCurrent() {
  const modulesYamlPath = path.join(stagedOpenClawDir, "node_modules", ".modules.yaml");
  if (!fs.existsSync(modulesYamlPath)) {
    return false;
  }

  const modulesYaml = readFileIfExists(modulesYamlPath);
  if (!modulesYaml) {
    return false;
  }

  const normalizedModulesYaml = normalizePnpmPath(modulesYaml);
  const expectedVirtualStoreDir = normalizePnpmPath(
    path.join(stagedOpenClawDir, "node_modules", ".pnpm"),
  );

  if (!normalizedModulesYaml.includes(`virtualstoredir: ${expectedVirtualStoreDir}`)) {
    return false;
  }

  return !normalizedModulesYaml.includes("openclaw-deploy-legacy");
}

function shouldRefreshProductionDependencies() {
  if (forceDeployRefresh) {
    return true;
  }
  if (!fs.existsSync(path.join(stagedOpenClawDir, "node_modules"))) {
    return true;
  }
  if (!fs.existsSync(path.join(stagedOpenClawDir, "openclaw.mjs"))) {
    return true;
  }
  if (!productionInstallMetadataIsCurrent()) {
    return true;
  }
  const signature = computeDeploySignature();
  const stamp = loadDeployStamp();
  if (!stamp?.signature) {
    saveDeployStamp(signature);
    return false;
  }
  return stamp.signature !== signature;
}

function syncOpenClawRuntimeAssets() {
  fs.mkdirSync(stagedOpenClawDir, { recursive: true });

  fs.rmSync(path.join(stagedOpenClawDir, "docs"), { recursive: true, force: true });
  fs.rmSync(path.join(stagedOpenClawDir, "CHANGELOG.md"), { recursive: true, force: true });
  fs.rmSync(path.join(stagedOpenClawDir, "scripts"), { recursive: true, force: true });

  copyFileToStage(path.join(openClawRoot, "openclaw.mjs"), path.join(stagedOpenClawDir, "openclaw.mjs"));
  copyFileToStage(path.join(openClawRoot, "package.json"), path.join(stagedOpenClawDir, "package.json"));
  copyFileToStage(path.join(openClawRoot, "pnpm-lock.yaml"), path.join(stagedOpenClawDir, "pnpm-lock.yaml"));
  copyFileToStage(path.join(openClawRoot, "README.md"), path.join(stagedOpenClawDir, "README.md"));
  copyFileToStage(path.join(openClawRoot, "LICENSE"), path.join(stagedOpenClawDir, "LICENSE"));
  log("Syncing OpenClaw assets into the production deploy bundle.");
  syncDirToStage(path.join(openClawRoot, "assets"), path.join(stagedOpenClawDir, "assets"));
  log("Syncing OpenClaw runtime dist into the production deploy bundle.");
  syncDirToStage(path.join(openClawRoot, "dist"), path.join(stagedOpenClawDir, "dist"));
  log("Syncing OpenClaw skills into the production deploy bundle.");
  syncDirToStage(path.join(openClawRoot, "skills"), path.join(stagedOpenClawDir, "skills"));

  const scriptsStageDir = path.join(stagedOpenClawDir, "scripts");
  fs.mkdirSync(scriptsStageDir, { recursive: true });
  copyFileToStage(
    path.join(openClawRoot, "scripts", "npm-runner.mjs"),
    path.join(scriptsStageDir, "npm-runner.mjs"),
  );
  copyFileToStage(
    path.join(openClawRoot, "scripts", "postinstall-bundled-plugins.mjs"),
    path.join(scriptsStageDir, "postinstall-bundled-plugins.mjs"),
  );

  log(`Synced OpenClaw runtime assets into production deploy: ${stagedOpenClawDir}`);
}

function ensureOpenClawProductionDependencies() {
  if (!shouldRefreshProductionDependencies()) {
    log("Reusing cached OpenClaw production dependencies.");
    return;
  }

  log("Installing isolated production dependencies for the staged OpenClaw bundle.");
  run(
    pnpmCmd,
    [
      "install",
      "--prod",
      "--ignore-scripts",
      "--ignore-workspace",
      "--config.confirmModulesPurge=false",
    ],
    stagedOpenClawDir,
  );
  saveDeployStamp(computeDeploySignature());
}

function hoistBundledExtensionRuntimeDeps() {
  const sourceExtensionsRoot = path.join(openClawRoot, "dist", "extensions");
  const stagedExtensionsRoot = path.join(stagedOpenClawDir, "dist", "extensions");
  const rootNodeModulesDir = path.join(stagedOpenClawDir, "node_modules");
  if (!fs.existsSync(sourceExtensionsRoot) || !fs.existsSync(rootNodeModulesDir)) {
    return;
  }

  log("Hoisting bundled extension runtime dependencies into the root production node_modules.");
  for (const extensionEntry of fs.readdirSync(sourceExtensionsRoot, { withFileTypes: true })) {
    if (!extensionEntry.isDirectory()) {
      continue;
    }
    const sourceExtensionNodeModulesDir = path.join(
      sourceExtensionsRoot,
      extensionEntry.name,
      "node_modules",
    );
    const stagedExtensionNodeModulesDir = path.join(
      stagedExtensionsRoot,
      extensionEntry.name,
      "node_modules",
    );
    if (!fs.existsSync(sourceExtensionNodeModulesDir)) {
      continue;
    }

    for (const depEntry of fs.readdirSync(sourceExtensionNodeModulesDir, { withFileTypes: true })) {
      if (depEntry.name.startsWith(".")) {
        continue;
      }

      const sourcePath = path.join(sourceExtensionNodeModulesDir, depEntry.name);
      const targetPath = path.join(rootNodeModulesDir, depEntry.name);

      if (depEntry.isDirectory() && depEntry.name.startsWith("@")) {
        fs.mkdirSync(targetPath, { recursive: true });
        for (const scopedEntry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
          if (!scopedEntry.isDirectory() || scopedEntry.name.startsWith(".")) {
            continue;
          }
          const scopedSourcePath = path.join(sourcePath, scopedEntry.name);
          const scopedTargetPath = path.join(targetPath, scopedEntry.name);
          if (shouldRefreshStagedDependency(scopedTargetPath)) {
            fs.rmSync(scopedTargetPath, { recursive: true, force: true });
            fs.cpSync(scopedSourcePath, scopedTargetPath, {
              recursive: true,
              force: true,
              dereference: true,
            });
          }
        }
        continue;
      }

      if (!depEntry.isDirectory() || !shouldRefreshStagedDependency(targetPath)) {
        continue;
      }

      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.cpSync(sourcePath, targetPath, {
        recursive: true,
        force: true,
        dereference: true,
      });
    }

    fs.rmSync(stagedExtensionNodeModulesDir, { recursive: true, force: true });
  }

  log("Hoisted bundled extension runtime dependencies into the root production node_modules.");
}

function shouldRefreshStagedDependency(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return true;
  }

  if (!fs.lstatSync(targetPath).isDirectory()) {
    return false;
  }

  return !fs.existsSync(path.join(targetPath, "package.json"));
}

function sanitizeBundledExtensionPackageManifests() {
  const extensionsRoot = path.join(stagedOpenClawDir, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return;
  }

  let sanitizedCount = 0;
  for (const extensionEntry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!extensionEntry.isDirectory()) {
      continue;
    }

    const packageJsonPath = path.join(extensionsRoot, extensionEntry.name, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      let changed = false;
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "devDependencies",
        "peerDependencies",
        "peerDependenciesMeta",
      ]) {
        if (packageJson[field] !== undefined) {
          delete packageJson[field];
          changed = true;
        }
      }

      if (!changed) {
        continue;
      }

      fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
      sanitizedCount += 1;
    } catch {
      // Ignore malformed plugin manifests; runtime will surface those separately.
    }
  }

  if (sanitizedCount > 0) {
    log(`Sanitized ${sanitizedCount} bundled extension package manifests for desktop packaging.`);
  }
}

function materializePackagedOpenClawRuntime() {
  fs.rmSync(packagedOpenClawDir, { recursive: true, force: true });
  copyPathResolvingSymlinks(stagedOpenClawDir, packagedOpenClawDir);
  log(`Materialized packaged OpenClaw runtime without symlinks: ${packagedOpenClawDir}`);
}

ensureExists(openClawRoot, "OpenClaw workspace");
ensureExists(toolProxyRoot, "tool-proxy directory");
ensureExists(desktopRoot, "desktop application");

const uiIndexPath = path.join(openClawRoot, "dist", "control-ui", "index.html");
const runtimeDistPath = path.join(openClawRoot, "dist");
const runtimeEntryPath = path.join(openClawRoot, "openclaw.mjs");
const proxyEntryPath = path.join(toolProxyRoot, "server.mjs");
const proxyConfigPath = path.join(toolProxyRoot, "proxy-config.json");
const macIconPath = path.join(desktopRoot, "assets", "icon.icns");
const defaultsFilePath = path.join(desktopRoot, "build", "lumina-defaults.json");
const shouldBuildOpenClawRuntime =
  forceRuntimeBuild ||
  (!skipRuntimeBuild && !fs.existsSync(runtimeDistPath));

sanitizeOpenClawSourceRuntimeOverlays();

if (shouldBuildOpenClawRuntime) {
  run(pnpmCmd, ["--dir", openClawRoot, "build:docker"], repoRoot);
} else if (!skipRuntimeBuild && !forceRuntimeBuild) {
  log("OpenClaw runtime artifacts already present; skipping build:docker. Use --build-openclaw to refresh them.");
}

if (!skipUiBuild) {
  run(pnpmCmd, ["--dir", openClawRoot, "ui:build"], repoRoot);
} else {
  log("Skipping ui:build because LUMINA_SKIP_OPENCLAW_UI_BUILD=1 or --skip-ui-build was set.");
}

ensureExists(uiIndexPath, "OpenClaw control UI build");
ensureExists(runtimeEntryPath, "OpenClaw runtime entry");
ensureExists(openClawPackageJsonPath, "OpenClaw package.json");
ensureExists(desktopPackageJsonPath, "desktop package.json");
ensureExists(tauriConfigPath, "Tauri config");
ensureExists(defaultsFilePath, "Lumina defaults file");
ensureExists(path.join(openClawRoot, "assets"), "OpenClaw assets");
ensureExists(runtimeDistPath, "OpenClaw dist");
ensureExists(proxyEntryPath, "tool-proxy server");
ensureExists(proxyConfigPath, "tool-proxy config");

syncOpenClawRuntimeAssets();
ensureOpenClawProductionDependencies();
hoistBundledExtensionRuntimeDeps();
sanitizeBundledExtensionPackageManifests();
materializePackagedOpenClawRuntime();
prepareBundledNodeRuntime();
fs.rmSync(canonicalBundleRoot, { recursive: true, force: true });
ensureDirectory(canonicalBundleRoot);

if (!fs.existsSync(macIconPath)) {
  log("assets/icon.icns is missing. macOS builds will use the PNG icon fallback.");
}

const canonicalBundleManifest = writeCanonicalBundleManifest();
writeLegacyBundleSummary(canonicalBundleManifest);
log("Deferred canonical runtime bundle payload assembly until the archive stage.");
log("Desktop bundle inputs are ready.");
