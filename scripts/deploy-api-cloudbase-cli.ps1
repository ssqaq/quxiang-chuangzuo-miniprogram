param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(1, 300)]
  [int]$LockWaitSeconds = 60
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
    -WaitSeconds $LockWaitSeconds
  $snapshot = Get-CloudDeploySourceSnapshot `
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
    -Snapshot $snapshot `
    -ProjectPath $project `
    -ApiPath $apiPath `
    -Stage "cloudbase cli upload"
  Write-Host "CloudBase CLI deployment completed for api version $version." `
    -ForegroundColor Green
}
finally {
  if ($null -ne $lock) {
    Exit-CloudDeployLock -LockHandle $lock
  }
}
