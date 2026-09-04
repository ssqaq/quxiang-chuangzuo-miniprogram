param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$WechatIde = "",
  [string]$ClientName = "default",
  [switch]$DryRun,
  [switch]$AllowOpenProjectWindow
)

# Keep this file ASCII-only so Windows PowerShell 5.1 can parse it without BOM.
$ErrorActionPreference = "Stop"

function Find-WechatIde {
  param([string]$Preferred)

  $candidates = @()
  if ($Preferred) {
    $candidates += $Preferred
  }
  if ($env:WECHATIDE_CLI) {
    $candidates += $env:WECHATIDE_CLI
  }
  $command = Get-Command "wechatide.cmd" -ErrorAction SilentlyContinue
  if ($command) {
    $candidates += $command.Source
  }
  foreach ($driveRoot in @("D:\", "C:\")) {
    if (-not (Test-Path -LiteralPath $driveRoot)) {
      continue
    }
    $candidates += Get-ChildItem -LiteralPath $driveRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "wechatide.cmd" }
  }
  return $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1
}

function Invoke-WechatIde {
  param(
    [string]$CliPath,
    [string[]]$Arguments
  )

  if (-not $AllowOpenProjectWindow) {
    throw "为防止微信开发者工具自动弹出，默认禁止调用 WechatIDE。若需手动执行，请显式加 -AllowOpenProjectWindow。"
  }

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $CliPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $text = ($output | Out-String).Trim()
  if ($exitCode -ne 0) {
    throw "wechatide failed with exit code ${exitCode}: $text"
  }
  $jsonStart = $text.IndexOf("{")
  if ($jsonStart -lt 0) {
    throw "wechatide did not return JSON: $text"
  }
  $response = $text.Substring($jsonStart) | ConvertFrom-Json
  if (-not $response.ok) {
    throw "wechatide rejected the request: $($response.message)"
  }
  return $response
}

$project = [IO.Path]::GetFullPath($ProjectPath)
$configPath = Join-Path $project "config.js"
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "config.js was not found under project path: $project"
}

$configText = Get-Content -LiteralPath $configPath -Raw
$envMatch = [regex]::Match($configText, 'cloudEnvId:\s*"([^"]+)"')
$functionMatch = [regex]::Match($configText, 'cloudFunctionName:\s*"([^"]+)"')
if (-not $envMatch.Success -or -not $envMatch.Groups[1].Value) {
  throw "cloudEnvId is missing from config.js"
}
if (-not $functionMatch.Success -or -not $functionMatch.Groups[1].Value) {
  throw "cloudFunctionName is missing from config.js"
}

$cloudEnvId = $envMatch.Groups[1].Value
$functionName = $functionMatch.Groups[1].Value
if ($functionName -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,58}$') {
  throw "cloudFunctionName contains unsupported characters: $functionName"
}
$cli = Find-WechatIde -Preferred $WechatIde
if (-not $cli) {
  throw "wechatide.cmd was not found. Set WECHATIDE_CLI or pass -WechatIde."
}

Write-Host "Project: $project"
Write-Host "Cloud environment: $cloudEnvId"
Write-Host "Cloud function: $functionName"
Write-Host "WechatIDE: $cli"

if ($DryRun) {
  Write-Host "Dry run passed. No cloud request was sent." -ForegroundColor Green
  exit 0
}

if ($AllowOpenProjectWindow) {
  Invoke-WechatIde -CliPath $cli -Arguments @(
    "-c", $ClientName,
    "open_project_window",
    "--project", $project,
    "--window-mode", "liteMode"
  ) | Out-Null

  Start-Sleep -Seconds 2
} else {
  Write-Host "Skip opening project window (default; use -AllowOpenProjectWindow to enable)"
}

$functionSource = "function() { return wx.cloud.callFunction({ name: '$functionName', data: { action: 'initializeDatabase', requestId: 'database-init-' + Date.now() } }).then(function(response) { return response.result; }); }"
$response = Invoke-WechatIde -CliPath $cli -Arguments @(
  "-c", $ClientName,
  "automation_evaluate",
  "--project", $project,
  "--fn-source", $functionSource
)

$payload = $response.result.result.result
if (-not $payload) {
  throw "Cloud function returned an empty result."
}

foreach ($item in @($payload.results)) {
  $color = switch ($item.status) {
    "created" { "Green" }
    "existing" { "Cyan" }
    default { "Red" }
  }
  $line = "{0,-32} {1}" -f $item.collection, $item.status
  if ($item.message) {
    $line += " - $($item.message)"
  }
  Write-Host $line -ForegroundColor $color
}

Write-Host (
  "Summary: total={0}, created={1}, existing={2}, failed={3}" -f
  $payload.total,
  $payload.created,
  $payload.existing,
  $payload.failed
)

if (-not $payload.ok -or [int]$payload.failed -gt 0) {
  $errorCode = if ($payload.errorCode) { $payload.errorCode } else { "DATABASE_INIT_FAILED" }
  throw "$errorCode`: $($payload.message)"
}

Write-Host "Cloud database initialization completed." -ForegroundColor Green
