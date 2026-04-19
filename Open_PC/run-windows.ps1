# ─────────────────────────────────────────────────────────────────
# run-windows.ps1  —  OpenClaw development launcher for Windows
#
# Runs the TypeScript source directly via tsx (no build needed).
#
# Usage:
#   .\run-windows.ps1                     Opens setup wizard
#   .\run-windows.ps1 gateway run         Starts the gateway
#   .\run-windows.ps1 --help              Shows help
#   .\run-windows.ps1 onboard             Runs onboarding wizard
#
# Prerequisites (one-time):
#   pnpm install
#
# Note: If PowerShell blocks execution, run once as admin:
#   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# ─────────────────────────────────────────────────────────────────

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PassThruArgs
)

$ErrorActionPreference = "Stop"

# Move to project root
$root = $PSScriptRoot
Set-Location $root

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "[openclaw-dev] node.exe not found in PATH.`n             Install Node.js v22.12+ from https://nodejs.org"
    exit 1
}

# Check node_modules
if (-not (Test-Path "$root\node_modules")) {
    Write-Error "[openclaw-dev] node_modules not found.`n             Run first:  pnpm install"
    exit 1
}

# Launch via the Node.js dev launcher
$launcher = Join-Path $root "openclaw-dev.mjs"
& node $launcher @PassThruArgs
exit $LASTEXITCODE
