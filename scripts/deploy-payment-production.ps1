param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$EnvironmentId = "",
  [string]$ReleaseContext = "",
  [string]$SecretFile = "",
  [switch]$WhatIf,
  [switch]$ReleaseGateLockHeld,
  [string]$ReleaseGateLockToken = "",
  [string]$DeployLockPath = "",
  [ValidateRange(1, 7200)][int]$LockWaitSeconds = 60,
  [switch]$AllowPostMergeRecovery
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:CloudBaseCliPackage = "@cloudbase/cli@3.8.1"
$script:TcbApiVersion = "2018-06-08"
$script:FlexDbApiVersion = "2018-11-27"
$script:PaymentCollections = @(
  "payment_orders",
  "payment_events",
  "recharge_config",
  "payment_monitor_status"
)
$script:RequiredSecretKeys = @(
  "XINGJU_API_BASE_URL",
  "XINGJU_PID",
  "XINGJU_PLATFORM_PUBLIC_KEY",
  "XINGJU_MERCHANT_PRIVATE_KEY"
)
$script:OptionalSecretKeys = @("XINGJU_NOTIFY_URL", "XINGJU_RETURN_URL")
$script:FunctionOrder = @(
  "payment-notify",
  "payment-reconcile",
  "payment-api"
)
$script:RuntimeSwitchMap = [ordered]@{
  orderCreationEnabled = "PAYMENT_ORDER_CREATION_ENABLED"
  callbackProcessingEnabled = "PAYMENT_CALLBACK_PROCESSING_ENABLED"
  reconciliationEnabled = "PAYMENT_RECONCILIATION_ENABLED"
}

function Get-ObjectProperty {
  param(
    [object]$InputObject,
    [Parameter(Mandatory = $true)][string]$Name,
    [object]$Default = $null
  )
  if ($null -eq $InputObject) { return $Default }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Get-FirstObjectProperty {
  param(
    [object]$InputObject,
    [Parameter(Mandatory = $true)][string[]]$Names,
    [object]$Default = $null
  )
  foreach ($name in $Names) {
    $value = Get-ObjectProperty -InputObject $InputObject -Name $name -Default $null
    if ($null -ne $value) { return $value }
  }
  return $Default
}

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label file is missing."
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  catch {
    throw "$Label is not valid JSON."
  }
}

function Resolve-ProjectRoot {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "ProjectPath does not exist."
  }
  return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).ProviderPath)
}

function Test-PathInsideRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate
  )
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
  $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd("\", "/")
  if ([string]::Equals($rootPath, $candidatePath, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  return $candidatePath.StartsWith(
    $rootPath + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Resolve-EnvironmentId {
  param(
    [Parameter(Mandatory = $true)][string]$Project,
    [string]$RequestedId
  )
  if (-not [string]::IsNullOrWhiteSpace($RequestedId)) {
    return $RequestedId.Trim()
  }
  $configPath = Join-Path $Project "config.js"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "EnvironmentId was not supplied and config.js is missing."
  }
  $source = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
  $match = [regex]::Match($source, 'cloudEnvId:\s*"([^"]+)"')
  if (-not $match.Success) {
    throw "EnvironmentId was not supplied and cloudEnvId is missing from config.js."
  }
  return $match.Groups[1].Value
}

function Get-AppVersion {
  param([Parameter(Mandatory = $true)][string]$Project)
  $configPath = Join-Path $Project "config.js"
  $source = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
  $match = [regex]::Match($source, 'appVersion:\s*"([^"]+)"')
  if (-not $match.Success) { throw "appVersion is missing from config.js." }
  return $match.Groups[1].Value
}

function Read-ProductionSecrets {
  param(
    [Parameter(Mandatory = $true)][string]$Project,
    [string]$Path
  )
  $values = [ordered]@{}
  $requestedPath = if ([string]::IsNullOrWhiteSpace($Path)) {
    [string]$env:PAYMENT_PRODUCTION_SECRET_FILE
  }
  else {
    $Path
  }
  if ([string]::IsNullOrWhiteSpace($requestedPath)) {
    return [pscustomobject]@{
      Values = $values
      Missing = @($script:RequiredSecretKeys)
      SourcePresent = $false
    }
  }
  if (-not (Test-Path -LiteralPath $requestedPath -PathType Leaf)) {
    throw "SecretFile does not exist."
  }
  $resolved = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $requestedPath).ProviderPath)
  if (Test-PathInsideRoot -Root $Project -Candidate $resolved) {
    throw "SecretFile must be outside the repository."
  }
  $document = Read-JsonFile -Path $resolved -Label "SecretFile"
  $source = Get-ObjectProperty -InputObject $document -Name "envVariables" -Default $document
  foreach ($key in @($script:RequiredSecretKeys + $script:OptionalSecretKeys)) {
    $raw = Get-ObjectProperty -InputObject $source -Name $key -Default ""
    if ($null -ne $raw -and -not [string]::IsNullOrWhiteSpace([string]$raw)) {
      $values[$key] = [string]$raw
    }
  }
  $missing = @($script:RequiredSecretKeys | Where-Object { -not $values.Contains($_) })
  return [pscustomobject]@{
    Values = $values
    Missing = $missing
    SourcePresent = $true
  }
}

function Assert-ProductionSecretShape {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$Values)
  foreach ($key in @("XINGJU_API_BASE_URL", "XINGJU_NOTIFY_URL", "XINGJU_RETURN_URL")) {
    if (-not $Values.Contains($key)) { continue }
    $uri = $null
    if (-not [Uri]::TryCreate([string]$Values[$key], [UriKind]::Absolute, [ref]$uri) `
        -or $uri.Scheme -ne "https" `
        -or [string]::IsNullOrWhiteSpace($uri.DnsSafeHost) `
        -or -not [string]::IsNullOrWhiteSpace($uri.UserInfo)) {
      throw "$key must be an absolute HTTPS URL."
    }
  }
  if ($Values.Contains("XINGJU_PID") -and [string]::IsNullOrWhiteSpace([string]$Values["XINGJU_PID"])) {
    throw "XINGJU_PID is empty."
  }
  foreach ($key in @("XINGJU_PLATFORM_PUBLIC_KEY", "XINGJU_MERCHANT_PRIVATE_KEY")) {
    if (-not $Values.Contains($key)) { continue }
    $pem = [string]$Values[$key]
    $rsa = [Security.Cryptography.RSA]::Create()
    try {
      $rsa.ImportFromPem($pem)
      $includePrivate = $key -eq "XINGJU_MERCHANT_PRIVATE_KEY"
      $parameters = $rsa.ExportParameters($includePrivate)
      if ($null -eq $parameters.Modulus -or $parameters.Modulus.Length -lt 256 `
          -or ($includePrivate -and $null -eq $parameters.D)) {
        throw "invalid RSA material"
      }
      if ($includePrivate) {
        $probe = [Text.Encoding]::UTF8.GetBytes("aips-payment-production-key-check")
        $signature = $rsa.SignData(
          $probe,
          [Security.Cryptography.HashAlgorithmName]::SHA256,
          [Security.Cryptography.RSASignaturePadding]::Pkcs1
        )
        if (-not $rsa.VerifyData(
            $probe,
            $signature,
            [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1
          )) {
          throw "RSA private-key self-check failed"
        }
      }
    }
    catch {
      $label = if ($key -eq "XINGJU_MERCHANT_PRIVATE_KEY") { "private" } else { "public" }
      throw "$key is not a valid RSA $label key."
    }
    finally {
      $rsa.Dispose()
    }
  }
}

function Assert-PaymentManifest {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$Project
  )
  if ([int](Get-ObjectProperty $Manifest "schemaVersion" 0) -ne 1) {
    throw "Unsupported payment manifest schemaVersion."
  }
  $production = Get-ObjectProperty $Manifest "productionDeployment"
  if ($null -eq $production `
      -or (Get-ObjectProperty $production "enabled" $false) -ne $true `
      -or (Get-ObjectProperty $production "automaticDeployment" $false) -ne $true `
      -or (Get-ObjectProperty $production "requiresExplicitProductionAuthorization" $false) -ne $true) {
    throw "Payment production deployment is not explicitly enabled by the manifest."
  }

  $functions = @(Get-ObjectProperty $Manifest "functions" @())
  if ($functions.Count -ne 3) { throw "Payment manifest must declare exactly three functions." }
  foreach ($name in $script:FunctionOrder) {
    $item = @($functions | Where-Object { [string](Get-ObjectProperty $_ "name" "") -eq $name })
    if ($item.Count -ne 1) { throw "Payment manifest function set is invalid: $name" }
    $entry = $item[0]
    if ((Get-ObjectProperty $entry "deploymentEnabled" $false) -ne $true) {
      throw "Payment function is not enabled for deployment: $name"
    }
    $root = [string](Get-ObjectProperty $entry "root" "")
    if ([string]::IsNullOrWhiteSpace($root) `
        -or -not (Test-Path -LiteralPath (Join-Path $Project $root) -PathType Container)) {
      throw "Payment function root is missing: $name"
    }
  }

  $expectedSwitches = [ordered]@{
    "payment-notify" = "callbackProcessingEnabled"
    "payment-reconcile" = "reconciliationEnabled"
    "payment-api" = "orderCreationEnabled"
  }
  foreach ($name in $script:FunctionOrder) {
    $entry = @($functions | Where-Object { [string](Get-ObjectProperty $_ "name" "") -eq $name })[0]
    $switches = Get-ObjectProperty $entry "runtimeSwitches"
    $switchName = $expectedSwitches[$name]
    if ($null -eq $switches -or (Get-ObjectProperty $switches $switchName $false) -ne $true) {
      throw "Required runtime switch is not true: $switchName"
    }
  }

  $notify = @($functions | Where-Object { [string](Get-ObjectProperty $_ "name" "") -eq "payment-notify" })[0]
  $route = Get-ObjectProperty $notify "httpRoute"
  if ($null -eq $route `
      -or (Get-ObjectProperty $route "declared" $false) -ne $true `
      -or (Get-ObjectProperty $route "enabled" $false) -ne $true `
      -or [string](Get-ObjectProperty $route "path" "") -ne "/payment/xingju/notify" `
      -or (Get-ObjectProperty $route "enableAuth" $true) -ne $false) {
    throw "payment-notify HTTP route declaration is invalid."
  }

  $reconcile = @($functions | Where-Object { [string](Get-ObjectProperty $_ "name" "") -eq "payment-reconcile" })[0]
  $timer = Get-ObjectProperty $reconcile "timer"
  if ($null -eq $timer `
      -or (Get-ObjectProperty $timer "declared" $false) -ne $true `
      -or (Get-ObjectProperty $timer "enabled" $false) -ne $true `
      -or [string](Get-ObjectProperty $timer "name" "") -ne "payment-reconcile" `
      -or [string](Get-ObjectProperty $timer "cron" "") -ne "0 */2 * * * * *") {
    throw "payment-reconcile Timer declaration is invalid."
  }
}

function Get-ManifestFunction {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$Name
  )
  return @(@(Get-ObjectProperty $Manifest "functions" @()) | Where-Object {
    [string](Get-ObjectProperty $_ "name" "") -eq $Name
  })[0]
}

function Write-DeploymentPlan {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][object]$Secrets,
    [Parameter(Mandatory = $true)][object[]]$PaymentIndexes
  )
  Write-Host "PAYMENT_PRODUCTION_PLAN environment=$Environment"
  foreach ($collection in $script:PaymentCollections) {
    Write-Host "PLAN collection ensure: $collection"
  }
  foreach ($index in $PaymentIndexes) {
    Write-Host "PLAN index ensure: $([string]$index.collection)/$([string]$index.name)"
  }
  foreach ($functionName in $script:FunctionOrder) {
    $item = Get-ManifestFunction -Manifest $Manifest -Name $functionName
    $switchName = [string]@((Get-ObjectProperty $item "runtimeSwitches").PSObject.Properties)[0].Name
    Write-Host "PLAN function deploy: $functionName; switch=${switchName}:true"
  }
  $notify = Get-ManifestFunction -Manifest $Manifest -Name "payment-notify"
  $route = Get-ObjectProperty $notify "httpRoute"
  Write-Host "PLAN HTTP route ensure: $([string](Get-ObjectProperty $route 'path' '')) -> payment-notify"
  $reconcile = Get-ManifestFunction -Manifest $Manifest -Name "payment-reconcile"
  $timer = Get-ObjectProperty $reconcile "timer"
  Write-Host "PLAN Timer ensure: $([string](Get-ObjectProperty $timer 'name' '')) cron=$([string](Get-ObjectProperty $timer 'cron' ''))"
  Write-Host "PLAN document ensure: recharge_config/global rechargeEnabled=true wxpay=true alipay=false rolloutPercent=100"
  if (@($Secrets.Missing).Count -gt 0) {
    Write-Host "MISSING_SECRET_KEYS: $(@($Secrets.Missing) -join ',')"
  }
  else {
    Write-Host "SECRET_KEYS_PRESENT: $($script:RequiredSecretKeys.Count)/$($script:RequiredSecretKeys.Count)"
  }
}

function ConvertFrom-TcbOutput {
  param([Parameter(Mandatory = $true)][string]$Text)
  $match = [regex]::Match($Text, '(?m)^\s*[\{\[]')
  if (-not $match.Success) { throw "CloudBase CLI did not return JSON." }
  $start = $match.Index
  while ($start -lt $Text.Length -and [char]::IsWhiteSpace($Text[$start])) { $start += 1 }
  try {
    return $Text.Substring($start) | ConvertFrom-Json
  }
  catch {
    throw "CloudBase CLI returned invalid JSON."
  }
}

function Resolve-TcbCli {
  $npxCommand = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
  if ($null -eq $npxCommand) { throw "npx.cmd is required to resolve CloudBase CLI 3.8.1." }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $lines = & $npxCommand.Source -y -p $script:CloudBaseCliPackage where.exe tcb.ps1 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { throw "CloudBase CLI 3.8.1 could not be resolved." }
  $candidate = @($lines | ForEach-Object { [string]$_ } | Where-Object {
    $_ -match 'tcb\.ps1\s*$' -and (Test-Path -LiteralPath $_.Trim() -PathType Leaf)
  } | Select-Object -Last 1)
  if ($candidate.Count -ne 1) { throw "CloudBase CLI PowerShell entrypoint was not found." }
  $cli = [IO.Path]::GetFullPath($candidate[0].Trim())
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $versionOutput = & $cli --version 2>&1
    $versionExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($versionExit -ne 0 -or (($versionOutput | Out-String) -notmatch 'CloudBase CLI 3\.8\.1')) {
    throw "CloudBase CLI version must be exactly 3.8.1."
  }
  return $cli
}

function Invoke-TcbJsonResult {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$WorkingDirectory = ""
  )
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $pushed = $false
  try {
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
      Push-Location -LiteralPath $WorkingDirectory
      $pushed = $true
    }
    $output = & $Cli @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    if ($pushed) { Pop-Location }
    $ErrorActionPreference = $previousPreference
  }
  $text = ($output | Out-String).Trim()
  $payload = $null
  try { $payload = ConvertFrom-TcbOutput -Text $text } catch {
    if ($exitCode -eq 0) { throw }
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Payload = $payload }
}

function Invoke-TcbJson {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$WorkingDirectory = "",
    [Parameter(Mandatory = $true)][string]$Operation
  )
  $result = Invoke-TcbJsonResult -Cli $Cli -Arguments $Arguments -WorkingDirectory $WorkingDirectory
  if ($result.ExitCode -ne 0 -or $null -eq $result.Payload) {
    $identity = Get-TcbErrorIdentity -Payload $result.Payload
    throw "CloudBase operation failed: $Operation. code=$($identity.Code) requestId=$($identity.RequestId). Raw CLI output was suppressed."
  }
  return $result.Payload
}

function Get-TcbData {
  param([object]$Payload)
  $data = Get-ObjectProperty $Payload "data" $null
  if ($null -ne $data) { return $data }
  return $Payload
}

function Get-TcbErrorIdentity {
  param([object]$Payload)
  $candidates = @($Payload)
  foreach ($name in @("error", "Error", "data", "Data")) {
    $candidate = Get-ObjectProperty -InputObject $Payload -Name $name -Default $null
    if ($null -ne $candidate) { $candidates += $candidate }
  }
  $code = "UNKNOWN"
  $requestId = "UNKNOWN"
  foreach ($candidate in $candidates) {
    if ($code -eq "UNKNOWN") {
      $value = [string](Get-FirstObjectProperty $candidate @("code", "Code", "ErrorCode", "errorCode") "")
      if (-not [string]::IsNullOrWhiteSpace($value)) { $code = $value }
    }
    if ($requestId -eq "UNKNOWN") {
      $value = [string](Get-FirstObjectProperty $candidate @("requestId", "RequestId", "requestID", "RequestID") "")
      if (-not [string]::IsNullOrWhiteSpace($value)) { $requestId = $value }
    }
  }
  return [pscustomobject]@{ Code = $code; RequestId = $requestId }
}

function Test-TcbResourceNotFoundCode {
  param(
    [string]$Code,
    [ValidateSet("Collection", "Function")][string]$ResourceType
  )
  $accepted = if ($ResourceType -eq "Function") {
    @("RESOURCE_NOT_FOUND", "ResourceNotFound.FunctionName", "ResourceNotFound.Function")
  }
  else {
    @("RESOURCE_NOT_FOUND", "ResourceNotFound.Collection")
  }
  return $accepted -contains $Code
}

function Get-EnvironmentDatabaseTag {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment
  )
  $payload = Invoke-TcbJson -Cli $Cli -Arguments @(
    "env", "detail", "-e", $Environment, "--json"
  ) -Operation "read environment detail"
  $data = Get-TcbData $payload
  if ([string](Get-ObjectProperty $data "envId" "") -ne $Environment `
      -or [string](Get-ObjectProperty $data "status" "") -ne "NORMAL") {
    throw "CloudBase environment is unavailable or does not match EnvironmentId."
  }
  $resources = Get-ObjectProperty $data "resources"
  $databases = @(Get-ObjectProperty $resources "databases" @())
  $running = @($databases | Where-Object {
    [string](Get-FirstObjectProperty $_ @("Status", "status") "") -eq "RUNNING"
  })
  if ($running.Count -ne 1) {
    throw "CloudBase environment must expose exactly one RUNNING document database."
  }
  $tag = [string](Get-FirstObjectProperty $running[0] @("InstanceId", "instanceId") "")
  if ([string]::IsNullOrWhiteSpace($tag)) { throw "CloudBase database tag is missing." }
  return $tag
}

function Invoke-FlexDbApi {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter(Mandatory = $true)][object]$Body,
    [switch]$AllowFailure
  )
  $bodyJson = $Body | ConvertTo-Json -Depth 20 -Compress
  $result = Invoke-TcbJsonResult -Cli $Cli -Arguments @(
    "api", "flexdb", $Action,
    "--body", $bodyJson,
    "--api-version", $script:FlexDbApiVersion,
    "--json"
  )
  if (-not $AllowFailure -and ($result.ExitCode -ne 0 -or $null -eq $result.Payload)) {
    throw "CloudBase database operation failed: $Action. Raw CLI output was suppressed."
  }
  return $result
}

function Get-CollectionDescription {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Collection
  )
  $result = Invoke-FlexDbApi -Cli $Cli -Action "DescribeTable" -Body ([ordered]@{
    Tag = $Tag
    TableName = $Collection
  }) -AllowFailure
  if ($result.ExitCode -eq 0 -and $null -ne $result.Payload) {
    return [pscustomobject]@{ Exists = $true; Data = (Get-TcbData $result.Payload) }
  }
  $identity = Get-TcbErrorIdentity -Payload $result.Payload
  $errorCode = [string]$identity.Code
  if (Test-TcbResourceNotFoundCode -Code $errorCode -ResourceType "Collection") {
    return [pscustomobject]@{ Exists = $false; Data = $null }
  }
  throw "CloudBase collection readback failed: $Collection. code=$($identity.Code) requestId=$($identity.RequestId). Raw CLI output was suppressed."
}

function Ensure-Collection {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Collection
  )
  $before = Get-CollectionDescription -Cli $Cli -Tag $Tag -Collection $Collection
  if (-not $before.Exists) {
    $create = Invoke-FlexDbApi -Cli $Cli -Action "CreateTable" -Body ([ordered]@{
      Tag = $Tag
      TableName = $Collection
    })
    if ($create.ExitCode -ne 0) { throw "CloudBase collection create failed: $Collection" }
  }
  $after = Get-CollectionDescription -Cli $Cli -Tag $Tag -Collection $Collection
  if (-not $after.Exists) { throw "CloudBase collection readback mismatch: $Collection" }
  Write-Host "VERIFIED collection: $Collection"
  return $after.Data
}

function Get-IndexDefinitionKey {
  param([Parameter(Mandatory = $true)][object]$Index)
  $name = [string](Get-FirstObjectProperty $Index @("Name", "name", "IndexName") "")
  $keySchema = Get-ObjectProperty $Index "MgoKeySchema" $null
  $keys = Get-FirstObjectProperty $Index @("Keys", "keys", "Key", "key", "MgoIndexKeys") $null
  if ($null -eq $keys -and $null -ne $keySchema) {
    $keys = Get-ObjectProperty $keySchema "MgoIndexKeys" @()
  }
  $keys = @($keys)
  $normalizedKeys = @($keys | ForEach-Object {
    [ordered]@{
      name = [string](Get-FirstObjectProperty $_ @("Name", "name") "")
      direction = [string](Get-FirstObjectProperty $_ @("Direction", "direction") "")
    }
  })
  $uniqueValue = Get-FirstObjectProperty $Index @("Unique", "unique", "MgoIsUnique") $null
  if ($null -eq $uniqueValue -and $null -ne $keySchema) {
    $uniqueValue = Get-ObjectProperty $keySchema "MgoIsUnique" $false
  }
  $unique = [bool]$uniqueValue
  return [pscustomobject]@{
    Name = $name
    Key = ([ordered]@{ keys = $normalizedKeys; unique = $unique } | ConvertTo-Json -Depth 8 -Compress)
  }
}

function ConvertTo-FlexDbCreateIndex {
  param([Parameter(Mandatory = $true)][object]$Spec)
  return [ordered]@{
    IndexName = [string]$Spec.name
    MgoKeySchema = [ordered]@{
      MgoIndexKeys = @(@($Spec.keys) | ForEach-Object {
        [ordered]@{ Name = [string]$_.name; Direction = [string]$_.direction }
      })
      MgoIsUnique = [bool]$Spec.unique
    }
  }
}

function Ensure-CollectionIndexes {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Collection,
    [Parameter(Mandatory = $true)][object[]]$Specs
  )
  if ($Specs.Count -eq 0) { return }
  $description = Get-CollectionDescription -Cli $Cli -Tag $Tag -Collection $Collection
  if (-not $description.Exists) { throw "Collection disappeared before index provisioning: $Collection" }
  $actual = @(Get-ObjectProperty $description.Data "Indexes" @())
  $missing = @()
  foreach ($spec in $Specs) {
    $expected = Get-IndexDefinitionKey ([pscustomobject]@{
      Name = [string]$spec.name
      Keys = @($spec.keys)
      Unique = [bool]$spec.unique
    })
    $sameName = @($actual | Where-Object {
      [string](Get-FirstObjectProperty $_ @("Name", "name", "IndexName") "") -eq $expected.Name
    })
    if ($sameName.Count -gt 1) { throw "Duplicate online index name: $Collection/$($expected.Name)" }
    if ($sameName.Count -eq 1) {
      $online = Get-IndexDefinitionKey $sameName[0]
      if ($online.Key -ne $expected.Key) {
        throw "Online index definition mismatch; destructive rebuild is refused: $Collection/$($expected.Name)"
      }
      continue
    }
    $equivalent = @($actual | Where-Object { (Get-IndexDefinitionKey $_).Key -eq $expected.Key })
    if ($equivalent.Count -eq 0) { $missing += $spec }
  }
  if ($missing.Count -gt 0) {
    $createIndexes = @($missing | ForEach-Object { ConvertTo-FlexDbCreateIndex $_ })
    $update = Invoke-FlexDbApi -Cli $Cli -Action "UpdateTable" -Body ([ordered]@{
      Tag = $Tag
      TableName = $Collection
      CreateIndexes = $createIndexes
    })
    if ($update.ExitCode -ne 0) { throw "CloudBase index create failed: $Collection" }
  }
  $verified = Get-CollectionDescription -Cli $Cli -Tag $Tag -Collection $Collection
  $onlineIndexes = @(Get-ObjectProperty $verified.Data "Indexes" @())
  foreach ($spec in $Specs) {
    $expected = Get-IndexDefinitionKey ([pscustomobject]@{
      Name = [string]$spec.name
      Keys = @($spec.keys)
      Unique = [bool]$spec.unique
    })
    $match = @($onlineIndexes | Where-Object {
      (Get-IndexDefinitionKey $_).Key -eq $expected.Key
    })
    if ($match.Count -lt 1) { throw "CloudBase index readback mismatch: $Collection/$($expected.Name)" }
    Write-Host "VERIFIED index: $Collection/$($expected.Name)"
  }
}

function New-RechargeConfigDocument {
  return [ordered]@{
    version = 1
    rechargeEnabled = $true
    channelConfig = [ordered]@{
      wxpay = [ordered]@{ enabled = $true }
      alipay = [ordered]@{ enabled = $false }
    }
    gray = [ordered]@{
      strategy = "hash"
      rolloutPercent = 100
    }
  }
}

function Invoke-NoSqlCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Collection,
    [Parameter(Mandatory = $true)][string]$CommandType,
    [Parameter(Mandatory = $true)][object]$Command,
    [Parameter(Mandatory = $true)][string]$Operation
  )
  $inner = $Command | ConvertTo-Json -Depth 20 -Compress
  $entry = [ordered]@{
    TableName = $Collection
    CommandType = $CommandType
    Command = $inner
  }
  $commands = ConvertTo-Json -InputObject (, $entry) -Depth 20 -Compress
  return Invoke-TcbJson -Cli $Cli -Arguments @(
    "-e", $Environment,
    "db", "nosql", "execute",
    "--tag", $Tag,
    "--command", $commands,
    "--json"
  ) -Operation $Operation
}

function Get-NoSqlFirstDocument {
  param([Parameter(Mandatory = $true)][object]$Payload)
  $data = Get-TcbData $Payload
  $results = @(Get-ObjectProperty $data "results" @())
  if ($results.Count -ne 1) { throw "CloudBase NoSQL readback shape is invalid." }
  $documents = @($results[0])
  if ($documents.Count -eq 0) { return $null }
  return $documents[0]
}

function Ensure-RechargeConfig {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][string]$Tag
  )
  $desired = New-RechargeConfigDocument
  $set = [ordered]@{
    version = $desired.version
    rechargeEnabled = $true
    "channelConfig.wxpay.enabled" = $true
    "channelConfig.alipay.enabled" = $false
    "gray.strategy" = "hash"
    "gray.rolloutPercent" = 100
  }
  $update = [ordered]@{
    update = "recharge_config"
    updates = @([ordered]@{
      q = [ordered]@{ _id = "global" }
      u = [ordered]@{ '$set' = $set }
      upsert = $true
      multi = $false
    })
  }
  Invoke-NoSqlCommand -Cli $Cli -Environment $Environment -Tag $Tag -Collection "recharge_config" `
    -CommandType "UPDATE" -Command $update -Operation "upsert recharge_config/global" | Out-Null
  $query = [ordered]@{
    find = "recharge_config"
    filter = [ordered]@{ _id = "global" }
    limit = 1
  }
  $payload = Invoke-NoSqlCommand -Cli $Cli -Environment $Environment -Tag $Tag -Collection "recharge_config" `
    -CommandType "QUERY" -Command $query -Operation "read recharge_config/global"
  $document = Get-NoSqlFirstDocument $payload
  $channel = Get-ObjectProperty $document "channelConfig"
  $gray = Get-ObjectProperty $document "gray"
  $wxpay = Get-ObjectProperty $channel "wxpay"
  $alipay = Get-ObjectProperty $channel "alipay"
  if ($null -eq $document `
      -or (Get-ObjectProperty $document "rechargeEnabled" $false) -ne $true `
      -or (Get-ObjectProperty $wxpay "enabled" $false) -ne $true `
      -or (Get-ObjectProperty $alipay "enabled" $true) -ne $false `
      -or [int](Get-ObjectProperty $gray "rolloutPercent" -1) -ne 100) {
    throw "recharge_config/global readback mismatch."
  }
  Write-Host "VERIFIED document: recharge_config/global"
  return $document
}

function New-FunctionEnvironment {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Secrets,
    [Parameter(Mandatory = $true)][string]$SwitchName
  )
  $environment = [ordered]@{
    NODE_ENV = "production"
    APP_ENV = "production"
    PAYMENT_ENV = "production"
    XINGJU_ENV = "production"
    XINGJU_SIGNATURE_MODE = "rsa"
  }
  foreach ($key in @($script:RequiredSecretKeys + $script:OptionalSecretKeys)) {
    if ($Secrets.Contains($key)) { $environment[$key] = [string]$Secrets[$key] }
  }
  $environment[$SwitchName] = "true"
  return $environment
}

function Protect-SensitivePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Directory
  )
  if ($IsWindows) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity.User) { throw "Cannot resolve the current Windows SID for sensitive ACL setup." }
    if ($Directory) {
      $security = [Security.AccessControl.DirectorySecurity]::new()
      $security.SetOwner($identity.User)
      $security.SetAccessRuleProtection($true, $false)
      $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
      )
      $security.AddAccessRule($rule)
      [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $security)
    }
    else {
      $security = [Security.AccessControl.FileSecurity]::new()
      $security.SetOwner($identity.User)
      $security.SetAccessRuleProtection($true, $false)
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow
      )
      $security.AddAccessRule($rule)
      [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), $security)
    }
    return
  }
  $mode = if ($Directory) { "700" } else { "600" }
  & chmod $mode -- $Path
  if ($LASTEXITCODE -ne 0) { throw "Failed to restrict sensitive path permissions: $Path" }
}

function Get-FunctionDetail {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $payload = Invoke-TcbJson -Cli $Cli -Arguments @(
    "fn", "detail", $Name, "-e", $Environment, "--json"
  ) -Operation "read function $Name"
  return Get-TcbData $payload
}

function ConvertTo-EnvironmentMap {
  param([object]$FunctionDetail)
  $map = [ordered]@{}
  $environment = Get-ObjectProperty $FunctionDetail "Environment"
  foreach ($entry in @(Get-ObjectProperty $environment "Variables" @())) {
    $key = [string](Get-FirstObjectProperty $entry @("Key", "key") "")
    if (-not [string]::IsNullOrWhiteSpace($key)) {
      $map[$key] = [string](Get-FirstObjectProperty $entry @("Value", "value") "")
    }
  }
  return $map
}

function Get-ExistingProductionSecrets {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment
  )
  $values = [ordered]@{}
  foreach ($name in $script:FunctionOrder) {
    $result = Invoke-TcbJsonResult -Cli $Cli -Arguments @(
      "fn", "detail", $name, "-e", $Environment, "--json"
    )
    if ($result.ExitCode -ne 0 -or $null -eq $result.Payload) {
      $identity = Get-TcbErrorIdentity -Payload $result.Payload
      if (Test-TcbResourceNotFoundCode -Code ([string]$identity.Code) -ResourceType "Function") { continue }
      throw "CloudBase function readback failed before environment merge: $name. code=$($identity.Code) requestId=$($identity.RequestId). Raw CLI output was suppressed."
    }
    $environmentMap = ConvertTo-EnvironmentMap (Get-TcbData $result.Payload)
    foreach ($key in @($script:RequiredSecretKeys + $script:OptionalSecretKeys)) {
      if (-not $environmentMap.Contains($key) -or
          [string]::IsNullOrWhiteSpace([string]$environmentMap[$key])) {
        continue
      }
      $value = [string]$environmentMap[$key]
      if ($values.Contains($key) -and
          -not [string]::Equals([string]$values[$key], $value, [StringComparison]::Ordinal)) {
        throw "Existing payment function environments disagree for key: $key"
      }
      $values[$key] = $value
    }
  }
  return $values
}

function Merge-ProductionSecrets {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Existing,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Supplied
  )
  $merged = [ordered]@{}
  foreach ($key in $Existing.Keys) { $merged[$key] = [string]$Existing[$key] }
  foreach ($key in $Supplied.Keys) { $merged[$key] = [string]$Supplied[$key] }
  return $merged
}

function Assert-FunctionReadback {
  param(
    [Parameter(Mandatory = $true)][object]$Detail,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$ExpectedEnvironment
  )
  if ([string](Get-FirstObjectProperty $Detail @("FunctionName", "functionName") "") -ne $Name `
      -or [string](Get-FirstObjectProperty $Detail @("Status", "status") "") -ne "Active" `
      -or [int](Get-FirstObjectProperty $Detail @("Timeout", "timeout") 0) -ne $TimeoutSeconds `
      -or [string](Get-FirstObjectProperty $Detail @("Runtime", "runtime") "") -ne "Nodejs20.19" `
      -or [string](Get-FirstObjectProperty $Detail @("Handler", "handler") "") -ne "index.main") {
    throw "CloudBase function metadata readback mismatch: $Name"
  }
  $actual = ConvertTo-EnvironmentMap $Detail
  foreach ($key in $ExpectedEnvironment.Keys) {
    if (-not $actual.Contains($key) -or [string]$actual[$key] -ne [string]$ExpectedEnvironment[$key]) {
      throw "CloudBase function environment readback mismatch: $Name/$key"
    }
  }
}

function Deploy-PaymentFunction {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][object]$ManifestItem,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Secrets
  )
  $name = [string](Get-ObjectProperty $ManifestItem "name" "")
  $timeoutSeconds = [int](Get-ObjectProperty $ManifestItem "timeoutSeconds" 0)
  $root = [IO.Path]::GetFullPath(
    (Join-Path $Project ([string](Get-ObjectProperty $ManifestItem "root" "")))
  )
  $switchProperty = @((Get-ObjectProperty $ManifestItem "runtimeSwitches").PSObject.Properties)
  if ($switchProperty.Count -ne 1 -or $switchProperty[0].Value -ne $true) {
    throw "Function runtime switch contract is invalid: $name"
  }
  $switchName = [string]$switchProperty[0].Name
  if (-not $script:RuntimeSwitchMap.Contains($switchName)) {
    throw "Function runtime switch is not approved: $switchName"
  }
  $switchEnvironmentName = [string]$script:RuntimeSwitchMap[$switchName]
  $functionEnvironment = New-FunctionEnvironment -Secrets $Secrets -SwitchName $switchEnvironmentName

  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\", "/")
  $tempRoot = Join-Path $tempParent ("aips-payment-production-" + [guid]::NewGuid().ToString("N"))
  if ([IO.Path]::GetDirectoryName($tempRoot).TrimEnd("\", "/") -ne $tempParent `
      -or [IO.Path]::GetFileName($tempRoot) -notlike "aips-payment-production-*") {
    throw "Temporary deployment path validation failed."
  }
  try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Protect-SensitivePath -Path $tempRoot -Directory
    $config = [ordered]@{
      envId = $Environment
      functions = @([ordered]@{
        name = $name
        timeout = $timeoutSeconds
        runtime = "Nodejs20.19"
        handler = "index.main"
        installDependency = $true
        envVariables = $functionEnvironment
      })
    }
    $temporaryConfigPath = Join-Path $tempRoot "cloudbaserc.json"
    [IO.File]::WriteAllText(
      $temporaryConfigPath,
      ($config | ConvertTo-Json -Depth 20),
      [Text.UTF8Encoding]::new($false)
    )
    Protect-SensitivePath -Path $temporaryConfigPath
    Invoke-TcbJson -Cli $Cli -WorkingDirectory $tempRoot -Arguments @(
      "fn", "deploy", $name,
      "--dir", $root,
      "--force",
      "--install-dependency", "true",
      "--json"
    ) -Operation "deploy function $name" | Out-Null
  }
  finally {
    if ((Test-Path -LiteralPath $tempRoot) `
        -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($tempRoot)).TrimEnd("\", "/") -eq $tempParent `
        -and [IO.Path]::GetFileName($tempRoot) -like "aips-payment-production-*") {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Stop
      if (Test-Path -LiteralPath $tempRoot) {
        throw "Sensitive temporary deployment directory cleanup failed."
      }
    }
  }
  $detail = Get-FunctionDetail -Cli $Cli -Environment $Environment -Name $name
  Assert-FunctionReadback -Detail $detail -Name $name -TimeoutSeconds $timeoutSeconds `
    -ExpectedEnvironment $functionEnvironment
  Write-Host "VERIFIED function: $name; switch=${switchEnvironmentName}:true"
  return $detail
}

function Get-DefaultHttpDomain {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment
  )
  $payload = Invoke-TcbJson -Cli $Cli -Arguments @(
    "domains", "ls", "-e", $Environment, "--limit", "1000", "--json"
  ) -Operation "read HTTP domains"
  $data = @(Get-TcbData $payload)
  $httpDomains = @($data | Where-Object {
    [string](Get-FirstObjectProperty $_ @("domainType", "DomainType") "HTTPSERVICE") -eq "HTTPSERVICE" `
      -and (Get-FirstObjectProperty $_ @("enable", "Enable") $false) -eq $true `
      -and [string](Get-FirstObjectProperty $_ @("status", "Status") "") -eq "SUCCESS"
  })
  $matching = @($httpDomains | Where-Object {
    (Get-FirstObjectProperty $_ @("isDefault", "IsDefault") $false) -eq $true `
      -and (Get-FirstObjectProperty $_ @("enable", "Enable") $false) -eq $true `
      -and [string](Get-FirstObjectProperty $_ @("status", "Status") "") -eq "SUCCESS"
  })
  if ($matching.Count -gt 1) {
    throw "CloudBase exposes multiple enabled default HTTP domains."
  }
  $domain = if ($matching.Count -eq 1) {
    [string](Get-FirstObjectProperty $matching[0] @("domain", "Domain") "")
  }
  else {
    # Match CloudBase CLI's own fallback: DescribeEnvInfo carries the AppId and
    # region needed for the deterministic default HTTPSERVICE hostname.
    $body = [ordered]@{ EnvId = $Environment } | ConvertTo-Json -Compress
    $environmentPayload = Invoke-TcbJson -Cli $Cli -Arguments @(
      "api", "tcb", "DescribeEnvInfo",
      "--body", $body,
      "--api-version", $script:TcbApiVersion,
      "--json"
    ) -Operation "derive default HTTP domain"
    $environmentData = Get-TcbData $environmentPayload
    $environmentInfo = Get-FirstObjectProperty $environmentData @("EnvInfo", "envInfo") $null
    $baseInfo = Get-FirstObjectProperty $environmentInfo @("EnvBaseInfo", "envBaseInfo") $null
    $userInfo = Get-FirstObjectProperty $environmentInfo @("UserInfo", "userInfo") $null
    $region = [string](Get-FirstObjectProperty $baseInfo @("Region", "region") "")
    $appId = [string](Get-FirstObjectProperty $userInfo @("AppId", "appId") "")
    if ([string](Get-FirstObjectProperty $baseInfo @("EnvId", "envId") "") -eq $Environment -and
        [string](Get-FirstObjectProperty $baseInfo @("Status", "status", "EnvStatus", "envStatus") "") -eq "NORMAL" -and
        $region -match '^[a-z0-9-]+$' -and $appId -match '^\d+$') {
      Write-Warning "CloudBase domains list omitted the default domain; using the DescribeEnvInfo-derived host."
      "$Environment-$appId.$region.app.tcloudbase.com"
    }
    elseif ($httpDomains.Count -eq 1) {
      Write-Warning "CloudBase has no marked default domain; using its sole enabled HTTPSERVICE domain."
      [string](Get-FirstObjectProperty $httpDomains[0] @("domain", "Domain") "")
    }
    else {
      $routeBody = [ordered]@{ EnvId = $Environment; Offset = 0; Limit = 1000 } | ConvertTo-Json -Compress
      $routePayload = Invoke-TcbJson -Cli $Cli -Arguments @(
        "api", "tcb", "DescribeHTTPServiceRoute",
        "--body", $routeBody,
        "--api-version", $script:TcbApiVersion,
        "--json"
      ) -Operation "read HTTP service origin domain"
      $originDomain = [string](Get-FirstObjectProperty (Get-TcbData $routePayload) @("OriginDomain", "originDomain") "")
      if ([string]::IsNullOrWhiteSpace($originDomain)) {
        throw "CloudBase default HTTP domain is absent and cannot be derived from the environment identity."
      }
      Write-Warning "CloudBase default domain is unavailable; using the API-reported HTTP service origin domain."
      $originDomain
    }
  }
  if ([string]::IsNullOrWhiteSpace($domain)) { throw "CloudBase default HTTP domain is empty." }
  if ($domain -notmatch '^[A-Za-z0-9.-]+\.(?:app\.tcloudbase\.com|tcbaccess-in\.tencentcloudbase\.com)$') {
    throw "CloudBase default HTTP domain has an unexpected hostname."
  }
  return $domain
}

function Resolve-NotifyUrl {
  param(
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Secrets,
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $expected = "https://$Domain$Path"
  if (-not $Secrets.Contains("XINGJU_NOTIFY_URL")) {
    $Secrets["XINGJU_NOTIFY_URL"] = $expected
    return $expected
  }
  $uri = $null
  if (-not [Uri]::TryCreate([string]$Secrets["XINGJU_NOTIFY_URL"], [UriKind]::Absolute, [ref]$uri) `
      -or $uri.Scheme -ne "https" `
      -or -not [string]::Equals($uri.DnsSafeHost, $Domain, [StringComparison]::OrdinalIgnoreCase) `
      -or $uri.AbsolutePath.TrimEnd("/") -ne $Path.TrimEnd("/") `
      -or -not [string]::IsNullOrWhiteSpace($uri.Query) `
      -or -not [string]::IsNullOrWhiteSpace($uri.Fragment)) {
    throw "XINGJU_NOTIFY_URL must exactly match the approved CloudBase default-domain route."
  }
  $Secrets["XINGJU_NOTIFY_URL"] = $expected
  return $expected
}

function Get-RouteList {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][string]$Path
  )
  # `routes list --json` in CloudBase CLI 3.8.1 intentionally drops
  # EnableSafeDomain and QPSPolicy. Read the raw API response so the production
  # gate can verify every security/rate-limit field it just wrote.
  $body = [ordered]@{
    EnvId = $Environment
    Offset = 0
    Limit = 1000
    Filters = @(
      [ordered]@{ Name = "DomainType"; Values = @("HTTPSERVICE") },
      [ordered]@{ Name = "Domain"; Values = @($Domain) },
      [ordered]@{ Name = "Path"; Values = @($Path) }
    )
  } | ConvertTo-Json -Depth 12 -Compress
  $payload = Invoke-TcbJson -Cli $Cli -Arguments @(
    "api", "tcb", "DescribeHTTPServiceRoute",
    "--body", $body,
    "--api-version", $script:TcbApiVersion,
    "--json"
  ) -Operation "read full HTTP route"
  $data = Get-TcbData $payload
  $routes = @()
  foreach ($domainItem in @(Get-FirstObjectProperty $data @("Domains", "domains") @())) {
    $domainName = [string](Get-FirstObjectProperty $domainItem @("Domain", "domain") "")
    foreach ($route in @(Get-FirstObjectProperty $domainItem @("Routes", "routes") @())) {
      $flat = [ordered]@{ Domain = $domainName }
      foreach ($property in $route.PSObject.Properties) { $flat[$property.Name] = $property.Value }
      $routes += [pscustomobject]$flat
    }
  }
  return $routes
}

function Assert-NotifyRoute {
  param(
    [Parameter(Mandatory = $true)][object[]]$Routes,
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][object]$RouteManifest
  )
  $path = [string](Get-ObjectProperty $RouteManifest "path" "")
  $matches = @($Routes | Where-Object {
    [string](Get-FirstObjectProperty $_ @("domain", "Domain") "") -eq $Domain `
      -and [string](Get-FirstObjectProperty $_ @("path", "Path") "") -eq $path
  })
  if ($matches.Count -ne 1) { throw "CloudBase HTTP route readback count mismatch." }
  $route = $matches[0]
  $qps = Get-FirstObjectProperty $route @("qpsPolicy", "QpsPolicy", "QPSPolicy") $null
  $perClient = Get-FirstObjectProperty $qps @("qpsPerClient", "QpsPerClient", "QPSPerClient") $null
  if ([string](Get-FirstObjectProperty $route @("upstreamResourceType", "UpstreamResourceType") "") -ne "SCF" `
      -or [string](Get-FirstObjectProperty $route @("upstreamResourceName", "UpstreamResourceName") "") -ne "payment-notify" `
      -or (Get-FirstObjectProperty $route @("enable", "Enable") $false) -ne $true `
      -or (Get-FirstObjectProperty $route @("enableAuth", "EnableAuth") $true) -ne $false `
      -or (Get-FirstObjectProperty $route @("enableSafeDomain", "EnableSafeDomain") $false) -ne $true `
      -or (Get-FirstObjectProperty $route @("enablePathTransmission", "EnablePathTransmission") $true) -ne $false `
      -or [int](Get-FirstObjectProperty $qps @("qpsTotal", "QpsTotal", "QPSTotal") -1) -ne [int](Get-ObjectProperty $RouteManifest "qpsTotal" 100) `
      -or [string](Get-FirstObjectProperty $perClient @("limitBy", "LimitBy") "") -ne "ClientIP" `
      -or [int](Get-FirstObjectProperty $perClient @("limitValue", "LimitValue") -1) -ne [int](Get-ObjectProperty $RouteManifest "qpsPerClient" 20)) {
    throw "CloudBase HTTP route readback mismatch."
  }
  return $route
}

function Ensure-NotifyRoute {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][object]$RouteManifest
  )
  $path = [string](Get-ObjectProperty $RouteManifest "path" "")
  $routes = Get-RouteList -Cli $Cli -Environment $Environment -Domain $Domain -Path $path
  $existing = @($routes | Where-Object {
    [string](Get-FirstObjectProperty $_ @("domain", "Domain") "") -eq $Domain `
      -and [string](Get-FirstObjectProperty $_ @("path", "Path") "") -eq $path
  })
  if ($existing.Count -gt 1) { throw "Multiple CloudBase routes use the payment notify path." }
  $route = [ordered]@{
    path = $path
    upstreamResourceType = "SCF"
    upstreamResourceName = "payment-notify"
    enable = $true
    enableAuth = $false
    enableSafeDomain = $true
    enablePathTransmission = $false
    qpsPolicy = [ordered]@{
      qpsTotal = [int](Get-ObjectProperty $RouteManifest "qpsTotal" 100)
      qpsPerClient = [ordered]@{
        limitBy = "ClientIP"
        limitValue = [int](Get-ObjectProperty $RouteManifest "qpsPerClient" 20)
      }
    }
  }
  $data = [ordered]@{ domain = $Domain; routes = @($route) } | ConvertTo-Json -Depth 12 -Compress
  $command = if ($existing.Count -eq 0) { "add" } else { "edit" }
  Invoke-TcbJson -Cli $Cli -Arguments @(
    "routes", $command, "-e", $Environment, "--data", $data, "--json"
  ) -Operation "$command HTTP route" | Out-Null
  $verified = Get-RouteList -Cli $Cli -Environment $Environment -Domain $Domain -Path $path
  $verifiedRoute = Assert-NotifyRoute -Routes $verified -Domain $Domain -RouteManifest $RouteManifest
  Write-Host "VERIFIED HTTP route: https://$Domain$path"
  return $verifiedRoute
}

function Find-ReconcileTrigger {
  param(
    [Parameter(Mandatory = $true)][object]$FunctionDetail,
    [Parameter(Mandatory = $true)][string]$Name
  )
  return @(@(Get-ObjectProperty $FunctionDetail "Triggers" @()) | Where-Object {
    [string](Get-FirstObjectProperty $_ @("TriggerName", "triggerName", "Name", "name") "") -eq $Name
  })
}

function Assert-ReconcileTrigger {
  param(
    [Parameter(Mandatory = $true)][object[]]$Matches,
    [Parameter(Mandatory = $true)][string]$Cron
  )
  if ($Matches.Count -ne 1) { throw "CloudBase Timer readback count mismatch." }
  $trigger = $Matches[0]
  $actualCron = [string](Get-FirstObjectProperty $trigger @("TriggerDesc", "triggerDesc", "Cron", "cron") "")
  if ($actualCron -ne $Cron) { throw "CloudBase Timer cron readback mismatch." }
  $enabled = Get-FirstObjectProperty $trigger @("Enable", "enable", "Status", "status") $null
  if ($null -eq $enabled `
      -or $enabled -eq $false `
      -or [string]$enabled -match '^(0|FALSE|CLOSE|CLOSED|DISABLED)$') {
    throw "CloudBase Timer is disabled."
  }
  return $trigger
}

function Ensure-ReconcileTimer {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][object]$TimerManifest
  )
  $functionName = "payment-reconcile"
  $triggerName = [string](Get-ObjectProperty $TimerManifest "name" "")
  $cron = [string](Get-ObjectProperty $TimerManifest "cron" "")
  $detail = Get-FunctionDetail -Cli $Cli -Environment $Environment -Name $functionName
  $matches = Find-ReconcileTrigger -FunctionDetail $detail -Name $triggerName
  if ($matches.Count -gt 1) { throw "Multiple CloudBase Timer triggers use the payment reconcile name." }
  if ($matches.Count -eq 1) {
    try {
      Assert-ReconcileTrigger -Matches $matches -Cron $cron | Out-Null
    }
    catch {
      Invoke-TcbJson -Cli $Cli -Arguments @(
        "fn", "trigger", "delete", $functionName, $triggerName,
        "-e", $Environment,
        "--json"
      ) -Operation "delete drifted payment reconcile Timer" | Out-Null
      $matches = @()
    }
  }
  if ($matches.Count -eq 0) {
    Invoke-TcbJson -Cli $Cli -Arguments @(
      "fn", "trigger", "create", $functionName,
      "--trigger-name", $triggerName,
      "--cron", $cron,
      "-e", $Environment,
      "--json"
    ) -Operation "create payment reconcile Timer" | Out-Null
  }
  $verifiedDetail = Get-FunctionDetail -Cli $Cli -Environment $Environment -Name $functionName
  $verified = Find-ReconcileTrigger -FunctionDetail $verifiedDetail -Name $triggerName
  $verifiedTrigger = Assert-ReconcileTrigger -Matches $verified -Cron $cron
  Write-Host "VERIFIED Timer: $triggerName"
  return $verifiedTrigger
}

function Write-PaymentDeploymentReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$ContextPath,
    [Parameter(Mandatory = $true)][object]$Context,
    [Parameter(Mandatory = $true)][object]$Receipt
  )
  $contextHash = [ordered]@{}
  foreach ($property in $Context.PSObject.Properties) {
    $contextHash[$property.Name] = $property.Value
  }
  $contextHash["paymentDeployment"] = $Receipt
  Write-CloudDeployContextAtomic -ContextPath $ContextPath -Context ([pscustomobject]$contextHash)
}

function New-PaymentDeploymentIdempotencyKey {
  param(
    [Parameter(Mandatory = $true)][object]$Context,
    [Parameter(Mandatory = $true)][string]$Environment
  )
  foreach ($field in @("operationId", "releaseCommit", "treeSha")) {
    if ($null -eq $Context.PSObject.Properties[$field] -or
        [string]::IsNullOrWhiteSpace([string]$Context.$field)) {
      throw "Cannot create payment deployment idempotency key; release context is missing $field."
    }
  }
  if ([string]::IsNullOrWhiteSpace($Environment)) {
    throw "Cannot create payment deployment idempotency key; environment is missing."
  }
  return "payment:$([string]$Context.operationId):$([string]$Context.releaseCommit):$([string]$Context.treeSha):$Environment"
}

$project = Resolve-ProjectRoot $ProjectPath
$environment = Resolve-EnvironmentId -Project $project -RequestedId $EnvironmentId
$version = Get-AppVersion -Project $project
$manifestPath = Join-Path $project "scripts\payment-cloudfunctions.json"
$manifest = Read-JsonFile -Path $manifestPath -Label "payment-cloudfunctions.json"
Assert-PaymentManifest -Manifest $manifest -Project $project

$indexManifestPath = Join-Path $project "scripts\database-indexes.json"
$indexManifest = Read-JsonFile -Path $indexManifestPath -Label "database-indexes.json"
$paymentIndexes = @(@(Get-ObjectProperty $indexManifest "indexes" @()) | Where-Object {
  $script:PaymentCollections -contains [string](Get-ObjectProperty $_ "collection" "")
})
if ($paymentIndexes.Count -lt 2) {
  throw "Payment database indexes are missing from database-indexes.json."
}

$secretState = Read-ProductionSecrets -Project $project -Path $SecretFile
Write-DeploymentPlan -Manifest $manifest -Environment $environment -Secrets $secretState `
  -PaymentIndexes $paymentIndexes

if ($WhatIf) {
  if ($secretState.Values.Count -gt 0) {
    Assert-ProductionSecretShape -Values $secretState.Values
  }
  Write-Host "WHATIF_OK: no CloudBase read or mutation was executed."
  exit 0
}

$contextPath = if ([string]::IsNullOrWhiteSpace($ReleaseContext)) {
  [string]$env:RELEASE_GATE_CONTEXT
}
else {
  $ReleaseContext
}
if ([string]::IsNullOrWhiteSpace($contextPath)) {
  throw "ReleaseContext is required for production deployment."
}
$safetyScript = Join-Path $project "scripts\cloud-deploy-safety.ps1"
if (-not (Test-Path -LiteralPath $safetyScript -PathType Leaf)) {
  throw "cloud-deploy-safety.ps1 is missing."
}
. $safetyScript
$expectedRemote = (& git -C $project remote get-url origin 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($expectedRemote)) {
  throw "Git origin could not be resolved for the release context check."
}
$releaseIdentity = Assert-CloudDeployReleaseContext `
  -ContextPath ([IO.Path]::GetFullPath($contextPath)) `
  -ProjectPath $project `
  -ExpectedVersion $version `
  -ExpectedRemoteUrl $expectedRemote `
  -AllowPostMergeRecovery:$AllowPostMergeRecovery

$lock = $null
$ownsLock = $false
try {
  if ($ReleaseGateLockHeld) {
    if ([string]::IsNullOrWhiteSpace($DeployLockPath)) {
      throw "DeployLockPath is required when ReleaseGateLockHeld is set."
    }
    Assert-ReleaseLockHandoff -LockPath $DeployLockPath `
      -HandoffToken $ReleaseGateLockToken `
      -OperationId ([string]$releaseIdentity.operationId) | Out-Null
  }
  else {
    if (-not [string]::IsNullOrWhiteSpace($ReleaseGateLockToken)) {
      throw "ReleaseGateLockToken is only valid with ReleaseGateLockHeld."
    }
    $lock = Enter-CloudDeployLock -ProjectPath $project -TargetVersion $version `
      -FunctionName "payment-production" -WaitSeconds $LockWaitSeconds -LockPath $DeployLockPath
    $ownsLock = $true
  }
  $cli = Resolve-TcbCli
  $databaseTag = Get-EnvironmentDatabaseTag -Cli $cli -Environment $environment

  $existingSecrets = Get-ExistingProductionSecrets -Cli $cli -Environment $environment
  $effectiveSecrets = Merge-ProductionSecrets -Existing $existingSecrets -Supplied $secretState.Values
  $notifyItem = Get-ManifestFunction -Manifest $manifest -Name "payment-notify"
  $notifyRoute = Get-ObjectProperty $notifyItem "httpRoute"
  $domain = Get-DefaultHttpDomain -Cli $cli -Environment $environment
  $notifyUrl = Resolve-NotifyUrl -Secrets $effectiveSecrets -Domain $domain `
    -Path ([string](Get-ObjectProperty $notifyRoute "path" ""))
  Assert-ProductionSecretShape -Values $effectiveSecrets
  $missingCredentials = @($script:RequiredSecretKeys | Where-Object {
    -not $effectiveSecrets.Contains($_) -or [string]::IsNullOrWhiteSpace([string]$effectiveSecrets[$_])
  })
  $credentialsConfigured = $missingCredentials.Count -eq 0
  if (-not $credentialsConfigured) {
    Write-Warning "Payment provider remains fail-closed; missing credential keys: $($missingCredentials -join ',')"
  }

  foreach ($collection in $script:PaymentCollections) {
    Ensure-Collection -Cli $cli -Tag $databaseTag -Collection $collection | Out-Null
    $collectionIndexes = @($paymentIndexes | Where-Object {
      [string](Get-ObjectProperty $_ "collection" "") -eq $collection
    })
    Ensure-CollectionIndexes -Cli $cli -Tag $databaseTag -Collection $collection `
      -Specs $collectionIndexes
  }

  $notifyDetail = Deploy-PaymentFunction -Cli $cli -Project $project -Environment $environment `
    -ManifestItem $notifyItem -Secrets $effectiveSecrets
  $routeDetail = Ensure-NotifyRoute -Cli $cli -Environment $environment -Domain $domain `
    -RouteManifest $notifyRoute

  $reconcileItem = Get-ManifestFunction -Manifest $manifest -Name "payment-reconcile"
  $reconcileDetail = Deploy-PaymentFunction -Cli $cli -Project $project -Environment $environment `
    -ManifestItem $reconcileItem -Secrets $effectiveSecrets
  $timerDetail = Ensure-ReconcileTimer -Cli $cli -Environment $environment `
    -TimerManifest (Get-ObjectProperty $reconcileItem "timer")

  $apiItem = Get-ManifestFunction -Manifest $manifest -Name "payment-api"
  $apiDetail = Deploy-PaymentFunction -Cli $cli -Project $project -Environment $environment `
    -ManifestItem $apiItem -Secrets $effectiveSecrets
  $rechargeDetail = Ensure-RechargeConfig -Cli $cli -Environment $environment -Tag $databaseTag

  $functionReceipt = [ordered]@{}
  foreach ($pair in @(
    [pscustomobject]@{ Name = "payment-notify"; Detail = $notifyDetail; Switch = "PAYMENT_CALLBACK_PROCESSING_ENABLED" },
    [pscustomobject]@{ Name = "payment-reconcile"; Detail = $reconcileDetail; Switch = "PAYMENT_RECONCILIATION_ENABLED" },
    [pscustomobject]@{ Name = "payment-api"; Detail = $apiDetail; Switch = "PAYMENT_ORDER_CREATION_ENABLED" }
  )) {
    $functionReceipt[$pair.Name] = [ordered]@{
      status = [string](Get-FirstObjectProperty $pair.Detail @("Status", "status") "")
      runtime = [string](Get-FirstObjectProperty $pair.Detail @("Runtime", "runtime") "")
      handler = [string](Get-FirstObjectProperty $pair.Detail @("Handler", "handler") "")
      timeoutSeconds = [int](Get-FirstObjectProperty $pair.Detail @("Timeout", "timeout") 0)
      runtimeSwitch = [string]$pair.Switch
      runtimeSwitchEnabled = $true
    }
  }
  $paymentReceipt = [ordered]@{
    schemaVersion = 1
    state = "verified"
    status = "verified"
    operationId = [string]$releaseIdentity.operationId
    environment = $environment
    version = $version
    releaseCommit = [string]$releaseIdentity.releaseCommit
    treeSha = [string]$releaseIdentity.treeSha
    sourceSha256 = [string]$releaseIdentity.sourceSha256
    packageSha256 = [string]$releaseIdentity.packageSha256
    mainCommit = [string]$releaseIdentity.mainCommit
    idempotencyKey = New-PaymentDeploymentIdempotencyKey -Context $releaseIdentity -Environment $environment
    credentialsConfigured = [bool]$credentialsConfigured
    providerState = if ($credentialsConfigured) { "configured" } else { "fail-closed" }
    missingCredentialKeys = @($missingCredentials)
    functions = $functionReceipt
    route = [ordered]@{
      status = "verified"
      domain = $domain
      path = [string](Get-FirstObjectProperty $routeDetail @("path", "Path") "")
      target = "payment-notify"
      enabled = $true
    }
    timer = [ordered]@{
      status = "verified"
      name = [string](Get-FirstObjectProperty $timerDetail @("TriggerName", "triggerName", "Name", "name") "")
      cron = [string](Get-FirstObjectProperty $timerDetail @("TriggerDesc", "triggerDesc", "Cron", "cron") "")
      enabled = $true
    }
    rechargeConfig = [ordered]@{
      status = "verified"
      rechargeEnabled = [bool](Get-ObjectProperty $rechargeDetail "rechargeEnabled" $false)
      wxpayEnabled = $true
      alipayEnabled = $false
      rolloutPercent = 100
    }
    verifiedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Write-PaymentDeploymentReceipt -ContextPath ([IO.Path]::GetFullPath($contextPath)) `
    -Context $releaseIdentity -Receipt ([pscustomobject]$paymentReceipt)

  Write-Host "PAYMENT_PRODUCTION_DEPLOY_OK version=$version environment=$environment credentialsConfigured=$($credentialsConfigured.ToString().ToLowerInvariant())" -ForegroundColor Green
}
finally {
  if ($ownsLock -and $null -ne $lock) { Exit-CloudDeployLock -LockHandle $lock }
}
