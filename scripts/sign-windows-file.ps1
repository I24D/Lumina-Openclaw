param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = "Stop"

if ($env:LUMINA_REQUIRE_WINDOWS_SIGNING -ne "1") {
  throw "LUMINA_REQUIRE_WINDOWS_SIGNING=1 is required for the signed release pipeline."
}

$thumbprint = [string]$env:WINDOWS_CERTIFICATE_THUMBPRINT
$thumbprint = $thumbprint.Replace(" ", "").Trim()
if (-not $thumbprint) {
  throw "WINDOWS_CERTIFICATE_THUMBPRINT is not configured."
}

$timestampUrl = if ($env:WINDOWS_TIMESTAMP_URL) {
  $env:WINDOWS_TIMESTAMP_URL
} else {
  "http://timestamp.digicert.com"
}

$signTool = $env:SIGNTOOL_PATH
if (-not $signTool) {
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $signTool = Get-ChildItem -LiteralPath $kitsRoot -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signTool -or -not (Test-Path -LiteralPath $signTool)) {
  throw "signtool.exe was not found."
}

foreach ($path in $Paths) {
  $resolved = (Resolve-Path -LiteralPath $path).Path
  & $signTool sign /sha1 $thumbprint /fd SHA256 /tr $timestampUrl /td SHA256 /v $resolved
  if ($LASTEXITCODE -ne 0) {
    throw "signtool failed for $resolved with exit code $LASTEXITCODE."
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($signature.Status -ne "Valid") {
    throw "Authenticode verification failed for ${resolved}: $($signature.StatusMessage)"
  }
  Write-Host "[lumina-sign] Valid signature: $resolved"
}
