param(
  [string]$CliPath = "D:\微信web开发者工具\cli.bat"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Split-Path -Parent $projectRoot
$configPath = Join-Path $projectRoot "config.js"
$configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8

if ($configText -notmatch 'appVersion:\s*"([^"]+)"') {
  throw "config.js 没有找到 appVersion。"
}

$version = $Matches[1]
$qrPath = Join-Path $outputRoot "wechat-miniapp-preview-v$version-qr.png"
$infoPath = Join-Path $outputRoot "wechat-miniapp-preview-v$version-info.json"

if (-not (Test-Path -LiteralPath $CliPath)) {
  throw "找不到微信开发者工具 CLI：$CliPath。可用 -CliPath 指定实际路径。"
}

Push-Location $projectRoot
try {
  Write-Host "[$version] 1/3 检查工程..."
  & node scripts/validate.js
  if ($LASTEXITCODE -ne 0) {
    throw "工程检查失败，已停止，不生成预览码。"
  }

  Write-Host "[$version] 2/3 打正式包..."
  & python scripts/package-release.py
  if ($LASTEXITCODE -ne 0) {
    throw "正式打包失败，已停止，不生成预览码。"
  }

  Write-Host "[$version] 3/3 生成微信预览码..."
  & $CliPath preview `
    --project $projectRoot `
    --qr-format image `
    --qr-output $qrPath `
    --info-output $infoPath
  if ($LASTEXITCODE -ne 0) {
    throw "微信预览失败，已停止。"
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $qrPath)) {
  throw "预览命令返回成功，但没有找到二维码：$qrPath"
}
if (-not (Test-Path -LiteralPath $infoPath)) {
  throw "预览命令返回成功，但没有找到信息文件：$infoPath"
}

$qr = Get-Item -LiteralPath $qrPath
Write-Host "预览完成：$qrPath"
Write-Host "二维码大小：$($qr.Length) bytes"
Write-Host "预览信息：$infoPath"
