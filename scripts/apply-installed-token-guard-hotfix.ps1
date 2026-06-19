param(
  [string]$InstallRoot = "C:\Program Files\Lumina OpenClaw"
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  throw "Run this script from an elevated PowerShell window so Program Files can be updated."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$payloadRoot = Join-Path $repoRoot "apps\lumina-desktop\build\runtime-bundle\payload"
$timestamp = Get-Date -Format "yyyyMMddHHmmss"
$backupRoot = Join-Path $InstallRoot "codex-token-guard-backups\$timestamp"

$copyPairs = @(
  @{
    Source = Join-Path $payloadRoot "proxy\server.mjs"
    Target = Join-Path $InstallRoot "proxy\server.mjs"
  },
  @{
    Source = Join-Path $payloadRoot "openclaw\dist\extensions\lumina-pc\index.js"
    Target = Join-Path $InstallRoot "openclaw\dist\extensions\lumina-pc\index.js"
  },
  @{
    Source = Join-Path $payloadRoot "openclaw\dist\attempt.tool-run-context-DVk9Vlyx.js"
    Target = Join-Path $InstallRoot "openclaw\dist\attempt.tool-run-context-DVk9Vlyx.js"
  },
  @{
    Source = Join-Path $payloadRoot "openclaw\dist\bash-process-registry-DU_0t2zf.js"
    Target = Join-Path $InstallRoot "openclaw\dist\bash-process-registry-DU_0t2zf.js"
  },
  @{
    Source = Join-Path $payloadRoot "openclaw\dist\session-write-lock-_a5O1H8L.js"
    Target = Join-Path $InstallRoot "openclaw\dist\session-write-lock-_a5O1H8L.js"
  },
  @{
    Source = Join-Path $payloadRoot "openclaw\dist\runtime-schema-GQm0yEH6.js"
    Target = Join-Path $InstallRoot "openclaw\dist\runtime-schema-GQm0yEH6.js"
  },
  @{
    Source = Join-Path $payloadRoot "openclaw\dist\types.base-DS--yneR.d.ts"
    Target = Join-Path $InstallRoot "openclaw\dist\types.base-DS--yneR.d.ts"
  }
)

foreach ($pair in $copyPairs) {
  if (-not (Test-Path -LiteralPath $pair.Source)) {
    throw "Missing source artifact: $($pair.Source)"
  }
  if (-not (Test-Path -LiteralPath $pair.Target)) {
    throw "Missing installed artifact: $($pair.Target)"
  }
}

$uiSource = Join-Path $payloadRoot "ui"
$uiTarget = Join-Path $InstallRoot "ui"
if (-not (Test-Path -LiteralPath $uiSource)) {
  throw "Missing source UI artifact: $uiSource"
}
if (-not (Test-Path -LiteralPath $uiTarget)) {
  throw "Missing installed UI directory: $uiTarget"
}

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

foreach ($pair in $copyPairs) {
  $relative = $pair.Target.Substring($InstallRoot.Length).TrimStart("\", "/")
  $backupPath = Join-Path $backupRoot $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
  Copy-Item -LiteralPath $pair.Target -Destination $backupPath -Force
  Copy-Item -LiteralPath $pair.Source -Destination $pair.Target -Force
}

$uiBackup = Join-Path $backupRoot "ui"
Copy-Item -LiteralPath $uiTarget -Destination $uiBackup -Recurse -Force
Copy-Item -Path (Join-Path $uiSource "*") -Destination $uiTarget -Recurse -Force

Write-Host "Lumina OpenClaw token/output guard hotfix installed."
Write-Host "Backup: $backupRoot"
