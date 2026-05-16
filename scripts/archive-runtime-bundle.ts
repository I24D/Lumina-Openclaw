#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeFileByteSize,
  computeFileSha256,
  readJsonFile,
  validateBundleManifest,
  writeJsonFile,
} from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const workspaceRoot = path.resolve(repoRoot, "..");
const defaultCanonicalBundleRoot = path.join(desktopRoot, "build", "runtime-bundle");
const defaultCanonicalBundleManifestPath = path.join(
  defaultCanonicalBundleRoot,
  "bundle.manifest.json",
);
const defaultReleaseRoot = path.join(desktopRoot, "release");
const defaultsFilePath = path.join(desktopRoot, "build", "lumina-defaults.json");
const runtimeNodeDir = path.join(desktopRoot, "build", "runtime-node");
const packagedOpenClawDir = path.join(desktopRoot, "build", "openclaw-package");
const toolProxyRoot = path.join(repoRoot, "tool-proxy");
const proxyEntryPath = path.join(toolProxyRoot, "server.mjs");
const proxyConfigPath = path.join(toolProxyRoot, "proxy-config.json");
const luminaCodeVsixPath =
  process.env.LUMINA_CODE_VSIX_PATH ??
  path.join(workspaceRoot, "src", "lumina-code", "official", "extensions", "vscode", "build", "lumina-code-0.1.0.vsix");

function log(message) {
  process.stdout.write(`[lumina-release] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[lumina-release] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
      continue;
    }

    args.set(key, next);
    index += 1;
  }
  return args;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
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

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    fail(`Missing ${label}: ${targetPath}`);
  }
}

function copyFileToStage(sourcePath, targetPath) {
  ensureExists(sourcePath, "bundle source file");
  const sourceStats = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.linkSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, sourceStats.mode);
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EXDEV", "EMLINK", "EPERM", "EEXIST"].includes(String(error.code))
      ) {
        throw error;
      }
    }
  }

  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, sourceStats.mode);
}

function copyDirToStage(sourceDir, targetDir) {
  ensureExists(sourceDir, "bundle source directory");
  copyPathToStage(sourceDir, targetDir);
}

function syncDirToStage(sourceDir, targetDir) {
  ensureExists(sourceDir, "bundle source directory");

  fs.rmSync(targetDir, { recursive: true, force: true });
  copyDirToStage(sourceDir, targetDir);
}

function listArchiveEntries(sourceDir) {
  const entries = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (entries.length === 0) {
    fail(`Cannot archive an empty directory: ${sourceDir}`);
  }
  return entries;
}

function copyPathToStage(sourcePath, targetPath, ancestors = new Set<string>()) {
  const sourceLstat = fs.lstatSync(sourcePath);
  const resolvedSourcePath = sourceLstat.isSymbolicLink()
    ? fs.realpathSync(sourcePath)
    : sourcePath;
  const sourceStats = sourceLstat.isSymbolicLink() ? fs.statSync(resolvedSourcePath) : sourceLstat;

  if (sourceStats.isDirectory()) {
    const realDirectoryPath = fs.realpathSync(resolvedSourcePath);
    if (ancestors.has(realDirectoryPath)) {
      fail(`Detected a cyclic symbolic link while staging ${sourcePath}`);
    }

    fs.mkdirSync(targetPath, { recursive: true });
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(realDirectoryPath);
    const entries = fs
      .readdirSync(resolvedSourcePath, { withFileTypes: true })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      copyPathToStage(
        path.join(resolvedSourcePath, entry.name),
        path.join(targetPath, entry.name),
        nextAncestors,
      );
    }
    return;
  }

  if (!sourceStats.isFile()) {
    fail(`Unsupported runtime bundle entry type: ${sourcePath}`);
  }

  copyFileToStage(resolvedSourcePath, targetPath);
}

function sanitizeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function buildArtifactBaseName(bundleManifest) {
  const version = sanitizeName(bundleManifest.bundleVersion);
  const platform = sanitizeName(bundleManifest.platform);
  const arch = sanitizeName(bundleManifest.arch);
  return `lumina-openclaw-runtime-bundle-${version}-${platform}-${arch}`;
}

function assembleCanonicalRuntimeBundle(
  canonicalBundleRoot,
  sourceBundleManifestPath,
  canonicalBundleManifestPath,
) {
  ensureExists(sourceBundleManifestPath, "canonical bundle manifest");
  ensureExists(defaultsFilePath, "Lumina defaults file");
  ensureExists(runtimeNodeDir, "bundled Node runtime");
  ensureExists(packagedOpenClawDir, "packaged OpenClaw runtime");
  ensureExists(path.join(packagedOpenClawDir, "dist", "control-ui", "index.html"), "OpenClaw UI");
  ensureExists(proxyEntryPath, "tool proxy entry");
  ensureExists(proxyConfigPath, "tool proxy config");
  ensureExists(luminaCodeVsixPath, "Lumina Code VSIX");

  const manifestJson = fs.readFileSync(sourceBundleManifestPath, "utf8");
  const canonicalPayloadRoot = path.join(canonicalBundleRoot, "payload");

  fs.rmSync(canonicalBundleRoot, { recursive: true, force: true });
  fs.mkdirSync(canonicalPayloadRoot, { recursive: true });

  copyFileToStage(
    defaultsFilePath,
    path.join(canonicalPayloadRoot, "config", "lumina-defaults.json"),
  );
  syncDirToStage(runtimeNodeDir, path.join(canonicalPayloadRoot, "node"));
  syncDirToStage(packagedOpenClawDir, path.join(canonicalPayloadRoot, "openclaw"));
  syncDirToStage(
    path.join(packagedOpenClawDir, "dist", "control-ui"),
    path.join(canonicalPayloadRoot, "ui"),
  );
  copyFileToStage(proxyEntryPath, path.join(canonicalPayloadRoot, "proxy", "server.mjs"));
  copyFileToStage(
    proxyConfigPath,
    path.join(canonicalPayloadRoot, "proxy", "proxy-config.json"),
  );
  copyFileToStage(
    luminaCodeVsixPath,
    path.join(canonicalPayloadRoot, "lumina-code", "lumina-code-0.1.0.vsix"),
  );
  fs.writeFileSync(canonicalBundleManifestPath, manifestJson, "utf8");
  log(`Prepared canonical runtime bundle payload: ${canonicalBundleRoot}`);
}

const args = parseArgs(process.argv.slice(2));
const releaseRoot = args.get("release-root") ?? defaultReleaseRoot;
fs.mkdirSync(releaseRoot, { recursive: true });

const explicitCanonicalBundleRoot = args.get("canonical-bundle-root");
const canonicalBundleRoot =
  explicitCanonicalBundleRoot ??
  fs.mkdtempSync(path.join(releaseRoot, ".lumina-runtime-bundle-"));
const sourceBundleManifestPath =
  args.get("bundle-manifest") ??
  (explicitCanonicalBundleRoot
    ? path.join(explicitCanonicalBundleRoot, "bundle.manifest.json")
    : defaultCanonicalBundleManifestPath);
const canonicalBundleManifestPath = path.join(canonicalBundleRoot, "bundle.manifest.json");

if (!fs.existsSync(sourceBundleManifestPath)) {
  fail(`Missing canonical bundle manifest: ${sourceBundleManifestPath}`);
}

try {
  assembleCanonicalRuntimeBundle(
    canonicalBundleRoot,
    sourceBundleManifestPath,
    canonicalBundleManifestPath,
  );
  const bundleManifest = validateBundleManifest(readJsonFile(canonicalBundleManifestPath));
  const artifactBaseName = buildArtifactBaseName(bundleManifest);
  const archiveFileName = `${artifactBaseName}.tar.gz`;
  const manifestFileName = `${artifactBaseName}.manifest.json`;
  const metadataFileName = `${artifactBaseName}.artifact.json`;
  const archivePath = path.join(releaseRoot, archiveFileName);
  const releaseManifestCopyPath = path.join(releaseRoot, manifestFileName);
  const metadataPath = path.join(releaseRoot, metadataFileName);

  fs.rmSync(archivePath, { force: true });
  fs.rmSync(releaseManifestCopyPath, { force: true });
  fs.rmSync(metadataPath, { force: true });

  log(`Archiving runtime bundle to ${archivePath}`);
  run("tar", ["-czf", archivePath, "-C", canonicalBundleRoot, ...listArchiveEntries(canonicalBundleRoot)], repoRoot);
  fs.copyFileSync(canonicalBundleManifestPath, releaseManifestCopyPath);

  const metadata = {
    artifactId: artifactBaseName,
    role: "runtime-bundle",
    format: "tar.gz",
    platform: bundleManifest.platform,
    arch: bundleManifest.arch,
    fileName: archiveFileName,
    relativePath: archiveFileName,
    byteSize: computeFileByteSize(archivePath),
    sha256: computeFileSha256(archivePath),
    bundleManifestFileName: manifestFileName,
    bundleManifestRelativePath: manifestFileName,
    bundleManifestSha256: computeFileSha256(releaseManifestCopyPath),
  };

  writeJsonFile(metadataPath, metadata);
  log(`Wrote runtime bundle archive metadata: ${metadataPath}`);
} finally {
  if (!explicitCanonicalBundleRoot) {
    fs.rmSync(canonicalBundleRoot, { recursive: true, force: true });
  }
}
