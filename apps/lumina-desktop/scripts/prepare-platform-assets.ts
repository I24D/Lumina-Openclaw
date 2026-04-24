#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const assetsDir = path.join(desktopRoot, "assets");
const pngIconPath = path.join(assetsDir, "icon.png");
const icoIconPath = path.join(assetsDir, "icon.ico");
const icnsIconPath = path.join(assetsDir, "icon.icns");

function log(message) {
  process.stdout.write(`[lumina-assets] ${message}\n`);
}

function run(command, args, envOverrides = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...envOverrides },
  });

  if (result.error) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 1}`);
  }
}

function generateMacIcon() {
  if (process.platform !== "darwin") {
    log("Skipping macOS icon generation on non-macOS host.");
    return;
  }

  if (!fs.existsSync(pngIconPath)) {
    throw new Error(`Missing source PNG icon: ${pngIconPath}`);
  }

  const iconsetDir = path.join(os.tmpdir(), `lumina-iconset-${process.pid}`);
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  const iconVariants: Array<[number, string]> = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];

  try {
    for (const [size, filename] of iconVariants) {
      run("sips", ["-z", String(size), String(size), pngIconPath, "--out", path.join(iconsetDir, filename)]);
    }
    run("iconutil", ["-c", "icns", iconsetDir, "-o", icnsIconPath]);
    log(`Generated macOS icon: ${icnsIconPath}`);
  } finally {
    fs.rmSync(iconsetDir, { recursive: true, force: true });
  }
}

function generateWindowsIcon() {
  if (process.platform !== "win32") {
    log("Skipping Windows icon generation on non-Windows host.");
    return;
  }

  if (!fs.existsSync(pngIconPath)) {
    throw new Error(`Missing source PNG icon: ${pngIconPath}`);
  }

  const windowsIconScript = `
Add-Type -AssemblyName System.Drawing
$SourcePng = $env:LUMINA_ICON_SOURCE_PNG
$DestinationIco = $env:LUMINA_ICON_DEST_ICO
$ErrorActionPreference = "Stop"
$tempPngPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.Guid]::NewGuid().ToString() + ".png")
$sourceImage = [System.Drawing.Image]::FromFile($SourcePng)
try {
  $bitmap = New-Object System.Drawing.Bitmap 256, 256
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($sourceImage, 0, 0, 256, 256)
      $bitmap.Save($tempPngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
    }
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $sourceImage.Dispose()
}

$pngBytes = [System.IO.File]::ReadAllBytes($tempPngPath)
$destinationDir = Split-Path -Parent $DestinationIco
if ($destinationDir) {
  [System.IO.Directory]::CreateDirectory($destinationDir) | Out-Null
}
$stream = [System.IO.File]::Open($DestinationIco, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($stream)
try {
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]1)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$pngBytes.Length)
  $writer.Write([UInt32]22)
  $writer.Write($pngBytes)
} finally {
  $writer.Dispose()
  $stream.Dispose()
  if (Test-Path -LiteralPath $tempPngPath) {
    Remove-Item -LiteralPath $tempPngPath -Force
  }
}
`;

  run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsIconScript,
  ], {
    LUMINA_ICON_SOURCE_PNG: pngIconPath,
    LUMINA_ICON_DEST_ICO: icoIconPath,
  });
  log(`Generated Windows icon: ${icoIconPath}`);
}

generateWindowsIcon();
generateMacIcon();
