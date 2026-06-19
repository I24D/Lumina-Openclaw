#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
);
const nsisRoot = path.join(desktopRoot, "src-tauri", "target", "release", "bundle", "nsis");
const releaseRoot = path.join(desktopRoot, "release");

if (process.platform !== "win32") {
  throw new Error("The Windows installer can only be staged on Windows.");
}
if (!fs.existsSync(nsisRoot)) {
  throw new Error(`NSIS output directory is missing: ${nsisRoot}`);
}

const candidates = fs
  .readdirSync(nsisRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /setup\.exe$/i.test(entry.name))
  .map((entry) => {
    const absolutePath = path.join(nsisRoot, entry.name);
    return { absolutePath, mtimeMs: fs.statSync(absolutePath).mtimeMs };
  })
  .sort((left, right) => right.mtimeMs - left.mtimeMs);

if (candidates.length === 0) {
  throw new Error(`No NSIS setup.exe was found in ${nsisRoot}`);
}

const sourcePath = candidates[0].absolutePath;
if (!path.basename(sourcePath).includes(packageJson.version)) {
  throw new Error(
    `Newest NSIS installer does not match version ${packageJson.version}: ${sourcePath}`,
  );
}
const outputName = `Lumina.OpenClaw_${packageJson.version}_x64-setup.exe`;
const outputPath = path.join(releaseRoot, outputName);
fs.mkdirSync(releaseRoot, { recursive: true });
fs.copyFileSync(sourcePath, outputPath);

const sha256 = crypto.createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
fs.writeFileSync(`${outputPath}.sha256`, `${sha256}  ${outputName}\n`, "utf8");
process.stdout.write(`[lumina-installer] Staged ${outputPath}\n`);
process.stdout.write(`[lumina-installer] SHA256 ${sha256}\n`);
