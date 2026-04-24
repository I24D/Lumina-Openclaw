#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

const generatedPaths = [
  path.join(appRoot, "dist"),
  path.join(appRoot, "release"),
  path.join(appRoot, "build"),
];

const skippedDirNames = new Set(["node_modules", ".git"]);

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function removeResidualUnpackedDirs(rootDir) {
  const pendingDirs = [rootDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    let dirents = [];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const childPath = path.join(currentDir, dirent.name);
      if (dirent.name.endsWith("-unpacked")) {
        removePath(childPath);
        continue;
      }

      if (skippedDirNames.has(dirent.name)) {
        continue;
      }

      pendingDirs.push(childPath);
    }
  }
}

for (const targetPath of generatedPaths) {
  removePath(targetPath);
}

removeResidualUnpackedDirs(appRoot);
