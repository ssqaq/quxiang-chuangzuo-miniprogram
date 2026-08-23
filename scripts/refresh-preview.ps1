param(
  [string]$CliPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Split-Path -Parent $projectRoot
$configPath = Join-Path $projectRoot "config.js"
$configText = Get-Content -LiteralPath $configPath -Raw

if ($configText -notmatch 'appVersion:\s*"([^"]+)"') {
  throw "config.js does not contain appVersion."
}

$version = $Matches[1]
$qrPath = Join-Path $outputRoot "wechat-miniapp-preview-v$version-qr.png"
$infoPath = Join-Path $outputRoot "wechat-miniapp-preview-v$version-info.json"

if ([string]::IsNullOrWhiteSpace($CliPath)) {
  $CliPath = $env:WECHAT_DEVTOOLS_CLI
}

if ([string]::IsNullOrWhiteSpace($CliPath)) {
  $toolName = -join ([char[]](0x5fae, 0x4fe1, 0x5f00, 0x53d1, 0x8005, 0x5de5, 0x5177))
  $CliPath = "D:\$toolName\cli.bat"
}

if (-not (Test-Path -LiteralPath $CliPath)) {
  throw "WeChat DevTools CLI not found: $CliPath"
}

Push-Location $projectRoot
try {
  Write-Host "[$version] 1/3 validate"
  & node scripts/validate.js
  if ($LASTEXITCODE -ne 0) {
    throw "Validation failed. Preview was not generated."
  }

  Write-Host "[$version] 2/3 package"
  & python scripts/package-release.py
  if ($LASTEXITCODE -ne 0) {
    throw "Packaging failed. Preview was not generated."
  }

  Write-Host "[$version] 3/3 preview"
  & $CliPath preview `
    --project $projectRoot `
    --qr-format image `
    --qr-output $qrPath `
    --info-output $infoPath
  if ($LASTEXITCODE -ne 0) {
    throw "WeChat preview failed."
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $qrPath)) {
  throw "Preview returned success but QR file is missing: $qrPath"
}
if (-not (Test-Path -LiteralPath $infoPath)) {
  throw "Preview returned success but info file is missing: $infoPath"
}

$qr = Get-Item -LiteralPath $qrPath
Write-Host "Preview complete: $qrPath"
Write-Host "QR bytes: $($qr.Length)"
Write-Host "Info file: $infoPath"
