param(
  [string]$Source = "C:\I24D_WhatsApp\Lumina_PC\tool-proxy\server.mjs",
  [string]$Target = "C:\Program Files\Lumina OpenClaw\proxy\server.mjs"
)

$ErrorActionPreference = "Stop"

$Source = [System.IO.Path]::GetFullPath($Source)
$Target = [System.IO.Path]::GetFullPath($Target)
$InstallRoot = [System.IO.Path]::GetFullPath("C:\Program Files\Lumina OpenClaw")
$TargetDir = [System.IO.Path]::GetDirectoryName($Target)

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Source proxy file not found: $Source"
}

if (-not $Target.StartsWith($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to patch outside Lumina install root: $Target"
}

if (-not (Test-Path -LiteralPath $TargetDir -PathType Container)) {
  throw "Target proxy directory not found: $TargetDir"
}

$Backup = "$Target.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
if (Test-Path -LiteralPath $Target -PathType Leaf) {
  Copy-Item -LiteralPath $Target -Destination $Backup -Force
}

Copy-Item -LiteralPath $Source -Destination $Target -Force

$ProxyProcesses = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -ieq "node.exe" -and
    $_.CommandLine -like "*C:\Program Files\Lumina OpenClaw\proxy\server.mjs*"
  }

foreach ($Process in $ProxyProcesses) {
  Stop-Process -Id $Process.ProcessId -Force
}

Start-Sleep -Seconds 2

$NodePath = "C:\Program Files\Lumina OpenClaw\node\node.exe"
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "Installed Node runtime not found: $NodePath"
}

Start-Process -FilePath $NodePath -ArgumentList @($Target) -WorkingDirectory $TargetDir -WindowStyle Hidden

Write-Host "Lumina proxy hotfix applied."
Write-Host "Backup: $Backup"
