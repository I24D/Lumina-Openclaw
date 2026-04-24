#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  buildReleaseManifestFileName,
  computeFileByteSize,
  computeFileSha256,
  readJsonFile,
  validateBundleManifest,
  validateReleaseManifest,
  writeJsonFile,
} from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const defaultCanonicalBundleManifestPath = path.join(
  desktopRoot,
  "build",
  "runtime-bundle",
  "bundle.manifest.json",
);
const defaultReleaseRoot = path.join(desktopRoot, "release");

type GenerateReleaseManifestOptions = {
  baseUrl?: string;
  channel?: string;
  bundleManifestPath?: string;
  releaseRoot?: string;
  outputPath?: string;
  manifestId?: string;
  minBootstrapVersion?: string;
};

function log(message) {
  process.stdout.write(`[lumina-release] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[lumina-release] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
      continue;
    }
    args.set(key, next);
    index += 1;
  }
  return args;
}

function safeJoinUrl(baseUrl, relativePath) {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedRelative = relativePath.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedRelative}`;
}

function classifyArtifact(fileName) {
  if (fileName.endsWith(".artifact.json")) {
    return null;
  }
  if (fileName.endsWith(".manifest.json")) {
    return { role: "bundle-manifest", format: "json" };
  }
  if (fileName.toLowerCase().includes("portable") && fileName.endsWith(".exe")) {
    return { role: "desktop-installer", format: "portable" };
  }
  if (fileName.endsWith(".exe")) {
    return { role: "desktop-installer", format: "exe" };
  }
  if (fileName.endsWith(".msi")) {
    return { role: "desktop-installer", format: "msi" };
  }
  if (fileName.endsWith(".pkg")) {
    return { role: "desktop-installer", format: "pkg" };
  }
  if (fileName.endsWith(".dmg")) {
    return { role: "desktop-installer", format: "dmg" };
  }
  if (fileName.endsWith(".deb")) {
    return { role: "desktop-installer", format: "deb" };
  }
  if (fileName.endsWith(".rpm")) {
    return { role: "desktop-installer", format: "rpm" };
  }
  if (fileName.endsWith(".AppImage")) {
    return { role: "desktop-installer", format: "appimage" };
  }
  if (fileName.endsWith(".tar.gz")) {
    return { role: "runtime-bundle", format: "tar.gz" };
  }
  return null;
}

function stripArtifactExtension(fileName) {
  for (const suffix of [
    ".tar.gz",
    ".manifest.json",
    ".AppImage",
    ".msi",
    ".pkg",
    ".dmg",
    ".deb",
    ".rpm",
    ".exe",
    ".json",
    ".zip",
  ]) {
    if (fileName.endsWith(suffix)) {
      return fileName.slice(0, -suffix.length);
    }
  }
  const extension = path.extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function readArtifactMetadata(releaseRoot, fileName) {
  const candidates = [path.join(releaseRoot, `${fileName}.artifact.json`)];
  if (!fileName.endsWith(".manifest.json")) {
    candidates.push(path.join(releaseRoot, `${stripArtifactExtension(fileName)}.artifact.json`));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return readJsonFile(candidate);
    }
  }
  return null;
}

function buildArtifactRecord(releaseRoot, { id, role, format, relativePath, fileName, url, platform, arch, sha256 }) {
  const absolutePath = path.join(releaseRoot, relativePath);
  return {
    id,
    role,
    platform,
    arch,
    format,
    fileName,
    relativePath,
    url,
    byteSize: computeFileByteSize(absolutePath),
    sha256,
  };
}

export function generateReleaseManifest(
  options: GenerateReleaseManifestOptions = {},
) {
  const baseUrl = options.baseUrl ?? process.env.LUMINA_RELEASE_BASE_URL;
  const channel = options.channel ?? process.env.LUMINA_RELEASE_CHANNEL ?? "stable";
  const canonicalBundleManifestPath =
    options.bundleManifestPath ?? defaultCanonicalBundleManifestPath;
  const releaseRoot = options.releaseRoot ?? defaultReleaseRoot;
  const manifestId =
    options.manifestId ??
    process.env.LUMINA_RELEASE_MANIFEST_ID ??
    "lumina-openclaw-release";
  const minBootstrapVersion =
    options.minBootstrapVersion ??
    process.env.LUMINA_MIN_BOOTSTRAP_VERSION ??
    "1.0.0";

  if (!fs.existsSync(canonicalBundleManifestPath)) {
    fail(`Missing canonical bundle manifest: ${canonicalBundleManifestPath}`);
  }
  if (!fs.existsSync(releaseRoot)) {
    fail(`Missing release directory: ${releaseRoot}`);
  }

  const bundleManifest = validateBundleManifest(readJsonFile(canonicalBundleManifestPath));
  const outputPath =
    options.outputPath ??
    path.join(
      releaseRoot,
      buildReleaseManifestFileName(
        bundleManifest.bundleVersion,
        bundleManifest.platform,
        bundleManifest.arch,
      ),
    );
  const artifacts = [];
  const outputFileName = path.basename(outputPath);

  for (const dirent of fs.readdirSync(releaseRoot, { withFileTypes: true })) {
    if (!dirent.isFile()) {
      continue;
    }
    if (dirent.name === outputFileName) {
      continue;
    }

    const classification = classifyArtifact(dirent.name);
    if (!classification) {
      continue;
    }

    const relativePath = dirent.name;
    const absolutePath = path.join(releaseRoot, relativePath);
    const url = baseUrl ? safeJoinUrl(baseUrl, relativePath) : undefined;
    const metadata = readArtifactMetadata(releaseRoot, dirent.name);
    const effectiveRole = metadata?.role ?? classification.role;
    const effectiveFormat = metadata?.format ?? classification.format;
    const effectiveId =
      metadata?.artifactId ??
      (effectiveRole === "bundle-manifest"
        ? "runtime-bundle-manifest"
        : `${effectiveRole}-${bundleManifest.platform}-${bundleManifest.arch}-${dirent.name}`);
    const effectivePlatform = metadata?.platform ?? bundleManifest.platform;
    const effectiveArch = metadata?.arch ?? bundleManifest.arch;
    const effectiveSha256 = metadata?.sha256 ?? computeFileSha256(absolutePath);

    if (effectiveRole === "runtime-bundle") {
      const metadataPath = absolutePath.replace(/\.tar\.gz$/i, ".artifact.json");
      const runtimeMetadata =
        metadata ?? (fs.existsSync(metadataPath) ? readJsonFile(metadataPath) : null);
      artifacts.push({
        ...buildArtifactRecord(releaseRoot, {
          id: runtimeMetadata?.artifactId ?? "runtime-bundle",
          role: effectiveRole,
          format: effectiveFormat,
          relativePath,
          fileName: dirent.name,
          url,
          platform: effectivePlatform,
          arch: effectiveArch,
          sha256: effectiveSha256,
        }),
        bundleManifestRelativePath:
          runtimeMetadata?.bundleManifestRelativePath ??
          dirent.name.replace(/\.tar\.gz$/i, ".manifest.json"),
        bundleManifestSha256:
          runtimeMetadata?.bundleManifestSha256 ??
          computeFileSha256(path.join(releaseRoot, dirent.name.replace(/\.tar\.gz$/i, ".manifest.json"))),
      });
      continue;
    }

    if (effectiveRole === "bundle-manifest") {
      artifacts.push(
        buildArtifactRecord(releaseRoot, {
          id: effectiveId,
          role: effectiveRole,
          format: effectiveFormat,
          relativePath,
          fileName: dirent.name,
          url,
          platform: effectivePlatform,
          arch: effectiveArch,
          sha256: effectiveSha256,
        }),
      );
      continue;
    }

    artifacts.push(
      buildArtifactRecord(releaseRoot, {
        id: effectiveId,
        role: effectiveRole,
        format: effectiveFormat,
        relativePath,
        fileName: dirent.name,
        url,
        platform: effectivePlatform,
        arch: effectiveArch,
        sha256: effectiveSha256,
      }),
    );
  }

  if (artifacts.length === 0) {
    fail(`No releasable artifacts were found in ${releaseRoot}`);
  }

  artifacts.sort((left, right) => left.id.localeCompare(right.id));

  const releaseManifest = {
    $schema: "../schemas/lumina-release-manifest.schema.json",
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    manifestId,
    channel,
    version: bundleManifest.bundleVersion,
    publishedAt: new Date().toISOString(),
    product: {
      ...bundleManifest.product,
    },
    target: {
      platform: bundleManifest.platform,
      arch: bundleManifest.arch,
    },
    bundle: {
      bundleId: bundleManifest.bundleId,
      bundleVersion: bundleManifest.bundleVersion,
      minBootstrapVersion,
    },
    bootstrap: {
      strategy: "download-and-expand-runtime-bundle",
    },
    artifacts,
  };

  validateReleaseManifest(releaseManifest);
  writeJsonFile(outputPath, releaseManifest);
  log(`Wrote release manifest: ${outputPath}`);
  return releaseManifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  generateReleaseManifest({
    baseUrl: args.get("base-url"),
    channel: args.get("channel"),
    bundleManifestPath: args.get("bundle-manifest"),
    releaseRoot: args.get("release-root"),
    outputPath: args.get("output"),
    manifestId: args.get("manifest-id"),
    minBootstrapVersion: args.get("min-bootstrap-version"),
  });
}
