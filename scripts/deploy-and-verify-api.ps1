param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$WechatIde = "",
  [string]$ClientName = "default",
  [switch]$SkipRemoteNpmInstall,
  [switch]$DryRun,
  [switch]$VerifyOnly
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

function Repair-CloudFunctionTimeout {
  param(
    [string]$EnvironmentId,
    [string]$FunctionName,
    [int]$TimeoutSeconds = 900
  )

  $npxCommand = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
  if (-not $npxCommand) {
    $npxCommand = Get-Command "npx" -ErrorAction SilentlyContinue
  }
  if (-not $npxCommand) {
    throw "npx 未找到，无法自动把云函数超时修正为 $TimeoutSeconds 秒。"
  }

  $arguments = @(
    "-y",
    "-p",
    "@cloudbase/cli",
    "tcb",
    "config",
    "update",
    "fn",
    $FunctionName,
    "--timeout",
    [string]$TimeoutSeconds,
    "-e",
    $EnvironmentId,
    "--json"
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $npxCommand.Source @arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    $text = ($output | Out-String).Trim()
    throw "自动修正云函数超时失败（exit code ${exitCode}）：$text"
  }
  Write-Host "已通过 CloudBase CLI 请求把云函数超时修正为 $TimeoutSeconds 秒。"
}

function Invoke-CloudBaseCliJson {
  param([string[]]$Arguments)

  $npxCommand = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
  if (-not $npxCommand) {
    $npxCommand = Get-Command "npx" -ErrorAction SilentlyContinue
  }
  if (-not $npxCommand) {
    throw "npx 未找到，无法执行 CloudBase 只读核验。"
  }

  $fullArguments = @(
    "-y",
    "-p",
    "@cloudbase/cli",
    "tcb"
  ) + $Arguments
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    # CloudBase detail 会返回环境变量；这里只在内存中解析，绝不回显原始输出。
    $output = & $npxCommand.Source @fullArguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "CloudBase CLI 请求失败（原始输出已隐藏，防止环境变量或密钥泄露）。"
  }
  $text = ($output | Out-String).Trim()
  $jsonStart = $text.IndexOf("{")
  if ($jsonStart -lt 0) {
    throw "CloudBase CLI 没有返回可解析的 JSON（原始输出已隐藏）。"
  }
  try {
    return $text.Substring($jsonStart) | ConvertFrom-Json
  }
  catch {
    throw "CloudBase CLI 返回的 JSON 无法解析（原始输出已隐藏）。"
  }
}

function Get-CloudBaseFunctionSnapshot {
  param(
    [string]$EnvironmentId,
    [string]$FunctionName
  )

  $response = Invoke-CloudBaseCliJson -Arguments @(
    "fn",
    "detail",
    $FunctionName,
    "-e",
    $EnvironmentId,
    "--json"
  )
  $data = Get-ObjectPropertyValue -Value $response -Name "data"
  if ($null -eq $data) {
    $data = $response
  }
  $codeInfo = [string](Get-ObjectPropertyValue -Value $data -Name "CodeInfo")
  $versionMatch = [regex]::Match(
    $codeInfo,
    'const API_BUILD_VERSION = "([^"]+)"'
  )
  $markerMatch = [regex]::Match(
    $codeInfo,
    'const API_BUILD_MARKER = "([^"]+)"'
  )
  $modeMatch = [regex]::Match(
    $codeInfo,
    'const DEFAULT_IMAGE_MODE = "([^"]+)"'
  )
  return [pscustomobject]@{
    Status = [string](Get-ObjectPropertyValue -Value $data -Name "Status")
    Timeout = [int](Get-ObjectPropertyValue -Value $data -Name "Timeout")
    BuildVersion = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { "" }
    BuildMarker = if ($markerMatch.Success) { $markerMatch.Groups[1].Value } else { "" }
    ImageMode = if ($modeMatch.Success) { $modeMatch.Groups[1].Value } else { "" }
  }
}

function Assert-CloudBaseFunctionSnapshot {
  param(
    [object]$Snapshot,
    [string]$ExpectedVersion,
    [string]$ExpectedMarker,
    [string]$ExpectedImageMode,
    [int]$ExpectedTimeout
  )

  if ($null -eq $Snapshot) {
    throw "CloudBase 只读代码快照为空。"
  }
  if ([string]$Snapshot.Status -ne "Active") {
    throw "CloudBase 云函数当前不是 Active：$($Snapshot.Status)"
  }
  if ([int]$Snapshot.Timeout -ne $ExpectedTimeout) {
    throw "CloudBase 只读核验失败：线上超时=$($Snapshot.Timeout) 秒，期望=$ExpectedTimeout 秒。"
  }
  if ([string]$Snapshot.BuildVersion -ne $ExpectedVersion) {
    throw "CloudBase 只读核验失败：线上代码版本=$($Snapshot.BuildVersion)，本地=$ExpectedVersion。"
  }
  if (
    $ExpectedMarker -and
    [string]$Snapshot.BuildMarker -ne $ExpectedMarker
  ) {
    throw "CloudBase 只读核验失败：线上构建标记与本地不一致。"
  }
  if (
    [string]::IsNullOrWhiteSpace([string]$Snapshot.ImageMode) -or
    ([string]$Snapshot.ImageMode).ToLowerInvariant() -ne $ExpectedImageMode.ToLowerInvariant()
  ) {
    throw "CloudBase 只读核验失败：线上图片模式=$($Snapshot.ImageMode)，本地=$ExpectedImageMode。"
  }
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

function Get-CloudFunctionInfo {
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
  return $function
}

function Get-CloudFunctionStatus {
  param(
    [string]$CliPath,
    [string]$AppId,
    [string]$EnvironmentId,
    [string]$FunctionName
  )

  $function = Get-CloudFunctionInfo `
    -CliPath $CliPath `
    -AppId $AppId `
    -EnvironmentId $EnvironmentId `
    -FunctionName $FunctionName
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
    [switch]$ReadOnly,
    [int]$Attempts = 3
  )

  $readOnlyLiteral = if ($ReadOnly) { "true" } else { "false" }
  $functionSource = "function() { return wx.cloud.callFunction({ name: '$FunctionName', data: { action: 'checkDeployment', readOnly: $readOnlyLiteral, requestId: 'deploy-verify-' + Date.now() } }).then(function(response) { return response.result; }); }"
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

function Assert-DeploymentImageConfiguration {
  param(
    [object]$Deployment,
    [string]$ExpectedImageMode
  )

  $primary = Get-ObjectPropertyValue -Value $Deployment -Name "image"
  $backup = Get-ObjectPropertyValue -Value $Deployment -Name "imageBackup"
  $tencent = Get-ObjectPropertyValue -Value $Deployment -Name "tencentFaceFusion"
  $flows = Get-ObjectPropertyValue -Value $Deployment -Name "flows"
  $normalFlow = Get-ObjectPropertyValue -Value $flows -Name "normal"
  $tencentFlow = Get-ObjectPropertyValue -Value $flows -Name "tencent"

  if ($null -eq $primary -or $null -eq $backup) {
    throw "线上核验失败：没有返回图片主备模型配置。"
  }
  if (
    [string]$primary.provider -ne "xingju" -or
    [string]$primary.model -ne "jw-gpt-image-2" -or
    ([string]$primary.mode).ToLowerInvariant() -ne $ExpectedImageMode.ToLowerInvariant() -or
    [int]$primary.timeoutMs -ne 150000 -or
    [int]$primary.maxRetries -ne 1
  ) {
    throw "线上核验失败：主模型必须是星炬 jw-gpt-image-2、150 秒超时、失败重试 1 次。"
  }
  if (-not [bool]$primary.apiKeyConfigured) {
    throw "线上核验失败：星炬主模型 API Key 尚未配置。"
  }
  if (
    [string]$backup.provider -ne "lingyun" -or
    [string]$backup.model -ne "gpt-image-2" -or
    ([string]$backup.mode).ToLowerInvariant() -ne $ExpectedImageMode.ToLowerInvariant() -or
    [int]$backup.timeoutMs -ne 150000 -or
    [int]$backup.maxRetries -ne 0
  ) {
    throw "线上核验失败：备用模型必须是凌云 gpt-image-2、150 秒超时、备用不重复重试。"
  }
  if (-not [bool]$backup.apiKeyConfigured) {
    throw "线上核验失败：凌云备用模型 API Key 尚未配置。"
  }
  if (
    $null -eq $tencent -or
    [string]$tencent.model -ne "FuseFaceUltra" -or
    [int]$tencent.timeoutMs -ne 75000
  ) {
    throw "线上核验失败：腾讯 FuseFaceUltra 必须使用 75 秒超时。"
  }
  if (-not [bool]$tencent.credentialsConfigured) {
    throw "线上核验失败：腾讯换脸凭据尚未配置。"
  }
  if (
    $null -eq $normalFlow -or
    [int]$normalFlow.totalSteps -ne 1 -or
    [int]$normalFlow.imageEditSteps -ne 1 -or
    [int]$normalFlow.faceFusionSteps -ne 0
  ) {
    throw "线上核验失败：普通版必须一次图片编辑完成。"
  }
  if (
    $null -eq $tencentFlow -or
    [int]$tencentFlow.totalSteps -ne 2 -or
    [int]$tencentFlow.imageEditSteps -ne 1 -or
    [int]$tencentFlow.faceFusionSteps -ne 1
  ) {
    throw "线上核验失败：腾讯版必须是先改图、再腾讯换脸的两步流程。"
  }
}

$project = [IO.Path]::GetFullPath($ProjectPath)
$configPath = Join-Path $project "config.js"
$projectConfigPath = Join-Path $project "project.config.json"
$apiPath = Join-Path $project "cloudfunctions\api"
$apiIndexPath = Join-Path $apiPath "index.js"
$apiConfigPath = Join-Path $apiPath "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "config.js was not found under project path: $project"
}
if (-not (Test-Path -LiteralPath $projectConfigPath)) {
  throw "project.config.json was not found under project path: $project"
}
if (-not (Test-Path -LiteralPath $apiIndexPath)) {
  throw "cloudfunctions/api/index.js was not found under project path: $project"
}
if (-not (Test-Path -LiteralPath $apiConfigPath)) {
  throw "cloudfunctions/api/config.json was not found under project path: $project"
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
$apiConfig = Get-Content -LiteralPath $apiConfigPath -Raw -Encoding UTF8 |
  ConvertFrom-Json
$expectedFunctionTimeout = [int](
  Get-ObjectPropertyValue -Value $apiConfig -Name "timeout"
)
if ($expectedFunctionTimeout -ne 900) {
  throw "cloudfunctions/api/config.json timeout must be exactly 900 seconds."
}
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
Write-Host "Expected function timeout: $expectedFunctionTimeout seconds"
if ($VerifyOnly) {
  Write-Host "Mode: read-only online verification (no source upload, no remote write)"
}
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
  if ($VerifyOnly) {
    Write-Host "Read-only verification: inspect CloudBase code snapshot"
    $cloudBaseSnapshot = Get-CloudBaseFunctionSnapshot `
      -EnvironmentId $cloudEnvId `
      -FunctionName $functionName
    Assert-CloudBaseFunctionSnapshot `
      -Snapshot $cloudBaseSnapshot `
      -ExpectedVersion $appVersion `
      -ExpectedMarker $expectedMarker `
      -ExpectedImageMode $imageMode `
      -ExpectedTimeout $expectedFunctionTimeout
    Write-Host "CloudBase code snapshot: version=$($cloudBaseSnapshot.BuildVersion), timeout=$($cloudBaseSnapshot.Timeout), status=$($cloudBaseSnapshot.Status)"

    Write-Host "Read-only verification: check WechatIDE login"
    $ideStatus = Invoke-WechatIdeTool -CliPath $cli -Arguments @(
      "-c", $ClientName,
      "check_wechatide_status"
    )
    if ($ideStatus.loginExpired -eq $true) {
      throw "WechatIDE login has expired. Log in again before verifying."
    }

    Write-Host "Read-only verification: open project runtime context"
    Invoke-WechatIdeTool -CliPath $cli -Arguments @(
      "-c", $ClientName,
      "open_project_window",
      "--project", $project,
      "--window-mode", "liteMode"
    ) | Out-Null
    Start-Sleep -Seconds 2

    Write-Host "Read-only verification: wait for Active and inspect timeout"
    Wait-CloudFunctionReady `
      -CliPath $cli `
      -AppId $appId `
      -EnvironmentId $cloudEnvId `
      -FunctionName $functionName
    $functionInfo = Get-CloudFunctionInfo `
      -CliPath $cli `
      -AppId $appId `
      -EnvironmentId $cloudEnvId `
      -FunctionName $functionName
    $actualFunctionTimeout = [int](
      Get-ObjectPropertyValue -Value $functionInfo -Name "timeout"
    )
    Write-Host "Online function timeout: $actualFunctionTimeout seconds"
    if ($actualFunctionTimeout -lt $expectedFunctionTimeout) {
      throw "Read-only verification failed: online function timeout is $actualFunctionTimeout seconds, expected $expectedFunctionTimeout seconds."
    }

    Write-Host "Read-only verification: inspect online build"
    $deployment = Get-DeploymentResult `
      -CliPath $cli `
      -Project $project `
      -FunctionName $functionName `
      -ReadOnly
    $actualVersion = [string]$deployment.buildVersion
    $actualMarker = [string]$deployment.buildMarker
    $actualImageMode = [string]$deployment.image.mode
    Write-Host "Online version: $actualVersion"
    Write-Host "Online marker: $actualMarker"
    Write-Host "Online image mode: $actualImageMode"
    if ([string]::IsNullOrWhiteSpace($actualVersion)) {
      throw "Read-only verification failed: online cloud function did not return buildVersion."
    }
    if ($actualVersion -ne $appVersion) {
      throw "Read-only verification failed: local=$appVersion, online=$actualVersion."
    }
    if ($expectedMarker -and $actualMarker -ne $expectedMarker) {
      throw "Read-only verification failed: local marker=$expectedMarker, online=$actualMarker."
    }
    if ([string]::IsNullOrWhiteSpace($actualImageMode)) {
      throw "Read-only verification failed: online cloud function did not return image.mode."
    }
    if ($actualImageMode.ToLowerInvariant() -ne $imageMode.ToLowerInvariant()) {
      throw "Read-only verification failed: local image mode=$imageMode, online=$actualImageMode."
    }
    if (-not [bool]$deployment.readOnly -or [bool]$deployment.logWritten) {
      throw "Read-only verification failed: online check unexpectedly wrote a deployment log."
    }
    Assert-DeploymentImageConfiguration `
      -Deployment $deployment `
      -ExpectedImageMode $imageMode
    Write-Host "Read-only online verification passed. No source upload or remote write was sent." -ForegroundColor Green
    return
  }

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
  $functionInfo = Get-CloudFunctionInfo `
    -CliPath $cli `
    -AppId $appId `
    -EnvironmentId $cloudEnvId `
    -FunctionName $functionName
  $actualFunctionTimeout = [int](
    Get-ObjectPropertyValue -Value $functionInfo -Name "timeout"
  )
  Write-Host "Online function timeout: $actualFunctionTimeout seconds"
  if ($actualFunctionTimeout -lt $expectedFunctionTimeout) {
    Write-Host "Online function timeout is too short. Start automatic repair."
    Repair-CloudFunctionTimeout `
      -EnvironmentId $cloudEnvId `
      -FunctionName $functionName `
      -TimeoutSeconds $expectedFunctionTimeout
    Wait-CloudFunctionReady `
      -CliPath $cli `
      -AppId $appId `
      -EnvironmentId $cloudEnvId `
      -FunctionName $functionName
    $functionInfo = Get-CloudFunctionInfo `
      -CliPath $cli `
      -AppId $appId `
      -EnvironmentId $cloudEnvId `
      -FunctionName $functionName
    $actualFunctionTimeout = [int](
      Get-ObjectPropertyValue -Value $functionInfo -Name "timeout"
    )
    Write-Host "Online function timeout after repair: $actualFunctionTimeout seconds"
    if ($actualFunctionTimeout -lt $expectedFunctionTimeout) {
      throw "Online function timeout is still too short after automatic repair. Expected $expectedFunctionTimeout seconds, actual $actualFunctionTimeout seconds."
    }
  }

  Write-Host "5/6 Verify CloudBase code snapshot"
  $cloudBaseSnapshot = Get-CloudBaseFunctionSnapshot `
    -EnvironmentId $cloudEnvId `
    -FunctionName $functionName
  Assert-CloudBaseFunctionSnapshot `
    -Snapshot $cloudBaseSnapshot `
    -ExpectedVersion $appVersion `
    -ExpectedMarker $expectedMarker `
    -ExpectedImageMode $imageMode `
    -ExpectedTimeout $expectedFunctionTimeout
  Write-Host "CloudBase code snapshot: version=$($cloudBaseSnapshot.BuildVersion), timeout=$($cloudBaseSnapshot.Timeout), status=$($cloudBaseSnapshot.Status)"

  Write-Host "6/6 Verify online runtime configuration"
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
  Assert-DeploymentImageConfiguration `
    -Deployment $deployment `
    -ExpectedImageMode $imageMode
  Write-Host "Cloud function deployment verified successfully." -ForegroundColor Green
}
finally {
  Pop-Location
}
