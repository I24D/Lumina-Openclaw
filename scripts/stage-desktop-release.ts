#!/usr/bin/env node

import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildReleaseManifestFileName,
  readJsonFile,
} from "./lumina-bundle-lib.ts";
import { publishReleaseArtifacts } from "./publish-release-artifacts.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const desktopPackageJsonPath = path.join(desktopRoot, "package.json");
const defaultReleaseRoot = path.join(desktopRoot, "release");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

type StageDesktopReleaseOptions = {
  channel?: string;
  releaseRoot?: string;
  releaseManifestPath?: string;
  publishRoot?: string | null;
  baseUrl?: string | null;
  skipBuild?: boolean;
  skipBootstrapperStage?: boolean;
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

function spawnOpts(command: string, args: string[], cwd: string) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/c", command, ...args],
      opts: { cwd, stdio: "inherit" as const, env: process.env },
    };
  }
  return { command, args, opts: { cwd, stdio: "inherit" as const, env: process.env } };
}

function run(command: string, args: string[], cwd = repoRoot) {
  log(`Running: ${command} ${args.join(" ")}`);
  const { command: cmd, args: cmdArgs, opts } = spawnOpts(command, args, cwd);
  const result = spawnSync(cmd, cmdArgs, opts);
  if (result.error) {
    fail(`Failed to start ${command}: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    fail(`${command} exited with code ${result.status ?? 1}`);
  }
}

function runAsync(command: string, args: string[], cwd = repoRoot): Promise<void> {
  log(`Running (parallel): ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const { command: cmd, args: cmdArgs, opts } = spawnOpts(command, args, cwd);
    const proc = spawn(cmd, cmdArgs, opts);
    proc.on("error", (err) => reject(new Error(`Failed to start ${command}: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
      }
    });
  });
}

export async function stageDesktopRelease(options: StageDesktopReleaseOptions = {}) {
  const channel = options.channel ?? process.env.LUMINA_RELEASE_CHANNEL ?? "stable";
  const releaseRoot = options.releaseRoot ?? defaultReleaseRoot;
  const desktopPackageJson = readJsonFile(desktopPackageJsonPath);
  const releaseManifestPath =
    options.releaseManifestPath ??
    path.join(
      releaseRoot,
      buildReleaseManifestFileName(
        desktopPackageJson.version,
        process.platform,
        process.arch,
      ),
    );
  const publishRoot = options.publishRoot ?? null;
  const baseUrl = options.baseUrl ?? null;
  const skipBuild = options.skipBuild ?? false;
  const skipBootstrapperStage = options.skipBootstrapperStage ?? false;

  fs.mkdirSync(releaseRoot, { recursive: true });

  if (!skipBuild) {
    run(pnpmCmd, ["--dir", repoRoot, "--filter", "@lumina/desktop", "tauri:archive"]);
  } else {
    run(process.execPath, [
      "--experimental-strip-types",
      path.join(repoRoot, "scripts", "prepare-desktop-bundle.ts"),
      "--skip-ui-build",
    ]);
  }
  // archive-runtime-bundle and stage-bootstrapper-artifact are independent — run in parallel
  const parallelArchives: Promise<void>[] = [
    runAsync(process.execPath, [
      "--experimental-strip-types",
      path.join(repoRoot, "scripts", "archive-runtime-bundle.ts"),
    ]),
  ];
  if (!skipBootstrapperStage) {
    parallelArchives.push(
      runAsync(process.execPath, [
        "--experimental-strip-types",
        path.join(repoRoot, "scripts", "stage-bootstrapper-artifact.ts"),
      ]),
    );
  }
  await Promise.all(parallelArchives);

  run(process.execPath, [
    "--experimental-strip-types",
    path.join(repoRoot, "scripts", "generate-release-manifest.ts"),
    "--channel",
    channel,
    "--release-root",
    releaseRoot,
    "--output",
    releaseManifestPath,
  ]);
  run(process.execPath, [
    "--experimental-strip-types",
    path.join(repoRoot, "scripts", "validate-release-contract.ts"),
    "--release-root",
    releaseRoot,
    "--release-manifest",
    releaseManifestPath,
  ]);

  if (publishRoot) {
    publishReleaseArtifacts({
      releaseRoot,
      releaseManifestPath,
      publishRoot,
      baseUrl,
    });
  }

  return {
    releaseRoot,
    releaseManifestPath,
    publishRoot,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  stageDesktopRelease({
    channel: args.get("channel"),
    releaseRoot: args.get("release-root"),
    releaseManifestPath: args.get("release-manifest"),
    publishRoot: args.get("publish-root"),
    baseUrl: args.get("base-url"),
    skipBuild: args.get("skip-build") === "true",
    skipBootstrapperStage: args.get("skip-bootstrapper-stage") === "true",
  }).catch((err) => {
    process.stderr.write(`[lumina-release] ${err.message}\n`);
    process.exit(1);
  });
}
