param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$EnvironmentId = "",
  [switch]$CheckOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Stop-WithMessage {
  param(
    [string]$Message,
    [int]$ExitCode = 1
  )

  Write-Output $Message
  exit $ExitCode
}

function Require-File {
  param(
    [string]$Path,
    [string]$Code
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Stop-WithMessage -Message $Code -ExitCode 1
  }
}

function Get-SafeErrorCode {
  param(
    $ErrorValue,
    [string]$Fallback = "INDEX_MANAGER_FAILED"
  )

  $candidate = ""
  if ($null -ne $ErrorValue) {
    if ($ErrorValue -is [System.Management.Automation.ErrorRecord]) {
      $candidate = [string]$ErrorValue.Exception.Message
    } elseif ($ErrorValue -is [System.Exception]) {
      $candidate = [string]$ErrorValue.Message
    } elseif (
      $null -ne $ErrorValue.PSObject.Properties["code"]
    ) {
      $candidate = [string]$ErrorValue.code
    } else {
      $candidate = [string]$ErrorValue
    }
  }

  if ($candidate -match "^[A-Za-z0-9_.-]+$") {
    return $candidate
  }
  return $Fallback
}

function Write-JsonValue {
  param($Value)

  $json = ConvertTo-Json -InputObject $Value -Depth 30
  Write-Output $json
}

function Write-CompleteCheck {
  param(
    [string]$Label,
    $Check
  )

  Write-Output $Label
  Write-Output "results:"
  Write-JsonValue -Value @($Check.results)
  Write-Output "extras:"
  Write-JsonValue -Value @($Check.extras)
  Write-Output "summary:"
  Write-JsonValue -Value $Check.summary
}

function Save-Report {
  param(
    [string]$Path,
    $Report
  )

  $json = ConvertTo-Json -InputObject $Report -Depth 40
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $encoding)
}

function Get-IncompleteItems {
  param($Check)

  return @(
    @($Check.results) | Where-Object {
      $_.status -eq "missing" -or
      $_.status -eq "mismatched" -or
      $_.status -eq "collection-missing" -or
      $_.status -eq "check-failed"
    }
  )
}

function Invoke-IndexManager {
  param(
    [ValidateSet("check", "apply")]
    [string]$Command,
    [string]$Collection = "",
    [string]$IndexName = "",
    [switch]$AllowRebuild
  )

  $arguments = @(
    $script:ManagerPath,
    $Command,
    "--manifest",
    $script:ManifestPath,
    "--environment",
    $script:ResolvedEnvironmentId
  )
  if ($Command -eq "apply") {
    $arguments += @(
      "--collection",
      $Collection,
      "--index",
      $IndexName
    )
    if ($AllowRebuild) {
      $arguments += "--allow-rebuild"
    }
  }

  $stderrPath = [System.IO.Path]::GetTempFileName()
  try {
    $stdoutLines = @(
      & $script:NodePath @arguments 2> $stderrPath
    )
    $exitCode = $LASTEXITCODE
    $stdoutText = ($stdoutLines -join [Environment]::NewLine).Trim()
    $stderrText = [System.IO.File]::ReadAllText($stderrPath).Trim()
  } finally {
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }

  $jsonText = $stdoutText
  if ([string]::IsNullOrWhiteSpace($jsonText)) {
    $jsonText = $stderrText
  }
  if ([string]::IsNullOrWhiteSpace($jsonText)) {
    throw (New-Object System.Exception("INDEX_MANAGER_EMPTY_RESPONSE"))
  }

  try {
    $payload = ConvertFrom-Json -InputObject $jsonText -ErrorAction Stop
  } catch {
    throw (New-Object System.Exception("INDEX_MANAGER_JSON_INVALID"))
  }

  $hasError = $null -ne $payload.PSObject.Properties["error"]
  $hasResults = $null -ne $payload.PSObject.Properties["results"]
  $reportedFailure = (
    $null -ne $payload.PSObject.Properties["ok"] -and
    $payload.ok -eq $false -and
    -not $hasResults
  )
  if ($exitCode -ne 0 -or $hasError -or $reportedFailure) {
    $errorCode = "INDEX_MANAGER_FAILED"
    if (
      $hasError -and
      $null -ne $payload.error -and
      $null -ne $payload.error.PSObject.Properties["code"]
    ) {
      $errorCode = Get-SafeErrorCode -ErrorValue $payload.error
    }
    throw (New-Object System.Exception($errorCode))
  }

  if (
    $Command -eq "check" -and (
      -not $hasResults -or
      $null -eq $payload.PSObject.Properties["extras"] -or
      $null -eq $payload.PSObject.Properties["summary"]
    )
  ) {
    throw (New-Object System.Exception("INDEX_MANAGER_JSON_INVALID"))
  }

  return $payload
}

function New-SkippedOperation {
  param(
    $Item,
    [string]$Action,
    [string]$Reason
  )

  return [pscustomobject][ordered]@{
    collection = [string]$Item.collection
    indexName = [string]$Item.name
    action = $Action
    status = "skipped"
    reason = $Reason
  }
}

function Invoke-ApplyOperation {
  param(
    $Item,
    [string]$Action,
    [switch]$AllowRebuild
  )

  try {
    $applyResult = Invoke-IndexManager `
      -Command "apply" `
      -Collection ([string]$Item.collection) `
      -IndexName ([string]$Item.name) `
      -AllowRebuild:$AllowRebuild
    Write-Host "Apply result:"
    Write-Host (ConvertTo-Json -InputObject $applyResult -Depth 30)

    $status = "completed"
    if ($null -ne $applyResult.PSObject.Properties["status"]) {
      $status = [string]$applyResult.status
    }
    return [pscustomobject][ordered]@{
      collection = [string]$Item.collection
      indexName = [string]$Item.name
      action = $Action
      status = $status
      result = $applyResult
    }
  } catch {
    $errorCode = Get-SafeErrorCode -ErrorValue $_
    Write-Host ("Index operation failed: " + $errorCode)
    return [pscustomobject][ordered]@{
      collection = [string]$Item.collection
      indexName = [string]$Item.name
      action = $Action
      status = "failed"
      error = [pscustomobject][ordered]@{
        code = $errorCode
      }
    }
  }
}

$projectRoot = [System.IO.Path]::GetFullPath($ProjectPath)
$configPath = Join-Path $projectRoot "config.js"
$scriptRoot = Join-Path $projectRoot "scripts"
$script:ManifestPath = Join-Path $scriptRoot "database-indexes.json"
$toolRoot = Join-Path $scriptRoot "cloud-database-index-manager"
$script:ManagerPath = Join-Path $toolRoot "index.js"
$packageLockPath = Join-Path $toolRoot "package-lock.json"
$managerPackagePath = Join-Path (
  Join-Path $toolRoot "node_modules"
) "@cloudbase\manager-node"

Require-File -Path $configPath -Code "DATABASE_INDEX_CONFIG_MISSING"
Require-File -Path $script:ManifestPath -Code "DATABASE_INDEX_MANIFEST_MISSING"
Require-File -Path $script:ManagerPath -Code "DATABASE_INDEX_MANAGER_MISSING"
Require-File -Path $packageLockPath -Code "DATABASE_INDEX_MANAGER_LOCK_MISSING"

$nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  Stop-WithMessage -Message "NODE_NOT_FOUND" -ExitCode 1
}
$npmCommand = Get-Command "npm" -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
  Stop-WithMessage -Message "NPM_NOT_FOUND" -ExitCode 1
}
$script:NodePath = $nodeCommand.Source

if (
  [string]::IsNullOrWhiteSpace($env:TENCENTCLOUD_SECRET_ID) -or
  [string]::IsNullOrWhiteSpace($env:TENCENTCLOUD_SECRET_KEY)
) {
  Stop-WithMessage -Message "TENCENT_CLOUD_CREDENTIALS_MISSING" -ExitCode 1
}
Write-Output "Tencent Cloud credentials are configured."

$script:ResolvedEnvironmentId = $EnvironmentId.Trim()
if ([string]::IsNullOrWhiteSpace($script:ResolvedEnvironmentId)) {
  $configText = Get-Content -LiteralPath $configPath -Raw
  $environmentMatch = [regex]::Match(
    $configText,
    'cloudEnvId\s*:\s*["'']([^"'']+)["'']'
  )
  if (-not $environmentMatch.Success) {
    Stop-WithMessage -Message "TENCENT_CLOUD_ENVIRONMENT_MISSING" -ExitCode 1
  }
  $script:ResolvedEnvironmentId = $environmentMatch.Groups[1].Value.Trim()
}
if ([string]::IsNullOrWhiteSpace($script:ResolvedEnvironmentId)) {
  Stop-WithMessage -Message "TENCENT_CLOUD_ENVIRONMENT_MISSING" -ExitCode 1
}
Write-Output ("Cloud environment: " + $script:ResolvedEnvironmentId)

if (-not (Test-Path -LiteralPath $managerPackagePath -PathType Container)) {
  Write-Output "Installing the CloudBase index manager dependencies..."
  $installOutput = @(
    & $npmCommand.Source `
      ci `
      --ignore-scripts `
      --no-audit `
      --no-fund `
      --prefix $toolRoot 2>&1
  )
  if ($LASTEXITCODE -ne 0) {
    $installOutput | ForEach-Object { Write-Output ([string]$_) }
    Stop-WithMessage `
      -Message "DATABASE_INDEX_MANAGER_INSTALL_FAILED" `
      -ExitCode 1
  }
  Write-Output "CloudBase index manager dependencies installed."
}

$reportRoot = Join-Path $projectRoot "_tmp_database-index-reports"
[System.IO.Directory]::CreateDirectory($reportRoot) | Out-Null
$reportName = "database-index-report-{0}-{1}.json" -f (
  Get-Date -Format "yyyyMMdd-HHmmss"
), ([Guid]::NewGuid().ToString("N"))
$reportPath = Join-Path $reportRoot $reportName
$report = [pscustomobject][ordered]@{
  generatedAt = (Get-Date).ToString("o")
  environmentId = $script:ResolvedEnvironmentId
  checkOnly = [bool]$CheckOnly
  initial = $null
  operations = @()
  verification = $null
}

try {
  $initial = Invoke-IndexManager -Command "check"
} catch {
  $errorCode = Get-SafeErrorCode -ErrorValue $_
  $report.initial = [pscustomobject][ordered]@{
    ok = $false
    error = [pscustomobject][ordered]@{ code = $errorCode }
  }
  Save-Report -Path $reportPath -Report $report
  Write-Output ("Initial database index check failed: " + $errorCode)
  Write-Output ("Report: " + $reportPath)
  exit 1
}

$report.initial = $initial
Save-Report -Path $reportPath -Report $report
Write-CompleteCheck -Label "Initial database index check:" -Check $initial
Write-Output ("Report: " + $reportPath)

$initialIncomplete = @(Get-IncompleteItems -Check $initial)
if ($CheckOnly) {
  if ($initialIncomplete.Count -gt 0) {
    Write-Output "DATABASE_INDEX_CHECK_INCOMPLETE"
    exit 2
  }
  exit 0
}

$collectionMissing = @(
  @($initial.results) | Where-Object {
    $_.status -eq "collection-missing"
  }
)
if ($collectionMissing.Count -gt 0) {
  Write-Output "One or more collections are missing."
  Write-Output "Run scripts\init-cloud-database.ps1 first."
  Write-Output "DATABASE_INDEX_CHECK_INCOMPLETE"
  exit 2
}

$checkFailed = @(
  @($initial.results) | Where-Object {
    $_.status -eq "check-failed"
  }
)
if ($checkFailed.Count -gt 0) {
  Write-Output "One or more index checks failed. No changes were made."
  Write-Output "DATABASE_INDEX_CHECK_INCOMPLETE"
  exit 2
}

$operations = @()
$autoCreateMissing = $false
$quitChanges = $false
$changeItems = @(
  @($initial.results) | Where-Object {
    $_.status -eq "missing" -or $_.status -eq "mismatched"
  }
)

foreach ($item in $changeItems) {
  if ($quitChanges) {
    $operations += New-SkippedOperation `
      -Item $item `
      -Action ([string]$item.status) `
      -Reason "quit"
    continue
  }

  if ($item.status -eq "missing") {
    $shouldCreate = $autoCreateMissing
    if (-not $autoCreateMissing) {
      $answer = Read-Host "Create this index? [Y/N/A/Q]"
      $normalizedAnswer = [string]$answer
      $normalizedAnswer = $normalizedAnswer.Trim().ToUpperInvariant()
      if ($normalizedAnswer -eq "Y") {
        $shouldCreate = $true
      } elseif ($normalizedAnswer -eq "A") {
        $autoCreateMissing = $true
        $shouldCreate = $true
      } elseif ($normalizedAnswer -eq "Q") {
        $quitChanges = $true
        $operations += New-SkippedOperation `
          -Item $item `
          -Action "create" `
          -Reason "quit"
        continue
      } else {
        $operations += New-SkippedOperation `
          -Item $item `
          -Action "create" `
          -Reason "user-skipped"
        continue
      }
    }

    if ($shouldCreate) {
      $operations += Invoke-ApplyOperation `
        -Item $item `
        -Action "create"
    }
    continue
  }

  Write-Output (
    "Index definition mismatch: " +
    [string]$item.collection +
    "/" +
    [string]$item.name
  )
  Write-Output "Actual definition:"
  if ($null -ne $item.PSObject.Properties["actual"]) {
    Write-JsonValue -Value $item.actual
  } else {
    Write-JsonValue -Value $null
  }
  Write-Output "Expected definition:"
  Write-JsonValue -Value ([pscustomobject][ordered]@{
    name = [string]$item.name
    keys = @($item.keys)
    unique = [bool]$item.unique
  })

  $typedName = Read-Host "Type the full index name to rebuild"
  if ([string]$typedName -cne [string]$item.name) {
    $operations += New-SkippedOperation `
      -Item $item `
      -Action "rebuild" `
      -Reason "name-not-confirmed"
    continue
  }

  $operations += Invoke-ApplyOperation `
    -Item $item `
    -Action "rebuild" `
    -AllowRebuild
}

$report.operations = @($operations)
Save-Report -Path $reportPath -Report $report

try {
  $verification = Invoke-IndexManager -Command "check"
  $report.verification = $verification
  Save-Report -Path $reportPath -Report $report
  Write-CompleteCheck `
    -Label "Database index verification:" `
    -Check $verification
} catch {
  $errorCode = Get-SafeErrorCode -ErrorValue $_
  $report.verification = [pscustomobject][ordered]@{
    ok = $false
    error = [pscustomobject][ordered]@{ code = $errorCode }
  }
  Save-Report -Path $reportPath -Report $report
  Write-Output ("Database index verification failed: " + $errorCode)
  Write-Output "DATABASE_INDEX_CHECK_INCOMPLETE"
  exit 2
}

$remaining = @(Get-IncompleteItems -Check $verification)
$failedOperations = @(
  @($operations) | Where-Object { $_.status -eq "failed" }
)
Write-Output ("Report: " + $reportPath)
if ($remaining.Count -gt 0 -or $failedOperations.Count -gt 0) {
  Write-Output "DATABASE_INDEX_CHECK_INCOMPLETE"
  exit 2
}
exit 0
