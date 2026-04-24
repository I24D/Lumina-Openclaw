#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const buildRoot = path.join(desktopRoot, "build", "runtime-tools");
const binaryName = process.platform === "win32" ? "lumina-bootstrapper.exe" : "lumina-bootstrapper";
const sourceBinaryPath = path.join(
  repoRoot,
  "rust",
  "lumina-bootstrapper",
  "target",
  "release",
  binaryName,
);
const outputBinaryPath = path.join(buildRoot, binaryName);

function fail(message) {
  process.stderr.write(`[lumina-runtime-tools] ${message}\n`);
  process.exit(1);
}

const buildResult = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    path.join(repoRoot, "scripts", "run-cargo-bootstrapper.ts"),
    "build",
    "--manifest-path",
    path.join("rust", "lumina-bootstrapper", "Cargo.toml"),
    "--release",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  },
);

if (buildResult.error) {
  fail(`Failed to start the Rust runtime tools build: ${buildResult.error.message}`);
}
if ((buildResult.status ?? 1) !== 0) {
  fail(`The Rust runtime tools build exited with code ${buildResult.status ?? 1}`);
}

if (!fs.existsSync(sourceBinaryPath)) {
  fail(`The compiled runtime manager binary is missing: ${sourceBinaryPath}`);
}

fs.mkdirSync(buildRoot, { recursive: true });
fs.copyFileSync(sourceBinaryPath, outputBinaryPath);

process.stdout.write(`[lumina-runtime-tools] Prepared ${outputBinaryPath}\n`);
