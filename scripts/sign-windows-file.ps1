param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = "Stop"

if ($env:LUMINA_REQUIRE_WINDOWS_SIGNING -ne "1") {
  throw "LUMINA_REQUIRE_WINDOWS_SIGNING=1 is required for the signed release pipeline."
}

$provider = [string]$env:WINDOWS_SIGNING_PROVIDER
if (-not $provider) {
  $provider = "pfx"
}
$provider = $provider.Trim().ToLowerInvariant()

$resolvedPaths = @()
foreach ($path in $Paths) {
  $resolvedPaths += (Resolve-Path -LiteralPath $path).Path
}

if ($provider -eq "artifact-signing") {
  $endpoint = [string]$env:ARTIFACT_SIGNING_ENDPOINT
  $accountName = [string]$env:ARTIFACT_SIGNING_ACCOUNT_NAME
  $profileName = [string]$env:ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME
  foreach ($required in @{
    ARTIFACT_SIGNING_ENDPOINT = $endpoint
    ARTIFACT_SIGNING_ACCOUNT_NAME = $accountName
    ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME = $profileName
    AZURE_CLIENT_ID = [string]$env:AZURE_CLIENT_ID
    AZURE_CLIENT_SECRET = [string]$env:AZURE_CLIENT_SECRET
    AZURE_TENANT_ID = [string]$env:AZURE_TENANT_ID
  }.GetEnumerator()) {
    if (-not $required.Value) {
      throw "$($required.Key) is not configured."
    }
  }

  $trustedSigningCli = Get-Command "trusted-signing-cli" -ErrorAction SilentlyContinue
  if (-not $trustedSigningCli) {
    throw "trusted-signing-cli was not found. Install it with: cargo install artifact-signing-cli"
  }

  foreach ($resolved in $resolvedPaths) {
    & $trustedSigningCli.Source `
      -e $endpoint `
      -a $accountName `
      -c $profileName `
      -d "Lumina OpenClaw" `
      $resolved
    if ($LASTEXITCODE -ne 0) {
      throw "trusted-signing-cli failed for $resolved with exit code $LASTEXITCODE."
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -ne "Valid") {
      throw "Artifact Signing verification failed for ${resolved}: $($signature.StatusMessage)"
    }
    Write-Host "[lumina-sign] Valid Artifact Signing signature: $resolved"
  }
  exit 0
}

if ($provider -ne "pfx") {
  throw "Unsupported WINDOWS_SIGNING_PROVIDER: $provider"
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

foreach ($resolved in $resolvedPaths) {
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
