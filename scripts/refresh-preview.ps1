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
$latestQrPath = Join-Path $outputRoot "wechat-miniapp-preview-latest-qr.png"
$latestInfoPath = Join-Path $outputRoot "wechat-miniapp-preview-latest-info.json"

if ([string]::IsNullOrWhiteSpace($CliPath)) {
  $CliPath = $env:WECHAT_DEVTOOLS_CLI
}

if ([string]::IsNullOrWhiteSpace($CliPath)) {
  $searchRoots = @("D:\", "C:\Program Files", "C:\Program Files (x86)")
  $CliPath = Get-ChildItem -LiteralPath $searchRoots -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
      $candidate = Join-Path $_.FullName "cli.bat"
      if (Test-Path -LiteralPath $candidate) {
        Get-Item -LiteralPath $candidate
      }
    } |
    Select-Object -First 1 -ExpandProperty FullName
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

$latestQrTempPath = "$latestQrPath.tmp"
$latestInfoTempPath = "$latestInfoPath.tmp"
try {
  Copy-Item -LiteralPath $qrPath -Destination $latestQrTempPath -Force
  Move-Item -LiteralPath $latestQrTempPath -Destination $latestQrPath -Force
  Copy-Item -LiteralPath $infoPath -Destination $latestInfoTempPath -Force
  Move-Item -LiteralPath $latestInfoTempPath -Destination $latestInfoPath -Force
}
finally {
  Remove-Item -LiteralPath $latestQrTempPath, $latestInfoTempPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $latestQrPath)) {
  throw "Preview latest QR file is missing: $latestQrPath"
}
if (-not (Test-Path -LiteralPath $latestInfoPath)) {
  throw "Preview latest info file is missing: $latestInfoPath"
}
Write-Host "Latest QR: $latestQrPath"
Write-Host "Latest info: $latestInfoPath"
