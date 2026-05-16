#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveVcvars64Path, runInWindowsMsvcEnv } from "./msvc-toolchain.ts";

const cliArgs = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`[lumina-tauri] ${message}\n`);
  process.exit(1);
}

function resolveCommandPath(candidates) {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  for (const segment of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidateName of candidates) {
      const candidatePath = path.join(segment, candidateName);
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }
  return "";
}

function resolvePnpmPath() {
  const explicit = process.env.PNPM?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const binaryName = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const resolvedFromPath = resolveCommandPath([binaryName]);
  if (resolvedFromPath) {
    return resolvedFromPath;
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    const fallback = path.join(appData, "npm", binaryName);
    if (fs.existsSync(fallback)) {
      return fallback;
    }
  }

  return "";
}

function resolveCargoPath() {
  const explicit = process.env.CARGO?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const binaryName = process.platform === "win32" ? "cargo.exe" : "cargo";
  const resolvedFromPath = resolveCommandPath([binaryName]);
  if (resolvedFromPath) {
    return resolvedFromPath;
  }

  const homeDir = os.homedir();
  if (process.platform === "win32") {
    for (const candidate of [
      path.join(homeDir, ".cargo", "bin", "cargo.exe"),
      path.join(
        homeDir,
        ".rustup",
        "toolchains",
        "stable-x86_64-pc-windows-msvc",
        "bin",
        "cargo.exe",
      ),
    ]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return "";
  }

  const fallback = path.join(homeDir, ".cargo", "bin", "cargo");
  return fs.existsSync(fallback) ? fallback : "";
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

  return resolveCommandPath([rustcName]);
}

const pnpmPath = resolvePnpmPath();
if (!pnpmPath) {
  fail("pnpm was not found. Install pnpm or set the PNPM environment variable.");
}

const cargoPath = resolveCargoPath();
if (!cargoPath) {
  fail("Cargo was not found. Install Rust or set the CARGO environment variable.");
}

const rustcPath = resolveRustcPath(cargoPath);
if (!rustcPath) {
  fail("rustc was not found. Install Rust or set the RUSTC environment variable.");
}

const tauriArgs =
  cliArgs.length > 0 ? cliArgs : ["exec", "tauri", "build", "--bundles", "nsis"];

const vcvarsPath = process.platform === "win32" ? resolveVcvars64Path(process.env) : "";

const result =
  process.platform === "win32" && vcvarsPath
    ? runInWindowsMsvcEnv({
        vcvarsPath,
        commandPath: pnpmPath,
        args: tauriArgs,
        cwd: process.cwd(),
        env: process.env,
        prependPathEntries: [path.dirname(pnpmPath), path.dirname(cargoPath)],
        envVars: {
          CARGO: cargoPath,
          RUSTC: rustcPath,
        },
      })
    : spawnSync(pnpmPath, tauriArgs, {
        cwd: process.cwd(),
        stdio: "inherit",
        env: {
          ...process.env,
          CARGO: cargoPath,
          RUSTC: rustcPath,
          PATH: [path.dirname(pnpmPath), path.dirname(cargoPath), process.env.PATH ?? process.env.Path ?? ""]
            .filter(Boolean)
            .join(path.delimiter),
        },
      });

if (result.error) {
  fail(`Failed to start pnpm/tauri: ${result.error.message}`);
}

if ((result.status ?? 1) !== 0) {
  if (process.platform === "win32" && !vcvarsPath) {
    fail(
      "Tauri bundling exited with a Windows toolchain error. Install Visual Studio Build Tools with the MSVC toolchain and Windows SDK, or set VCVARS64_BAT to vcvars64.bat.",
    );
  }
  fail(`pnpm tauri command exited with code ${result.status ?? 1}`);
}
