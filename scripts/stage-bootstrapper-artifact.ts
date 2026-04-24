#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeJsonFile, readJsonFile } from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const bootstrapperRoot = path.join(repoRoot, "rust", "lumina-bootstrapper");
const releaseRoot = path.join(desktopRoot, "release");
const bootstrapperPackage = readJsonFile(path.join(desktopRoot, "package.json"));

function fail(message) {
  process.stderr.write(`[lumina-bootstrapper] ${message}\n`);
  process.exit(1);
}

function sha256File(targetPath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(targetPath));
  return hash.digest("hex");
}

function byteSize(targetPath) {
  return fs.statSync(targetPath).size;
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

const binaryName = process.platform === "win32" ? "lumina-bootstrapper.exe" : "lumina-bootstrapper";
const inputBinaryPath = path.join(
  bootstrapperRoot,
  "target",
  "release",
  binaryName,
);

if (!fs.existsSync(inputBinaryPath)) {
  fail(`Missing compiled bootstrapper binary: ${inputBinaryPath}`);
}

fs.mkdirSync(releaseRoot, { recursive: true });
const version = bootstrapperPackage.version;
const platform = process.platform;
const arch = process.arch;
const artifactBaseName = `lumina-bootstrapper-${version}-${platform}-${arch}`;
const artifactFileName = `${artifactBaseName}.tar.gz`;
const artifactPath = path.join(releaseRoot, artifactFileName);
const metadataPath = path.join(releaseRoot, `${artifactBaseName}.artifact.json`);

fs.rmSync(artifactPath, { force: true });
fs.rmSync(metadataPath, { force: true });

const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-bootstrapper-stage-"));
try {
  fs.copyFileSync(inputBinaryPath, path.join(stageDir, binaryName));
  archiveWithTar(stageDir, artifactPath);
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}

writeJsonFile(metadataPath, {
  artifactId: "lumina-bootstrap-installer",
  role: "bootstrap-installer",
  format: "tar.gz",
  platform,
  arch,
  fileName: artifactFileName,
  relativePath: artifactFileName,
  byteSize: byteSize(artifactPath),
  sha256: sha256File(artifactPath),
});

process.stdout.write(`[lumina-bootstrapper] Staged ${artifactPath}\n`);
