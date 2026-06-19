#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const buildRoot = path.join(desktopRoot, "build", "runtime-tools");
const windows = process.platform === "win32";
const runtimeTools = [
  {
    label: "runtime manager",
    manifestPath: path.join("rust", "lumina-bootstrapper", "Cargo.toml"),
    binaryName: windows ? "lumina-bootstrapper.exe" : "lumina-bootstrapper",
    sourceBinaryPath: path.join(
      repoRoot,
      "rust",
      "lumina-bootstrapper",
      "target",
      "release",
      windows ? "lumina-bootstrapper.exe" : "lumina-bootstrapper",
    ),
  },
  ...(windows
    ? [
        {
          label: "voice sidecar",
          manifestPath: path.join("rust", "lumina-voice", "Cargo.toml"),
          binaryName: "lumina-voice.exe",
          sourceBinaryPath: path.join(
            repoRoot,
            "rust",
            "lumina-voice",
            "target",
            "release",
            "lumina-voice.exe",
          ),
        },
      ]
    : []),
];

function fail(message) {
  process.stderr.write(`[lumina-runtime-tools] ${message}\n`);
  process.exit(1);
}

for (const tool of runtimeTools) {
  const buildResult = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(repoRoot, "scripts", "run-cargo-bootstrapper.ts"),
      "build",
      "--manifest-path",
      tool.manifestPath,
      "--release",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    },
  );

  if (buildResult.error) {
    fail(`Failed to start the ${tool.label} build: ${buildResult.error.message}`);
  }
  if ((buildResult.status ?? 1) !== 0) {
    fail(`The ${tool.label} build exited with code ${buildResult.status ?? 1}`);
  }
  if (!fs.existsSync(tool.sourceBinaryPath)) {
    fail(`The compiled ${tool.label} binary is missing: ${tool.sourceBinaryPath}`);
  }
}

if (windows && process.env.LUMINA_REQUIRE_WINDOWS_SIGNING === "1") {
  const signingResult = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "sign-windows-file.ps1"),
      ...runtimeTools.map((tool) => tool.sourceBinaryPath),
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (signingResult.error) {
    fail(`Failed to start runtime-tools signing: ${signingResult.error.message}`);
  }
  if ((signingResult.status ?? 1) !== 0) {
    fail(`Runtime-tools signing exited with code ${signingResult.status ?? 1}`);
  }
}

fs.mkdirSync(buildRoot, { recursive: true });
for (const tool of runtimeTools) {
  const outputBinaryPath = path.join(buildRoot, tool.binaryName);
  fs.copyFileSync(tool.sourceBinaryPath, outputBinaryPath);
  process.stdout.write(`[lumina-runtime-tools] Prepared ${outputBinaryPath}\n`);
}
