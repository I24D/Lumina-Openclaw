#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASH_FILE = path.join(ROOT_DIR, "src", "canvas-host", "a2ui", ".bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor", "a2ui", "renderers", "lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walk(entryPath, files) {
  const stats = await fs.stat(entryPath);
  if (stats.isDirectory()) {
    const entries = (await fs.readdir(entryPath)).sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await walk(path.join(entryPath, entry), files);
    }
    return;
  }
  files.push(entryPath);
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

async function computeHash(inputs) {
  const files = [];
  for (const input of inputs) {
    await walk(input, files);
  }

  files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const relativePath = normalizePath(path.relative(ROOT_DIR, filePath));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function run(command, args) {
  const result =
    process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", command, ...args], {
          cwd: ROOT_DIR,
          stdio: "inherit",
          env: process.env,
        })
      : spawnSync(command, args, {
          cwd: ROOT_DIR,
          stdio: "inherit",
          env: process.env,
          shell: false,
        });

  if (result.error) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 1}`);
  }
}

function bundleWithRolldown() {
  try {
    run(pnpmCmd, ["-s", "exec", "rolldown", "-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")]);
    return;
  } catch (error) {
    log(`[a2ui] pnpm exec rolldown failed, retrying with pnpm dlx: ${error.message}`);
  }

  run(pnpmCmd, ["-s", "dlx", "rolldown", "-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")]);
}

async function main() {
  const hasRendererSources = await pathExists(A2UI_RENDERER_DIR);
  const hasAppSources = await pathExists(A2UI_APP_DIR);

  if (!hasRendererSources || !hasAppSources) {
    if (await pathExists(OUTPUT_FILE)) {
      log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    fail(`A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}`);
  }

  const inputs = [
    path.join(ROOT_DIR, "package.json"),
    path.join(ROOT_DIR, "pnpm-lock.yaml"),
    A2UI_RENDERER_DIR,
    A2UI_APP_DIR,
  ];

  const currentHash = await computeHash(inputs);
  if (await pathExists(HASH_FILE) && await pathExists(OUTPUT_FILE)) {
    const previousHash = (await fs.readFile(HASH_FILE, "utf8")).trim();
    if (previousHash === currentHash) {
      log("A2UI bundle up to date; skipping.");
      return;
    }
  }

  run(pnpmCmd, ["-s", "exec", "tsc", "-p", path.join(A2UI_RENDERER_DIR, "tsconfig.json")]);
  bundleWithRolldown();
  await fs.writeFile(HASH_FILE, `${currentHash}\n`, "utf8");
}

main().catch((error) => {
  fail(`A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle\n${error.message}`);
});
