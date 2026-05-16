import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUNDLE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const PUBLISHED_RELEASE_MANIFEST_FILE_NAME = "lumina-release.manifest.json";

const SUPPORTED_CHANNELS = new Set(["stable", "beta", "nightly"]);
const SUPPORTED_BUNDLE_KINDS = new Set(["desktop-runtime"]);
const SUPPORTED_ENTRY_KINDS = new Set(["config", "runtime", "service", "content", "ui"]);
const SUPPORTED_LAYOUTS = new Set(["file", "directory"]);
const SUPPORTED_COPY_MODES = new Set(["merge-contents-of-payload-root"]);
const SUPPORTED_LAUNCH_STRATEGIES = new Set(["desktop-runtime-bundle"]);
const SUPPORTED_BOOTSTRAP_STRATEGIES = new Set(["download-and-expand-runtime-bundle"]);
const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const SUPPORTED_ROLES = new Set([
  "runtime-bundle",
  "bundle-manifest",
  "desktop-installer",
  "bootstrap-installer",
]);
const SUPPORTED_FORMATS = new Set([
  "tar.gz",
  "zip",
  "exe",
  "msi",
  "pkg",
  "dmg",
  "deb",
  "rpm",
  "appimage",
  "portable",
  "directory",
  "json",
]);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`[lumina-release] ${message}`);
}

export function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

export function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function writeJsonFile(targetPath, payload) {
  ensureDirectory(path.dirname(targetPath));
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function readJsonFile(targetPath) {
  return JSON.parse(fs.readFileSync(targetPath, "utf8").replace(/^\uFEFF/, ""));
}

export function computeFileSha256(targetPath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(targetPath));
  return hash.digest("hex");
}

export function computeFileByteSize(targetPath) {
  return fs.statSync(targetPath).size;
}

function compareStablePathStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sanitizeFileNameSegment(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function buildReleaseManifestFileName(version, platform, arch) {
  return `lumina-release-${sanitizeFileNameSegment(version)}-${sanitizeFileNameSegment(
    platform,
  )}-${sanitizeFileNameSegment(arch)}.manifest.json`;
}

export function resolveReleaseManifestPath(releaseRoot, explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  const legacyPath = path.join(releaseRoot, PUBLISHED_RELEASE_MANIFEST_FILE_NAME);
  const candidateNames = fs.existsSync(releaseRoot)
    ? fs
        .readdirSync(releaseRoot, { withFileTypes: true })
        .filter(
          (dirent) =>
            dirent.isFile() &&
            dirent.name.startsWith("lumina-release-") &&
            dirent.name.endsWith(".manifest.json"),
        )
        .map((dirent) => dirent.name)
        .sort((left, right) => left.localeCompare(right))
    : [];

  if (candidateNames.length === 1) {
    return path.join(releaseRoot, candidateNames[0]);
  }

  if (candidateNames.length === 0 && fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  if (candidateNames.length === 0) {
    return legacyPath;
  }

  fail(
    `Multiple target-specific release manifests were found in ${releaseRoot}. Pass --release-manifest explicitly.`,
  );
}

function walkDirectory(rootPath, currentPath, files) {
  const dirEntries = fs.readdirSync(currentPath, { withFileTypes: true })
    .slice()
    .sort((left, right) => compareStablePathStrings(left.name, right.name));

  for (const dirEntry of dirEntries) {
    const absolutePath = path.join(currentPath, dirEntry.name);
    const relativePath = toPosixPath(path.relative(rootPath, absolutePath));

    if (dirEntry.isSymbolicLink()) {
      fail(`Bundle payloads must not contain symbolic links: ${absolutePath}`);
    }

    if (dirEntry.isDirectory()) {
      walkDirectory(rootPath, absolutePath, files);
      continue;
    }

    if (!dirEntry.isFile()) {
      fail(`Unsupported payload entry type in bundle: ${absolutePath}`);
    }

    files.push({
      relativePath,
      byteSize: fs.statSync(absolutePath).size,
    });
  }
}

export function computeDirectoryDigest(rootPath) {
  const files = [];
  walkDirectory(rootPath, rootPath, files);
  files.sort((left, right) => compareStablePathStrings(left.relativePath, right.relativePath));

  // Directory entries can contain very large dependency trees. We keep the
  // release artifact itself content-addressed and use a structural digest here
  // so bundle-manifest generation and validation stay fast in CI.
  const digest = crypto.createHash("sha256");
  let byteSize = 0;
  for (const file of files) {
    digest.update("file\0");
    digest.update(file.relativePath);
    digest.update("\0");
    digest.update(String(file.byteSize));
    digest.update("\0");
    byteSize += file.byteSize;
  }

  return {
    byteSize,
    fileCount: files.length,
    sha256: digest.digest("hex"),
  };
}

export function normalizeRelativePath(rawPath, label) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    fail(`${label} must be a non-empty relative path.`);
  }

  const normalized = toPosixPath(rawPath.trim());
  if (normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../")) {
    fail(`${label} must stay inside the bundle root: ${rawPath}`);
  }

  if (normalized === "." || normalized === "..") {
    fail(`${label} must not resolve to the bundle root: ${rawPath}`);
  }

  return normalized;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer.`);
  }
}

function assertStrictlyPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer.`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean.`);
  }
}

function assertSha256(value, label) {
  assertNonEmptyString(value, label);
  if (!SHA256_HEX_PATTERN.test(value)) {
    fail(`${label} must be a 64-character lowercase sha256 hex string.`);
  }
}

function assertTimestamp(value, label) {
  assertNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(value))) {
    fail(`${label} must be a valid ISO-8601 timestamp.`);
  }
}

function pathContainsPath(parentPath, childPath) {
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

function requireLaunchTargetInsideEntries(entries, targetPath, label) {
  const matches = entries.some((entry) =>
    pathContainsPath(entry.installRelativePath, targetPath),
  );
  if (!matches) {
    fail(`${label} must resolve inside one of the bundle entries: ${targetPath}`);
  }
}

export function createBundleEntry({
  id,
  kind,
  bundleRelativePath,
  installRelativePath,
  sourcePath,
  required = true,
  executable = false,
}) {
  assertNonEmptyString(id, "bundle entry id");
  if (!SUPPORTED_ENTRY_KINDS.has(kind)) {
    fail(`Unsupported bundle entry kind "${kind}" for "${id}".`);
  }

  const normalizedBundlePath = normalizeRelativePath(bundleRelativePath, `${id} bundleRelativePath`);
  const normalizedInstallPath = normalizeRelativePath(installRelativePath, `${id} installRelativePath`);
  if (!fs.existsSync(sourcePath)) {
    fail(`Missing bundle entry source for "${id}": ${sourcePath}`);
  }

  const stats = fs.statSync(sourcePath);
  const layout = stats.isDirectory() ? "directory" : "file";

  if (!SUPPORTED_LAYOUTS.has(layout)) {
    fail(`Unsupported bundle entry layout "${layout}" for "${id}".`);
  }

  const digest = stats.isDirectory()
    ? computeDirectoryDigest(sourcePath)
    : {
        byteSize: stats.size,
        fileCount: 1,
        sha256: computeFileSha256(sourcePath),
      };

  return {
    id,
    kind,
    layout,
    bundleRelativePath: normalizedBundlePath,
    installRelativePath: normalizedInstallPath,
    required,
    executable,
    byteSize: digest.byteSize,
    fileCount: digest.fileCount,
    sha256: digest.sha256,
  };
}

function validateCommonHeader(manifest, version, label) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`${label} must be a JSON object.`);
  }
  if (manifest.schemaVersion !== version) {
    fail(`${label} schemaVersion must equal ${version}.`);
  }
}

export function validateBundleManifest(manifest) {
  validateCommonHeader(manifest, BUNDLE_MANIFEST_SCHEMA_VERSION, "bundle manifest");

  assertNonEmptyString(manifest.bundleId, "bundle manifest bundleId");
  assertNonEmptyString(manifest.bundleVersion, "bundle manifest bundleVersion");
  assertTimestamp(manifest.createdAt, "bundle manifest createdAt");

  if (!SUPPORTED_CHANNELS.has(manifest.channel)) {
    fail(`Unsupported bundle channel "${manifest.channel}".`);
  }
  if (!SUPPORTED_BUNDLE_KINDS.has(manifest.bundleKind)) {
    fail(`Unsupported bundle kind "${manifest.bundleKind}".`);
  }
  if (!SUPPORTED_PLATFORMS.has(manifest.platform)) {
    fail(`Unsupported bundle platform "${manifest.platform}".`);
  }

  assertNonEmptyString(manifest.platform, "bundle manifest platform");
  assertNonEmptyString(manifest.arch, "bundle manifest arch");

  const product = manifest.product ?? {};
  assertNonEmptyString(product.appId, "bundle manifest product.appId");
  assertNonEmptyString(product.productName, "bundle manifest product.productName");
  assertNonEmptyString(product.vendor, "bundle manifest product.vendor");

  const source = manifest.source ?? {};
  assertNonEmptyString(source.desktopPackageName, "bundle manifest source.desktopPackageName");
  assertNonEmptyString(source.desktopPackageVersion, "bundle manifest source.desktopPackageVersion");
  assertNonEmptyString(source.openClawPackageName, "bundle manifest source.openClawPackageName");
  assertNonEmptyString(source.openClawVersion, "bundle manifest source.openClawVersion");
  assertNonEmptyString(source.hostNodeVersion, "bundle manifest source.hostNodeVersion");
  assertSha256(source.lockfileSha256, "bundle manifest source.lockfileSha256");

  const install = manifest.install ?? {};
  install.payloadRoot = normalizeRelativePath(
    install.payloadRoot,
    "bundle manifest install.payloadRoot",
  );
  if (!SUPPORTED_COPY_MODES.has(install.copyMode)) {
    fail(`Unsupported bundle install copyMode "${install.copyMode}".`);
  }
  if (!SUPPORTED_LAUNCH_STRATEGIES.has(install.launchStrategy)) {
    fail(`Unsupported bundle install launchStrategy "${install.launchStrategy}".`);
  }

  const launch = manifest.launch ?? {};
  for (const key of ["defaultsFile", "nodeExecutable", "openClawEntry", "uiIndex", "proxyEntry"]) {
    launch[key] = normalizeRelativePath(launch[key], `bundle manifest launch.${key}`);
  }

  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail("bundle manifest entries must be a non-empty array.");
  }

  const seenIds = new Set();
  const seenInstallPaths = new Set();
  const seenBundlePaths = new Set();
  for (const entry of manifest.entries) {
    assertNonEmptyString(entry.id, "bundle manifest entry id");
    if (seenIds.has(entry.id)) {
      fail(`Duplicate bundle entry id "${entry.id}".`);
    }
    seenIds.add(entry.id);

    if (!SUPPORTED_ENTRY_KINDS.has(entry.kind)) {
      fail(`Unsupported bundle entry kind "${entry.kind}".`);
    }
    if (!SUPPORTED_LAYOUTS.has(entry.layout)) {
      fail(`Unsupported bundle entry layout "${entry.layout}".`);
    }

    const bundleRelativePath = normalizeRelativePath(
      entry.bundleRelativePath,
      `bundle manifest entry "${entry.id}" bundleRelativePath`,
    );
    if (seenBundlePaths.has(bundleRelativePath)) {
      fail(`Duplicate bundle path "${bundleRelativePath}".`);
    }
    seenBundlePaths.add(bundleRelativePath);
    if (!pathContainsPath(install.payloadRoot, bundleRelativePath)) {
      fail(
        `Bundle entry "${entry.id}" must live under install.payloadRoot "${install.payloadRoot}": ${bundleRelativePath}`,
      );
    }

    const installRelativePath = normalizeRelativePath(
      entry.installRelativePath,
      `bundle manifest entry "${entry.id}" installRelativePath`,
    );
    if (seenInstallPaths.has(installRelativePath)) {
      fail(`Duplicate bundle install path "${installRelativePath}".`);
    }
    seenInstallPaths.add(installRelativePath);

    assertBoolean(entry.required, `bundle manifest entry "${entry.id}" required`);
    assertBoolean(entry.executable, `bundle manifest entry "${entry.id}" executable`);
    assertPositiveInteger(entry.byteSize, `bundle manifest entry "${entry.id}" byteSize`);
    assertStrictlyPositiveInteger(entry.fileCount, `bundle manifest entry "${entry.id}" fileCount`);
    assertSha256(entry.sha256, `bundle manifest entry "${entry.id}" sha256`);

    entry.bundleRelativePath = bundleRelativePath;
    entry.installRelativePath = installRelativePath;
  }

  requireLaunchTargetInsideEntries(
    manifest.entries,
    launch.defaultsFile,
    "bundle manifest launch.defaultsFile",
  );
  requireLaunchTargetInsideEntries(
    manifest.entries,
    launch.nodeExecutable,
    "bundle manifest launch.nodeExecutable",
  );
  requireLaunchTargetInsideEntries(
    manifest.entries,
    launch.openClawEntry,
    "bundle manifest launch.openClawEntry",
  );
  requireLaunchTargetInsideEntries(
    manifest.entries,
    launch.uiIndex,
    "bundle manifest launch.uiIndex",
  );
  requireLaunchTargetInsideEntries(
    manifest.entries,
    launch.proxyEntry,
    "bundle manifest launch.proxyEntry",
  );

  return manifest;
}

export function validateReleaseManifest(manifest) {
  validateCommonHeader(manifest, RELEASE_MANIFEST_SCHEMA_VERSION, "release manifest");

  assertNonEmptyString(manifest.manifestId, "release manifest manifestId");
  assertNonEmptyString(manifest.version, "release manifest version");
  assertTimestamp(manifest.publishedAt, "release manifest publishedAt");

  if (!SUPPORTED_CHANNELS.has(manifest.channel)) {
    fail(`Unsupported release channel "${manifest.channel}".`);
  }

  const product = manifest.product ?? {};
  assertNonEmptyString(product.appId, "release manifest product.appId");
  assertNonEmptyString(product.productName, "release manifest product.productName");
  assertNonEmptyString(product.vendor, "release manifest product.vendor");

  const target = manifest.target ?? {};
  if (!SUPPORTED_PLATFORMS.has(target.platform)) {
    fail(`Unsupported release target platform "${target.platform}".`);
  }
  assertNonEmptyString(target.arch, "release manifest target.arch");

  const bundle = manifest.bundle ?? {};
  assertNonEmptyString(bundle.bundleId, "release manifest bundle.bundleId");
  assertNonEmptyString(bundle.bundleVersion, "release manifest bundle.bundleVersion");
  assertNonEmptyString(bundle.minBootstrapVersion, "release manifest bundle.minBootstrapVersion");

  const bootstrap = manifest.bootstrap ?? {};
  if (!SUPPORTED_BOOTSTRAP_STRATEGIES.has(bootstrap.strategy)) {
    fail(`Unsupported release bootstrap strategy "${bootstrap.strategy}".`);
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail("release manifest artifacts must be a non-empty array.");
  }

  const seenIds = new Set();
  let runtimeBundleCount = 0;
  let bundleManifestCount = 0;
  let desktopInstallerCount = 0;
  for (const artifact of manifest.artifacts) {
    assertNonEmptyString(artifact.id, "release manifest artifact id");
    if (seenIds.has(artifact.id)) {
      fail(`Duplicate release artifact id "${artifact.id}".`);
    }
    seenIds.add(artifact.id);

    if (!SUPPORTED_ROLES.has(artifact.role)) {
      fail(`Unsupported release artifact role "${artifact.role}".`);
    }
    if (!SUPPORTED_FORMATS.has(artifact.format)) {
      fail(`Unsupported release artifact format "${artifact.format}".`);
    }
    if (!SUPPORTED_PLATFORMS.has(artifact.platform)) {
      fail(`Unsupported release artifact platform "${artifact.platform}".`);
    }

    assertNonEmptyString(artifact.platform, `release artifact "${artifact.id}" platform`);
    assertNonEmptyString(artifact.arch, `release artifact "${artifact.id}" arch`);
    assertNonEmptyString(artifact.fileName, `release artifact "${artifact.id}" fileName`);
    normalizeRelativePath(artifact.relativePath, `release artifact "${artifact.id}" relativePath`);
    assertPositiveInteger(artifact.byteSize, `release artifact "${artifact.id}" byteSize`);
    assertSha256(artifact.sha256, `release artifact "${artifact.id}" sha256`);

    if (artifact.platform !== target.platform || artifact.arch !== target.arch) {
      fail(
        `Release artifact "${artifact.id}" target mismatch: expected ${target.platform}/${target.arch}, got ${artifact.platform}/${artifact.arch}.`,
      );
    }

    if (artifact.url !== undefined) {
      assertNonEmptyString(artifact.url, `release artifact "${artifact.id}" url`);
    }
    if (artifact.bundleManifestSha256 !== undefined) {
      assertSha256(
        artifact.bundleManifestSha256,
        `release artifact "${artifact.id}" bundleManifestSha256`,
      );
    }
    if (artifact.bundleManifestRelativePath !== undefined) {
      artifact.bundleManifestRelativePath = normalizeRelativePath(
        artifact.bundleManifestRelativePath,
        `release artifact "${artifact.id}" bundleManifestRelativePath`,
      );
    }
    if (artifact.role === "runtime-bundle") {
      runtimeBundleCount += 1;
      if (artifact.bundleManifestRelativePath === undefined) {
        fail(
          `Release artifact "${artifact.id}" must declare bundleManifestRelativePath because it is a runtime-bundle.`,
        );
      }
      if (artifact.bundleManifestSha256 === undefined) {
        fail(
          `Release artifact "${artifact.id}" must declare bundleManifestSha256 because it is a runtime-bundle.`,
        );
      }
    }
    if (artifact.role === "bundle-manifest") {
      bundleManifestCount += 1;
    }
    if (artifact.role === "desktop-installer") {
      desktopInstallerCount += 1;
    }
  }

  if (runtimeBundleCount === 0) {
    fail("release manifest must contain at least one runtime-bundle artifact.");
  }
  if (bundleManifestCount === 0) {
    fail("release manifest must contain at least one bundle-manifest artifact.");
  }
  if (desktopInstallerCount === 0) {
    fail("release manifest must contain at least one desktop-installer artifact.");
  }

  return manifest;
}
