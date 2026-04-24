#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { StdioOptions } from "node:child_process";

function existingFile(candidate) {
  return candidate && fs.existsSync(candidate) ? candidate : "";
}

function existingDirectory(candidate) {
  return candidate && fs.existsSync(candidate) ? candidate : "";
}

function normalizeEnvPath(value) {
  return value?.trim().replace(/^"+|"+$/g, "") ?? "";
}

function resolveVsWherePath(env = process.env) {
  const candidates = [
    normalizeEnvPath(env.VSWHERE),
    path.join(
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "Installer",
      "vswhere.exe",
    ),
    path.join(
      env.ProgramFiles ?? "C:\\Program Files",
      "Microsoft Visual Studio",
      "Installer",
      "vswhere.exe",
    ),
  ];

  return candidates.map(existingFile).find(Boolean) ?? "";
}

export function resolveVisualStudioInstallRoot(env = process.env) {
  const explicit = existingDirectory(normalizeEnvPath(env.VSINSTALLDIR));
  if (explicit) {
    return explicit;
  }

  const vswherePath = resolveVsWherePath(env);
  if (vswherePath) {
    const result = spawnSync(
      vswherePath,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    if ((result.status ?? 1) === 0) {
      const resolved = existingDirectory(result.stdout.trim());
      if (resolved) {
        return resolved;
      }
    }
  }

  const fallbackRoots = [
    "C:\\BuildTools",
    path.join(
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "2022",
      "BuildTools",
    ),
    path.join(
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "2022",
      "Community",
    ),
    path.join(
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "2022",
      "Professional",
    ),
    path.join(
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "2022",
      "Enterprise",
    ),
  ];

  return fallbackRoots.map(existingDirectory).find(Boolean) ?? "";
}

export function resolveVcvars64Path(env = process.env) {
  const explicit = existingFile(normalizeEnvPath(env.VCVARS64_BAT));
  if (explicit) {
    return explicit;
  }

  const installRoot = resolveVisualStudioInstallRoot(env);
  if (installRoot) {
    const candidate = existingFile(path.join(installRoot, "VC", "Auxiliary", "Build", "vcvars64.bat"));
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

export function quoteWindowsBatchArgument(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function buildWindowsMsvcBatchScript({
  vcvarsPath,
  commandPath,
  args = [],
  prependPathEntries = [],
  envVars = {},
}) {
  const pathPrefix = prependPathEntries.filter(Boolean).join(";");
  const commandLine = [
    quoteWindowsBatchArgument(commandPath),
    ...args.map((entry) => quoteWindowsBatchArgument(entry)),
  ].join(" ");

  const lines = [
    "@echo off",
    `call ${quoteWindowsBatchArgument(vcvarsPath)}`,
    "if errorlevel 1 exit /b %errorlevel%",
  ];

  if (pathPrefix) {
    lines.push(`set "PATH=${pathPrefix};%PATH%"`);
  }

  for (const [key, value] of Object.entries(envVars)) {
    if (value) {
      lines.push(`set "${key}=${value}"`);
    }
  }

  lines.push(commandLine);
  lines.push("exit /b %errorlevel%");
  return `${lines.join("\r\n")}\r\n`;
}

export function runInWindowsMsvcEnv({
  vcvarsPath,
  commandPath,
  args = [],
  cwd,
  env = process.env,
  prependPathEntries = [],
  envVars = {},
  stdio = "inherit",
}: {
  vcvarsPath: string;
  commandPath: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prependPathEntries?: string[];
  envVars?: Record<string, string>;
  stdio?: StdioOptions;
}) {
  const tempScriptPath = path.join(
    os.tmpdir(),
    `lumina-msvc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.cmd`,
  );

  fs.writeFileSync(
    tempScriptPath,
    buildWindowsMsvcBatchScript({
      vcvarsPath,
      commandPath,
      args,
      prependPathEntries,
      envVars,
    }),
    "utf8",
  );

  try {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", tempScriptPath], {
      cwd,
      env,
      stdio,
    });
  } finally {
    fs.rmSync(tempScriptPath, { force: true });
  }
}
