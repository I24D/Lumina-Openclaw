import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReleaseManifestFileName,
  computeFileByteSize,
  computeFileSha256,
  createBundleEntry,
  validateBundleManifest,
  validateReleaseManifest,
  writeJsonFile,
} from "../scripts/lumina-bundle-lib.ts";
import { generateReleaseManifest } from "../scripts/generate-release-manifest.ts";
import { publishReleaseArtifacts } from "../scripts/publish-release-artifacts.ts";
import { validateReleaseContract } from "../scripts/validate-release-contract.ts";

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-bundle-contract-"));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildValidBundleManifest(tempDir) {
  const configPath = path.join(tempDir, "payload", "config", "lumina-defaults.json");
  const runtimePath = path.join(tempDir, "payload", "node", "node.exe");
  const openClawPath = path.join(tempDir, "payload", "openclaw", "openclaw.mjs");
  const uiPath = path.join(tempDir, "payload", "ui", "index.html");
  const proxyPath = path.join(tempDir, "payload", "proxy", "server.mjs");

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.mkdirSync(path.dirname(openClawPath), { recursive: true });
  fs.mkdirSync(path.dirname(uiPath), { recursive: true });
  fs.mkdirSync(path.dirname(proxyPath), { recursive: true });

  fs.writeFileSync(configPath, "{}\n", "utf8");
  fs.writeFileSync(runtimePath, "node runtime\n", "utf8");
  fs.writeFileSync(openClawPath, "export {};\n", "utf8");
  fs.writeFileSync(uiPath, "<html></html>\n", "utf8");
  fs.writeFileSync(proxyPath, "export {};\n", "utf8");

  return {
    $schema: "../../schemas/lumina-desktop-bundle.schema.json",
    schemaVersion: 1,
    bundleId: "lumina-openclaw-desktop",
    bundleKind: "desktop-runtime",
    bundleVersion: "1.2.3",
    createdAt: "2026-04-21T00:00:00.000Z",
    channel: "stable",
    platform: "win32",
    arch: "x64",
    product: {
      appId: "ai.lumina.desktop",
      productName: "Lumina OpenClaw",
      vendor: "I24D",
    },
    source: {
      desktopPackageName: "@lumina/desktop",
      desktopPackageVersion: "1.2.3",
      openClawPackageName: "openclaw",
      openClawVersion: "0.1.0",
      hostNodeVersion: "24.13.1",
      lockfileSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    install: {
      payloadRoot: "payload",
      copyMode: "merge-contents-of-payload-root",
      launchStrategy: "desktop-runtime-bundle",
    },
    launch: {
      defaultsFile: "config/lumina-defaults.json",
      nodeExecutable: "node/node.exe",
      openClawEntry: "openclaw/openclaw.mjs",
      uiIndex: "ui/index.html",
      proxyEntry: "proxy/server.mjs",
    },
    entries: [
      createBundleEntry({
        id: "defaults",
        kind: "config",
        bundleRelativePath: "payload/config/lumina-defaults.json",
        installRelativePath: "config/lumina-defaults.json",
        sourcePath: configPath,
      }),
      createBundleEntry({
        id: "runtime-node",
        kind: "runtime",
        bundleRelativePath: "payload/node",
        installRelativePath: "node",
        sourcePath: path.join(tempDir, "payload", "node"),
        executable: true,
      }),
      createBundleEntry({
        id: "openclaw-runtime",
        kind: "content",
        bundleRelativePath: "payload/openclaw",
        installRelativePath: "openclaw",
        sourcePath: path.join(tempDir, "payload", "openclaw"),
      }),
      createBundleEntry({
        id: "openclaw-ui",
        kind: "ui",
        bundleRelativePath: "payload/ui",
        installRelativePath: "ui",
        sourcePath: path.join(tempDir, "payload", "ui"),
      }),
      createBundleEntry({
        id: "proxy-runtime",
        kind: "service",
        bundleRelativePath: "payload/proxy",
        installRelativePath: "proxy",
        sourcePath: path.join(tempDir, "payload", "proxy"),
      }),
    ],
  };
}

function createReleaseFixture(tempDir) {
  const canonicalBundleRoot = path.join(tempDir, "runtime-bundle");
  const payloadRoot = path.join(canonicalBundleRoot, "payload");
  const releaseRoot = path.join(tempDir, "release");
  const bundleManifestPath = path.join(canonicalBundleRoot, "bundle.manifest.json");
  const detachedBundleManifestPath = path.join(releaseRoot, "fixture-runtime.manifest.json");
  const runtimeBundleArchivePath = path.join(releaseRoot, "fixture-runtime.tar.gz");
  const shellArchivePath = path.join(releaseRoot, "lumina-shell.tar.gz");

  fs.mkdirSync(payloadRoot, { recursive: true });
  fs.mkdirSync(releaseRoot, { recursive: true });

  const bundleManifest = buildValidBundleManifest(canonicalBundleRoot);
  writeJsonFile(bundleManifestPath, bundleManifest);
  writeJsonFile(detachedBundleManifestPath, bundleManifest);
  fs.writeFileSync(runtimeBundleArchivePath, "fixture bundle archive\n", "utf8");
  fs.writeFileSync(shellArchivePath, "fixture desktop shell archive\n", "utf8");

  const releaseManifest = {
    $schema: "../schemas/lumina-release-manifest.schema.json",
    schemaVersion: 1,
    manifestId: "lumina-openclaw-release",
    channel: "stable",
    version: bundleManifest.bundleVersion,
    publishedAt: "2026-04-21T00:00:00.000Z",
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
      minBootstrapVersion: "1.0.0",
    },
    bootstrap: {
      strategy: "download-and-expand-runtime-bundle",
    },
    artifacts: [
      {
        id: "runtime-bundle",
        role: "runtime-bundle",
        platform: bundleManifest.platform,
        arch: bundleManifest.arch,
        format: "tar.gz",
        fileName: path.basename(runtimeBundleArchivePath),
        relativePath: path.basename(runtimeBundleArchivePath),
        byteSize: computeFileByteSize(runtimeBundleArchivePath),
        sha256: computeFileSha256(runtimeBundleArchivePath),
        bundleManifestRelativePath: path.basename(detachedBundleManifestPath),
        bundleManifestSha256: computeFileSha256(detachedBundleManifestPath),
      },
      {
        id: "runtime-bundle-manifest",
        role: "bundle-manifest",
        platform: bundleManifest.platform,
        arch: bundleManifest.arch,
        format: "json",
        fileName: path.basename(detachedBundleManifestPath),
        relativePath: path.basename(detachedBundleManifestPath),
        byteSize: computeFileByteSize(detachedBundleManifestPath),
        sha256: computeFileSha256(detachedBundleManifestPath),
      },
      {
        id: "lumina-desktop-shell",
        role: "desktop-installer",
        platform: bundleManifest.platform,
        arch: bundleManifest.arch,
        format: "tar.gz",
        fileName: path.basename(shellArchivePath),
        relativePath: path.basename(shellArchivePath),
        byteSize: computeFileByteSize(shellArchivePath),
        sha256: computeFileSha256(shellArchivePath),
      },
    ],
  };

  return {
    bundleManifest,
    bundleManifestPath,
    canonicalBundleRoot,
    releaseRoot,
    releaseManifest,
  };
}

test("validateBundleManifest accepts the canonical desktop runtime contract", () => {
  withTempDir((tempDir) => {
    const manifest = buildValidBundleManifest(tempDir);
    assert.equal(validateBundleManifest(manifest), manifest);
  });
});

test("validateBundleManifest rejects launch targets that are outside declared entries", () => {
  withTempDir((tempDir) => {
    const manifest = buildValidBundleManifest(tempDir);
    manifest.launch.uiIndex = "outside/index.html";
    assert.throws(
      () => validateBundleManifest(manifest),
      /launch\.uiIndex must resolve inside one of the bundle entries/,
    );
  });
});

test("validateReleaseManifest requires a single explicit target for all artifacts", () => {
  const releaseManifest = {
    $schema: "../schemas/lumina-release-manifest.schema.json",
    schemaVersion: 1,
    manifestId: "lumina-openclaw-release",
    channel: "stable",
    version: "1.2.3",
    publishedAt: "2026-04-21T00:00:00.000Z",
    product: {
      appId: "ai.lumina.desktop",
      productName: "Lumina OpenClaw",
      vendor: "I24D",
    },
    target: {
      platform: "win32",
      arch: "x64",
    },
    bundle: {
      bundleId: "lumina-openclaw-desktop",
      bundleVersion: "1.2.3",
      minBootstrapVersion: "1.0.0",
    },
    bootstrap: {
      strategy: "download-and-expand-runtime-bundle",
    },
    artifacts: [
      {
        id: "runtime-bundle",
        role: "runtime-bundle",
        platform: "linux",
        arch: "x64",
        format: "tar.gz",
        fileName: "bundle.tar.gz",
        relativePath: "bundle.tar.gz",
        byteSize: 123,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bundleManifestRelativePath: "bundle.manifest.json",
        bundleManifestSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      {
        id: "runtime-bundle-manifest",
        role: "bundle-manifest",
        platform: "win32",
        arch: "x64",
        format: "json",
        fileName: "bundle.manifest.json",
        relativePath: "bundle.manifest.json",
        byteSize: 456,
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
  };

  assert.throws(
    () => validateReleaseManifest(releaseManifest),
    /target mismatch: expected win32\/x64, got linux\/x64/,
  );
});

test("validateReleaseManifest requires at least one desktop installer artifact", () => {
  withTempDir((tempDir) => {
    const fixture = createReleaseFixture(tempDir);
    fixture.releaseManifest.artifacts = fixture.releaseManifest.artifacts.filter(
      (artifact) => artifact.role !== "desktop-installer",
    );

    assert.throws(
      () => validateReleaseManifest(fixture.releaseManifest),
      /must contain at least one desktop-installer artifact/,
    );
  });
});

test("validate-release-contract script accepts a matching bundle and release fixture", () => {
  withTempDir((tempDir) => {
    const fixture = createReleaseFixture(tempDir);
    const releaseManifestPath = path.join(
      fixture.releaseRoot,
      buildReleaseManifestFileName(
        fixture.bundleManifest.bundleVersion,
        fixture.bundleManifest.platform,
        fixture.bundleManifest.arch,
      ),
    );
    writeJsonFile(releaseManifestPath, fixture.releaseManifest);

    const result = validateReleaseContract({
      canonicalBundleRoot: fixture.canonicalBundleRoot,
      bundleManifestPath: fixture.bundleManifestPath,
      releaseRoot: fixture.releaseRoot,
      releaseManifestPath,
    });

    assert.equal(result.bundleManifest.bundleId, fixture.bundleManifest.bundleId);
    assert.equal(result.releaseManifest.bundle.bundleVersion, fixture.bundleManifest.bundleVersion);
  });
});

test("validate-release-contract can skip canonical payload validation when requested", () => {
  withTempDir((tempDir) => {
    const fixture = createReleaseFixture(tempDir);
    const releaseManifestPath = path.join(
      fixture.releaseRoot,
      buildReleaseManifestFileName(
        fixture.bundleManifest.bundleVersion,
        fixture.bundleManifest.platform,
        fixture.bundleManifest.arch,
      ),
    );
    writeJsonFile(releaseManifestPath, fixture.releaseManifest);
    fs.rmSync(path.join(fixture.canonicalBundleRoot, "payload"), {
      recursive: true,
      force: true,
    });

    const result = validateReleaseContract({
      canonicalBundleRoot: fixture.canonicalBundleRoot,
      bundleManifestPath: fixture.bundleManifestPath,
      releaseRoot: fixture.releaseRoot,
      releaseManifestPath,
      skipBundlePayload: true,
    });

    assert.equal(result.bundleManifest.bundleId, fixture.bundleManifest.bundleId);
    assert.equal(result.releaseManifest.bundle.bundleVersion, fixture.bundleManifest.bundleVersion);
  });
});

test("generate-release-manifest script produces a valid target-specific release manifest", () => {
  withTempDir((tempDir) => {
    const fixture = createReleaseFixture(tempDir);
    const runtimeBundleMetadataPath = path.join(fixture.releaseRoot, "fixture-runtime.artifact.json");
    const bootstrapperArchivePath = path.join(fixture.releaseRoot, "lumina-bootstrapper.tar.gz");
    const bootstrapperMetadataPath = path.join(
      fixture.releaseRoot,
      "lumina-bootstrapper.artifact.json",
    );
    const shellArchivePath = path.join(fixture.releaseRoot, "lumina-shell.tar.gz");
    const shellMetadataPath = path.join(fixture.releaseRoot, "lumina-shell.artifact.json");
    fs.writeFileSync(bootstrapperArchivePath, "fixture bootstrapper archive\n", "utf8");
    fs.writeFileSync(shellArchivePath, "fixture tauri shell archive\n", "utf8");
    writeJsonFile(runtimeBundleMetadataPath, {
      artifactId: "runtime-bundle",
      role: "runtime-bundle",
      format: "tar.gz",
      platform: fixture.bundleManifest.platform,
      arch: fixture.bundleManifest.arch,
      fileName: "fixture-runtime.tar.gz",
      relativePath: "fixture-runtime.tar.gz",
      byteSize: computeFileByteSize(path.join(fixture.releaseRoot, "fixture-runtime.tar.gz")),
      sha256: computeFileSha256(path.join(fixture.releaseRoot, "fixture-runtime.tar.gz")),
      bundleManifestFileName: "fixture-runtime.manifest.json",
      bundleManifestRelativePath: "fixture-runtime.manifest.json",
      bundleManifestSha256: computeFileSha256(
        path.join(fixture.releaseRoot, "fixture-runtime.manifest.json"),
      ),
    });
    writeJsonFile(bootstrapperMetadataPath, {
      artifactId: "lumina-bootstrap-installer",
      role: "bootstrap-installer",
      format: "tar.gz",
      platform: fixture.bundleManifest.platform,
      arch: fixture.bundleManifest.arch,
      fileName: "lumina-bootstrapper.tar.gz",
      relativePath: "lumina-bootstrapper.tar.gz",
      byteSize: computeFileByteSize(bootstrapperArchivePath),
      sha256: computeFileSha256(bootstrapperArchivePath),
    });
    writeJsonFile(shellMetadataPath, {
      artifactId: "lumina-desktop-shell",
      role: "desktop-installer",
      format: "tar.gz",
      platform: fixture.bundleManifest.platform,
      arch: fixture.bundleManifest.arch,
      fileName: "lumina-shell.tar.gz",
      relativePath: "lumina-shell.tar.gz",
      byteSize: computeFileByteSize(shellArchivePath),
      sha256: computeFileSha256(shellArchivePath),
    });

    const outputPath = path.join(
      fixture.releaseRoot,
      buildReleaseManifestFileName(
        fixture.bundleManifest.bundleVersion,
        fixture.bundleManifest.platform,
        fixture.bundleManifest.arch,
      ),
    );
    const generatedManifest = generateReleaseManifest({
      bundleManifestPath: fixture.bundleManifestPath,
      releaseRoot: fixture.releaseRoot,
      outputPath,
    });
    assert.equal(generatedManifest.target.platform, fixture.bundleManifest.platform);
    assert.equal(generatedManifest.target.arch, fixture.bundleManifest.arch);
    assert.equal(generatedManifest.artifacts.length, 4);
    assert.equal(
      generatedManifest.artifacts.find((artifact) => artifact.id === "lumina-bootstrap-installer")
        ?.role,
      "bootstrap-installer",
    );
    assert.equal(
      generatedManifest.artifacts.find((artifact) => artifact.id === "lumina-desktop-shell")?.role,
      "desktop-installer",
    );
    assert.ok(fs.existsSync(outputPath));
  });
});

test("publish-release-artifacts writes immutable versioned output and channel latest output", () => {
  withTempDir((tempDir) => {
    const fixture = createReleaseFixture(tempDir);
    const releaseManifestPath = path.join(
      fixture.releaseRoot,
      buildReleaseManifestFileName(
        fixture.bundleManifest.bundleVersion,
        fixture.bundleManifest.platform,
        fixture.bundleManifest.arch,
      ),
    );
    writeJsonFile(releaseManifestPath, fixture.releaseManifest);

    const publishRoot = path.join(tempDir, "published");
    const published = publishReleaseArtifacts({
      releaseRoot: fixture.releaseRoot,
      releaseManifestPath,
      publishRoot,
      baseUrl: "https://downloads.example.com/lumina",
    });

    const versionedManifestPath = path.join(published.versionedRoot, "lumina-release.manifest.json");
    const channelManifestPath = path.join(published.channelRoot, "lumina-release.manifest.json");
    const channelIndexPath = path.join(published.channelRoot, "index.json");
    const versionedManifest = JSON.parse(fs.readFileSync(versionedManifestPath, "utf8"));
    const channelManifest = JSON.parse(fs.readFileSync(channelManifestPath, "utf8"));
    const channelIndex = JSON.parse(fs.readFileSync(channelIndexPath, "utf8"));
    const runtimeArtifact = versionedManifest.artifacts.find((artifact) => artifact.id === "runtime-bundle");

    assert.ok(fs.existsSync(path.join(published.versionedRoot, "fixture-runtime.tar.gz")));
    assert.ok(fs.existsSync(path.join(published.channelRoot, "fixture-runtime.tar.gz")));
    assert.equal(
      runtimeArtifact?.url.startsWith(
        "https://downloads.example.com/lumina/versions/stable/win32/x64/1.2.3/",
      ),
      true,
    );
    assert.deepEqual(channelManifest.artifacts, versionedManifest.artifacts);
    assert.equal(channelIndex.version, "1.2.3");
    assert.equal(channelIndex.channel, "stable");
  });
});
