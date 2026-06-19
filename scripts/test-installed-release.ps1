param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,

  [int]$DurationSeconds = 120
)

$ErrorActionPreference = "Stop"
$setup = (Resolve-Path -LiteralPath $SetupPath).Path
$installRoot = Join-Path $env:ProgramFiles "Lumina OpenClaw"

Write-Host "[lumina-smoke] Installing $setup"
$installer = Start-Process -FilePath $setup -ArgumentList "/S" -Wait -PassThru
if ($installer.ExitCode -ne 0) {
  throw "NSIS installer exited with code $($installer.ExitCode)."
}

$required = @(
  (Join-Path $installRoot "lumina-desktop-tauri.exe"),
  (Join-Path $installRoot "runtime-tools\lumina-bootstrapper.exe"),
  (Join-Path $installRoot "runtime-tools\lumina-voice.exe"),
  (Join-Path $installRoot "openclaw\openclaw.mjs"),
  (Join-Path $installRoot "openclaw\node_modules\@agentclientprotocol\claude-agent-acp\dist\lib.js"),
  (Join-Path $installRoot "openclaw\node_modules\@anthropic-ai\claude-agent-sdk\sdk.mjs"),
  (Join-Path $installRoot "openclaw\dist\extensions\lumina-memory\openclaw.plugin.json"),
  (Join-Path $installRoot "openclaw\dist\extensions\lumina-observation\openclaw.plugin.json"),
  (Join-Path $installRoot "openclaw\dist\extensions\lumina-presence\openclaw.plugin.json"),
  (Join-Path $installRoot "openclaw\dist\extensions\lumina-input-control\openclaw.plugin.json")
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Installed release is incomplete: $path"
  }
}

$shellPath = Join-Path $installRoot "lumina-desktop-tauri.exe"
$shell = Start-Process -FilePath $shellPath -PassThru
$deadline = (Get-Date).AddMinutes(10)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $gateway = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:18789/health" -TimeoutSec 3
    $proxy = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4321/health" -TimeoutSec 3
    if ($gateway.StatusCode -eq 200 -and $proxy.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 5
  }
}
if (-not $ready) {
  throw "Installed Lumina did not become healthy before the startup deadline."
}

$sessionPath = Join-Path $env:USERPROFILE ".lumina\runtime-manager\runtime-session.json"
$firstManagerPid = $null
$firstGatewayPid = $null
$samples = [Math]::Max(1, [Math]::Ceiling($DurationSeconds / 5))
for ($index = 0; $index -lt $samples; $index++) {
  if ($shell.HasExited) {
    throw "Lumina desktop shell exited during the smoke test."
  }
  $session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
  $managerPid = $session.activeSession.managerPid
  $gatewayPid = $session.activeSession.gatewayPid
  if (-not $firstManagerPid) {
    $firstManagerPid = $managerPid
    $firstGatewayPid = $gatewayPid
  } elseif ($managerPid -ne $firstManagerPid -or $gatewayPid -ne $firstGatewayPid) {
    throw "Watchdog restart detected: manager $firstManagerPid->$managerPid, gateway $firstGatewayPid->$gatewayPid."
  }
  $gateway = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:18789/health" -TimeoutSec 3
  $proxy = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4321/health" -TimeoutSec 3
  if ($gateway.StatusCode -ne 200 -or $proxy.StatusCode -ne 200) {
    throw "Runtime health check failed during the smoke test."
  }
  Start-Sleep -Seconds 5
}

Write-Host "[lumina-smoke] Stable for $DurationSeconds seconds. Manager PID=$firstManagerPid Gateway PID=$firstGatewayPid"
