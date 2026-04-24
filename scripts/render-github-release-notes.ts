#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readJsonFile,
  validateReleaseManifest,
} from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const defaultArtifactsRoot = path.join(repoRoot, "release-artifacts");
const defaultOutputPath = path.join(repoRoot, "github-release-notes.md");

type RenderReleaseNotesOptions = {
  artifactsRoot?: string;
  outputPath?: string;
};

type ReleaseArtifact = {
  role: string;
  fileName: string;
};

type ReleaseSummary = {
  arch: string;
  channel: string;
  desktopInstaller: ReleaseArtifact;
  bootstrapInstaller: ReleaseArtifact | null;
  platform: string;
  runtimeBundle: ReleaseArtifact | null;
  version: string;
};

function fail(message: string): never {
  throw new Error(`[lumina-release] ${message}`);
}

function log(message: string): void {
  process.stdout.write(`[lumina-release] ${message}\n`);
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
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

function isReleaseManifestFile(fileName: string): boolean {
  return (
    fileName === "lumina-release.manifest.json" ||
    (fileName.startsWith("lumina-release-") && fileName.endsWith(".manifest.json"))
  );
}

function walkReleaseManifestPaths(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    fail(`Artifacts root does not exist: ${rootDir}`);
  }

  const pendingDirs = [rootDir];
  const manifestPaths: string[] = [];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    const dirents = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const dirent of dirents) {
      const absolutePath = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        pendingDirs.push(absolutePath);
        continue;
      }
      if (dirent.isFile() && isReleaseManifestFile(dirent.name)) {
        manifestPaths.push(absolutePath);
      }
    }
  }

  return manifestPaths.sort((left, right) => left.localeCompare(right));
}

function getRequiredArtifact(
  summaryLabel: string,
  artifacts: ReleaseArtifact[],
  role: string,
): ReleaseArtifact {
  const artifact = artifacts.find((entry) => entry.role === role);
  if (!artifact) {
    fail(`Release manifest ${summaryLabel} is missing a ${role} artifact.`);
  }
  return artifact;
}

function getOptionalArtifact(
  artifacts: ReleaseArtifact[],
  role: string,
): ReleaseArtifact | null {
  return artifacts.find((entry) => entry.role === role) ?? null;
}

function loadReleaseSummaries(artifactsRoot: string): ReleaseSummary[] {
  const manifestPaths = walkReleaseManifestPaths(artifactsRoot);
  if (manifestPaths.length === 0) {
    fail(`No release manifests were found under ${artifactsRoot}`);
  }

  return manifestPaths
    .map((manifestPath) => {
      const manifest = validateReleaseManifest(readJsonFile(manifestPath));
      const summaryLabel = path.relative(artifactsRoot, manifestPath);
      const artifacts = manifest.artifacts.map((artifact) => ({
        role: artifact.role,
        fileName: artifact.fileName,
      }));

      return {
        arch: manifest.target.arch,
        channel: manifest.channel,
        desktopInstaller: getRequiredArtifact(summaryLabel, artifacts, "desktop-installer"),
        bootstrapInstaller: getOptionalArtifact(artifacts, "bootstrap-installer"),
        platform: manifest.target.platform,
        runtimeBundle: getOptionalArtifact(artifacts, "runtime-bundle"),
        version: manifest.version,
      };
    })
    .sort((left, right) => {
      const leftKey = `${left.platform}:${left.arch}:${left.version}`;
      const rightKey = `${right.platform}:${right.arch}:${right.version}`;
      return leftKey.localeCompare(rightKey);
    });
}

function formatPlatform(platform: string): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function renderReleaseNotes(summaries: ReleaseSummary[]): string {
  const lines = [
    "# Lumina PC Downloads",
    "",
    "Download the `desktop-installer` asset for your operating system.",
    "The `runtime-bundle` and `bootstrap-installer` assets are support files for updates and recovery, not the normal first download.",
    "",
  ];

  for (const summary of summaries) {
    lines.push(`## ${formatPlatform(summary.platform)} (${summary.arch})`);
    lines.push(`- Channel: \`${summary.channel}\``);
    lines.push(`- Version: \`${summary.version}\``);
    lines.push(`- Download this file: \`${summary.desktopInstaller.fileName}\``);
    if (summary.bootstrapInstaller) {
      lines.push(`- Optional bootstrapper: \`${summary.bootstrapInstaller.fileName}\``);
    }
    if (summary.runtimeBundle) {
      lines.push(`- Runtime bundle: \`${summary.runtimeBundle.fileName}\``);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function renderGitHubReleaseNotes(
  options: RenderReleaseNotesOptions = {},
): { outputPath: string; releaseNotes: string } {
  const artifactsRoot = options.artifactsRoot ?? defaultArtifactsRoot;
  const outputPath = options.outputPath ?? defaultOutputPath;
  const releaseNotes = renderReleaseNotes(loadReleaseSummaries(artifactsRoot));

  fs.writeFileSync(outputPath, releaseNotes, "utf8");
  log(`Wrote GitHub release notes: ${outputPath}`);
  return { outputPath, releaseNotes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  renderGitHubReleaseNotes({
    artifactsRoot: args.get("artifacts-root"),
    outputPath: args.get("output"),
  });
}
