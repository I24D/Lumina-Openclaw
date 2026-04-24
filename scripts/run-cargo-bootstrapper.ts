#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveVcvars64Path, runInWindowsMsvcEnv } from "./msvc-toolchain.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const bootstrapperRoot = path.join(repoRoot, "rust", "lumina-bootstrapper");
const cliArgs = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`[lumina-bootstrapper] ${message}\n`);
  process.exit(1);
}

function resolveCargoPath() {
  const explicit = process.env.CARGO?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  for (const segment of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(segment, process.platform === "win32" ? "cargo.exe" : "cargo");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const homeDir = os.homedir();
  if (process.platform === "win32") {
    const candidates = [
      path.join(homeDir, ".cargo", "bin", "cargo.exe"),
      path.join(
        homeDir,
        ".rustup",
        "toolchains",
        "stable-x86_64-pc-windows-msvc",
        "bin",
        "cargo.exe",
      ),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? "";
  }

  const unixCandidate = path.join(homeDir, ".cargo", "bin", "cargo");
  return fs.existsSync(unixCandidate) ? unixCandidate : "";
}

function resolveRustcPath(cargoPath) {
  const explicit = process.env.RUSTC?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const cargoDirectory = path.dirname(cargoPath);
  const rustcName = process.platform === "win32" ? "rustc.exe" : "rustc";
  const siblingRustc = path.join(cargoDirectory, rustcName);
  if (fs.existsSync(siblingRustc)) {
    return siblingRustc;
  }

  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  for (const segment of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(segment, rustcName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const homeDir = os.homedir();
  if (process.platform === "win32") {
    const candidate = path.join(
      homeDir,
      ".rustup",
      "toolchains",
      "stable-x86_64-pc-windows-msvc",
      "bin",
      rustcName,
    );
    return fs.existsSync(candidate) ? candidate : "";
  }

  const unixCandidate = path.join(homeDir, ".cargo", "bin", rustcName);
  return fs.existsSync(unixCandidate) ? unixCandidate : "";
}

const cargoPath = resolveCargoPath();
if (!cargoPath) {
  fail("Cargo was not found. Install Rust or set the CARGO environment variable.");
}

const rustcPath = resolveRustcPath(cargoPath);
if (!rustcPath) {
  fail("rustc was not found. Install Rust or set the RUSTC environment variable.");
}

const cargoArgs =
  cliArgs.length > 0
    ? cliArgs
    : ["build", "--manifest-path", path.join(bootstrapperRoot, "Cargo.toml"), "--release"];

const vcvarsPath = process.platform === "win32" ? resolveVcvars64Path(process.env) : "";

const result =
  process.platform === "win32" && vcvarsPath
    ? runInWindowsMsvcEnv({
        vcvarsPath,
        commandPath: cargoPath,
        args: cargoArgs,
        cwd: repoRoot,
        env: process.env,
        prependPathEntries: [path.dirname(cargoPath)],
        envVars: {
          RUSTC: rustcPath,
        },
      })
    : spawnSync(cargoPath, cargoArgs, {
        cwd: repoRoot,
        stdio: "inherit",
        env: process.env,
      });

if (result.error) {
  fail(`Failed to start Cargo: ${result.error.message}`);
}
if ((result.status ?? 1) !== 0) {
  if (process.platform === "win32" && !vcvarsPath) {
    fail(
      "Cargo exited with a Windows toolchain error. Install Visual Studio Build Tools with the MSVC toolchain and Windows SDK, or set VCVARS64_BAT to vcvars64.bat.",
    );
  }
  fail(`Cargo exited with code ${result.status ?? 1}`);
}
