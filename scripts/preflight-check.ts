#!/usr/bin/env node
/**
 * preflight-check.ts — Fast pre-build validation for Lumina Desktop release.
 *
 * Runs in < 5 seconds. Catches the late-stage failures that previously forced
 * full pipeline re-runs (disk pressure, missing bundle inputs, bad manifests).
 *
 * Modes:
 *   --mode=source         Check required source-level files/dirs exist
 *   --mode=bundle-inputs  Check that OpenClaw build output is present and usable
 *   --mode=disk           Check available disk space only
 *   --mode=all            Run all checks (default when called locally)
 *
 * Usage:
 *   node --experimental-strip-types scripts/preflight-check.ts
 *   node --experimental-strip-types scripts/preflight-check.ts --mode=bundle-inputs
 *   pnpm desktop:preflight
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const openClawRoot = path.join(repoRoot, "Open_PC");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const toolProxyRoot = path.join(repoRoot, "tool-proxy");

// ── Helpers ───────────────────────────────────────────────────────────────────

let errors = 0;
let warnings = 0;

function ok(msg: string) {
  process.stdout.write(`  ✓ ${msg}\n`);
}

function warn(msg: string) {
  warnings++;
  process.stdout.write(`  ⚠ ${msg}\n`);
}

function fail(msg: string) {
  errors++;
  process.stderr.write(`  ✗ ${msg}\n`);
}

function section(title: string) {
  process.stdout.write(`\n[preflight] ${title}\n`);
}

function checkExists(p: string, label: string, required = true) {
  if (fs.existsSync(p)) {
    ok(`${label} — ${p}`);
    return true;
  }
  if (required) {
    fail(`Missing ${label}: ${p}`);
  } else {
    warn(`Optional ${label} not found: ${p}`);
  }
  return false;
}

function checkFileNotEmpty(p: string, label: string) {
  if (!fs.existsSync(p)) {
    fail(`Missing ${label}: ${p}`);
    return false;
  }
  const size = fs.statSync(p).size;
  if (size === 0) {
    fail(`${label} is empty (0 bytes): ${p}`);
    return false;
  }
  ok(`${label} — ${size} bytes`);
  return true;
}

function checkJsonParseable(p: string, label: string) {
  if (!fs.existsSync(p)) {
    fail(`Missing ${label}: ${p}`);
    return false;
  }
  try {
    const raw = fs.readFileSync(p, "utf8");
    JSON.parse(raw);
    ok(`${label} is valid JSON`);
    return true;
  } catch (err: any) {
    fail(`${label} is not valid JSON: ${err.message}`);
    return false;
  }
}

// ── Disk space check ──────────────────────────────────────────────────────────
// Minimum free space required before archiving (bytes).
const REQUIRED_FREE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const WARN_FREE_BYTES     = 6 * 1024 * 1024 * 1024; // 6 GB warn threshold

function getFreeDiskBytes(dir: string): number | null {
  try {
    if (process.platform === "linux" || process.platform === "darwin") {
      // df -k gives 1KB blocks; pick the Available column
      const out = execSync(`df -k "${dir}"`, { encoding: "utf8" });
      const lines = out.trim().split("\n");
      const last = lines[lines.length - 1];
      const parts = last.trim().split(/\s+/);
      // Format: Filesystem 1K-blocks Used Available Use% Mounted
      const availKb = parseInt(parts[3], 10);
      if (!isNaN(availKb)) return availKb * 1024;
    } else if (process.platform === "win32") {
      const out = execSync(`wmic logicaldisk where "DeviceID='${dir.slice(0, 2)}'" get FreeSpace`, {
        encoding: "utf8",
      });
      const match = out.match(/\d+/);
      if (match) return parseInt(match[0], 10);
    }
  } catch {
    // Non-critical — disk check is best-effort
  }
  return null;
}

function checkDiskSpace() {
  section("Disk space");
  const freeBytes = getFreeDiskBytes(repoRoot);
  if (freeBytes === null) {
    warn("Could not determine free disk space (platform not supported or df unavailable).");
    return;
  }
  const freeGb = (freeBytes / (1024 ** 3)).toFixed(2);
  if (freeBytes < REQUIRED_FREE_BYTES) {
    fail(`Only ${freeGb} GB free — need at least 4 GB before archiving.`);
  } else if (freeBytes < WARN_FREE_BYTES) {
    warn(`${freeGb} GB free — low, consider freeing space before archiving.`);
  } else {
    ok(`${freeGb} GB free — OK`);
  }
}

// ── Source layout check ───────────────────────────────────────────────────────
// Verifies that the repo is structured correctly BEFORE any build starts.

function checkSourceLayout() {
  section("Source layout");

  // Workspace roots
  checkExists(path.join(repoRoot, "pnpm-workspace.yaml"), "pnpm workspace");
  checkExists(path.join(repoRoot, "pnpm-lock.yaml"),      "root lockfile");
  checkExists(openClawRoot,                                "Open_PC root");
  checkExists(path.join(openClawRoot, "package.json"),     "Open_PC package.json");
  checkExists(desktopRoot,                                 "lumina-desktop root");
  checkExists(path.join(desktopRoot, "src-tauri"),         "src-tauri dir");

  // Tauri config
  const tauriConf = path.join(desktopRoot, "src-tauri", "tauri.conf.json");
  checkJsonParseable(tauriConf, "tauri.conf.json");

  // Tool proxy (bundled into every release)
  checkExists(path.join(toolProxyRoot, "server.mjs"),        "tool-proxy entry");
  checkExists(path.join(toolProxyRoot, "proxy-config.json"), "tool-proxy config");
  checkJsonParseable(path.join(toolProxyRoot, "proxy-config.json"), "proxy-config.json");

  // Schemas
  checkExists(
    path.join(repoRoot, "schemas", "lumina-desktop-bundle.schema.json"),
    "bundle schema",
    false,
  );

  // Rust crates
  checkExists(
    path.join(repoRoot, "rust", "lumina-bootstrapper", "Cargo.toml"),
    "bootstrapper Cargo.toml",
  );
  checkExists(
    path.join(desktopRoot, "src-tauri", "Cargo.toml"),
    "tauri Cargo.toml",
  );
}

// ── Bundle inputs check ───────────────────────────────────────────────────────
// Verifies that OpenClaw build output exists BEFORE Tauri compilation.
//
// In CI this runs AFTER the openclaw-build artifact is downloaded to Open_PC/.
// The artifact provides: Open_PC/dist/, Open_PC/openclaw.mjs, Open_PC/assets/, Open_PC/skills/
//
// apps/lumina-desktop/build/openclaw-package/ is created by prepare-desktop-bundle.ts
// which runs INSIDE the desktop build step — so it does NOT exist at this point.
// We check it as optional (warn) so it doesn't block CI.

function checkBundleInputs() {
  section("Bundle inputs (OpenClaw build output)");

  // ── Primary checks: Open_PC/dist/ from the openclaw-build artifact ──────────
  // These files are required. If missing, the OpenClaw artifact download failed
  // or went to the wrong path.
  const openClawDist       = path.join(openClawRoot, "dist");
  const openClawMjs        = path.join(openClawRoot, "openclaw.mjs");
  const controlUiDir       = path.join(openClawDist, "control-ui");
  const controlUiIndex     = path.join(controlUiDir, "index.html");

  checkExists(openClawDist, "Open_PC/dist dir (artifact output)");
  checkExists(openClawMjs,  "Open_PC/openclaw.mjs (artifact output)");
  checkExists(controlUiDir, "Open_PC/dist/control-ui dir");
  checkFileNotEmpty(controlUiIndex, "Open_PC/dist/control-ui/index.html");
  checkExists(path.join(openClawDist, "index.js"), "Open_PC/dist/index.js", false);

  // ── Secondary checks: post-prepare-desktop-bundle paths (optional in CI) ────
  // These only exist after prepare-desktop-bundle.ts runs (inside the build step).
  // Warn if missing — never fail, since they don't exist at pre-build time.
  const buildDir       = path.join(desktopRoot, "build");
  const openClawPkg    = path.join(buildDir, "openclaw-package");
  const openClawDeploy = path.join(buildDir, "openclaw-deploy");
  const runtimeNodeDir = path.join(buildDir, "runtime-node");
  const defaultsFile   = path.join(buildDir, "lumina-defaults.json");

  checkExists(openClawPkg,    "openclaw-package dir (post-prepare)", false);
  checkExists(openClawDeploy, "openclaw-deploy dir (post-prepare)", false);

  const nodeExeWin  = path.join(runtimeNodeDir, "node.exe");
  const nodeExeUnix = path.join(runtimeNodeDir, "node");
  if (fs.existsSync(nodeExeWin) || fs.existsSync(nodeExeUnix)) {
    ok("bundled Node runtime binary found");
  } else {
    warn(`Bundled Node runtime not found — will be embedded during desktop build`);
  }

  if (fs.existsSync(defaultsFile)) {
    checkJsonParseable(defaultsFile, "lumina-defaults.json");
  } else {
    warn(`lumina-defaults.json not found — will be created during desktop build`);
  }
}

// ── Release artifacts check ───────────────────────────────────────────────────
// Validates the staged release directory AFTER a build, before upload.

function checkReleaseArtifacts() {
  section("Release artifacts (post-build)");

  const releaseDir = path.join(desktopRoot, "release");
  if (!fs.existsSync(releaseDir)) {
    warn(`Release directory not found: ${releaseDir} — run this after desktop:release:stage`);
    return;
  }

  const entries = fs.readdirSync(releaseDir);
  if (entries.length === 0) {
    fail(`Release directory is empty: ${releaseDir}`);
    return;
  }

  ok(`Release directory has ${entries.length} files`);

  // Must have at least one manifest
  const manifests = entries.filter((e) => e.endsWith(".json"));
  if (manifests.length === 0) {
    fail("No JSON manifests found in release directory.");
  } else {
    for (const m of manifests) {
      checkJsonParseable(path.join(releaseDir, m), `manifest ${m}`);
    }
  }

  // Must have at least one archive
  const archives = entries.filter((e) => e.endsWith(".tar.gz") || e.endsWith(".zip") || e.endsWith(".exe") || e.endsWith(".dmg") || e.endsWith(".AppImage") || e.endsWith(".deb"));
  if (archives.length === 0) {
    warn("No distributable archives found in release directory yet.");
  } else {
    ok(`${archives.length} distributable archive(s): ${archives.join(", ")}`);
    // Check none are empty
    for (const a of archives) {
      checkFileNotEmpty(path.join(releaseDir, a), a);
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const stripped = token.slice(2);
    const eqIdx = stripped.indexOf("=");
    if (eqIdx !== -1) {
      args.set(stripped.slice(0, eqIdx), stripped.slice(eqIdx + 1));
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { args.set(stripped, "true"); continue; }
    args.set(stripped, next);
    i++;
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.get("mode") ?? "all";

  process.stdout.write(`\n╔══ Lumina Desktop Pre-flight Check (mode: ${mode}) ══╗\n`);

  if (mode === "disk" || mode === "all") {
    checkDiskSpace();
  }
  if (mode === "source" || mode === "all") {
    checkSourceLayout();
  }
  if (mode === "bundle-inputs" || mode === "all") {
    checkBundleInputs();
  }
  if (mode === "release-artifacts" || mode === "all") {
    checkReleaseArtifacts();
  }

  process.stdout.write("\n");

  if (errors > 0) {
    process.stderr.write(`[preflight] FAILED — ${errors} error(s), ${warnings} warning(s).\n`);
    process.exit(1);
  }

  if (warnings > 0) {
    process.stdout.write(`[preflight] PASSED with ${warnings} warning(s).\n`);
  } else {
    process.stdout.write(`[preflight] All checks passed.\n`);
  }
}
