param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(1, 300)]
  [int]$LockWaitSeconds = 60,
  [string]$LockPath = ""
)

$ErrorActionPreference = "Stop"

$project = [IO.Path]::GetFullPath($ProjectPath)
$configPath = Join-Path $project "config.js"
$apiPath = Join-Path $project "cloudfunctions\api"
$configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
$envMatch = [regex]::Match($configText, 'cloudEnvId:\s*"([^"]+)"')
$versionMatch = [regex]::Match($configText, 'appVersion:\s*"([^"]+)"')
if (-not $envMatch.Success -or -not $versionMatch.Success) {
  throw "config.js is missing cloudEnvId or appVersion."
}
$environmentId = $envMatch.Groups[1].Value
$version = $versionMatch.Groups[1].Value

$safetyScript = Join-Path $PSScriptRoot "cloud-deploy-safety.ps1"
. $safetyScript

$lock = $null
try {
  $lock = Enter-CloudDeployLock `
    -ProjectPath $project `
    -TargetVersion $version `
    -FunctionName "api" `
    -WaitSeconds $LockWaitSeconds `
    -LockPath $LockPath
  $sourceSnapshot = Get-CloudDeploySourceSnapshot `
    -ProjectPath $project `
    -ApiPath $apiPath

  $onlineVersion = Get-CloudBaseFunctionVersion `
    -EnvironmentId $environmentId `
    -FunctionName "api"
  $versionDecision = Assert-CloudDeployVersionNotDowngrade `
    -LocalVersion $version `
    -OnlineVersion $onlineVersion
  Write-Host "Version guard passed: local=$($versionDecision.LocalVersion), online=$($versionDecision.OnlineVersion), relation=$($versionDecision.Relation)"

  & node (Join-Path $project "scripts\check-cloudfunction-dependencies.js")
  if ($LASTEXITCODE -ne 0) {
    throw "Cloud function dependency check failed."
  }

  Invoke-CloudBaseFunctionDeploy `
    -EnvironmentId $environmentId `
    -FunctionName "api" `
    -ApiPath $apiPath `
    -TimeoutSeconds 900 | Out-Null
  Assert-CloudDeploySourceSnapshotStable `
    -Snapshot $sourceSnapshot `
    -ProjectPath $project `
    -ApiPath $apiPath `
    -Stage "cloudbase cli upload"
  Wait-CloudBaseFunctionReady `
    -EnvironmentId $environmentId `
    -FunctionName "api"
  $runtimeSnapshot = Get-CloudBaseFunctionSnapshot `
    -EnvironmentId $environmentId `
    -FunctionName "api"
  if ($runtimeSnapshot.Timeout -lt 900) {
    Repair-CloudBaseFunctionTimeout `
      -EnvironmentId $environmentId `
      -FunctionName "api" `
      -TimeoutSeconds 900
    Wait-CloudBaseFunctionReady `
      -EnvironmentId $environmentId `
      -FunctionName "api"
    $runtimeSnapshot = Get-CloudBaseFunctionSnapshot `
      -EnvironmentId $environmentId `
      -FunctionName "api"
    if ($runtimeSnapshot.Timeout -lt 900) {
      throw "CloudBase 线上超时未达到 900 秒。[CLOUDBASE_TIMEOUT_MISMATCH]"
    }
  }
  $markerMatch = [regex]::Match(
    (Get-Content -LiteralPath (Join-Path $apiPath "index.js") -Raw -Encoding UTF8),
    'const API_BUILD_MARKER = "([^"]+)"'
  )
  $expectedMarker = if ($markerMatch.Success) { $markerMatch.Groups[1].Value } else { "" }
  if ([string]$runtimeSnapshot.BuildVersion -ne $version) {
    throw "CloudBase 线上版本不一致。[CLOUDBASE_VERSION_MISMATCH]"
  }
  if ($expectedMarker -and [string]$runtimeSnapshot.BuildMarker -ne $expectedMarker) {
    throw "CloudBase 线上构建标记不一致。[CLOUDBASE_MARKER_MISMATCH]"
  }
  $runtimeHealth = Get-CloudBaseRuntimeHealth `
    -EnvironmentId $environmentId `
    -FunctionName "api"
  Assert-CloudBaseRuntimeHealth `
    -Health $runtimeHealth `
    -ExpectedVersion $version `
    -ExpectedMarker $expectedMarker
  Assert-CloudDeploySourceSnapshotStable `
    -Snapshot $sourceSnapshot `
    -ProjectPath $project `
    -ApiPath $apiPath `
    -Stage "cloudbase runtime verification"
  Write-Host "CloudBase CLI deployment and runtime verification completed for api version $version." `
    -ForegroundColor Green
}
finally {
  if ($null -ne $lock) {
    Exit-CloudDeployLock -LockHandle $lock
  }
}
