/**
 * screen-capture.ts
 * Tool: lumina_screen_capture
 *
 * Takes a screenshot of the primary monitor using PowerShell + .NET
 * and returns it as a base64-encoded PNG, plus optional OCR text.
 *
 * OCR uses Windows.Media.Ocr.OcrEngine (available on Win 10+).
 * No external dependencies required.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { imageResultFromFile, jsonResult } from "../../../../src/agents/tools/common.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { runPowerShell, psEscape } from "../utils/powershell.js";

const SCREENSHOT_PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screens = [System.Windows.Forms.Screen]::AllScreens
$primary = $screens | Where-Object { $_.Primary } | Select-Object -First 1
if (-not $primary) { $primary = $screens[0] }

$bounds = $primary.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$graphics.Dispose()

$bitmap.Save("{OUTPATH}", [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Output ("{WIDTH}x{HEIGHT}" -f $bounds.Width, $bounds.Height)
`.trimStart();

const OCR_PS = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]

function Await($WinRtTask, $ResultType) {
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethod("AsTask", @($WinRtTask.GetType()))
    if ($asTask) { return $asTask.Invoke($null, @($WinRtTask)).Result }
    return $WinRtTask.GetResults()
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
    Write-Output ""
    exit 0
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync("{IMGPATH}")) $null
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) $null
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) $null
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) $null
$result = Await ($engine.RecognizeAsync($bitmap)) $null
$stream.Dispose()

Write-Output ($result.Lines | ForEach-Object { $_.Text } | Join-String -Separator " ")
`.trimStart();

export type ScreenCaptureConfig = {
  screenshotDir?: string;
};

export function createScreenCaptureTool(config: ScreenCaptureConfig = {}): AnyAgentTool {
  return {
    name: "lumina_screen_capture",
    description:
      "Takes a screenshot of the primary monitor and returns it as an image. " +
      "Optionally extracts visible text using Windows OCR (Windows 10+ built-in). " +
      "Use this so I24D can see what is currently on the screen.",
    parameters: Type.Object({
      ocr: Type.Optional(
        Type.Boolean({
          description:
            "If true, also extract visible text via Windows OCR and include in the result. Default: false.",
        }),
      ),
      return_image: Type.Optional(
        Type.Boolean({
          description: "If true (default), include the screenshot image in the result.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      if (process.platform !== "win32") {
        return jsonResult({
          ok: false,
          error: "lumina_screen_capture is only available on Windows.",
        });
      }

      const screenshotDir =
        config.screenshotDir ?? path.join(os.tmpdir(), "lumina-pc-screenshots");

      await fs.mkdir(screenshotDir, { recursive: true });

      const filename = `screenshot-${Date.now()}.png`;
      const outPath = path.join(screenshotDir, filename);

      // Take screenshot
      const screenshotCmd = SCREENSHOT_PS
        .replace("{OUTPATH}", psEscape(outPath))
        .replace(/\{WIDTH\}/g, "")
        .replace(/\{HEIGHT\}/g, "");

      const ssResult = await runPowerShell(
        `$bounds = ([System.Windows.Forms.Screen]::PrimaryScreen).Bounds; ` +
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `Add-Type -AssemblyName System.Drawing; ` +
        `$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); ` +
        `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
        `$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); ` +
        `$g.Dispose(); ` +
        `$bmp.Save("${psEscape(outPath)}", [System.Drawing.Imaging.ImageFormat]::Png); ` +
        `$bmp.Dispose(); ` +
        `Write-Output "$($bounds.Width)x$($bounds.Height)"`,
        20_000,
      );

      if (!ssResult.ok) {
        return jsonResult({
          ok: false,
          error: `Screenshot failed: ${ssResult.error ?? ssResult.stderr}`,
        });
      }

      const resolution = ssResult.stdout.trim();
      let ocrText: string | undefined;

      if (params.ocr === true) {
        const ocrCmd =
          `Add-Type -AssemblyName System.Runtime.WindowsRuntime; ` +
          `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages(); ` +
          `if ($engine) { ` +
          `  $file = [Windows.Storage.StorageFile]::GetFileFromPathAsync("${psEscape(outPath)}").GetAwaiter().GetResult(); ` +
          `  $stream = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read).GetAwaiter().GetResult(); ` +
          `  $decoder = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream).GetAwaiter().GetResult(); ` +
          `  $bitmap = $decoder.GetSoftwareBitmapAsync().GetAwaiter().GetResult(); ` +
          `  $result = $engine.RecognizeAsync($bitmap).GetAwaiter().GetResult(); ` +
          `  $stream.Dispose(); ` +
          `  $result.Lines | ForEach-Object { $_.Text } | Join-String -Separator " " ` +
          `} else { Write-Output "" }`;

        const ocrResult = await runPowerShell(ocrCmd, 30_000);
        ocrText = ocrResult.ok ? ocrResult.stdout.trim() : undefined;
      }

      const returnImage = params.return_image !== false;

      if (returnImage) {
        const imgResult = await imageResultFromFile({
          label: "Screenshot",
          path: outPath,
          extraText: [
            `Screenshot captured at ${new Date().toISOString()}`,
            resolution ? `Resolution: ${resolution}` : "",
            ocrText ? `\nOCR text:\n${ocrText}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          details: {
            resolution,
            path: outPath,
            ocr_text: ocrText,
            timestamp: new Date().toISOString(),
          },
        });
        return imgResult;
      }

      // Return metadata only
      return jsonResult({
        ok: true,
        path: outPath,
        resolution,
        ocr_text: ocrText,
        timestamp: new Date().toISOString(),
      });
    },
  };
}
