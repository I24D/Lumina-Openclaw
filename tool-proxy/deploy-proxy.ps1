# deploy-proxy.ps1  — Run as Administrator
# Copies the updated server.mjs to the installed Lumina OpenClaw proxy
# and restarts the proxy process.

$src  = "C:\I24D_WhatsApp\Lumina_PC\tool-proxy\server.mjs"
$dest = "C:\Program Files\Lumina OpenClaw\proxy\server.mjs"

Write-Host "Stopping existing proxy processes..." -ForegroundColor Cyan
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
  $_.MainModule.FileName -match "node" -and
  (Get-WmiObject Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine -match "server\.mjs"
} | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Milliseconds 500

Write-Host "Copying updated server.mjs ..." -ForegroundColor Cyan
Copy-Item -Path $src -Destination $dest -Force
if (-not $?) {
  Write-Host "ERROR: Copy failed. Make sure you are running as Administrator." -ForegroundColor Red
  pause
  exit 1
}

Write-Host "Deployed OK -> $dest" -ForegroundColor Green

# Optionally restart proxy via Lumina runtime manager if the app is running
$runtimeSession = Join-Path $env:USERPROFILE ".lumina\runtime-manager\runtime-session.json"
if (Test-Path $runtimeSession) {
  $session = Get-Content $runtimeSession | ConvertFrom-Json
  Write-Host "Proxy entry: $($session.proxyEntryPath)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Done. Restart Lumina OpenClaw to reload the proxy." -ForegroundColor Yellow
Write-Host "Or run: node `"$dest`" to test it manually." -ForegroundColor Gray
pause
