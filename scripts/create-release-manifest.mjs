#!/usr/bin/env node
/**
 * create-release-manifest.mjs
 *
 * Generates the release-manifest JSON needed for GitHub Releases.
 * Run AFTER packing the runtime bundle:
 *
 *   node scripts/create-release-manifest.mjs \
 *     --bundle openclaw-runtime-1.0.5-win32-x64.tar.gz \
 *     --bundle-manifest bundle.manifest.json \
 *     --version 1.0.5 \
 *     --platform win32 \
 *     --arch x64 \
 *     --release-tag runtime-1.0.5 \
 *     --repo I24D/Lumina-I24D
 *
 * Output: release-manifest-win32-x64.json  (upload this to GitHub Releases too)
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    bundle: { type: "string" },
    "bundle-manifest": { type: "string" },
    version: { type: "string" },
    platform: { type: "string", default: "win32" },
    arch: { type: "string", default: "x64" },
    "release-tag": { type: "string" },
    repo: { type: "string" },
    channel: { type: "string", default: "stable" },
    output: { type: "string" },
  },
  strict: true,
});

function required(key) {
  if (!values[key]) {
    console.error(`Missing required argument: --${key}`);
    process.exit(1);
  }
  return values[key];
}

function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function byteSize(filePath) {
  return statSync(filePath).size;
}

const bundlePath = required("bundle");
const bundleManifestPath = required("bundle-manifest");
const version = required("version");
const platform = values["platform"];
const arch = values["arch"];
const releaseTag = required("release-tag");
const repo = required("repo");
const channel = values["channel"];

const bundleFileName = basename(bundlePath);
const bundleManifestFileName = basename(bundleManifestPath);
const baseUrl = `https://github.com/${repo}/releases/download/${releaseTag}`;
const outputFile = values["output"] ?? `release-manifest-${platform}-${arch}.json`;

console.log(`Computing SHA-256 for ${bundleFileName}...`);
const bundleSha256 = sha256(bundlePath);
const bundleBytes = byteSize(bundlePath);

console.log(`Computing SHA-256 for ${bundleManifestFileName}...`);
const manifestSha256 = sha256(bundleManifestPath);
const manifestBytes = byteSize(bundleManifestPath);

const releaseManifest = {
  schemaVersion: 1,
  manifestId: `lumina-openclaw-desktop-${version}-${platform}-${arch}`,
  channel,
  version,
  publishedAt: new Date().toISOString(),
  product: {
    appId: "ai.lumina.desktop",
    productName: "Lumina OpenClaw",
    vendor: "I24D",
  },
  target: { platform, arch },
  bundle: {
    bundleId: "lumina-openclaw-desktop",
    bundleVersion: version,
    minBootstrapVersion: "1.0.0",
  },
  bootstrap: {
    strategy: "download-and-expand-runtime-bundle",
  },
  artifacts: [
    {
      id: "runtime-bundle",
      role: "runtime-bundle",
      platform,
      arch,
      format: "tar.gz",
      fileName: bundleFileName,
      relativePath: bundleFileName,
      url: `${baseUrl}/${bundleFileName}`,
      byteSize: bundleBytes,
      sha256: bundleSha256,
      bundleManifestSha256: manifestSha256,
      bundleManifestRelativePath: bundleManifestFileName,
    },
    {
      id: "bundle-manifest",
      role: "bundle-manifest",
      platform,
      arch,
      format: "json",
      fileName: bundleManifestFileName,
      relativePath: bundleManifestFileName,
      url: `${baseUrl}/${bundleManifestFileName}`,
      byteSize: manifestBytes,
      sha256: manifestSha256,
    },
  ],
};

writeFileSync(outputFile, JSON.stringify(releaseManifest, null, 2) + "\n", "utf8");

console.log(`\nRelease manifest written to: ${outputFile}`);
console.log(`\nUpload these files to GitHub Release "${releaseTag}":`);
console.log(`  - ${bundleFileName}`);
console.log(`  - ${bundleManifestFileName}`);
console.log(`  - ${outputFile}`);
console.log(`\nThen set runtimeReleaseManifestUrl in render-preset.json to:`);
console.log(`  ${baseUrl}/${outputFile}`);
