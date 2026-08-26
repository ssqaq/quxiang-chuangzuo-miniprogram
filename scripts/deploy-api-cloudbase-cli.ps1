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
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) (
  "wechat-miniapp-cloudbase-cli-" + [guid]::NewGuid().ToString("N")
)
try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $cloudbaseConfig = [ordered]@{
    envId = $environmentId
    functions = @(
      [ordered]@{
        name = "api"
        timeout = 900
      }
    )
  } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText(
    (Join-Path $tempRoot "cloudbaserc.json"),
    $cloudbaseConfig,
    [Text.UTF8Encoding]::new($false)
  )

  $lock = Enter-CloudDeployLock `
    -ProjectPath $project `
    -TargetVersion $version `
    -FunctionName "api" `
    -WaitSeconds $LockWaitSeconds
  $snapshot = Get-CloudDeploySourceSnapshot `
    -ProjectPath $project `
    -ApiPath $apiPath

  & node (Join-Path $project "scripts\check-cloudfunction-dependencies.js")
  if ($LASTEXITCODE -ne 0) {
    throw "Cloud function dependency check failed."
  }

  Push-Location $tempRoot
  try {
    $output = & npx -y -p @cloudbase/cli tcb fn deploy api `
      --dir $apiPath `
      --force `
      --install-dependency true `
      --json 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "CloudBase CLI deployment failed. Exit code: $exitCode"
  }
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
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
