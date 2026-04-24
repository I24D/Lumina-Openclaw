#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PUBLISHED_RELEASE_MANIFEST_FILE_NAME,
  readJsonFile,
  resolveReleaseManifestPath,
  validateReleaseManifest,
  writeJsonFile,
} from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const defaultReleaseRoot = path.join(desktopRoot, "release");
const defaultPublishRoot = path.join(defaultReleaseRoot, "publish");

type PublishReleaseArtifactsOptions = {
  releaseRoot?: string;
  releaseManifestPath?: string;
  publishRoot?: string;
  baseUrl?: string | null;
};

function log(message) {
  process.stdout.write(`[lumina-publish] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[lumina-publish] ${message}\n`);
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

function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

function copyReleaseFiles(sourceRoot, targetRoot, artifactPaths) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });

  for (const relativePath of artifactPaths) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(sourcePath)) {
      fail(`Missing release artifact during publish: ${sourcePath}`);
    }
    const targetPath = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function createPublishedManifest(releaseManifest, versionedUrlRoot) {
  if (!versionedUrlRoot) {
    return JSON.parse(JSON.stringify(releaseManifest));
  }

  return {
    ...JSON.parse(JSON.stringify(releaseManifest)),
    artifacts: releaseManifest.artifacts.map((artifact) => ({
      ...artifact,
      url: safeJoinUrl(versionedUrlRoot, artifact.relativePath),
    })),
  };
}

export function publishReleaseArtifacts(
  options: PublishReleaseArtifactsOptions = {},
) {
  const releaseRoot = options.releaseRoot ?? defaultReleaseRoot;
  const releaseManifestPath = resolveReleaseManifestPath(
    releaseRoot,
    options.releaseManifestPath,
  );
  const publishRoot = options.publishRoot ?? defaultPublishRoot;
  const baseUrl = options.baseUrl ?? null;

  if (!fs.existsSync(releaseManifestPath)) {
    fail(`Missing release manifest: ${releaseManifestPath}`);
  }

  const releaseManifest = validateReleaseManifest(readJsonFile(releaseManifestPath));
  const { channel, version, publishedAt, target } = releaseManifest;
  const { platform, arch } = target;
  const manifestFileName = PUBLISHED_RELEASE_MANIFEST_FILE_NAME;
  const versionedRelativeRoot = toPosixPath(
    path.join("versions", channel, platform, arch, version),
  );
  const channelRelativeRoot = toPosixPath(
    path.join("channels", channel, platform, arch),
  );
  const versionedRoot = path.join(publishRoot, "versions", channel, platform, arch, version);
  const channelRoot = path.join(publishRoot, "channels", channel, platform, arch);
  const artifactPaths = releaseManifest.artifacts.map((artifact) => artifact.relativePath);
  const publishedManifest = createPublishedManifest(
    releaseManifest,
    baseUrl ? safeJoinUrl(baseUrl, versionedRelativeRoot) : null,
  );
  validateReleaseManifest(publishedManifest);

  copyReleaseFiles(releaseRoot, versionedRoot, artifactPaths);
  copyReleaseFiles(releaseRoot, channelRoot, artifactPaths);

  writeJsonFile(path.join(versionedRoot, manifestFileName), publishedManifest);
  writeJsonFile(path.join(channelRoot, manifestFileName), publishedManifest);

  const channelIndex = {
    channel,
    platform,
    arch,
    version,
    publishedAt,
    manifestFileName,
    manifestRelativePath: `${channelRelativeRoot}/${manifestFileName}`,
    versionedManifestRelativePath: `${versionedRelativeRoot}/${manifestFileName}`,
    manifestUrl: baseUrl
      ? safeJoinUrl(baseUrl, `${channelRelativeRoot}/${manifestFileName}`)
      : undefined,
    versionedManifestUrl: baseUrl
      ? safeJoinUrl(baseUrl, `${versionedRelativeRoot}/${manifestFileName}`)
      : undefined,
  };
  writeJsonFile(path.join(channelRoot, "index.json"), channelIndex);

  log(`Published ${channel}/${platform}/${arch} release to ${channelRoot}`);
  return {
    releaseManifest: publishedManifest,
    versionedRoot,
    channelRoot,
    channelIndex,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  publishReleaseArtifacts({
    releaseRoot: args.get("release-root"),
    releaseManifestPath: args.get("release-manifest"),
    publishRoot: args.get("publish-root"),
    baseUrl: args.get("base-url"),
  });
}
