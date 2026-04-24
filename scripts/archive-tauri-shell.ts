#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeFileByteSize,
  computeFileSha256,
  readJsonFile,
  writeJsonFile,
} from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const tauriConfigPath = path.join(tauriRoot, "tauri.conf.json");
const desktopPackageJsonPath = path.join(desktopRoot, "package.json");
const defaultReleaseRoot = path.join(desktopRoot, "release");

type ArchiveTauriShellOptions = {
  platform?: string;
  arch?: string;
  releaseRoot?: string;
  binaryName?: string;
  binaryPath?: string;
  productName?: string;
  version?: string;
};

function log(message) {
  process.stdout.write(`[lumina-tauri] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[lumina-tauri] ${message}\n`);
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

function sanitizeSegment(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    fail(`Missing ${label}: ${targetPath}`);
  }
}

function copyResource(sourcePath, targetPath) {
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      dereference: true,
    });
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function archiveWithTar(sourceDir, archivePath) {
  const result = spawnSync("tar", ["-czf", archivePath, "-C", sourceDir, "."], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    fail(`Failed to start tar: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    fail(`tar exited with code ${result.status ?? 1}`);
  }
}

export function archiveTauriShell(options: ArchiveTauriShellOptions = {}) {
  const desktopPackageJson = readJsonFile(desktopPackageJsonPath);
  const tauriConfig = readJsonFile(tauriConfigPath);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const releaseRoot = options.releaseRoot ?? defaultReleaseRoot;
  const binaryName =
    options.binaryName ??
    (platform === "win32" ? "lumina-desktop-tauri.exe" : "lumina-desktop-tauri");
  const binaryPath =
    options.binaryPath ??
    path.join(tauriRoot, "target", "release", binaryName);
  const productName =
    options.productName ??
    tauriConfig.productName ??
    desktopPackageJson.build?.productName ??
    "Lumina OpenClaw";
  const version = options.version ?? tauriConfig.version ?? desktopPackageJson.version;
  const archiveBaseName = [
    "lumina-openclaw-shell",
    sanitizeSegment(version),
    sanitizeSegment(platform),
    sanitizeSegment(arch),
  ].join("-");
  const archiveFileName = `${archiveBaseName}.tar.gz`;
  const archivePath = path.join(releaseRoot, archiveFileName);
  const metadataPath = path.join(releaseRoot, `${archiveBaseName}.artifact.json`);
  const stagedBinaryName = platform === "win32" ? `${productName}.exe` : productName;
  const resources = tauriConfig.bundle?.resources as Record<string, string> | undefined;

  ensureExists(binaryPath, "compiled Tauri binary");
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    fail(`Unsupported Tauri bundle.resources layout in ${tauriConfigPath}`);
  }

  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(metadataPath, { force: true });

  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-tauri-shell-"));
  const stageDir = path.join(stageRoot, `${productName}-${version}-${platform}-${arch}`);

  try {
    fs.mkdirSync(stageDir, { recursive: true });
    fs.copyFileSync(binaryPath, path.join(stageDir, stagedBinaryName));

    for (const [from, to] of Object.entries(resources)) {
      const sourcePath = path.resolve(tauriRoot, from);
      const targetPath = path.join(stageDir, "resources", to);
      ensureExists(sourcePath, `Tauri resource "${from}"`);
      copyResource(sourcePath, targetPath);
    }

    archiveWithTar(stageRoot, archivePath);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }

  const metadata = {
    artifactId: "lumina-desktop-shell",
    role: "desktop-installer",
    format: "tar.gz",
    platform,
    arch,
    fileName: archiveFileName,
    relativePath: archiveFileName,
    byteSize: computeFileByteSize(archivePath),
    sha256: computeFileSha256(archivePath),
  };

  writeJsonFile(metadataPath, metadata);
  log(`Archived portable Tauri shell: ${archivePath}`);
  return {
    archivePath,
    archiveFileName,
    metadataPath,
    metadata,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  archiveTauriShell({
    binaryPath: args.get("binary"),
    binaryName: args.get("binary-name"),
    releaseRoot: args.get("release-root"),
    platform: args.get("platform"),
    arch: args.get("arch"),
    productName: args.get("product-name"),
    version: args.get("version"),
  });
}
