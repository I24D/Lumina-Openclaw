param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $repoRoot "apps\lumina-desktop"
$required = @(
  (Resolve-Path -LiteralPath $SetupPath).Path,
  (Join-Path $desktopRoot "src-tauri\target\release\lumina-desktop-tauri.exe"),
  (Join-Path $desktopRoot "build\runtime-tools\lumina-bootstrapper.exe"),
  (Join-Path $desktopRoot "build\runtime-tools\lumina-voice.exe")
)

foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required Windows release binary is missing: $path"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne "Valid") {
    throw "Invalid or missing Authenticode signature: $path ($($signature.Status))"
  }
  Write-Host "[lumina-verify] Signed: $path"
}

$expectedVersion = (Get-Content -LiteralPath (Join-Path $desktopRoot "package.json") -Raw | ConvertFrom-Json).version
if ([System.IO.Path]::GetFileName($SetupPath) -notmatch [regex]::Escape($expectedVersion)) {
  throw "Setup filename does not contain expected version $expectedVersion."
}

Write-Host "[lumina-verify] Windows release verification passed for version $expectedVersion."
