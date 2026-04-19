@echo off
:: ─────────────────────────────────────────────────────────────────
:: run-windows.bat  —  OpenClaw development launcher for Windows
::
:: Runs the TypeScript source directly via tsx (no build needed).
::
:: Usage:
::   run-windows.bat                     Opens setup wizard
::   run-windows.bat gateway run         Starts the gateway
::   run-windows.bat --help              Shows help
::   run-windows.bat onboard             Runs onboarding wizard
::
:: Prerequisites (one-time):
::   pnpm install
:: ─────────────────────────────────────────────────────────────────
setlocal EnableDelayedExpansion

:: Move to the project root (same folder as this script)
cd /d "%~dp0"

:: Check Node.js is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [openclaw-dev] ERROR: node.exe not found in PATH.
    echo             Install Node.js v22.12+ from https://nodejs.org
    exit /b 1
)

:: Check node_modules exist
if not exist "%~dp0node_modules" (
    echo [openclaw-dev] ERROR: node_modules not found.
    echo             Run first:  pnpm install
    exit /b 1
)

:: Launch via the Node.js dev launcher
node "%~dp0openclaw-dev.mjs" %*
exit /b %errorlevel%
