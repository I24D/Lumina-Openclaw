#!/usr/bin/env node
/**
 * openclaw-dev.mjs
 * ─────────────────────────────────────────────────────────────────
 * Windows-friendly development launcher for OpenClaw.
 *
 * Runs TypeScript source directly via `tsx` — NO BUILD STEP required.
 * Useful for Windows native development while keeping the source tree
 * intact for continued feature work.
 *
 * Usage:
 *   node openclaw-dev.mjs [openclaw-args...]
 *   run-windows.bat [openclaw-args...]      ← batch wrapper
 *   run-windows.ps1 [openclaw-args...]      ← PowerShell wrapper
 *
 * Prerequisites:
 *   pnpm install   (installs tsx and all dev dependencies)
 *
 * How it works:
 *   1. Locates the `tsx` binary in node_modules/.bin
 *   2. Spawns `tsx src/entry.ts` with the original CLI args
 *   3. Sets OPENCLAW_NO_RESPAWN=1 so the respawn mechanism
 *      does not attempt to re-launch the process without tsx
 *   4. Inherits all stdio → works exactly like the normal CLI
 * ─────────────────────────────────────────────────────────────────
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── helpers ─────────────────────────────────────────────────────

function fail(message) {
  process.stderr.write(`[openclaw-dev] ${message}\n`);
  process.exit(1);
}

function findTsxBin() {
  // Windows: node_modules\.bin\tsx.cmd  |  Unix: node_modules/.bin/tsx
  const candidates =
    process.platform === "win32"
      ? [
          path.join(__dirname, "node_modules", ".bin", "tsx.cmd"),
          path.join(__dirname, "node_modules", ".bin", "tsx"),
        ]
      : [
          path.join(__dirname, "node_modules", ".bin", "tsx"),
          path.join(__dirname, "node_modules", ".bin", "tsx.cmd"),
        ];

  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

// ── pre-flight checks ────────────────────────────────────────────

if (!fs.existsSync(path.join(__dirname, "node_modules"))) {
  fail(
    "node_modules not found.\n" +
      "         Install dependencies first:\n" +
      "           pnpm install",
  );
}

const tsxBin = findTsxBin();
if (!tsxBin) {
  fail(
    "tsx binary not found in node_modules/.bin.\n" +
      "         Install dependencies first:\n" +
      "           pnpm install",
  );
}

const entryFile = path.join(__dirname, "src", "entry.ts");
if (!fs.existsSync(entryFile)) {
  fail(`Source entry not found: ${entryFile}`);
}

// ── launch ───────────────────────────────────────────────────────

const child = spawn(tsxBin, [entryFile, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: __dirname,
  // On Windows, .cmd scripts need shell:true to execute
  shell: process.platform === "win32",
  env: {
    ...process.env,
    // Prevent the built-in respawn mechanism from re-launching the
    // process without the tsx loader (which would fail on .ts files).
    OPENCLAW_NO_RESPAWN: "1",
    // Compile cache is irrelevant when tsx transpiles at runtime.
    NODE_DISABLE_COMPILE_CACHE: "1",
  },
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exit(code ?? 1);
});

child.once("error", (err) => {
  fail(`Failed to launch tsx: ${err.message}`);
});
