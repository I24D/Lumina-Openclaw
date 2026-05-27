#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  createBundleEntry,
  ensureDirectory,
  readJsonFile,
  validateBundleManifest,
  writeJsonFile,
} from "./lumina-bundle-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const openClawRoot = path.join(repoRoot, "Open_PC");
const desktopRoot = path.join(repoRoot, "apps", "lumina-desktop");
const toolProxyRoot = path.join(repoRoot, "tool-proxy");
const workspaceRoot = path.resolve(repoRoot, "..");
const luminaCodeVsixPath = resolveLatestLuminaCodeVsixPath();
const luminaCodeVsixFileName = path.basename(luminaCodeVsixPath);
const luminaCodeBundleRelativePath = `lumina-code/${luminaCodeVsixFileName}`;
const luminaCodePayloadRelativePath = `payload/${luminaCodeBundleRelativePath}`;

function resolveLatestLuminaCodeVsixPath() {
  if (process.env.LUMINA_CODE_VSIX_PATH) {
    return process.env.LUMINA_CODE_VSIX_PATH;
  }
  const buildDir = path.join(
    workspaceRoot,
    "src",
    "lumina-code",
    "official",
    "extensions",
    "vscode",
    "build",
  );
  const latestFileName = fs.existsSync(buildDir)
    ? fs
        .readdirSync(buildDir)
        .filter((fileName) => /^lumina-code-.+\.vsix$/i.test(fileName))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0]
    : undefined;
  return path.join(buildDir, latestFileName ?? "lumina-code-0.1.0.vsix");
}
const bundleManifestPath = path.join(desktopRoot, "build", "openclaw-bundle.json");
const canonicalBundleRoot = path.join(desktopRoot, "build", "runtime-bundle");
const canonicalBundlePayloadRoot = path.join(canonicalBundleRoot, "payload");
const canonicalBundleManifestPath = path.join(canonicalBundleRoot, "bundle.manifest.json");
const runtimeNodeDir = path.join(desktopRoot, "build", "runtime-node");
const stagedOpenClawDir = path.join(desktopRoot, "build", "openclaw-deploy");
const packagedOpenClawDir = path.join(desktopRoot, "build", "openclaw-package");
const deployStampPath = path.join(desktopRoot, "build", "openclaw-deploy-stamp.json");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const desktopPackageJsonPath = path.join(desktopRoot, "package.json");
const tauriConfigPath = path.join(desktopRoot, "src-tauri", "tauri.conf.json");
const openClawPackageJsonPath = path.join(openClawRoot, "package.json");
const openClawNpmrcPath = path.join(openClawRoot, ".npmrc");
const openClawWorkspacePath = path.join(openClawRoot, "pnpm-workspace.yaml");
const openClawPatchesDir = path.join(openClawRoot, "patches");
const PRODUCTION_DEPENDENCY_LAYOUT_VERSION = 4;
const NODE_MODULES_PRUNE_SUFFIXES = [".ts", ".mts", ".cts", ".map", ".md", ".mdx"];
const NODE_MODULES_PRUNE_FILE_NAMES = new Set(["readme", "readme.md", "changelog", "changelog.md"]);
const NODE_MODULES_KEEP_FILE_NAMES = new Set([
  "authors",
  "authors.md",
  "copying",
  "copying.md",
  "licence",
  "licence.md",
  "license",
  "license.md",
  "notice",
  "notice.md",
]);
const NODE_MODULES_RUNTIME_FILE_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".node",
  ".wasm",
]);
const NODE_MODULES_PRUNE_DIRECTORY_NAMES = new Set([
  "__tests__",
  ".github",
  ".vscode",
  "coverage",
  "example",
  "examples",
  "test",
  "tests",
]);
const BUNDLED_PLUGIN_RUNTIME_METADATA_PRUNE_DIRECTORIES = new Set(["node_modules"]);
const EMBEDDED_ACPX_RUNTIME_DEPENDENCIES = [
  "@zed-industries/codex-acp",
  `@zed-industries/codex-acp-${process.platform}-${process.arch}`,
];

const cliArgs = new Set(process.argv.slice(2));
const forceRuntimeBuild =
  cliArgs.has("--build-openclaw") || process.env.LUMINA_FORCE_OPENCLAW_BUILD === "1";
const forceDeployRefresh =
  cliArgs.has("--refresh-openclaw-deploy") || process.env.LUMINA_FORCE_OPENCLAW_DEPLOY === "1";
const skipRuntimeBuild =
  cliArgs.has("--skip-openclaw-build") || process.env.LUMINA_SKIP_OPENCLAW_BUILD === "1";
const skipUiBuild =
  cliArgs.has("--skip-ui-build") || process.env.LUMINA_SKIP_OPENCLAW_UI_BUILD === "1";
const skipCanonicalRuntimeBundle =
  cliArgs.has("--skip-canonical-runtime-bundle") ||
  process.env.LUMINA_SKIP_CANONICAL_RUNTIME_BUNDLE === "1";
const skipRuntimePostbuild =
  cliArgs.has("--skip-runtime-postbuild") || process.env.LUMINA_SKIP_RUNTIME_POSTBUILD === "1";

function log(message) {
  process.stdout.write(`[lumina-desktop] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[lumina-desktop] ${message}\n`);
  process.exit(1);
}

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    fail(`Missing ${label}: ${targetPath}`);
  }
}

function readPackageJson(targetPath) {
  return readJsonFile(targetPath);
}

function readVsixPackageJson(targetPath, label) {
  const attempts = [
    ["tar", ["-xOf", targetPath, "extension/package.json"]],
    ["unzip", ["-p", targetPath, "extension/package.json"]],
  ];
  const failures = [];

  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    if ((result.status ?? 1) !== 0) {
      const details = [result.error?.message, result.stderr, result.stdout]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .join("\n");
      failures.push(`${command}: ${details || `exit ${result.status ?? 1}`}`);
      continue;
    }
    try {
      return JSON.parse(String(result.stdout ?? ""));
    } catch (err) {
      fail(
        `Could not parse ${label} package.json from VSIX: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  fail(
    `Could not read ${label} package.json from VSIX using tar or unzip.\n${failures.join("\n")}`,
  );
}

function verifyLuminaCodeVsixManifest(targetPath) {
  const manifest = readVsixPackageJson(targetPath, "Lumina Code VSIX");
  const serialized = JSON.stringify(manifest);
  const forbidden = ["Lumina Studio", "lumina.autonomousTask", "Deploy Changelog"];
  const foundForbidden = forbidden.filter((needle) => serialized.includes(needle));
  if (foundForbidden.length > 0) {
    fail(
      `Lumina Code VSIX is the experimental Studio build, not the official Continue-based build: ${foundForbidden.join(", ")}`,
    );
  }
  if (!serialized.includes("continue.continueGUIView")) {
    fail(
      "Lumina Code VSIX does not expose continue.continueGUIView; refusing to package the wrong extension.",
    );
  }
  log("Lumina Code VSIX manifest verified as official Continue-based build.");
}

function copyFileToStage(sourcePath, targetPath) {
  ensureExists(sourcePath, "bundle source file");
  const sourceStats = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, sourceStats.mode);
}

function copyDirToStage(sourceDir, targetDir) {
  ensureExists(sourceDir, "bundle source directory");
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

function syncDirToStage(sourceDir, targetDir) {
  ensureExists(sourceDir, "bundle source directory");

  if (process.platform === "win32") {
    fs.mkdirSync(targetDir, { recursive: true });
    const result = spawnSync(
      "robocopy",
      [sourceDir, targetDir, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    if (result.error) {
      fail(`Failed to sync ${sourceDir} -> ${targetDir} with robocopy: ${result.error.message}`);
    }

    if ((result.status ?? 16) > 7) {
      fail(`robocopy exited with code ${result.status ?? 16} while syncing ${sourceDir}`);
    }
    return;
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  copyDirToStage(sourceDir, targetDir);
}

function copyBundledPluginRuntimeMetadata(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  for (const dirent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (BUNDLED_PLUGIN_RUNTIME_METADATA_PRUNE_DIRECTORIES.has(dirent.name)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);

    if (dirent.isDirectory()) {
      copyBundledPluginRuntimeMetadata(sourcePath, targetPath);
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    if (path.extname(dirent.name).toLowerCase() === ".js") {
      continue;
    }

    copyFileToStage(sourcePath, targetPath);
  }
}

function syncBundledPluginRuntimeMetadata() {
  const sourceExtensionsRoot = path.join(openClawRoot, "dist-runtime", "extensions");
  const targetExtensionsRoot = path.join(stagedOpenClawDir, "dist", "extensions");

  if (!fs.existsSync(sourceExtensionsRoot)) {
    return;
  }

  log("Syncing bundled plugin runtime metadata into the production deploy bundle.");
  copyBundledPluginRuntimeMetadata(sourceExtensionsRoot, targetExtensionsRoot);
}

function shouldSkipPackagedRuntimePath(sourcePath) {
  const relativePath = path.relative(stagedOpenClawDir, sourcePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }

  const normalizedRelativePath = relativePath.split(path.sep).join("/");
  return (
    normalizedRelativePath === ".npmrc" ||
    normalizedRelativePath === "pnpm-lock.yaml" ||
    normalizedRelativePath === "pnpm-workspace.yaml" ||
    normalizedRelativePath === "node_modules/.modules.yaml" ||
    normalizedRelativePath === "node_modules/.pnpm" ||
    normalizedRelativePath.startsWith("node_modules/.pnpm/") ||
    normalizedRelativePath === "patches" ||
    normalizedRelativePath.startsWith("patches/")
  );
}

function copyPathResolvingSymlinks(sourcePath, targetPath, ancestors = new Set()) {
  if (shouldSkipPackagedRuntimePath(sourcePath)) {
    return;
  }

  const sourceLstat = fs.lstatSync(sourcePath);
  const resolvedSourcePath = sourceLstat.isSymbolicLink()
    ? fs.realpathSync(sourcePath)
    : sourcePath;
  const sourceStats = sourceLstat.isSymbolicLink() ? fs.statSync(resolvedSourcePath) : sourceLstat;

  if (sourceStats.isDirectory()) {
    const realDirectoryPath = fs.realpathSync(resolvedSourcePath);
    if (ancestors.has(realDirectoryPath)) {
      fail(`Detected a cyclic symbolic link while materializing ${sourcePath}`);
    }

    fs.mkdirSync(targetPath, { recursive: true });
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(realDirectoryPath);
    const entries = fs
      .readdirSync(resolvedSourcePath, { withFileTypes: true })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      copyPathResolvingSymlinks(
        path.join(sourcePath, entry.name),
        path.join(targetPath, entry.name),
        nextAncestors,
      );
    }
    return;
  }

  if (!sourceStats.isFile()) {
    fail(`Unsupported staged runtime entry type: ${sourcePath}`);
  }

  copyFileToStage(resolvedSourcePath, targetPath);
}

function removeDistPluginNodeModulesSymlinks(rootDir) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return 0;
  }

  let removed = 0;
  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Ignore missing or unreadable paths so bundle prep can continue.
    }
  }

  return removed;
}

function sanitizeOpenClawSourceRuntimeOverlays() {
  const removedCount =
    removeDistPluginNodeModulesSymlinks(path.join(openClawRoot, "dist")) +
    removeDistPluginNodeModulesSymlinks(path.join(openClawRoot, "dist-runtime"));
  if (removedCount > 0) {
    log(`Removed ${removedCount} stale OpenClaw runtime overlay node_modules symlinks.`);
  }
}

function refreshOpenClawRuntimePostBuildArtifacts() {
  runNodeScript(path.join(openClawRoot, "scripts", "runtime-postbuild.mjs"), openClawRoot);
}

function run(command, args, cwd) {
  log(`Running: ${command} ${args.join(" ")}`);
  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
          ["/d", "/c", command, ...args],
          {
            cwd,
            stdio: "inherit",
            env: process.env,
          },
        )
      : spawnSync(command, args, {
          cwd,
          stdio: "inherit",
          env: process.env,
        });

  if (result.error) {
    fail(`Failed to start ${command}: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    fail(`${command} exited with code ${result.status ?? 1}`);
  }
}

function runNodeScript(scriptPath, cwd, args = []) {
  log(`Running Node script: ${scriptPath} ${args.join(" ")}`.trimEnd());
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    fail(`Failed to start Node script ${scriptPath}: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    fail(`Node script ${scriptPath} exited with code ${result.status ?? 1}`);
  }
}

function createEmptyCanonicalBundle() {
  fs.rmSync(canonicalBundleRoot, { recursive: true, force: true });
  ensureDirectory(canonicalBundlePayloadRoot);
}

function validateRequiredPaths(rootDir, rootLabel, entries) {
  const missingEntries = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, ...entry.relativePath.split("/"));
    const exists = fs.existsSync(absolutePath);
    const kindMatches =
      exists &&
      (entry.kind === "directory"
        ? fs.statSync(absolutePath).isDirectory()
        : fs.statSync(absolutePath).isFile());

    if (!kindMatches) {
      missingEntries.push({
        label: entry.label,
        absolutePath,
        expectedKind: entry.kind,
      });
    }
  }

  if (missingEntries.length > 0) {
    const details = missingEntries
      .map((entry) => ` - ${entry.label} (${entry.expectedKind}) -> ${entry.absolutePath}`)
      .join("\n");
    fail(
      `Runtime bundle validation failed for ${rootLabel}.\n` +
        `The installer would be incomplete, so the build is stopping.\n` +
        details,
    );
  }

  log(`Validated required runtime bundle paths in ${rootLabel}.`);
}

function validatePackagedOpenClawRuntime() {
  validateRequiredPaths(packagedOpenClawDir, "packaged OpenClaw runtime", [
    {
      relativePath: "openclaw.mjs",
      label: "openclaw/openclaw.mjs",
      kind: "file",
    },
    {
      relativePath: "package.json",
      label: "openclaw/package.json",
      kind: "file",
    },
    {
      relativePath: "docs/reference/templates/AGENTS.md",
      label: "openclaw/docs/reference/templates/AGENTS.md",
      kind: "file",
    },
    {
      relativePath: "dist/extensions/lumina-pc",
      label: "openclaw/dist/extensions/lumina-pc",
      kind: "directory",
    },
    {
      relativePath: "dist/extensions/lumina-pc/openclaw.plugin.json",
      label: "openclaw/dist/extensions/lumina-pc/openclaw.plugin.json",
      kind: "file",
    },
    {
      relativePath: "dist/extensions/lumina-pc/package.json",
      label: "openclaw/dist/extensions/lumina-pc/package.json",
      kind: "file",
    },
    {
      relativePath: "dist/control-ui/index.html",
      label: "ui/index.html",
      kind: "file",
    },
    {
      relativePath: "node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
      label: "openclaw/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
      kind: "file",
    },
    {
      relativePath: path.join(
        "node_modules",
        "@zed-industries",
        `codex-acp-${process.platform}-${process.arch}`,
        "bin",
        process.platform === "win32" ? "codex-acp.exe" : "codex-acp",
      ),
      label: `openclaw/node_modules/@zed-industries/codex-acp-${process.platform}-${process.arch}/bin/${
        process.platform === "win32" ? "codex-acp.exe" : "codex-acp"
      }`,
      kind: "file",
    },
  ]);
  validatePackagedBundledExtensionRuntimeDependencies();
  validatePackagedRuntimeModuleImports();
}

function validatePackagedBundledExtensionRuntimeDependencies() {
  const extensionsRoot = path.join(packagedOpenClawDir, "dist", "extensions");
  const rootNodeModulesDir = path.join(packagedOpenClawDir, "node_modules");
  if (!fs.existsSync(extensionsRoot) || !fs.existsSync(rootNodeModulesDir)) {
    return;
  }

  const missingDependencies = [];
  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageJsonPath = path.join(extensionsRoot, entry.name, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    } catch {
      continue;
    }

    if (packageJson?.openclaw?.bundle?.stageRuntimeDependencies !== true) {
      continue;
    }

    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      const dependencyPackageJsonPath = path.join(
        rootNodeModulesDir,
        ...dependencyName.split("/"),
        "package.json",
      );
      if (!fs.existsSync(dependencyPackageJsonPath)) {
        missingDependencies.push(`${entry.name}: ${dependencyName}`);
      }
    }
  }

  if (missingDependencies.length > 0) {
    fail(
      "Missing staged bundled extension runtime dependencies in packaged OpenClaw runtime:\n" +
        missingDependencies.map((item) => `  - ${item}`).join("\n"),
    );
  }

  log("Validated staged bundled extension runtime dependencies in packaged OpenClaw runtime.");
}

function resolveGatewayServerBundlePath(runtimeRoot) {
  const distRoot = path.join(runtimeRoot, "dist");
  if (!fs.existsSync(distRoot)) {
    fail(`Missing dist directory for gateway import validation: ${distRoot}`);
  }

  for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      (!entry.name.startsWith("server-") && !entry.name.startsWith("server.impl-")) ||
      !entry.name.endsWith(".js")
    ) {
      continue;
    }

    const candidatePath = path.join(distRoot, entry.name);
    try {
      const source = fs.readFileSync(candidatePath, "utf8");
      if (
        source.includes("startGatewayServer") &&
        /export\s*\{[^}]*\bstartGatewayServer\b/u.test(source)
      ) {
        return candidatePath;
      }
    } catch {
      // Ignore unreadable bundle candidates and keep scanning.
    }
  }

  fail(`Unable to locate the packaged gateway server bundle inside ${distRoot}`);
}

function runPackagedRuntimeImportSmokeTest(targetPath, label) {
  const importUrl = pathToFileURL(targetPath).href;
  const validationScript = `await import(${JSON.stringify(importUrl)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", validationScript], {
    cwd: path.dirname(targetPath),
    env: {
      ...process.env,
      OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "1",
      OPENCLAW_STARTUP_TRACE: "0",
    },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      fail(`Packaged runtime import smoke test timed out for ${label}: ${targetPath}`);
    }
    fail(
      `Failed to start packaged runtime import smoke test for ${label}: ${result.error.message}`,
    );
  }

  if ((result.status ?? 1) !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const details = [stderr, stdout].filter(Boolean).join("\n");
    fail(
      `Packaged runtime import smoke test failed for ${label}: ${targetPath}\n` +
        (details || `node exited with code ${result.status ?? 1}`),
    );
  }

  log(`Validated packaged runtime import smoke test for ${label}.`);
}

function validatePackagedRuntimeModuleImports() {
  const gatewayServerBundlePath = resolveGatewayServerBundlePath(packagedOpenClawDir);
  runPackagedRuntimeImportSmokeTest(gatewayServerBundlePath, "gateway server bundle");
}

function validateCanonicalRuntimeBundlePayload() {
  const bundledNodeRelativePath = process.platform === "win32" ? "node/node.exe" : "node/node";

  validateRequiredPaths(canonicalBundlePayloadRoot, "canonical runtime bundle payload", [
    {
      relativePath: bundledNodeRelativePath,
      label: bundledNodeRelativePath,
      kind: "file",
    },
    {
      relativePath: "proxy/server.mjs",
      label: "proxy/server.mjs",
      kind: "file",
    },
    {
      relativePath: "proxy/proxy-config.json",
      label: "proxy/proxy-config.json",
      kind: "file",
    },
    {
      relativePath: luminaCodeBundleRelativePath,
      label: luminaCodeBundleRelativePath,
      kind: "file",
    },
    {
      relativePath: "openclaw/openclaw.mjs",
      label: "openclaw/openclaw.mjs",
      kind: "file",
    },
    {
      relativePath: "openclaw/package.json",
      label: "openclaw/package.json",
      kind: "file",
    },
    {
      relativePath: "openclaw/docs/reference/templates/AGENTS.md",
      label: "openclaw/docs/reference/templates/AGENTS.md",
      kind: "file",
    },
    {
      relativePath: "openclaw/dist/extensions/lumina-pc",
      label: "openclaw/dist/extensions/lumina-pc",
      kind: "directory",
    },
    {
      relativePath: "openclaw/dist/extensions/lumina-pc/openclaw.plugin.json",
      label: "openclaw/dist/extensions/lumina-pc/openclaw.plugin.json",
      kind: "file",
    },
    {
      relativePath: "openclaw/dist/extensions/lumina-pc/package.json",
      label: "openclaw/dist/extensions/lumina-pc/package.json",
      kind: "file",
    },
    {
      relativePath: "ui/index.html",
      label: "ui/index.html",
      kind: "file",
    },
  ]);
}

function buildCanonicalRuntimeBundle() {
  createEmptyCanonicalBundle();

  copyFileToStage(
    defaultsFilePath,
    path.join(canonicalBundlePayloadRoot, "config", "lumina-defaults.json"),
  );
  syncDirToStage(runtimeNodeDir, path.join(canonicalBundlePayloadRoot, "node"));
  const canonicalOpenClawDir = path.join(canonicalBundlePayloadRoot, "openclaw");
  syncDirToStage(packagedOpenClawDir, canonicalOpenClawDir);
  fs.rmSync(path.join(canonicalOpenClawDir, "dist", "control-ui"), {
    recursive: true,
    force: true,
  });
  syncDirToStage(
    path.join(packagedOpenClawDir, "dist", "control-ui"),
    path.join(canonicalBundlePayloadRoot, "ui"),
  );
  copyFileToStage(proxyEntryPath, path.join(canonicalBundlePayloadRoot, "proxy", "server.mjs"));
  copyFileToStage(
    proxyConfigPath,
    path.join(canonicalBundlePayloadRoot, "proxy", "proxy-config.json"),
  );
  copyFileToStage(
    luminaCodeVsixPath,
    path.join(canonicalBundlePayloadRoot, "lumina-code", luminaCodeVsixFileName),
  );

  log(`Prepared canonical runtime bundle payload: ${canonicalBundleRoot}`);
}

function writeCanonicalBundleManifest() {
  const desktopPackageJson = readPackageJson(desktopPackageJsonPath);
  const tauriConfig = readJsonFile(tauriConfigPath);
  const openClawPackageJson = readPackageJson(openClawPackageJsonPath);
  const appId =
    typeof tauriConfig.identifier === "string" && tauriConfig.identifier.trim().length > 0
      ? tauriConfig.identifier
      : "ai.lumina.desktop";
  const productName =
    typeof tauriConfig.productName === "string" && tauriConfig.productName.trim().length > 0
      ? tauriConfig.productName
      : "Lumina OpenClaw";

  const manifest = {
    $schema: "../../schemas/lumina-desktop-bundle.schema.json",
    schemaVersion: BUNDLE_MANIFEST_SCHEMA_VERSION,
    bundleId: "lumina-openclaw-desktop",
    bundleKind: "desktop-runtime",
    bundleVersion: desktopPackageJson.version,
    createdAt: new Date().toISOString(),
    channel: process.env.LUMINA_RELEASE_CHANNEL ?? "stable",
    platform: process.platform,
    arch: process.arch,
    product: {
      appId,
      productName,
      vendor: desktopPackageJson.author ?? "I24D",
    },
    source: {
      desktopPackageName: desktopPackageJson.name,
      desktopPackageVersion: desktopPackageJson.version,
      openClawPackageName: openClawPackageJson.name,
      openClawVersion: openClawPackageJson.version,
      hostNodeVersion: process.versions.node,
      lockfileSha256: computeDeploySignature(),
    },
    install: {
      payloadRoot: "payload",
      copyMode: "merge-contents-of-payload-root",
      launchStrategy: "desktop-runtime-bundle",
    },
    launch: {
      defaultsFile: "config/lumina-defaults.json",
      nodeExecutable: process.platform === "win32" ? "node/node.exe" : "node/node",
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
        sourcePath: defaultsFilePath,
      }),
      createBundleEntry({
        id: "runtime-node",
        kind: "runtime",
        bundleRelativePath: "payload/node",
        installRelativePath: "node",
        sourcePath: runtimeNodeDir,
        executable: true,
      }),
      createBundleEntry({
        id: "openclaw-runtime",
        kind: "content",
        bundleRelativePath: "payload/openclaw",
        installRelativePath: "openclaw",
        sourcePath: path.join(canonicalBundlePayloadRoot, "openclaw"),
      }),
      createBundleEntry({
        id: "openclaw-ui",
        kind: "ui",
        bundleRelativePath: "payload/ui",
        installRelativePath: "ui",
        sourcePath: path.join(canonicalBundlePayloadRoot, "ui"),
      }),
      createBundleEntry({
        id: "proxy-runtime",
        kind: "service",
        bundleRelativePath: "payload/proxy/server.mjs",
        installRelativePath: "proxy/server.mjs",
        sourcePath: proxyEntryPath,
      }),
      createBundleEntry({
        id: "proxy-config",
        kind: "config",
        bundleRelativePath: "payload/proxy/proxy-config.json",
        installRelativePath: "proxy/proxy-config.json",
        sourcePath: proxyConfigPath,
      }),
      createBundleEntry({
        id: "lumina-code-vsix",
        kind: "content",
        bundleRelativePath: luminaCodePayloadRelativePath,
        installRelativePath: luminaCodeBundleRelativePath,
        sourcePath: luminaCodeVsixPath,
      }),
    ],
  };

  validateBundleManifest(manifest);
  writeJsonFile(canonicalBundleManifestPath, manifest);
  log(`Wrote canonical bundle manifest: ${canonicalBundleManifestPath}`);
  return manifest;
}

function writeLegacyBundleSummary(manifest) {
  const hostNodeExecutable = fs.realpathSync(process.execPath);
  const bundledNodeExecutable = path.join(runtimeNodeDir, path.basename(hostNodeExecutable));

  const summary = {
    preparedAt: new Date().toISOString(),
    desktopRoot,
    openClawRoot,
    stagedOpenClawDir,
    canonicalBundleRoot,
    canonicalBundleManifestPath,
    bundle: {
      bundleId: manifest.bundleId,
      bundleVersion: manifest.bundleVersion,
      platform: manifest.platform,
      arch: manifest.arch,
    },
    hostNodeVersion: process.versions.node,
    assets: {
      bundledNodeExecutable,
      uiIndex: path.join(stagedOpenClawDir, "dist", "control-ui", "index.html"),
      stagedOpenClawEntry: path.join(stagedOpenClawDir, "openclaw.mjs"),
      stagedOpenClawPackageJson: path.join(stagedOpenClawDir, "package.json"),
      stagedOpenClawAssetsDir: path.join(stagedOpenClawDir, "assets"),
      stagedOpenClawDistDir: path.join(stagedOpenClawDir, "dist"),
      stagedOpenClawSkillsDir: path.join(stagedOpenClawDir, "skills"),
      stagedOpenClawScriptsDir: path.join(stagedOpenClawDir, "scripts"),
      proxyEntry: proxyEntryPath,
      proxyConfig: proxyConfigPath,
    },
  };

  writeJsonFile(bundleManifestPath, summary);
  log(`Wrote legacy bundle summary: ${bundleManifestPath}`);
}

function prepareBundledNodeRuntime() {
  const hostNodeExecutable = fs.realpathSync(process.execPath);
  const targetPath = path.join(runtimeNodeDir, path.basename(hostNodeExecutable));

  fs.mkdirSync(runtimeNodeDir, { recursive: true });
  fs.copyFileSync(hostNodeExecutable, targetPath);
  fs.chmodSync(targetPath, fs.statSync(hostNodeExecutable).mode);
  log(`Bundled host Node.js runtime v${process.versions.node}: ${targetPath}`);
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function computeDeploySignature() {
  return crypto
    .createHash("sha256")
    .update(readFileIfExists(path.join(openClawRoot, "package.json")))
    .update("\n---lockfile---\n")
    .update(readFileIfExists(path.join(openClawRoot, "pnpm-lock.yaml")))
    .update("\n---npmrc---\n")
    .update(readFileIfExists(openClawNpmrcPath))
    .update("\n---workspace---\n")
    .update(readFileIfExists(openClawWorkspacePath))
    .digest("hex");
}

function computeLegacyDeploySignature() {
  return crypto
    .createHash("sha256")
    .update(readFileIfExists(path.join(openClawRoot, "package.json")))
    .update("\n---lockfile---\n")
    .update(readFileIfExists(path.join(openClawRoot, "pnpm-lock.yaml")))
    .digest("hex");
}

function loadDeployStamp() {
  try {
    return JSON.parse(fs.readFileSync(deployStampPath, "utf8"));
  } catch {
    return null;
  }
}

function saveDeployStamp(signature) {
  fs.mkdirSync(path.dirname(deployStampPath), { recursive: true });
  fs.writeFileSync(
    deployStampPath,
    `${JSON.stringify(
      {
        signature,
        layoutVersion: PRODUCTION_DEPENDENCY_LAYOUT_VERSION,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function normalizePnpmPath(value) {
  return value.replaceAll("/", "\\").toLowerCase();
}

function productionInstallMetadataIsCurrent() {
  const modulesYamlPath = path.join(stagedOpenClawDir, "node_modules", ".modules.yaml");
  if (!fs.existsSync(modulesYamlPath)) {
    return false;
  }

  const modulesYaml = readFileIfExists(modulesYamlPath);
  if (!modulesYaml) {
    return false;
  }

  const normalizedModulesYaml = normalizePnpmPath(modulesYaml);
  const expectedVirtualStoreDir = normalizePnpmPath(
    path.join(stagedOpenClawDir, "node_modules", ".pnpm"),
  );
  let resolvedVirtualStoreDir = "";
  try {
    const parsedModulesYaml = JSON.parse(modulesYaml);
    if (typeof parsedModulesYaml.virtualStoreDir === "string") {
      resolvedVirtualStoreDir = normalizePnpmPath(parsedModulesYaml.virtualStoreDir);
    }
  } catch {
    // Fall back to a raw text match for older pnpm metadata formats.
  }

  if (
    resolvedVirtualStoreDir !== expectedVirtualStoreDir &&
    !normalizedModulesYaml.includes(expectedVirtualStoreDir)
  ) {
    return false;
  }

  return !normalizedModulesYaml.includes("openclaw-deploy-legacy");
}

function shouldRefreshProductionDependencies() {
  if (forceDeployRefresh) {
    return true;
  }
  if (!fs.existsSync(path.join(stagedOpenClawDir, "node_modules"))) {
    return true;
  }
  if (!fs.existsSync(path.join(stagedOpenClawDir, "openclaw.mjs"))) {
    return true;
  }
  if (!productionInstallMetadataIsCurrent()) {
    return true;
  }
  const signature = computeDeploySignature();
  const stamp = loadDeployStamp();
  if (!stamp?.signature) {
    saveDeployStamp(signature);
    return false;
  }
  if (
    stamp.layoutVersion === undefined &&
    stamp.signature === computeLegacyDeploySignature() &&
    productionInstallMetadataIsCurrent()
  ) {
    saveDeployStamp(signature);
    return false;
  }
  if (stamp.layoutVersion !== PRODUCTION_DEPENDENCY_LAYOUT_VERSION) {
    return true;
  }
  return stamp.signature !== signature;
}

function syncOpenClawRuntimeAssets() {
  fs.mkdirSync(stagedOpenClawDir, { recursive: true });

  fs.rmSync(path.join(stagedOpenClawDir, "docs"), { recursive: true, force: true });
  fs.rmSync(path.join(stagedOpenClawDir, "CHANGELOG.md"), { recursive: true, force: true });
  fs.rmSync(path.join(stagedOpenClawDir, "scripts"), { recursive: true, force: true });
  fs.rmSync(path.join(stagedOpenClawDir, ".npmrc"), { force: true });
  fs.rmSync(path.join(stagedOpenClawDir, "pnpm-workspace.yaml"), { force: true });
  fs.rmSync(path.join(stagedOpenClawDir, "patches"), { recursive: true, force: true });

  copyFileToStage(
    path.join(openClawRoot, "openclaw.mjs"),
    path.join(stagedOpenClawDir, "openclaw.mjs"),
  );
  copyFileToStage(
    path.join(openClawRoot, "package.json"),
    path.join(stagedOpenClawDir, "package.json"),
  );
  copyFileToStage(
    path.join(openClawRoot, "pnpm-lock.yaml"),
    path.join(stagedOpenClawDir, "pnpm-lock.yaml"),
  );
  if (fs.existsSync(openClawNpmrcPath)) {
    copyFileToStage(openClawNpmrcPath, path.join(stagedOpenClawDir, ".npmrc"));
  }
  if (fs.existsSync(openClawWorkspacePath)) {
    copyFileToStage(openClawWorkspacePath, path.join(stagedOpenClawDir, "pnpm-workspace.yaml"));
  }
  copyFileToStage(path.join(openClawRoot, "README.md"), path.join(stagedOpenClawDir, "README.md"));
  copyFileToStage(path.join(openClawRoot, "LICENSE"), path.join(stagedOpenClawDir, "LICENSE"));
  log("Syncing OpenClaw assets into the production deploy bundle.");
  syncDirToStage(path.join(openClawRoot, "assets"), path.join(stagedOpenClawDir, "assets"));
  log("Syncing OpenClaw runtime dist into the production deploy bundle.");
  syncDirToStage(path.join(openClawRoot, "dist"), path.join(stagedOpenClawDir, "dist"));
  syncBundledPluginRuntimeMetadata();
  log("Syncing OpenClaw skills into the production deploy bundle.");
  syncDirToStage(path.join(openClawRoot, "skills"), path.join(stagedOpenClawDir, "skills"));

  const refTemplatesSource = path.join(openClawRoot, "docs", "reference", "templates");
  if (fs.existsSync(refTemplatesSource)) {
    log("Syncing OpenClaw reference templates into the production deploy bundle.");
    syncDirToStage(
      refTemplatesSource,
      path.join(stagedOpenClawDir, "docs", "reference", "templates"),
    );
  }

  if (fs.existsSync(openClawPatchesDir)) {
    log("Syncing OpenClaw pnpm patches into the production deploy bundle.");
    syncDirToStage(openClawPatchesDir, path.join(stagedOpenClawDir, "patches"));
  }

  const scriptsStageDir = path.join(stagedOpenClawDir, "scripts");
  fs.mkdirSync(scriptsStageDir, { recursive: true });
  copyFileToStage(
    path.join(openClawRoot, "scripts", "npm-runner.mjs"),
    path.join(scriptsStageDir, "npm-runner.mjs"),
  );
  copyFileToStage(
    path.join(openClawRoot, "scripts", "postinstall-bundled-plugins.mjs"),
    path.join(scriptsStageDir, "postinstall-bundled-plugins.mjs"),
  );

  log(`Synced OpenClaw runtime assets into production deploy: ${stagedOpenClawDir}`);
}

function ensureOpenClawProductionDependencies() {
  if (!shouldRefreshProductionDependencies()) {
    log("Reusing cached OpenClaw production dependencies.");
    return;
  }

  log("Installing isolated production dependencies for the staged OpenClaw bundle.");
  fs.rmSync(path.join(stagedOpenClawDir, "node_modules"), { recursive: true, force: true });
  const installArgs = [
    "install",
    "--prod",
    "--ignore-scripts",
    "--no-frozen-lockfile",
    // The packaged desktop runtime cannot rely on pnpm symlink topology after
    // we materialize the bundle without symlinks, so hoist transitive runtime
    // deps into the root node_modules to keep CommonJS resolution intact.
    "--shamefully-hoist",
    "--config.confirmModulesPurge=false",
    // Official development-only dependencies can carry patches omitted from a production bundle.
    "--config.allowUnusedPatches=true",
  ];
  if (!fs.existsSync(path.join(stagedOpenClawDir, "pnpm-workspace.yaml"))) {
    installArgs.splice(3, 0, "--ignore-workspace");
  }
  run(pnpmCmd, installArgs, stagedOpenClawDir);
  pruneDesktopOnlyOptionalRuntimeDependencies();
  saveDeployStamp(computeDeploySignature());
}

function pruneDesktopOnlyOptionalRuntimeDependencies() {
  // OpenClaw's local embedding stack auto-installs node-llama-cpp as an optional
  // peer, but Lumina desktop does not require that package for first-run startup.
  // Keeping it in the desktop runtime adds ~700 MB and tens of thousands of extra
  // filesystem operations during extraction, which is unacceptable for installer UX.
  for (const relativePath of [
    path.join("node_modules", "node-llama-cpp"),
    path.join("node_modules", "@node-llama-cpp"),
  ]) {
    fs.rmSync(path.join(stagedOpenClawDir, relativePath), { recursive: true, force: true });
  }
}

function shouldPruneBundledNodeModulesFile(entryPath) {
  const fileName = path.basename(entryPath).toLowerCase();
  if (NODE_MODULES_KEEP_FILE_NAMES.has(fileName)) {
    return false;
  }
  if (NODE_MODULES_PRUNE_FILE_NAMES.has(fileName)) {
    return true;
  }

  return NODE_MODULES_PRUNE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function directoryContainsRuntimeModuleFiles(rootPath) {
  const pendingDirectories = [rootPath];

  while (pendingDirectories.length > 0) {
    const currentDir = pendingDirectories.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }

      if (
        entry.isFile() &&
        NODE_MODULES_RUNTIME_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        return true;
      }
    }
  }

  return false;
}

function shouldPruneBundledNodeModulesDirectory(entryPath) {
  const directoryName = path.basename(entryPath).toLowerCase();
  if (!NODE_MODULES_PRUNE_DIRECTORY_NAMES.has(directoryName)) {
    return false;
  }

  if (
    (directoryName === "doc" || directoryName === "docs") &&
    directoryContainsRuntimeModuleFiles(entryPath)
  ) {
    return false;
  }

  return true;
}

function measurePathFootprint(rootPath) {
  let fileCount = 0;
  let byteSize = 0;
  const pendingPaths = [rootPath];

  while (pendingPaths.length > 0) {
    const currentPath = pendingPaths.pop();
    if (!currentPath) {
      continue;
    }

    const stats = fs.lstatSync(currentPath);
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
        pendingPaths.push(path.join(currentPath, entry.name));
      }
      continue;
    }

    if (stats.isFile()) {
      fileCount += 1;
      byteSize += stats.size;
    }
  }

  return { fileCount, byteSize };
}

function pruneBundledNodeModulesForDesktop() {
  const nodeModulesRoot = path.join(stagedOpenClawDir, "node_modules");
  if (!fs.existsSync(nodeModulesRoot)) {
    return;
  }

  const pendingDirectories = [nodeModulesRoot];
  let removedFiles = 0;
  let removedDirectories = 0;
  let removedBytes = 0;

  while (pendingDirectories.length > 0) {
    const currentDir = pendingDirectories.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (shouldPruneBundledNodeModulesDirectory(entryPath)) {
          const digest = measurePathFootprint(entryPath);
          fs.rmSync(entryPath, { recursive: true, force: true });
          removedDirectories += 1;
          removedFiles += digest.fileCount;
          removedBytes += digest.byteSize;
          continue;
        }

        pendingDirectories.push(entryPath);
        continue;
      }

      if (!entry.isFile() || !shouldPruneBundledNodeModulesFile(entryPath)) {
        continue;
      }

      removedBytes += fs.statSync(entryPath).size;
      fs.rmSync(entryPath, { force: true });
      removedFiles += 1;
    }
  }

  const runtimeMapsDir = path.join(stagedOpenClawDir, "dist");
  if (fs.existsSync(runtimeMapsDir)) {
    for (const mapPath of walkFiles(runtimeMapsDir)) {
      if (!path.basename(mapPath).toLowerCase().endsWith(".map")) {
        continue;
      }
      removedBytes += fs.statSync(mapPath).size;
      fs.rmSync(mapPath, { force: true });
      removedFiles += 1;
    }
  }

  if (removedFiles > 0 || removedDirectories > 0) {
    log(
      `Pruned ${removedFiles} files and ${removedDirectories} directories ` +
        `(${(removedBytes / 1_048_576).toFixed(1)} MB) from the bundled desktop runtime.`,
    );
  }
}

function* walkFiles(rootDir) {
  const pendingDirectories = [rootDir];
  while (pendingDirectories.length > 0) {
    const currentDir = pendingDirectories.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }

      if (entry.isFile()) {
        yield entryPath;
      }
    }
  }
}

function hoistBundledExtensionRuntimeDeps() {
  const sourceExtensionsRoot = path.join(openClawRoot, "dist", "extensions");
  const stagedExtensionsRoot = path.join(stagedOpenClawDir, "dist", "extensions");
  const rootNodeModulesDir = path.join(stagedOpenClawDir, "node_modules");
  if (!fs.existsSync(sourceExtensionsRoot) || !fs.existsSync(rootNodeModulesDir)) {
    return;
  }

  log("Hoisting bundled extension runtime dependencies into the root production node_modules.");
  for (const extensionEntry of fs.readdirSync(sourceExtensionsRoot, { withFileTypes: true })) {
    if (!extensionEntry.isDirectory()) {
      continue;
    }
    const sourceExtensionNodeModulesDir = path.join(
      sourceExtensionsRoot,
      extensionEntry.name,
      "node_modules",
    );
    const stagedExtensionNodeModulesDir = path.join(
      stagedExtensionsRoot,
      extensionEntry.name,
      "node_modules",
    );
    if (!fs.existsSync(sourceExtensionNodeModulesDir)) {
      continue;
    }

    for (const depEntry of fs.readdirSync(sourceExtensionNodeModulesDir, { withFileTypes: true })) {
      if (depEntry.name.startsWith(".")) {
        continue;
      }

      const sourcePath = path.join(sourceExtensionNodeModulesDir, depEntry.name);
      const targetPath = path.join(rootNodeModulesDir, depEntry.name);

      if (depEntry.isDirectory() && depEntry.name.startsWith("@")) {
        fs.mkdirSync(targetPath, { recursive: true });
        for (const scopedEntry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
          if (!scopedEntry.isDirectory() || scopedEntry.name.startsWith(".")) {
            continue;
          }
          const scopedSourcePath = path.join(sourcePath, scopedEntry.name);
          const scopedTargetPath = path.join(targetPath, scopedEntry.name);
          if (shouldRefreshStagedDependency(scopedTargetPath)) {
            fs.rmSync(scopedTargetPath, { recursive: true, force: true });
            fs.cpSync(scopedSourcePath, scopedTargetPath, {
              recursive: true,
              force: true,
              dereference: true,
            });
          }
        }
        continue;
      }

      if (!depEntry.isDirectory() || !shouldRefreshStagedDependency(targetPath)) {
        continue;
      }

      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.cpSync(sourcePath, targetPath, {
        recursive: true,
        force: true,
        dereference: true,
      });
    }

    fs.rmSync(stagedExtensionNodeModulesDir, { recursive: true, force: true });
  }

  log("Hoisted bundled extension runtime dependencies into the root production node_modules.");
}

function stageEmbeddedAcpxRuntimeDependencies() {
  const acpxManifestPath = path.join(
    stagedOpenClawDir,
    "dist",
    "extensions",
    "acpx",
    "package.json",
  );
  if (!fs.existsSync(acpxManifestPath)) {
    return;
  }

  log("Staging embedded acpx Codex runtime dependencies.");
  const rootNodeModulesDir = path.join(stagedOpenClawDir, "node_modules");
  for (const dependencyName of EMBEDDED_ACPX_RUNTIME_DEPENDENCIES) {
    const dependencyPathParts = dependencyName.split("/");
    const sourcePath = path.join(openClawRoot, "node_modules", ...dependencyPathParts);
    const targetPath = path.join(rootNodeModulesDir, ...dependencyPathParts);
    ensureExists(sourcePath, `embedded acpx dependency ${dependencyName}`);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: true });
  }
}

function shouldRefreshStagedDependency(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return true;
  }

  if (!fs.lstatSync(targetPath).isDirectory()) {
    return false;
  }

  return !fs.existsSync(path.join(targetPath, "package.json"));
}

function sanitizeBundledExtensionPackageManifests() {
  const extensionsRoot = path.join(stagedOpenClawDir, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return;
  }

  let sanitizedCount = 0;
  for (const extensionEntry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!extensionEntry.isDirectory()) {
      continue;
    }

    const packageJsonPath = path.join(extensionsRoot, extensionEntry.name, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      let changed = false;
      // Runtime services such as acpx read dependency versions from their own
      // manifest to launch matching helpers via npx, even when modules are hoisted.
      for (const field of ["devDependencies", "peerDependencies", "peerDependenciesMeta"]) {
        if (packageJson[field] !== undefined) {
          delete packageJson[field];
          changed = true;
        }
      }

      if (!changed) {
        continue;
      }

      fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
      sanitizedCount += 1;
    } catch {
      // Ignore malformed plugin manifests; runtime will surface those separately.
    }
  }

  if (sanitizedCount > 0) {
    log(`Sanitized ${sanitizedCount} bundled extension package manifests for desktop packaging.`);
  }
}

function materializePackagedOpenClawRuntime() {
  fs.rmSync(packagedOpenClawDir, { recursive: true, force: true });
  copyPathResolvingSymlinks(stagedOpenClawDir, packagedOpenClawDir);
  log(`Materialized packaged OpenClaw runtime without symlinks: ${packagedOpenClawDir}`);
}

ensureExists(openClawRoot, "OpenClaw workspace");
ensureExists(toolProxyRoot, "tool-proxy directory");
ensureExists(desktopRoot, "desktop application");

const uiIndexPath = path.join(openClawRoot, "dist", "control-ui", "index.html");
const runtimeDistPath = path.join(openClawRoot, "dist");
const runtimeEntryPath = path.join(openClawRoot, "openclaw.mjs");
const proxyEntryPath = path.join(toolProxyRoot, "server.mjs");
const proxyConfigPath = path.join(toolProxyRoot, "proxy-config.json");
const macIconPath = path.join(desktopRoot, "assets", "icon.icns");
const defaultsFilePath = path.join(desktopRoot, "build", "lumina-defaults.json");
const shouldBuildOpenClawRuntime =
  forceRuntimeBuild || (!skipRuntimeBuild && !fs.existsSync(runtimeDistPath));

sanitizeOpenClawSourceRuntimeOverlays();

if (shouldBuildOpenClawRuntime) {
  run(pnpmCmd, ["--dir", openClawRoot, "build:docker"], repoRoot);
} else if (!skipRuntimeBuild && !forceRuntimeBuild) {
  log(
    "OpenClaw runtime artifacts already present; skipping build:docker. Use --build-openclaw to refresh them.",
  );
}

if (!skipUiBuild) {
  run(pnpmCmd, ["--dir", openClawRoot, "ui:build"], repoRoot);
} else {
  log("Skipping ui:build because LUMINA_SKIP_OPENCLAW_UI_BUILD=1 or --skip-ui-build was set.");
}

ensureExists(uiIndexPath, "OpenClaw control UI build");
ensureExists(runtimeEntryPath, "OpenClaw runtime entry");
ensureExists(openClawPackageJsonPath, "OpenClaw package.json");
ensureExists(desktopPackageJsonPath, "desktop package.json");
ensureExists(tauriConfigPath, "Tauri config");
ensureExists(defaultsFilePath, "Lumina defaults file");
ensureExists(path.join(openClawRoot, "assets"), "OpenClaw assets");
ensureExists(runtimeDistPath, "OpenClaw dist");
ensureExists(proxyEntryPath, "tool-proxy server");
ensureExists(proxyConfigPath, "tool-proxy config");
ensureExists(luminaCodeVsixPath, "Lumina Code VSIX");
verifyLuminaCodeVsixManifest(luminaCodeVsixPath);

if (skipRuntimePostbuild) {
  log(
    "Skipping OpenClaw runtime-postbuild because --skip-runtime-postbuild or LUMINA_SKIP_RUNTIME_POSTBUILD=1 was set.",
  );
} else {
  refreshOpenClawRuntimePostBuildArtifacts();
}
syncOpenClawRuntimeAssets();
ensureOpenClawProductionDependencies();
hoistBundledExtensionRuntimeDeps();
stageEmbeddedAcpxRuntimeDependencies();
sanitizeBundledExtensionPackageManifests();
pruneBundledNodeModulesForDesktop();
materializePackagedOpenClawRuntime();
validatePackagedOpenClawRuntime();
prepareBundledNodeRuntime();
if (skipCanonicalRuntimeBundle) {
  log("Skipping canonical runtime bundle payload assembly.");
} else {
  buildCanonicalRuntimeBundle();
  validateCanonicalRuntimeBundlePayload();
}

if (!fs.existsSync(macIconPath)) {
  log("assets/icon.icns is missing. macOS builds will use the PNG icon fallback.");
}

const canonicalBundleManifest = writeCanonicalBundleManifest();
writeLegacyBundleSummary(canonicalBundleManifest);
if (skipCanonicalRuntimeBundle) {
  log("Prepared installer bundle inputs without canonical runtime payload assembly.");
} else {
  log("Prepared canonical runtime bundle payload for installer packaging.");
}
log("Desktop bundle inputs are ready.");
