param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$WechatIde = "",
  [string]$ClientName = "default",
  [switch]$SkipRemoteNpmInstall,
  [switch]$DryRun
)

# Keep this file ASCII-only so Windows PowerShell 5.1 can parse it without BOM.
$ErrorActionPreference = "Stop"

if ($SkipRemoteNpmInstall) {
  throw "-SkipRemoteNpmInstall is disabled because WechatIDE strips node_modules from cloud function packages. Re-run without this switch so dependencies are installed remotely."
}

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
  foreach ($driveRoot in @("D:\", "C:\", "C:\Program Files", "C:\Program Files (x86)")) {
    if (-not (Test-Path -LiteralPath $driveRoot)) {
      continue
    }
    Get-ChildItem -LiteralPath $driveRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object {
        $candidates += Join-Path $_.FullName "wechatide.cmd"
      }
  }
  return $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -Unique -First 1
}

function Get-ConfigValue {
  param(
    [string]$Text,
    [string]$Name
  )

  $match = [regex]::Match($Text, "${Name}:\s*""([^""]+)""")
  if (-not $match.Success) {
    throw "config.js is missing $Name."
  }
  return $match.Groups[1].Value
}

function Get-ToolPayload {
  param([object]$Value)

  $current = $Value
  for ($index = 0; $index -lt 8; $index++) {
    if ($null -eq $current) {
      return $null
    }
    $property = $current.PSObject.Properties["result"]
    if ($null -eq $property -or $null -eq $property.Value) {
      break
    }
    $current = $property.Value
  }
  return $current
}

function Invoke-WechatIde {
  param(
    [string]$CliPath,
    [string[]]$Arguments
  )

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
  try {
    $response = $text.Substring($jsonStart) | ConvertFrom-Json
  }
  catch {
    throw "wechatide returned invalid JSON: $text"
  }
  if (-not $response.ok) {
    throw "wechatide rejected the request: $($response.message)"
  }
  return $response
}

function Resolve-ToolPayload {
  param(
    [string]$CliPath,
    [object]$Response
  )

  $payload = Get-ToolPayload $Response
  $taskIdProperty = if ($null -ne $payload) {
    $payload.PSObject.Properties["taskId"]
  } else {
    $null
  }
  if ($null -eq $taskIdProperty -or [string]::IsNullOrWhiteSpace([string]$taskIdProperty.Value)) {
    return $payload
  }

  $taskId = [string]$taskIdProperty.Value
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    Start-Sleep -Seconds 2
    $pollResponse = Invoke-WechatIde -CliPath $CliPath -Arguments @(
      "-c", $ClientName,
      "polling_task_result",
      "--task-id", $taskId
    )
    $pollPayload = Get-ToolPayload $pollResponse
    if ($null -eq $pollPayload) {
      continue
    }
    $status = [string]$pollPayload.status
    if ($status -in @("pending", "running", "processing")) {
      continue
    }
    if ($pollPayload.PSObject.Properties["result"]) {
      $nested = Get-ToolPayload $pollPayload
      if ($null -ne $nested -and $nested -ne $pollPayload) {
        return $nested
      }
    }
    return $pollPayload
  }
  throw "wechatide task timed out: $taskId"
}

function Invoke-WechatIdeTool {
  param(
    [string]$CliPath,
    [string[]]$Arguments
  )

  $response = Invoke-WechatIde -CliPath $CliPath -Arguments $Arguments
  return Resolve-ToolPayload -CliPath $CliPath -Response $response
}

function Get-ObjectPropertyValue {
  param(
    [object]$Value,
    [string]$Name
  )

  if ($null -eq $Value) {
    return $null
  }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Assert-CloudFunctionDeploymentResult {
  param(
    [object]$Payload,
    [string]$FunctionName
  )

  if ($null -eq $Payload) {
    throw "Cloud function deployment returned an empty result."
  }
  $functionResult = Get-ObjectPropertyValue -Value $Payload -Name $FunctionName
  if ($null -eq $functionResult) {
    throw "Cloud function deployment result is missing function entry: $FunctionName."
  }
  $errorResult = Get-ObjectPropertyValue -Value $functionResult -Name "error"
  if ($null -ne $errorResult) {
    $errorMessage = [string](Get-ObjectPropertyValue -Value $errorResult -Name "message")
    if ([string]::IsNullOrWhiteSpace($errorMessage)) {
      $errorMessage = [string]$errorResult
    }
    throw "Cloud function deployment failed: $errorMessage"
  }
  $filesCount = Get-ObjectPropertyValue -Value $functionResult -Name "filesCount"
  $packSize = Get-ObjectPropertyValue -Value $functionResult -Name "packSize"
  if ($null -ne $filesCount) {
    Write-Host "Deployed files: $filesCount"
  }
  if ($null -ne $packSize) {
    Write-Host "Deployment package size: $packSize"
  }
}

function Get-CloudFunctionStatus {
  param(
    [string]$CliPath,
    [string]$AppId,
    [string]$EnvironmentId,
    [string]$FunctionName
  )

  $payload = Invoke-WechatIdeTool -CliPath $CliPath -Arguments @(
    "-c", $ClientName,
    "cloud_fn_info",
    "--appid", $AppId,
    "--env", $EnvironmentId,
    "--names", $FunctionName
  )
  $list = @(Get-ObjectPropertyValue -Value $payload -Name "list")
  $function = @(
    $list |
      Where-Object { [string]$_.name -eq $FunctionName }
  ) | Select-Object -First 1
  if ($null -eq $function) {
    throw "Cloud function status result is missing function: $FunctionName."
  }
  return [string]$function.status
}

function Wait-CloudFunctionReady {
  param(
    [string]$CliPath,
    [string]$AppId,
    [string]$EnvironmentId,
    [string]$FunctionName,
    [int]$Attempts = 60,
    [int]$DelaySeconds = 2
  )

  $lastStatus = ""
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $status = Get-CloudFunctionStatus `
      -CliPath $CliPath `
      -AppId $AppId `
      -EnvironmentId $EnvironmentId `
      -FunctionName $FunctionName
    if ($status -ne $lastStatus) {
      Write-Host "Cloud function status: $status"
      $lastStatus = $status
    }
    if ($status -eq "Active") {
      return
    }
    if ($status -match "Failed|Error") {
      throw "Cloud function entered a failed state: $status."
    }
    if ($attempt -lt $Attempts) {
      Start-Sleep -Seconds $DelaySeconds
    }
  }
  throw "Cloud function did not become Active within $($Attempts * $DelaySeconds) seconds. Last status: $lastStatus."
}

function Get-DeploymentResult {
  param(
    [string]$CliPath,
    [string]$Project,
    [string]$FunctionName,
    [int]$Attempts = 3
  )

  $functionSource = "function() { return wx.cloud.callFunction({ name: '$FunctionName', data: { action: 'checkDeployment', requestId: 'deploy-verify-' + Date.now() } }).then(function(response) { return response.result; }); }"
  $lastError = ""
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      $payload = Invoke-WechatIdeTool -CliPath $CliPath -Arguments @(
        "-c", $ClientName,
        "automation_evaluate",
        "--project", $Project,
        "--fn-source", $functionSource
      )
      if ($null -eq $payload) {
        throw "Cloud function returned an empty result."
      }
      if (-not $payload.ok) {
        $code = if ($payload.errorCode) { $payload.errorCode } else { "CLOUD_FUNCTION_FAILED" }
        $message = if ($payload.message) { $payload.message } else { "Cloud function request failed." }
        throw "$code`: $message"
      }
      return $payload
    }
    catch {
      $lastError = $_.Exception.Message
      if ($attempt -lt $Attempts) {
        Start-Sleep -Seconds 3
      }
    }
  }
  throw "Deployment verification failed after $Attempts attempts: $lastError"
}

$project = [IO.Path]::GetFullPath($ProjectPath)
$configPath = Join-Path $project "config.js"
$projectConfigPath = Join-Path $project "project.config.json"
$apiPath = Join-Path $project "cloudfunctions\api"
$apiIndexPath = Join-Path $apiPath "index.js"
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "config.js was not found under project path: $project"
}
if (-not (Test-Path -LiteralPath $projectConfigPath)) {
  throw "project.config.json was not found under project path: $project"
}
if (-not (Test-Path -LiteralPath $apiIndexPath)) {
  throw "cloudfunctions/api/index.js was not found under project path: $project"
}

$configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
$appVersion = Get-ConfigValue -Text $configText -Name "appVersion"
$imageMode = Get-ConfigValue -Text $configText -Name "imageMode"
$cloudEnvId = Get-ConfigValue -Text $configText -Name "cloudEnvId"
$functionName = Get-ConfigValue -Text $configText -Name "cloudFunctionName"
if ($functionName -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,58}$') {
  throw "cloudFunctionName contains unsupported characters: $functionName"
}

$projectConfig = Get-Content -LiteralPath $projectConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appId = [string]$projectConfig.appid
if ([string]::IsNullOrWhiteSpace($appId)) {
  throw "project.config.json is missing appid."
}

$apiText = Get-Content -LiteralPath $apiIndexPath -Raw -Encoding UTF8
$markerMatch = [regex]::Match($apiText, 'const API_BUILD_MARKER = "([^"]+)"')
$expectedMarker = if ($markerMatch.Success) { $markerMatch.Groups[1].Value } else { "" }
$cli = Find-WechatIde -Preferred $WechatIde
if (-not $cli) {
  throw "wechatide.cmd was not found. Set WECHATIDE_CLI or pass -WechatIde."
}

Write-Host "Project: $project"
Write-Host "AppID: $appId"
Write-Host "Cloud environment: $cloudEnvId"
Write-Host "Cloud function: $functionName"
Write-Host "Expected version: $appVersion"
Write-Host "Expected image mode: $imageMode"
Write-Host "Remote npm install: required"
if ($expectedMarker) {
  Write-Host "Expected marker: $expectedMarker"
}
Write-Host "WechatIDE: $cli"

if ($DryRun) {
  Write-Host "Dry run passed. No deployment or cloud request was sent." -ForegroundColor Green
  exit 0
}

Push-Location $project
try {
  Write-Host "1/5 Check WechatIDE login"
  $ideStatus = Invoke-WechatIdeTool -CliPath $cli -Arguments @(
    "-c", $ClientName,
    "check_wechatide_status"
  )
  if ($ideStatus.loginExpired -eq $true) {
    throw "WechatIDE login has expired. Log in again before deploying."
  }

  Write-Host "2/5 Run local deployment checks"
  & node (Join-Path $project "scripts\validate.js")
  if ($LASTEXITCODE -ne 0) {
    throw "Local project validation failed."
  }
  & node (Join-Path $project "scripts\check-deployment.js") --strict
  if ($LASTEXITCODE -ne 0) {
    throw "Strict deployment check failed."
  }

  Write-Host "3/5 Open project runtime"
  Invoke-WechatIdeTool -CliPath $cli -Arguments @(
    "-c", $ClientName,
    "open_project_window",
    "--project", $project,
    "--window-mode", "liteMode"
  ) | Out-Null
  Start-Sleep -Seconds 2

  Write-Host "4/5 Deploy cloud function"
  Wait-CloudFunctionReady `
    -CliPath $cli `
    -AppId $appId `
    -EnvironmentId $cloudEnvId `
    -FunctionName $functionName
  $deployArguments = @(
    "-c", $ClientName,
    "cloud_fn_deploy",
    "--appid", $appId,
    "--env", $cloudEnvId,
    "--path", $apiPath,
    "--remote-npm-install"
  )
  $deployPayload = Invoke-WechatIdeTool -CliPath $cli -Arguments $deployArguments
  Assert-CloudFunctionDeploymentResult `
    -Payload $deployPayload `
    -FunctionName $functionName
  Wait-CloudFunctionReady `
    -CliPath $cli `
    -AppId $appId `
    -EnvironmentId $cloudEnvId `
    -FunctionName $functionName

  Write-Host "5/5 Verify online build"
  $deployment = Get-DeploymentResult `
    -CliPath $cli `
    -Project $project `
    -FunctionName $functionName
  $actualVersion = [string]$deployment.buildVersion
  $actualMarker = [string]$deployment.buildMarker
  $actualImageMode = [string]$deployment.image.mode
  Write-Host "Online version: $actualVersion"
  Write-Host "Online marker: $actualMarker"
  Write-Host "Online image mode: $actualImageMode"

  if ([string]::IsNullOrWhiteSpace($actualVersion)) {
    throw "Online cloud function did not return buildVersion."
  }
  if ($actualVersion -ne $appVersion) {
    throw "Online version mismatch. Local=$appVersion, online=$actualVersion."
  }
  if ($expectedMarker -and $actualMarker -ne $expectedMarker) {
    throw "Online build marker mismatch. Local=$expectedMarker, online=$actualMarker."
  }
  if ([string]::IsNullOrWhiteSpace($actualImageMode)) {
    throw "Online cloud function did not return image.mode."
  }
  if ($actualImageMode.ToLowerInvariant() -ne $imageMode.ToLowerInvariant()) {
    throw "Online image mode mismatch. Local=$imageMode, online=$actualImageMode."
  }
  Write-Host "Cloud function deployment verified successfully." -ForegroundColor Green
}
finally {
  Pop-Location
}
