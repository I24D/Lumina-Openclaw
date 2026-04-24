#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeDirectoryDigest,
  computeFileSha256,
  readJsonFile,
  resolveReleaseManifestPath,
  validateBundleManifest,
  validateReleaseManifest,
} from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const defaultCanonicalBundleRoot = path.join(desktopRoot, "build", "runtime-bundle");
const defaultCanonicalBundleManifestPath = path.join(
  defaultCanonicalBundleRoot,
  "bundle.manifest.json",
);
const defaultReleaseRoot = path.join(desktopRoot, "release");

type ValidateReleaseContractOptions = {
  bundleOnly?: boolean;
  canonicalBundleRoot?: string;
  bundleManifestPath?: string;
  releaseRoot?: string;
  releaseManifestPath?: string;
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

function computePathDigest(targetPath) {
  const stats = fs.statSync(targetPath);
  if (stats.isDirectory()) {
    return computeDirectoryDigest(targetPath);
  }
  return {
    byteSize: stats.size,
    fileCount: 1,
    sha256: computeFileSha256(targetPath),
  };
}

function validateBundlePayload(canonicalBundleRoot, bundleManifest) {
  const entryIds = new Set();
  for (const entry of bundleManifest.entries) {
    if (entryIds.has(entry.id)) {
      fail(`Duplicate bundle entry id during payload validation: ${entry.id}`);
    }
    entryIds.add(entry.id);

    const absolutePath = path.join(canonicalBundleRoot, entry.bundleRelativePath);
    if (!fs.existsSync(absolutePath)) {
      fail(`Bundle entry is missing from the canonical bundle: ${absolutePath}`);
    }

    const stats = fs.statSync(absolutePath);
    const expectedLayout = stats.isDirectory() ? "directory" : "file";
    if (expectedLayout !== entry.layout) {
      fail(
        `Bundle entry "${entry.id}" layout mismatch: manifest=${entry.layout}, actual=${expectedLayout}.`,
      );
    }

    const digest = computePathDigest(absolutePath);
    if (digest.byteSize !== entry.byteSize) {
      fail(
        `Bundle entry "${entry.id}" byteSize mismatch: manifest=${entry.byteSize}, actual=${digest.byteSize}.`,
      );
    }
    if (digest.fileCount !== entry.fileCount) {
      fail(
        `Bundle entry "${entry.id}" fileCount mismatch: manifest=${entry.fileCount}, actual=${digest.fileCount}.`,
      );
    }
    if (digest.sha256 !== entry.sha256) {
      fail(`Bundle entry "${entry.id}" sha256 mismatch.`);
    }
  }
}

function validateReleaseArtifacts(releaseRoot, releaseManifest) {
  const seenIds = new Set();

  for (const artifact of releaseManifest.artifacts) {
    if (seenIds.has(artifact.id)) {
      fail(`Duplicate release artifact id during payload validation: ${artifact.id}`);
    }
    seenIds.add(artifact.id);

    const absolutePath = path.join(releaseRoot, artifact.relativePath);
    if (!fs.existsSync(absolutePath)) {
      fail(`Release artifact is missing from disk: ${absolutePath}`);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.size !== artifact.byteSize) {
      fail(
        `Release artifact "${artifact.id}" byteSize mismatch: manifest=${artifact.byteSize}, actual=${stats.size}.`,
      );
    }

    const sha256 = computeFileSha256(absolutePath);
    if (sha256 !== artifact.sha256) {
      fail(`Release artifact "${artifact.id}" sha256 mismatch.`);
    }

    if (artifact.bundleManifestRelativePath) {
      const bundleManifestArtifactPath = path.join(releaseRoot, artifact.bundleManifestRelativePath);
      if (!fs.existsSync(bundleManifestArtifactPath)) {
        fail(
          `Release artifact "${artifact.id}" points to a missing bundle manifest: ${bundleManifestArtifactPath}`,
        );
      }
      if (artifact.bundleManifestSha256) {
        const bundleManifestSha256 = computeFileSha256(bundleManifestArtifactPath);
        if (bundleManifestSha256 !== artifact.bundleManifestSha256) {
          fail(`Release artifact "${artifact.id}" bundleManifestSha256 mismatch.`);
        }
      }
    }
  }
}

export function validateReleaseContract(
  options: ValidateReleaseContractOptions = {},
) {
  const bundleOnly = options.bundleOnly ?? false;
  const canonicalBundleRoot =
    options.canonicalBundleRoot ?? defaultCanonicalBundleRoot;
  const canonicalBundleManifestPath =
    options.bundleManifestPath ??
    path.join(canonicalBundleRoot, "bundle.manifest.json");
  const releaseRoot = options.releaseRoot ?? defaultReleaseRoot;
  const releaseManifestPath = resolveReleaseManifestPath(
    releaseRoot,
    options.releaseManifestPath,
  );

  if (!fs.existsSync(canonicalBundleManifestPath)) {
    fail(`Missing canonical bundle manifest: ${canonicalBundleManifestPath}`);
  }

  const bundleManifest = validateBundleManifest(readJsonFile(canonicalBundleManifestPath));
  validateBundlePayload(canonicalBundleRoot, bundleManifest);
  log("Bundle manifest structure and payload digests are valid.");

  if (bundleOnly) {
    return { bundleManifest, releaseManifest: null };
  }

  if (!fs.existsSync(releaseManifestPath)) {
    fail(`Missing release manifest: ${releaseManifestPath}`);
  }

  const releaseManifest = validateReleaseManifest(readJsonFile(releaseManifestPath));
  if (releaseManifest.bundle.bundleId !== bundleManifest.bundleId) {
    fail("Release manifest bundle.bundleId does not match the canonical bundle manifest.");
  }
  if (releaseManifest.bundle.bundleVersion !== bundleManifest.bundleVersion) {
    fail("Release manifest bundle.bundleVersion does not match the canonical bundle manifest.");
  }
  if (releaseManifest.target.platform !== bundleManifest.platform) {
    fail("Release manifest target.platform does not match the canonical bundle manifest.");
  }
  if (releaseManifest.target.arch !== bundleManifest.arch) {
    fail("Release manifest target.arch does not match the canonical bundle manifest.");
  }

  validateReleaseArtifacts(releaseRoot, releaseManifest);
  log("Release manifest structure and artifact digests are valid.");
  return { bundleManifest, releaseManifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  validateReleaseContract({
    bundleOnly: args.get("bundle-only") === "true",
    canonicalBundleRoot: args.get("canonical-bundle-root"),
    bundleManifestPath: args.get("bundle-manifest"),
    releaseRoot: args.get("release-root"),
    releaseManifestPath: args.get("release-manifest"),
  });
}
