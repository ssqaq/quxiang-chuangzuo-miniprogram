param(
    [Parameter(Mandatory = $true)][ValidatePattern('^op-[A-Za-z0-9][A-Za-z0-9._-]{5,120}$')][string]$OperationId,
    [string]$PolicyPath = "",
    [switch]$Publish,
    [switch]$Preview,
    [string]$PreviewCliPath = "",
    [string]$PreviewClientName = "default",
    [switch]$DeployCloud,
    [switch]$ResumePendingDeploy,
    [ValidateRange(1, 7200)][int]$LockWaitSeconds = 1800,
    [switch]$KeepWorktree,
    # 仅用于已明确指定 operationId 的恢复；不改变队头票据内容。
    [switch]$AllowOutOfOrder,
    [switch]$AllowPrepared
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot
. (Join-Path $scriptRoot "release-gate.ps1")
. (Join-Path $scriptRoot "release-lock.ps1")
. (Join-Path $scriptRoot "cloud-deploy-safety.ps1")
$queueScript = Join-Path $scriptRoot "release-queue.ps1"
if (-not (Test-Path -LiteralPath $queueScript -PathType Leaf)) { throw "缺少发布队列工具：$queueScript" }
. $queueScript

$canonicalGuess = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$policy = Get-ReleaseGatePolicy -PolicyPath $PolicyPath -RepositoryRoot $canonicalGuess
Assert-ReleaseCanonicalPolicy -Policy $policy -RepositoryRoot $canonicalGuess | Out-Null
$canonicalRepo = ConvertTo-ReleaseFullPath -Path ([string]$policy.canonicalRepo)
$queueRoot = [string]$policy.queueRoot
$queuePollMilliseconds = if ($policy.queue.PSObject.Properties["pollMilliseconds"]) { [int]$policy.queue.pollMilliseconds } else { 500 }
$queueLeaseSeconds = if ($policy.queue.PSObject.Properties["leaseSeconds"]) { [int]$policy.queue.leaseSeconds } else { 180 }

# Do this read-only check before reading/claiming a queue lease.  A stale
# owner for a non-terminal operation is not a bypass condition; it must be
# resolved explicitly before a resume publish can cross the PR boundary.
if ($Publish) {
    $lockHealthStaleAfter = if ($policy.queue.PSObject.Properties["staleAfterSeconds"]) { [int]$policy.queue.staleAfterSeconds } else { 600 }
    # A previous prepared run may have released its OS handle but left legacy
    # embedded metadata behind.  Only this explicit resume, for this exact
    # operation, may reclaim that queued/prepared residue.
    $lockHealth = Assert-ReleasePublishLockHealth -Policy $policy -StaleAfterSeconds $lockHealthStaleAfter -ExpectedOperationId $OperationId
    Write-Host "发布前锁健康检查通过：$($lockHealth.reason)。"
}
$ticket = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $OperationId
if ($null -eq $ticket) { throw "找不到可恢复的发布操作：$OperationId" }
$persistedDeployCloud = $false
if ($ticket.PSObject.Properties["metadata"] -and $null -ne $ticket.metadata -and
    $ticket.metadata.PSObject.Properties["deployCloud"]) {
    $rawDeployCloud = $ticket.metadata.deployCloud
    $persistedDeployCloud = $rawDeployCloud -eq $true -or
        [string]::Equals([string]$rawDeployCloud, "true", [StringComparison]::OrdinalIgnoreCase) -or
        [string]$rawDeployCloud -eq "1"
}
if ($persistedDeployCloud -and -not $DeployCloud) {
    $DeployCloud = $true
    Write-Host "队列已记录 deployCloud=true；恢复时保持该生产部署意图，禁止降级。"
}

$contextPath = if ($ticket.PSObject.Properties["contextPath"] -and $ticket.contextPath) {
    [IO.Path]::GetFullPath([string]$ticket.contextPath)
}
else {
    Join-Path ([string]$policy.contextRoot) "release-$OperationId.json"
}
 $contextRoot = (ConvertTo-ReleaseFullPath -Path ([string]$policy.contextRoot)).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not $contextPath.StartsWith($contextRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "队列票据 contextPath 不在 canonical context 目录内，拒绝恢复：$contextPath"
}
if (-not (Test-Path -LiteralPath $contextPath -PathType Leaf)) { throw "发布操作没有可恢复的 context：$contextPath" }
$context = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ReleaseContextShape -Context $context -Policy $policy | Out-Null
if ([string]$context.operationId -ne $OperationId) {
    throw "release context operationId 与恢复请求不一致：context=$($context.operationId)，请求=$OperationId"
}
if ($ticket.PSObject.Properties["version"] -and -not [string]::IsNullOrWhiteSpace([string]$ticket.version) -and [string]$ticket.version -ne [string]$context.version) {
    throw "队列票据版本与 release context 不一致：ticket=$($ticket.version)，context=$($context.version)"
}
if ($ticket.PSObject.Properties["contextPath"] -and -not [string]::IsNullOrWhiteSpace([string]$ticket.contextPath) -and -not (Test-ReleasePathEqual -Left ([string]$ticket.contextPath) -Right $contextPath)) {
    throw "队列票据 contextPath 与恢复文件不一致，拒绝跨操作恢复。"
}
$terminal = if ($context.PSObject.Properties["terminalStatus"]) { [string]$context.terminalStatus } else { "" }
# A publish can intentionally finish before the optional CloudBase/preview
# phase.  Keep the queue terminal state immutable, but allow an explicit
# post-merge request to complete the missing side effect with the same context.
$postMergeRequested = [bool]($DeployCloud -or $Preview)
$postMergeOnly = $terminal -eq "succeeded" -and [string]$ticket.status -eq "succeeded" -and $postMergeRequested
if ($terminal -eq "succeeded" -and [string]$ticket.status -eq "succeeded" -and -not $postMergeRequested) {
    Write-Host "发布操作已经完成，无需重复执行：$OperationId"
    Write-Host "Context: $contextPath"
    exit 0
}
if ([string]$ticket.status -eq "succeeded" -and $terminal -ne "succeeded") {
    throw "队列已是 succeeded，但 release context 未终态成功；拒绝重新领取或执行副作用。"
}
if ($terminal -eq "succeeded" -and [string]$ticket.status -ne "succeeded") {
    throw "release context 已终态成功，但队列未终态成功；拒绝重新发布。"
}

$reservationPath = if ($ticket.PSObject.Properties["reservationPath"] -and $ticket.reservationPath) { [IO.Path]::GetFullPath([string]$ticket.reservationPath) } else { "" }
$reservationRoot = (ConvertTo-ReleaseFullPath -Path ([string]$policy.reservationRoot)).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ([string]::IsNullOrWhiteSpace($reservationPath) -or -not $reservationPath.StartsWith($reservationRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "恢复操作缺少 canonical reservationPath，拒绝恢复以避免重新占用版本。"
}
if (-not (Test-Path -LiteralPath $reservationPath -PathType Leaf)) {
    throw "恢复操作 reservation 不存在：$reservationPath；为避免版本重新占用，已拒绝恢复。"
}
try {
    $reservationCheck = Get-Content -LiteralPath $reservationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $reservationCheck.PSObject.Properties["operationId"] -or [string]::IsNullOrWhiteSpace([string]$reservationCheck.operationId) -or [string]$reservationCheck.operationId -ne $OperationId) {
        throw "reservation operationId 与恢复请求不一致（可能缺失）：reservation=$([string]$reservationCheck.operationId)，请求=$OperationId。"
    }
    $reservedVersion = if ($reservationCheck.PSObject.Properties["targetVersion"]) { [string]$reservationCheck.targetVersion } elseif ($reservationCheck.PSObject.Properties["version"]) { [string]$reservationCheck.version } else { "" }
    if ([string]::IsNullOrWhiteSpace($reservedVersion) -or $reservedVersion -ne [string]$context.version) {
        throw "reservation 版本缺失或与 release context 不一致：reservation=$reservedVersion，context=$($context.version)"
    }
    if ($null -eq $reservationCheck.PSObject.Properties["status"] -or [string]::IsNullOrWhiteSpace([string]$reservationCheck.status)) { throw "reservation status 缺失。" }
}
catch {
    throw "reservation 校验失败：$($_.Exception.Message)"
}

# Reject an accidental plain resume before touching the queue lease or attempt
# counter.  A prepared/pr-opened context is only allowed to cross the PR
# boundary with an explicit -Publish; doing this check after Claim used to
# consume a retry slot and briefly block every later FIFO ticket.
$initialPhase = if ($context.PSObject.Properties["phase"]) { [string]$context.phase } else { [string]$context.status }
# Do this read-only preflight before Recover/Claim so a plan limitation or
# expired credential cannot consume a retry slot.  Invoke-ReleasePullRequest
# repeats the check while the release lock is held before any push.
if ($Publish -and $initialPhase -notin @("merged", "deployed", "previewed") -and [bool]$policy.mainProtection.enforceOnPublish) {
    Test-ReleaseGitHubProtection -RepositoryRoot $canonicalRepo -Policy $policy | Out-Null
}
if (-not $Publish -and $initialPhase -notin @("merged", "deployed", "previewed", "succeeded") -and -not $postMergeOnly) {
    throw "该 context 仍未完成 PR 合并；恢复发布必须显式带 -Publish，不能把准备状态误标为成功。"
}

function Write-ResumeReleaseRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][string]$TerminalStatus,
        [string]$Phase = "",
        [string]$MainCommit = "",
        [string]$MergedAt = ""
    )
    $recordPath = Join-Path ([string]$policy.recordRoot) "release-v$($context.version)-$($context.releaseCommit).json"
    $record = [ordered]@{}
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        try {
            $old = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($property in $old.PSObject.Properties) { $record[$property.Name] = $property.Value }
        }
        catch { throw "已有 release record 无法解析，拒绝用空记录覆盖：$recordPath。$($_.Exception.Message)" }
    }
    $record.schemaVersion = 2
    $record.operationId = $OperationId
    $record.status = $Status
    $record.terminalStatus = $TerminalStatus
    $record.version = [string]$context.version
    $record.baseHead = [string]$context.baseHead
    $record.sourceCommit = [string]$context.sourceCommit
    $record.releaseCommit = [string]$context.releaseCommit
    $record.treeSha = [string]$context.treeSha
    $record.sourceSha256 = [string]$context.sourceSha256
    $record.packagePath = [string]$context.artifactPath
    if ($context.PSObject.Properties["releaseWorktree"]) { $record.releaseWorktree = [string]$context.releaseWorktree }
    if ($context.PSObject.Properties["packageSha256"]) { $record.packageSha256 = [string]$context.packageSha256 }
    $record.contextPath = $contextPath
    $record.logPath = $logPath
    $record.reportPath = $reportPath
    $record.backupPath = $backupPath
    $record.generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $record.releaseBranch = if ($context.PSObject.Properties["releaseBranch"]) { [string]$context.releaseBranch } else { "release/$($context.version)-$OperationId" }
    $record.pullRequest = if ($context.PSObject.Properties["pullRequest"]) { [string]$context.pullRequest } else { "" }
    if (-not [string]::IsNullOrWhiteSpace($MainCommit)) { $record.mainCommit = $MainCommit }
    elseif ($context.PSObject.Properties["mainCommit"]) { $record.mainCommit = [string]$context.mainCommit }
    if (-not [string]::IsNullOrWhiteSpace($MergedAt)) { $record.mergedAt = $MergedAt }
    elseif ($context.PSObject.Properties["mergedAt"]) { $record.mergedAt = [string]$context.mergedAt }
    $record.phase = if (-not [string]::IsNullOrWhiteSpace($Phase)) { $Phase } elseif ($context.PSObject.Properties["phase"]) { [string]$context.phase } else { "" }
    if ($context.PSObject.Properties["cloudReceipt"]) { $record.cloudReceipt = $context.cloudReceipt }
    if ($context.PSObject.Properties["paymentDeployment"]) { $record["paymentDeployment"] = $context.paymentDeployment }
    if ($Status -eq "succeeded" -and $record.Contains("lastError")) { $record.Remove("lastError") }
    Write-ReleaseGateJsonAtomic -Path $recordPath -Value $record
    return $recordPath
}

$logPath = if ($context.PSObject.Properties["logPath"] -and $context.logPath) { [string]$context.logPath } else { New-ReleaseOperationLogPath -LogRoot ([string]$policy.logRoot) -OperationId $OperationId }
$reportPath = if ($context.PSObject.Properties["reportPath"] -and $context.reportPath) { [string]$context.reportPath } else { Join-Path ([string]$policy.reportRoot) "release-$OperationId.json" }
$backupPath = if ($context.PSObject.Properties["backupPath"] -and $context.backupPath) { [string]$context.backupPath } else { Join-Path ([string]$policy.backupRoot) "backup-$OperationId.json" }
$lock = $null
$worktree = ""
$completed = $false
$recordPath = Join-Path ([string]$policy.recordRoot) "release-v$($context.version)-$($context.releaseCommit).json"
$queueLease = $null
$queueHeartbeat = $null

function Write-ResumeLog {
    param([string]$Stage, [string]$Message)
    Write-Host "[$Stage] $Message"
    Write-ReleaseOperationLog -Path $logPath -Stage $Stage -Message $Message -OperationId $OperationId
}

function Save-ResumeContext {
    param(
        [hashtable]$Values,
        [string[]]$RemoveKeys = @()
    )
    $hash = [ordered]@{}
    foreach ($property in $context.PSObject.Properties) { $hash[$property.Name] = $property.Value }
    foreach ($key in $Values.Keys) { $hash[$key] = $Values[$key] }
    foreach ($key in @($RemoveKeys)) {
        if ($hash.Contains($key)) { $hash.Remove($key) }
    }
    if ($Values.ContainsKey("status") -and [string]$Values.status -eq "succeeded") {
        if ($hash.Contains("lastError")) { $hash.Remove("lastError") }
        if ($hash.Contains("recovery") -and $null -ne $hash.recovery) {
            $hash.recovery.resumable = $true
            $hash.recovery.lastFailureStage = ""
        }
    }
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $hash
    $script:context = [pscustomobject]$hash
    return $script:context
}

function Get-ResumeProperty {
    param(
        [object]$Value,
        [Parameter(Mandatory = $true)][string]$Name,
        [object]$Default = $null
    )
    if ($null -eq $Value) { return $Default }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Assert-ResumeCloudReceipt {
    <# A receipt is evidence, not a boolean flag.  Every identity field must
       bind back to the same context before a retry is allowed to skip upload. #>
    param(
        [Parameter(Mandatory = $true)][object]$Receipt,
        [Parameter(Mandatory = $true)][object]$Context
    )
    Assert-CloudDeployReceipt `
        -Receipt $Receipt `
        -Context $Context `
        -ExpectedMainCommit ([string](Get-ResumeProperty -Value $Context -Name "mainCommit" -Default "")) | Out-Null
    return $true
}

function Get-ResumeCloudReceipt {
    param([Parameter(Mandatory = $true)][object]$Context)
    $property = $Context.PSObject.Properties["cloudReceipt"]
    if ($null -eq $property -or $null -eq $property.Value) { return $null }
    return $property.Value
}

function Assert-ResumePaymentDeploymentReceipt {
    param(
        [Parameter(Mandatory = $true)][object]$Receipt,
        [Parameter(Mandatory = $true)][object]$Context
    )
    $required = @(
        "schemaVersion", "state", "status", "operationId", "environment", "version",
        "releaseCommit", "treeSha", "sourceSha256", "packageSha256", "mainCommit",
        "idempotencyKey", "credentialsConfigured", "providerState", "missingCredentialKeys",
        "functions", "route", "timer", "rechargeConfig", "verifiedAt"
    )
    foreach ($field in $required) {
        if ($null -eq $Receipt.PSObject.Properties[$field]) {
            throw "支付生产部署回执缺少字段：$field"
        }
    }
    if ([int]$Receipt.schemaVersion -ne 1 -or
        [string]$Receipt.state -ne "verified" -or
        [string]$Receipt.status -ne "verified" -or
        [string]::IsNullOrWhiteSpace([string]$Receipt.verifiedAt)) {
        throw "支付生产部署回执未通过核验。"
    }
    foreach ($field in @("operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "packageSha256", "mainCommit")) {
        $expected = [string](Get-ResumeProperty -Value $Context -Name $field -Default "")
        if ([string]::IsNullOrWhiteSpace($expected) -or
            -not [string]::Equals([string]$Receipt.$field, $expected, [StringComparison]::OrdinalIgnoreCase)) {
            throw "支付生产部署回执 $field 与 release context 不一致。"
        }
    }
    $cloudbaseEnvironment = Get-ResumeProperty -Value $Context -Name "cloudbaseEnvironment" -Default $null
    $expectedEnvironment = [string](Get-ResumeProperty -Value $cloudbaseEnvironment -Name "environmentId" -Default "")
    if ([string]::IsNullOrWhiteSpace([string]$Receipt.environment) -or
        (-not [string]::IsNullOrWhiteSpace($expectedEnvironment) -and
         -not [string]::Equals([string]$Receipt.environment, $expectedEnvironment, [StringComparison]::OrdinalIgnoreCase))) {
        throw "支付生产部署回执 environment 与 CloudBase 环境不一致。"
    }
    $expectedKey = "payment:$([string]$Context.operationId):$([string]$Context.releaseCommit):$([string]$Context.treeSha):$([string]$Receipt.environment)"
    if (-not [string]::Equals([string]$Receipt.idempotencyKey, $expectedKey, [StringComparison]::OrdinalIgnoreCase)) {
        throw "支付生产部署回执 idempotencyKey 与 release context 不一致。"
    }
    $paymentCredentialsConfigured = $Receipt.PSObject.Properties["credentialsConfigured"].Value
    if ($paymentCredentialsConfigured -isnot [bool]) {
        throw "支付生产部署回执 credentialsConfigured 不是布尔值。"
    }
    $missingCredentialKeys = @($Receipt.PSObject.Properties["missingCredentialKeys"].Value)
    if (($paymentCredentialsConfigured -and ([string]$Receipt.providerState -ne "configured" -or $missingCredentialKeys.Count -ne 0)) -or
        (-not $paymentCredentialsConfigured -and ([string]$Receipt.providerState -ne "fail-closed" -or $missingCredentialKeys.Count -eq 0))) {
        throw "支付生产部署回执凭据状态自相矛盾。"
    }
    return $Receipt
}

function Get-ResumeCloudOnlineMatch {
    param(
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][object]$Context
    )
    try {
        $configText = Get-Content -LiteralPath (Join-Path $WorktreePath "config.js") -Raw -Encoding UTF8
        $envMatch = [regex]::Match($configText, 'cloudEnvId:\s*"([^"]+)"')
        $functionMatch = [regex]::Match($configText, 'cloudFunctionName:\s*"([^"]+)"')
        if (-not $envMatch.Success -or -not $functionMatch.Success) { return $false }
        $markerText = Get-Content -LiteralPath (Join-Path $WorktreePath "cloudfunctions/api/index.js") -Raw -Encoding UTF8
        $markerMatch = [regex]::Match($markerText, 'const API_BUILD_MARKER = "([^"]+)"')
        $snapshot = Get-CloudBaseFunctionSnapshot -EnvironmentId $envMatch.Groups[1].Value -FunctionName $functionMatch.Groups[1].Value
        return [string]$snapshot.BuildVersion -eq [string]$Context.version -and
            $markerMatch.Success -and [string]$snapshot.BuildMarker -eq $markerMatch.Groups[1].Value
    }
    catch {
        return $false
    }
}

function Assert-ResumeContextIdentity {
    param([Parameter(Mandatory = $true)][object]$Value)
    Assert-ReleaseContextShape -Context $Value -Policy $policy | Out-Null
    if ([string]$Value.operationId -ne $OperationId) { throw "锁内重读的 release context operationId 不一致。" }
    if ([string]$Value.releaseCommit -notmatch '^[0-9a-fA-F]{7,64}$' -or [string]$Value.treeSha -notmatch '^[0-9a-fA-F]{7,64}$') {
        throw "锁内重读的 release context 提交身份无效。"
    }
    return $Value
}

function Ensure-ResumeBackupManifest {
    if (-not [string]::IsNullOrWhiteSpace([string](Get-ResumeProperty -Value $context -Name "backupPath" -Default "")) -and (Test-Path -LiteralPath ([string]$context.backupPath) -PathType Leaf)) {
        return [string]$context.backupPath
    }
    $backup = Write-ReleaseBackupManifest -Policy $policy -OperationId $OperationId -Version ([string]$context.version)
    $script:backupPath = [string]$backup.Path
    $script:context = Save-ResumeContext -Values @{ backupPath = [string]$backup.Path; backupManifest = $backup.Manifest }
    return [string]$backup.Path
}

function Ensure-ResumeAcceptanceReport {
    <#
      Re-check the four release endpoints with the original context.  This is
      deliberately called before a normal resume marks the queue succeeded,
      and it is also safe to call again after a terminal queue transition:
      report/latest writers are idempotent and refuse different content.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [switch]$RequireCloud,
        [switch]$RequirePreview
    )
    $result = Write-ReleaseAcceptanceReport -Policy $policy -Context $Value -ContextPath $contextPath -RequireCloud:$RequireCloud -RequirePreview:$RequirePreview
    if ($null -eq $result -or $null -eq $result.Report -or [string]$result.Report.status -ne "succeeded") {
        $statusText = if ($null -eq $result -or $null -eq $result.Report) { "unknown" } else { [string]$result.Report.status }
        throw "恢复发布验收未通过（$statusText），保留原 context。"
    }
    $script:reportPath = [string]$result.Path
    $script:context = Save-ResumeContext -Values @{ reportPath = [string]$result.Path; reportMarkdownPath = [string]$result.MarkdownPath }
    return $result
}

function Ensure-ResumePreviewImport {
    param(
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $script:PreviewCliPath = Resolve-ReleaseDevToolsCli -CliPath $PreviewCliPath
    $existing = if ($Value.PSObject.Properties["previewImport"]) { $Value.previewImport } else { $null }
    if ($null -ne $existing -and [string]$existing.status -eq "imported" -and
        [string]$existing.openStatus -eq "opened" -and
        [string]$existing.compileStatus -eq "succeeded" -and
        [string]$existing.operationId -eq [string]$Value.operationId -and
        [string]$existing.version -eq [string]$Value.version -and
        [string]$existing.releaseCommit -eq [string]$Value.releaseCommit -and
        [string]$existing.treeSha -eq [string]$Value.treeSha -and
        [string]$existing.projectPath -eq [IO.Path]::GetFullPath($WorktreePath)) {
        return $Value
    }
    Write-ResumeLog "preview-import" "把原 context 对应的隔离工作树导入微信开发者工具。"
    $receipt = Invoke-ReleasePreviewImport -CliPath $PreviewCliPath -ClientName $PreviewClientName -ProjectPath $WorktreePath
    $import = [ordered]@{
        status = [string]$receipt.status
        projectPath = [string]$receipt.projectPath
        operationId = [string]$Value.operationId
        version = [string]$Value.version
        releaseCommit = [string]$Value.releaseCommit
        treeSha = [string]$Value.treeSha
        sourceSha256 = [string]$Value.sourceSha256
        importedAt = [string]$receipt.importedAt
        openStatus = [string]$receipt.openStatus
        openResponse = $receipt.openResponse
        compileStatus = [string]$receipt.compileStatus
        compileTriggeredAt = [string]$receipt.compileTriggeredAt
        compileCompletedAt = [string]$receipt.compileCompletedAt
        compileElapsedMs = [int]$receipt.compileElapsedMs
        compileAttempts = [int]$receipt.compileAttempts
        compileVerification = $receipt.compileVerification
        compileResponse = $receipt.compileResponse
        steps = @($receipt.steps)
        response = $receipt.response
    }
    return Save-ResumeContext -Values @{ previewImport = $import }
}

function Test-ResumeFinalPreview {
    param([Parameter(Mandatory = $true)][object]$Value)
    $qrProperty = $Value.PSObject.Properties["previewQrPath"]
    $infoProperty = $Value.PSObject.Properties["previewInfoPath"]
    if ($null -eq $qrProperty -or $null -eq $infoProperty -or
        [string]::IsNullOrWhiteSpace([string]$qrProperty.Value) -or
        [string]::IsNullOrWhiteSpace([string]$infoProperty.Value) -or
        -not (Test-Path -LiteralPath ([string]$qrProperty.Value) -PathType Leaf) -or
        -not (Test-Path -LiteralPath ([string]$infoProperty.Value) -PathType Leaf)) {
        return $false
    }
    try {
        $artifactRoot = [IO.Path]::GetFullPath([string]$policy.artifactRoot).TrimEnd("\", "/")
        $qrPath = [IO.Path]::GetFullPath([string]$qrProperty.Value)
        $infoPath = [IO.Path]::GetFullPath([string]$infoProperty.Value)
        if (-not $qrPath.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
            -not $infoPath.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $expectedQrName = "wechat-miniapp-preview-v$($Value.version)-$($Value.releaseCommit)-qr.png"
        $expectedInfoName = "wechat-miniapp-preview-v$($Value.version)-$($Value.releaseCommit)-info.json"
        if ([IO.Path]::GetFileName($qrPath) -ne $expectedQrName -or [IO.Path]::GetFileName($infoPath) -ne $expectedInfoName) { return $false }
        $qrHash = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $receipt = Get-Content -LiteralPath ([string]$infoProperty.Value) -Raw -Encoding UTF8 | ConvertFrom-Json
        $mainCommit = if ($Value.PSObject.Properties["mainCommit"]) { [string]$Value.mainCommit } else { "" }
        $receiptMain = if ($receipt.PSObject.Properties["mainCommit"]) { [string]$receipt.mainCommit } else { "" }
        return [int]$receipt.schemaVersion -eq 1 -and
            -not [string]::IsNullOrWhiteSpace([string]$receipt.qrSha256) -and
            [string]$receipt.qrSha256 -eq $qrHash -and
            -not [string]::IsNullOrWhiteSpace($mainCommit) -and
            [string]::Equals($receiptMain, $mainCommit, [StringComparison]::OrdinalIgnoreCase) -and
            [string]$receipt.operationId -eq [string]$Value.operationId -and
            [string]$receipt.appVersion -eq [string]$Value.version -and
            [string]$receipt.gitCommit -eq [string]$Value.releaseCommit -and
            [string]$receipt.treeSha -eq [string]$Value.treeSha -and
            [string]$receipt.sourceSha256 -eq [string]$Value.sourceSha256
    }
    catch {
        return $false
    }
}

function Write-ResumeFinalPreview {
    param(
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$ReleaseCommit,
        [Parameter(Mandatory = $true)][string]$MainCommit
    )
    if ([string]::IsNullOrWhiteSpace($PreviewCliPath)) { $PreviewCliPath = $env:WECHAT_DEVTOOLS_CLI }
    if ([string]::IsNullOrWhiteSpace($PreviewCliPath) -or -not (Test-Path -LiteralPath $PreviewCliPath -PathType Leaf)) {
        throw "找不到微信开发者工具 CLI，无法生成最终二维码。"
    }
    $qrPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$($Value.version)-$ReleaseCommit-qr.png"
    $infoPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$($Value.version)-$ReleaseCommit-info.json"
    $identity = [ordered]@{
        schemaVersion = 1
        operationId = [string]$Value.operationId
        appVersion = [string]$Value.version
        gitCommit = $ReleaseCommit
        treeSha = [string]$Value.treeSha
        sourceSha256 = [string]$Value.sourceSha256
        artifactPath = [string]$Value.artifactPath
        mainCommit = $MainCommit
    }
    if (-not (Test-Path -LiteralPath $qrPath -PathType Leaf) -and (Test-Path -LiteralPath $infoPath -PathType Leaf)) {
        throw "已有二维码 info 但二维码文件缺失，拒绝重新生成或覆盖：$infoPath"
    }
    if (Test-Path -LiteralPath $qrPath -PathType Leaf) {
        if (-not (Test-Path -LiteralPath $infoPath -PathType Leaf)) { throw "已有二维码但缺少 info，拒绝覆盖：$qrPath" }
        if ((Get-Item -LiteralPath $qrPath).Length -le 0) { throw "已有二维码为空，拒绝覆盖：$qrPath" }
        $existingQrSha = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $existingInfo = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$existingInfo.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string]$existingInfo.qrSha256) -or [string]$existingInfo.qrSha256 -ne $existingQrSha) { throw "已有二维码 SHA/schema 与 info 不一致，拒绝覆盖：$qrPath" }
        foreach ($key in $identity.Keys) {
            if ([string]$existingInfo.$key -ne [string]$identity[$key]) { throw "已有二维码 info 与当前发布不一致，拒绝覆盖：$infoPath" }
        }
        return [pscustomobject]@{ qrPath = $qrPath; infoPath = $infoPath; qrSha256 = $existingQrSha }
    }
    $tempQrPath = "$qrPath.$PID.$([guid]::NewGuid().ToString('N')).tmp.png"
    try {
        Write-ResumeLog "preview-atomic" "生成最终二维码（临时文件，完成后原子落盘）。"
        & $PreviewCliPath -c $PreviewClientName create_preview_qrcode --project $WorktreePath --qr-format image --qr-output $tempQrPath 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempQrPath -PathType Leaf)) { throw "最终二维码生成失败。" }
        if ((Get-Item -LiteralPath $tempQrPath).Length -le 0) { throw "最终二维码为空。" }
        Write-ReleaseImmutableFile -SourcePath $tempQrPath -DestinationPath $qrPath | Out-Null
    }
    finally {
        if (Test-Path -LiteralPath $tempQrPath -PathType Leaf) { Remove-Item -LiteralPath $tempQrPath -Force -ErrorAction SilentlyContinue }
    }
    $identity.qrSha256 = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (Test-Path -LiteralPath $infoPath -PathType Leaf) {
        $existingInfo = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($key in $identity.Keys) {
            if ([string]$existingInfo.$key -ne [string]$identity[$key]) { throw "二维码 info 并发冲突，拒绝覆盖：$infoPath" }
        }
    }
    else { Write-ReleaseImmutableJson -Path $infoPath -Value $identity | Out-Null }
    return [pscustomobject]@{ qrPath = $qrPath; infoPath = $infoPath; qrSha256 = [string]$identity.qrSha256 }
}

function ConvertTo-ResumeComparableValue {
    <# WeChat DevTools rewrites project.config.json with a different key order
       and newline style when importing a project.  Compare JSON values rather
       than bytes so that this harmless preview-side formatting does not look
       like a source edit. #>
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) {
            $ordered[[string]$key] = ConvertTo-ResumeComparableValue -Value $Value[$key]
        }
        return [pscustomobject]$ordered
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        $items = @()
        foreach ($item in $Value) { $items += ,(ConvertTo-ResumeComparableValue -Value $item) }
        return ,$items
    }
    $properties = @($Value.PSObject.Properties)
    if ($properties.Count -gt 0 -and $Value -isnot [ValueType] -and $Value -isnot [string]) {
        $ordered = [ordered]@{}
        foreach ($property in @($properties | Sort-Object Name)) {
            $ordered[$property.Name] = ConvertTo-ResumeComparableValue -Value $property.Value
        }
        return [pscustomobject]$ordered
    }
    return $Value
}

function Test-ResumePreviewOnlyDirty {
    param(
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][object[]]$DirtyLines
    )
    $lines = @($DirtyLines | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -ne 1) { return $false }
    $line = $lines[0]
    # Porcelain v1 has two status columns followed by a space.  Reject
    # renames/untracked files and any path other than the DevTools metadata.
    if ($line.Length -lt 4 -or $line.Substring(0, 2) -notmatch '^[ MARCUD?!]{2}$') { return $false }
    $relative = $line.Substring(3).Trim()
    if (-not [string]::Equals($relative, "project.config.json", [StringComparison]::OrdinalIgnoreCase)) { return $false }
    try {
        $headText = (Invoke-ReleaseGit -WorkingDirectory $WorktreePath -Arguments @("show", "HEAD:project.config.json")) -join "`n"
        $workText = Get-Content -LiteralPath (Join-Path $WorktreePath "project.config.json") -Raw -Encoding UTF8
        $headJson = $headText | ConvertFrom-Json
        $workJson = $workText | ConvertFrom-Json
        $headNormalized = ConvertTo-ResumeComparableValue -Value $headJson | ConvertTo-Json -Depth 100 -Compress
        $workNormalized = ConvertTo-ResumeComparableValue -Value $workJson | ConvertTo-Json -Depth 100 -Compress
        return [string]::Equals($headNormalized, $workNormalized, [StringComparison]::Ordinal)
    }
    catch { return $false }
}

function Ensure-ResumeReleaseWorktree {
    param(
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][string]$ReleaseCommit,
        [Parameter(Mandatory = $true)][string]$Branch
    )
    $resolved = [IO.Path]::GetFullPath($WorktreePath)
    $worktreeRoot = (ConvertTo-ReleaseFullPath -Path ([string]$policy.worktreeRoot)).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($worktreeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "恢复工作树不在策略 worktreeRoot 内，拒绝使用：$resolved"
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        New-Item -ItemType Directory -Path ([string]$policy.worktreeRoot) -Force | Out-Null
        Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("fetch", "origin", "refs/heads/$Branch:refs/remotes/origin/$Branch") -AllowFailure | Out-Null
        Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("worktree", "add", "--detach", $resolved, $ReleaseCommit) | Out-Null
    }
    $registered = $false
    try {
        $worktreeList = Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("worktree", "list", "--porcelain")
        foreach ($line in $worktreeList) {
            if ([string]$line -match '(?i)^worktree\s+(.+?)\s*$') {
                try { if (Test-ReleasePathEqual -Left (ConvertTo-ReleaseFullPath -Path $Matches[1]) -Right $resolved) { $registered = $true; break } } catch { }
            }
        }
    }
    catch { $registered = $false }
    if (-not $registered) { throw "恢复目录不是 canonical Git 注册的 worktree，拒绝使用：$resolved" }
    $head = (Invoke-ReleaseGit -WorkingDirectory $resolved -Arguments @("rev-parse", "HEAD") | Select-Object -Last 1).Trim()
    if (-not [string]::Equals($head, $ReleaseCommit, [StringComparison]::OrdinalIgnoreCase)) {
        throw "恢复工作树 HEAD=$head 与 context releaseCommit=$ReleaseCommit 不一致，拒绝继续。"
    }
    $remote = (Invoke-ReleaseGit -WorkingDirectory $resolved -Arguments @("remote", "get-url", "origin") | Select-Object -Last 1).Trim()
    if (-not [string]::Equals($remote.TrimEnd('/'), [string]$policy.remote.TrimEnd('/'), [StringComparison]::OrdinalIgnoreCase)) { throw "恢复工作树 origin 不符合发布策略，拒绝继续：$remote" }
    $dirty = Invoke-ReleaseGit -WorkingDirectory $resolved -Arguments @("status", "--porcelain")
    $dirtyLines = @($dirty | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    $previewOnlyDirty = $dirtyLines.Count -gt 0 -and (Test-ResumePreviewOnlyDirty -WorktreePath $resolved -DirtyLines $dirtyLines)
    if ($dirtyLines.Count -gt 0 -and -not $previewOnlyDirty) { throw "恢复工作树不是干净状态，拒绝部署：$resolved" }
    $tree = (Invoke-ReleaseGit -WorkingDirectory $resolved -Arguments @("rev-parse", "$ReleaseCommit^{tree}") | Select-Object -Last 1).Trim()
    if (-not [string]::Equals($tree, [string]$context.treeSha, [StringComparison]::OrdinalIgnoreCase)) { throw "恢复工作树 tree SHA 与 context 不一致，拒绝继续。" }
    # The immutable context fingerprint is produced by package-release.py from
    # the Git archive.  Do the same check here instead of hashing the Windows
    # checkout directly: core.autocrlf and culture-specific path sorting can
    # otherwise make a clean worktree look different from the packaged tree.
    $packageScript = Join-Path $canonicalRepo "scripts/package-release.py"
    if (-not (Test-Path -LiteralPath $packageScript -PathType Leaf)) {
        throw "缺少发布包校验脚本，拒绝恢复：$packageScript"
    }
    $probeOutput = @(& python $packageScript --source-tree $ReleaseCommit --check-only --release-context $contextPath 2>&1 | ForEach-Object { [string]$_ })
    if ($LASTEXITCODE -ne 0) {
        throw "Git tree 源码 SHA 校验失败，拒绝继续。"
    }
    $probeText = ($probeOutput -join "`n")
    $shaMatch = [regex]::Match($probeText, '(?:sourceSha256|源码内容 SHA256)\s*[:：]\s*([0-9a-fA-F]{64})')
    if (-not $shaMatch.Success) {
        throw "发布包校验没有返回源码 SHA，拒绝继续。"
    }
    $sourceSha = $shaMatch.Groups[1].Value.ToLowerInvariant()
    if (-not [string]::Equals($sourceSha, [string]$context.sourceSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Git tree 源码 SHA 与 context 不一致，拒绝继续。"
    }
    return $resolved
}

try {
    if ($postMergeOnly) {
        # The queue ticket is already terminal after a successful PR merge.
        # Optional CloudBase/preview work is a post-merge side effect: hold the
        # same release lock, reuse the immutable worktree/context, and leave
        # queue=succeeded instead of trying to reopen a terminal ticket.
        $releaseCommit = [string]$context.releaseCommit
        $branch = if ($context.PSObject.Properties["releaseBranch"] -and $context.releaseBranch) { [string]$context.releaseBranch } else { "release/$($context.version)-$OperationId" }
        $worktree = if ($context.PSObject.Properties["releaseWorktree"] -and $context.releaseWorktree) { [string]$context.releaseWorktree } else { Join-Path ([string]$policy.worktreeRoot) "release-$OperationId" }
        $lock = Enter-ReleaseLock -ProjectPath $canonicalRepo -TargetVersion ([string]$context.version) -TargetType "release-post-merge" -WaitSeconds $LockWaitSeconds -LockPath ([string]$policy.lockPath) -ProjectId $OperationId -LeaseSeconds ([int]$policy.queue.leaseSeconds) -Stage "post-merge"
        Update-ReleaseLockOwner -LockHandle $lock -TargetVersion ([string]$context.version) -Stage "post-merge"
        # Re-read both durable records after acquiring the lock.  Two resume
        # processes may have observed the same terminal ticket before either
        # entered the critical section; only the locked snapshot decides which
        # effects remain outstanding.
        $ticket = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $OperationId -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
        if ($null -eq $ticket -or [string]$ticket.status -ne "succeeded") {
            throw "锁内重读发布队列已不是 succeeded，拒绝执行合并后副作用。"
        }
        $context = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $context = Assert-ResumeContextIdentity -Value $context
        $terminal = [string](Get-ResumeProperty -Value $context -Name "terminalStatus" -Default "")
        if ($terminal -ne "succeeded") { throw "锁内重读 release context 尚未终态成功，拒绝执行合并后副作用。" }
        $postMergeRequested = [bool]($DeployCloud -or $Preview)
        if (-not $postMergeRequested) { Write-Host "发布操作已经完成，无需重复执行：$OperationId"; return }
        $worktree = Ensure-ResumeReleaseWorktree -WorktreePath $worktree -ReleaseCommit $releaseCommit -Branch $branch
        $mergeCommit = if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }
        $null = Assert-ReleaseMainContainsCommit -RepositoryRoot $worktree -ReleaseCommit $releaseCommit -MergeCommit $mergeCommit
        Ensure-ResumeBackupManifest | Out-Null
        $phase = if ($context.PSObject.Properties["phase"]) { [string]$context.phase } else { "merged" }
        if ($phase -notin @("merged", "deployed", "previewed", "succeeded")) {
            throw "合并后 context 阶段无效：$phase"
        }
        if ($Preview) { $context = Ensure-ResumePreviewImport -WorktreePath $worktree -Value $context }

        $cloudReceipt = Get-ResumeCloudReceipt -Context $context
        $cloudReceiptValid = $false
        if ($null -ne $cloudReceipt) {
            try { Assert-ResumeCloudReceipt -Receipt $cloudReceipt -Context $context | Out-Null; $cloudReceiptValid = $true } catch { $cloudReceiptValid = $false }
        }
        if ($DeployCloud -and -not $cloudReceiptValid) {
            $deployScript = Join-Path $worktree "scripts/deploy-and-verify-api.ps1"
            if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) { throw "缺少 CloudBase 部署入口：$deployScript" }
            Write-ResumeLog "cloud" "为已合并 context 补做 CloudBase 部署。"
            $env:RELEASE_GATE_CONTEXT = $contextPath
            & pwsh -NoProfile -ExecutionPolicy Bypass -File $deployScript -ProjectPath $worktree -ReleaseContext $contextPath -ReleaseGateLockHeld -ReleaseGateLockToken ([string]$lock.Owner.handoffToken) -AllowPostMergeRecovery -DeployLockPath ([string]$policy.lockPath) -DeployTransport "auto" -LockWaitSeconds $LockWaitSeconds
            if ($LASTEXITCODE -ne 0) { throw "CloudBase 补部署失败；保留原 context，可用同一 operationId 重试。" }
            $context = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $context = Assert-ResumeContextIdentity -Value $context
            $onlineBuildVersion = [string]$context.version
            $onlineBuildMarker = ""
            try {
                $markerText = Get-Content -LiteralPath (Join-Path $worktree "cloudfunctions/api/index.js") -Raw -Encoding UTF8
                $markerMatch = [regex]::Match($markerText, 'const API_BUILD_MARKER = "([^"]+)"')
                if ($markerMatch.Success) { $onlineBuildMarker = $markerMatch.Groups[1].Value }
            } catch { }
            $receipt = [ordered]@{
                schemaVersion = 1
                operationId = $OperationId
                version = [string]$context.version
                releaseCommit = $releaseCommit
                treeSha = [string]$context.treeSha
                sourceSha256 = [string]$context.sourceSha256
                packageSha256 = if ($context.PSObject.Properties["packageSha256"]) { [string]$context.packageSha256 } else { "" }
                mainCommit = $mergeCommit
                idempotencyKey = New-CloudDeployIdempotencyKey -Context $context
                onlineBuildVersion = $onlineBuildVersion
                onlineBuildMarker = $onlineBuildMarker
                verifiedAt = [DateTimeOffset]::UtcNow.ToString("o")
                status = "verified"
            }
            $receipt = [pscustomobject]$receipt
            $context = Save-ResumeContext -Values @{ phase = "deployed"; cloudReceipt = $receipt; cloudDeployment = [ordered]@{ state = "verified"; idempotencyKey = $receipt.idempotencyKey; receipt = $receipt; updatedAt = [DateTimeOffset]::UtcNow.ToString("o") }; postMergeStatus = "running" }
            $phase = "deployed"
            $cloudReceiptValid = $true
        }
        elseif ($DeployCloud -and $cloudReceiptValid -and -not (Get-ResumeCloudOnlineMatch -WorktreePath $worktree -Context $context)) {
            throw "已有 CloudBase receipt 但线上构建身份不匹配，拒绝假设成功；请保留 context 现场审计。"
        }

        if ($DeployCloud) {
            $paymentDeployScript = Join-Path $worktree "scripts/deploy-payment-production.ps1"
            if (-not (Test-Path -LiteralPath $paymentDeployScript -PathType Leaf)) { throw "缺少支付生产部署入口：$paymentDeployScript" }
            Write-ResumeLog "payment-cloud" "为已合并 context 幂等核验并补做支付生产部署。"
            $env:RELEASE_GATE_CONTEXT = $contextPath
            & pwsh -NoProfile -ExecutionPolicy Bypass -File $paymentDeployScript -ProjectPath $worktree -ReleaseContext $contextPath -ReleaseGateLockHeld -ReleaseGateLockToken ([string]$lock.Owner.handoffToken) -DeployLockPath ([string]$policy.lockPath) -LockWaitSeconds $LockWaitSeconds -AllowPostMergeRecovery
            if ($LASTEXITCODE -ne 0) { throw "支付生产补部署失败；保留原 context，可用同一 operationId 重试。" }
            $context = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $context = Assert-ResumeContextIdentity -Value $context
            if (-not ($context.PSObject.Properties["paymentDeployment"] -and $null -ne $context.paymentDeployment)) {
                throw "支付生产部署未写入 paymentDeployment 回执。"
            }
            $paymentReceipt = Assert-ResumePaymentDeploymentReceipt -Receipt $context.paymentDeployment -Context $context
            $context = Save-ResumeContext -Values @{ postMergeStatus = "running" }
            $phase = [string](Get-ResumeProperty -Value $context -Name "phase" -Default $phase)
            if ([bool]$paymentReceipt.credentialsConfigured -eq $false) {
                Write-ResumeLog "payment-cloud" "支付资源与开关已核验；生产凭据未配置，provider 保持失败关闭。"
            }
        }

        if ($Preview -and -not (Test-ResumeFinalPreview -Value $context)) {
            Write-ResumeLog "preview" "为已合并 context 生成或幂等复用最终二维码。"
            $previewArtifact = Write-ResumeFinalPreview -WorktreePath $worktree -Value $context -ReleaseCommit $releaseCommit -MainCommit $mergeCommit
            $qrPath = [string]$previewArtifact.qrPath
            $infoPath = [string]$previewArtifact.infoPath
            $context = Save-ResumeContext -Values @{ phase = "previewed"; previewQrPath = $qrPath; previewInfoPath = $infoPath; postMergeStatus = "running" }
            $phase = "previewed"
        }

        if (-not (Test-Path -LiteralPath ([string]$context.artifactPath) -PathType Leaf)) {
            throw "补做合并后步骤时找不到不可变发布包：$($context.artifactPath)"
        }
        $packageScript = Join-Path $scriptRoot "package-release.py"
        $packageCheck = & python $packageScript --check-only --release-context $contextPath 2>&1
        if ($LASTEXITCODE -ne 0) { throw "合并后 package/context 校验失败：$($packageCheck -join "`n")" }
        $acceptance = Ensure-ResumeAcceptanceReport -Value $context -RequireCloud:$DeployCloud -RequirePreview:$Preview
        $postCompletedAt = [DateTimeOffset]::UtcNow.ToString("o")
        $context = Save-ResumeContext -Values @{ status = "succeeded"; terminalStatus = "succeeded"; postMergeStatus = "succeeded"; postMergeCompletedAt = $postCompletedAt; reportPath = [string]$acceptance.Path; reportMarkdownPath = [string]$acceptance.MarkdownPath; recovery = [ordered]@{ resumable = $true; lastFailureStage = "" } }
        $reservationExtra = @{ releaseCommit = $releaseCommit; treeSha = [string]$context.treeSha; contextPath = $contextPath; artifactPath = [string]$context.artifactPath; postMergeCompletedAt = $postCompletedAt }
        if ($context.PSObject.Properties["mainCommit"]) { $reservationExtra.mainCommit = [string]$context.mainCommit }
        if ($context.PSObject.Properties["cloudReceipt"]) { $reservationExtra.cloudReceipt = $context.cloudReceipt }
        if (-not [string]::IsNullOrWhiteSpace($reservationPath)) { Set-ReleaseReservationStatus -ReservationPath $reservationPath -Status "succeeded" -Extra $reservationExtra }
        [void](Write-ResumeReleaseRecord -Status "succeeded" -TerminalStatus "succeeded" -Phase ([string]$context.phase) -MainCommit $(if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }) -MergedAt $(if ($context.PSObject.Properties["mergedAt"]) { [string]$context.mergedAt } else { "" }))
        Write-ReleaseLatestManifest -Policy $policy -Context $context -ReportPath ([string]$acceptance.Path) -Report $acceptance.Report | Out-Null
        $completed = $true
        Write-ResumeLog "done" "合并后补充步骤已完成：$OperationId（队列保持 succeeded）。"
        Write-Host "Context: $contextPath"
        return
    }

    Recover-ReleaseQueueTickets -QueueRoot $queueRoot -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds | Out-Null
    $ticket = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $OperationId -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
    if ($null -eq $ticket) { throw "恢复时找不到发布队列票据：$OperationId" }
    if ([string]$ticket.status -in @("failed", "expired", "recoverable")) {
        # 恢复沿用同一个 operationId/version，只把票据重新排队；绝不重新分配版本。
        $ticket = Set-ReleaseQueueTicketStatus -TicketId ([string]$ticket.ticketId) -Status "queued" -Retry -QueueRoot $queueRoot -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
    }
    if ([string]$ticket.status -eq "cancelled") { throw "发布票据已取消，不能恢复：$OperationId" }
    if ([string]$ticket.status -in @("leased", "running")) { throw "发布票据仍由其他进程占用：$OperationId" }
    $lock = Enter-ReleaseLock -ProjectPath $canonicalRepo -TargetVersion ([string]$context.version) -TargetType "release-resume" -WaitSeconds $LockWaitSeconds -LockPath ([string]$policy.lockPath) -ProjectId $OperationId -LeaseSeconds ([int]$policy.queue.leaseSeconds) -Stage "resume"
    # A dry-run keeps its ticket in queued status with phase=prepared so it
    # remains the FIFO head.  Only this explicit resume path may claim that
    # special phase; ordinary release workers are rejected by the queue.
    $allowPreparedClaim = ([string]$ticket.phase -notin @("queued", ""))
    $queueLease = Claim-ReleaseQueueTicket -TicketId ([string]$ticket.ticketId) -LeaseOwner "release-resume/$PID/$OperationId" -LeaseSeconds $queueLeaseSeconds -AllowOutOfOrder:$AllowOutOfOrder -AllowPrepared:($allowPreparedClaim -or $AllowPrepared) -QueueRoot $queueRoot -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
    if ($null -eq $queueLease) { throw "恢复操作未能领取队列票据，仍有更早操作排队：$OperationId" }
    $queueLease = Start-ReleaseQueueTicket -TicketId ([string]$queueLease.ticketId) -LeaseId ([string]$queueLease.leaseId) -LeaseOwner ([string]$queueLease.leaseOwner) -QueueRoot $queueRoot -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
    # A preparation can be resumed later with stronger intent flags. Record
    # those flags in the durable ticket before any side effect so status/log
    # readers cannot mistake a real publish/deploy for a read-only prepare.
    $resumeMetadata = [ordered]@{}
    if ($ticket.PSObject.Properties["metadata"] -and $null -ne $ticket.metadata) {
        foreach ($property in $ticket.metadata.PSObject.Properties) { $resumeMetadata[$property.Name] = $property.Value }
    }
    if ($Publish) { $resumeMetadata.publish = $true }
    if ($Preview) { $resumeMetadata.preview = $true }
    if ($DeployCloud) { $resumeMetadata.deployCloud = $true }
    if ($resumeMetadata.Count -gt 0) {
        $queueLease = Set-ReleaseQueueTicketStatus -TicketId ([string]$queueLease.ticketId) -Status "running" -Stage "resume" -Metadata $resumeMetadata -LeaseId ([string]$queueLease.leaseId) -LeaseOwner ([string]$queueLease.leaseOwner) -QueueRoot $queueRoot -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
    }
    if (Get-Command Start-ReleaseQueueLeaseHeartbeat -ErrorAction SilentlyContinue) {
        $queueHeartbeat = Start-ReleaseQueueLeaseHeartbeat -TicketId ([string]$queueLease.ticketId) -LeaseId ([string]$queueLease.leaseId) -LeaseOwner ([string]$queueLease.leaseOwner) -QueueRoot $queueRoot -LeaseSeconds $queueLeaseSeconds -IntervalSeconds ([Math]::Max(5, [int]($queueLeaseSeconds / 3))) -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
    }
    Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $OperationId -Phase "resume" -Status "running" -Version ([string]$context.version) -BaseHead ([string]$context.baseHead) -ContextPath $contextPath -Lease $queueLease | Out-Null
    Update-ReleaseLockOwner -LockHandle $lock -TargetVersion ([string]$context.version) -Stage "resume"

    $releaseCommit = [string]$context.releaseCommit
    $branch = if ($context.PSObject.Properties["releaseBranch"] -and $context.releaseBranch) { [string]$context.releaseBranch } else { "release/$($context.version)-$OperationId" }
    $worktree = if ($context.PSObject.Properties["releaseWorktree"] -and $context.releaseWorktree) { [string]$context.releaseWorktree } else { Join-Path ([string]$policy.worktreeRoot) "release-$OperationId" }
    $worktree = Ensure-ResumeReleaseWorktree -WorktreePath $worktree -ReleaseCommit $releaseCommit -Branch $branch

    $phase = if ($context.PSObject.Properties["phase"]) { [string]$context.phase } else { [string]$context.status }
    if ($Publish -and $phase -notin @("merged", "deployed", "previewed")) {
        Write-ResumeLog "pr" "继续原 operationId 的 PR 发布：$branch"
        $pr = Invoke-ReleasePullRequest -RepositoryRoot $worktree -Branch $branch -Version ([string]$context.version) -OperationId $OperationId -CommitSha $releaseCommit -Policy $policy
        if ([string]$pr.status -ne "merged") { throw "原 PR 尚未合并，保留 context 等待下一次恢复。" }
        $changes = @{ status = "merged"; phase = "merged"; releaseBranch = $pr.branch; pullRequest = $pr.pr }
        if ($pr.PSObject.Properties["mainCommit"]) { $changes.mainCommit = [string]$pr.mainCommit }
        if ($pr.PSObject.Properties["mergedAt"]) { $changes.mergedAt = [string]$pr.mergedAt }
        $context = Save-ResumeContext -Values $changes
        Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $OperationId -Phase "merged" -Status "running" -Version ([string]$context.version) -BaseHead ([string]$context.baseHead) -ContextPath $contextPath -Lease $queueLease | Out-Null
        $phase = "merged"
    }

    Ensure-ResumeBackupManifest | Out-Null

    # Import only after the PR is confirmed merged.  This is deliberately
    # before the final QR/acceptance step so every update has a fresh DevTools
    # project entry tied to this exact context.
    if ($Preview -and $phase -in @("merged", "deployed", "previewed", "succeeded")) {
        $context = Ensure-ResumePreviewImport -WorktreePath $worktree -Value $context
    }

    if ($DeployCloud) {
        if ($phase -notin @("merged", "deployed", "previewed")) { throw "CloudBase 部署被拦截：PR 尚未确认合并。" }
        if (-not ($context.PSObject.Properties["cloudReceipt"] -and $context.cloudReceipt)) {
            $deployScript = Join-Path $worktree "scripts/deploy-and-verify-api.ps1"
            if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) { throw "缺少 CloudBase 部署入口：$deployScript" }
            Write-ResumeLog "cloud" "继续原 context 的 CloudBase 部署。"
            & pwsh -NoProfile -ExecutionPolicy Bypass -File $deployScript -ProjectPath $worktree -ReleaseContext $contextPath -ReleaseGateLockHeld -ReleaseGateLockToken ([string]$lock.Owner.handoffToken) -AllowPostMergeRecovery:$false -ResumePendingDeploy:$ResumePendingDeploy -DeployLockPath ([string]$policy.lockPath) -DeployTransport $(if ($ResumePendingDeploy) { "wechat" } else { "auto" }) -LockWaitSeconds $LockWaitSeconds
            if ($LASTEXITCODE -ne 0) { throw "CloudBase 恢复部署失败；保留原 context。" }
            $context = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $context = Assert-ResumeContextIdentity -Value $context
            $markerText = Get-Content -LiteralPath (Join-Path $worktree "cloudfunctions/api/index.js") -Raw -Encoding UTF8
            $markerMatch = [regex]::Match($markerText, 'const API_BUILD_MARKER = "([^"]+)"')
            $receipt = [ordered]@{
                schemaVersion = 1
                operationId = $OperationId
                version = [string]$context.version
                releaseCommit = $releaseCommit
                treeSha = [string]$context.treeSha
                sourceSha256 = [string]$context.sourceSha256
                packageSha256 = if ($context.PSObject.Properties["packageSha256"]) { [string]$context.packageSha256 } else { "" }
                mainCommit = if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }
                idempotencyKey = New-CloudDeployIdempotencyKey -Context $context
                onlineBuildVersion = [string]$context.version
                onlineBuildMarker = if ($markerMatch.Success) { $markerMatch.Groups[1].Value } else { "" }
                verifiedAt = [DateTimeOffset]::UtcNow.ToString("o")
                status = "verified"
            }
            $receipt = [pscustomobject]$receipt
            Assert-ResumeCloudReceipt -Receipt $receipt -Context $context | Out-Null
            $context = Save-ResumeContext -Values @{ phase = "deployed"; cloudReceipt = $receipt; cloudDeployment = [ordered]@{ state = "verified"; idempotencyKey = $receipt.idempotencyKey; receipt = $receipt; updatedAt = [DateTimeOffset]::UtcNow.ToString("o") } }
            $phase = "deployed"
        }

        $paymentDeployScript = Join-Path $worktree "scripts/deploy-payment-production.ps1"
        if (-not (Test-Path -LiteralPath $paymentDeployScript -PathType Leaf)) { throw "缺少支付生产部署入口：$paymentDeployScript" }
        Write-ResumeLog "payment-cloud" "继续原 context 的支付生产部署。"
        $env:RELEASE_GATE_CONTEXT = $contextPath
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $paymentDeployScript -ProjectPath $worktree -ReleaseContext $contextPath -ReleaseGateLockHeld -ReleaseGateLockToken ([string]$lock.Owner.handoffToken) -DeployLockPath ([string]$policy.lockPath) -LockWaitSeconds $LockWaitSeconds -AllowPostMergeRecovery:$false
        if ($LASTEXITCODE -ne 0) { throw "支付生产恢复部署失败；保留原 context。" }
        $context = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $context = Assert-ResumeContextIdentity -Value $context
        if (-not ($context.PSObject.Properties["paymentDeployment"] -and $null -ne $context.paymentDeployment)) {
            throw "支付生产部署未写入 paymentDeployment 回执。"
        }
        $paymentReceipt = Assert-ResumePaymentDeploymentReceipt -Receipt $context.paymentDeployment -Context $context
        $context = Save-ResumeContext -Values @{ phase = "deployed" }
        Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $OperationId -Phase "deployed" -Status "running" -Version ([string]$context.version) -BaseHead ([string]$context.baseHead) -ContextPath $contextPath -Lease $queueLease | Out-Null
        $phase = "deployed"
        if ([bool]$paymentReceipt.credentialsConfigured -eq $false) {
            Write-ResumeLog "payment-cloud" "支付资源与开关已核验；生产凭据未配置，provider 保持失败关闭。"
        }
    }

    $hasFinalPreview = $false
    if ($context.PSObject.Properties["previewQrPath"] -and $context.previewQrPath -and
        $context.PSObject.Properties["previewInfoPath"] -and $context.previewInfoPath -and
        (Test-Path -LiteralPath ([string]$context.previewQrPath) -PathType Leaf) -and
        (Test-Path -LiteralPath ([string]$context.previewInfoPath) -PathType Leaf)) {
        try {
            $previewReceipt = Get-Content -LiteralPath ([string]$context.previewInfoPath) -Raw -Encoding UTF8 | ConvertFrom-Json
            $receiptMain = if ($previewReceipt.PSObject.Properties["mainCommit"]) { [string]$previewReceipt.mainCommit } else { "" }
            $expectedMain = if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }
            $hasFinalPreview = -not [string]::IsNullOrWhiteSpace($receiptMain) -and
                -not [string]::IsNullOrWhiteSpace($expectedMain) -and
                [string]::Equals($receiptMain, $expectedMain, [StringComparison]::OrdinalIgnoreCase) -and
                [string]$previewReceipt.appVersion -eq [string]$context.version -and
                [string]$previewReceipt.gitCommit -eq $releaseCommit -and
                [string]$previewReceipt.treeSha -eq [string]$context.treeSha -and
                [string]$previewReceipt.sourceSha256 -eq [string]$context.sourceSha256
        }
        catch { $hasFinalPreview = $false }
    }
    if ($Preview -and -not $hasFinalPreview) {
        Write-ResumeLog "preview" "生成或幂等复用最终二维码。"
        $mergeCommit = if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }
        $previewArtifact = Write-ResumeFinalPreview -WorktreePath $worktree -Value $context -ReleaseCommit $releaseCommit -MainCommit $mergeCommit
        $qrPath = [string]$previewArtifact.qrPath
        $infoPath = [string]$previewArtifact.infoPath
        $context = Save-ResumeContext -Values @{ phase = "previewed"; previewQrPath = $qrPath; previewInfoPath = $infoPath }
        Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $OperationId -Phase "previewed" -Status "running" -Version ([string]$context.version) -BaseHead ([string]$context.baseHead) -ContextPath $contextPath -Lease $queueLease | Out-Null
        $phase = "previewed"
    }

    if (-not (Test-Path -LiteralPath ([string]$context.artifactPath) -PathType Leaf)) {
        throw "恢复前找不到不可变发布包：$($context.artifactPath)；保留原 context，不能重新打包占用版本。"
    }
    $packageScript = Join-Path $scriptRoot "package-release.py"
    if (-not (Test-Path -LiteralPath $packageScript -PathType Leaf)) { throw "缺少发布包校验入口：$packageScript" }
    $packageCheck = & python $packageScript --check-only --release-context $contextPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw "恢复前发布包/context 校验失败：$($packageCheck -join "`n")" }
    # Mirror release.ps1's two-phase finalization.  Keep queue status running
    # while context/reservation/record are written; only the final queue
    # transition is terminal.  This makes a crash at any intermediate point
    # recoverable with the same operationId and version.
    $reservationExtra = @{ releaseCommit = [string]$context.releaseCommit; treeSha = [string]$context.treeSha; contextPath = $contextPath; artifactPath = [string]$context.artifactPath }
    if ($context.PSObject.Properties["mainCommit"]) { $reservationExtra.mainCommit = [string]$context.mainCommit }
    if ($context.PSObject.Properties["mergedAt"]) { $reservationExtra.mergedAt = [string]$context.mergedAt }
    $context = Save-ResumeContext -Values @{ status = "finalizing"; finalization = [ordered]@{ state = "pending"; startedAt = [DateTimeOffset]::UtcNow.ToString("o") } } -RemoveKeys @("terminalStatus", "completedAt")
    Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $OperationId -Phase "finalizing" -Status "running" -Version ([string]$context.version) -BaseHead ([string]$context.baseHead) -ContextPath $contextPath -Lease $queueLease | Out-Null
    if (-not [string]::IsNullOrWhiteSpace($reservationPath)) {
        Set-ReleaseReservationStatus -ReservationPath $reservationPath -Status "finalizing" -Extra $reservationExtra
    }
    [void](Write-ResumeReleaseRecord -Status "finalizing" -TerminalStatus "pending" -Phase ([string]$context.phase) -MainCommit $(if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }) -MergedAt $(if ($context.PSObject.Properties["mergedAt"]) { [string]$context.mergedAt } else { "" }))

    # Do the same acceptance gate as the first publish attempt.  A resumed
    # operation must prove the original context still matches main/ZIP/QR/
    # CloudBase before it can become terminal; it must never silently turn a
    # repaired sidecar into a claimed new version.
    $acceptance = Ensure-ResumeAcceptanceReport -Value $context -RequireCloud:$DeployCloud -RequirePreview:$Preview
    $completedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $context = Save-ResumeContext -Values @{ status = "succeeded"; terminalStatus = "succeeded"; completedAt = $completedAt; reportPath = [string]$acceptance.Path; reportMarkdownPath = [string]$acceptance.MarkdownPath; finalization = [ordered]@{ state = "committed"; completedAt = $completedAt } }
    if (-not [string]::IsNullOrWhiteSpace($reservationPath)) {
        Set-ReleaseReservationStatus -ReservationPath $reservationPath -Status "succeeded" -Extra $reservationExtra
    }
    [void](Write-ResumeReleaseRecord -Status "succeeded" -TerminalStatus "succeeded" -Phase ([string]$context.phase) -MainCommit $(if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }) -MergedAt $(if ($context.PSObject.Properties["mergedAt"]) { [string]$context.mergedAt } else { "" }))
    # Sole terminal queue transition, deliberately last.
    Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $OperationId -Phase "succeeded" -Status "succeeded" -Version ([string]$context.version) -BaseHead ([string]$context.baseHead) -ContextPath $contextPath -Lease $queueLease | Out-Null
    $terminalQueue = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $OperationId -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
    if ($null -eq $terminalQueue -or [string]$terminalQueue.status -ne "succeeded") {
        throw "恢复后发布队列未确认 succeeded，保留原 context。"
    }
    Write-ReleaseLatestManifest -Policy $policy -Context $context -ReportPath ([string]$acceptance.Path) -Report $acceptance.Report | Out-Null
    $completed = $true
    Write-ResumeLog "done" "原发布操作已恢复完成：$OperationId"
    Write-Host "Context: $contextPath"
}
catch {
    $message = $_.Exception.Message
    try { Write-ResumeLog "failed" $message } catch { Write-Host "失败日志写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
    try {
        $alertVersion = if ($null -ne $context -and $context.PSObject.Properties["version"]) { [string]$context.version } else { "" }
        $alertPath = Write-ReleaseFailureAlert -Policy $policy -OperationId $OperationId -Version $alertVersion -Stage "resume" -Message $message -ContextPath $contextPath -LogPath $logPath
        Write-Host "恢复失败告警已记录：$alertPath" -ForegroundColor Yellow
    }
    catch { Write-Host "恢复失败告警处理失败：$($_.Exception.Message)" -ForegroundColor Yellow }
    $recoverable = -not [string]::IsNullOrWhiteSpace([string]$context.releaseCommit)

    if ($postMergeOnly) {
        # The main/queue release is already terminal.  A failed optional
        # side-effect must remain retryable without downgrading that terminal
        # release or allocating another version.
        try {
            $context = Save-ResumeContext -Values @{
                status = "succeeded"
                terminalStatus = "succeeded"
                postMergeStatus = "recoverable"
                postMergeRecovery = [ordered]@{ resumable = $true; lastFailureStage = $message; at = [DateTimeOffset]::UtcNow.ToString("o") }
            }
            if (-not [string]::IsNullOrWhiteSpace($reservationPath)) {
                Set-ReleaseReservationStatus -ReservationPath $reservationPath -Status "succeeded" -Extra @{ lastError = $message; postMergeStatus = "recoverable" }
            }
            [void](Write-ResumeReleaseRecord -Status "succeeded" -TerminalStatus "succeeded" -Phase ([string]$context.phase))
        }
        catch { Write-Host "合并后失败状态写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        throw
    }

    $queueSucceeded = $false
    try {
        $observedTicket = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $OperationId -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
        $queueSucceeded = $null -ne $observedTicket -and [string]$observedTicket.status -eq "succeeded"
    }
    catch { }

    if ($queueSucceeded) {
        # The terminal queue transition is authoritative and is intentionally
        # last.  If the process was interrupted while writing sidecars, retry
        # those writes idempotently instead of downgrading a successful ticket.
        $repairPhase = if ($context.PSObject.Properties["phase"]) { [string]$context.phase } else { "" }
        $repairAllowed = $repairPhase -in @("merged", "deployed", "previewed") -and (Test-Path -LiteralPath ([string]$context.artifactPath) -PathType Leaf)
        if ($repairAllowed) {
            try {
                $repairCheck = & python (Join-Path $scriptRoot "package-release.py") --check-only --release-context $contextPath 2>&1
                if ($LASTEXITCODE -ne 0) { throw "package/context 校验失败：$($repairCheck -join "`n")" }
                if (-not [string]::IsNullOrWhiteSpace($reservationPath)) {
                    $successExtra = @{ contextPath = $contextPath; artifactPath = [string]$context.artifactPath; releaseCommit = [string]$context.releaseCommit; treeSha = [string]$context.treeSha }
                    Set-ReleaseReservationStatus -ReservationPath $reservationPath -Status "succeeded" -Extra $successExtra
                }
                if ($terminal -ne "succeeded") {
                    $completedAt = [DateTimeOffset]::UtcNow.ToString("o")
                    $context = Save-ResumeContext -Values @{ status = "succeeded"; terminalStatus = "succeeded"; completedAt = $completedAt; finalization = [ordered]@{ state = "committed"; completedAt = $completedAt } }
                }
                [void](Write-ResumeReleaseRecord -Status "succeeded" -TerminalStatus "succeeded" -Phase ([string]$context.phase) -MainCommit $(if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }) -MergedAt $(if ($context.PSObject.Properties["mergedAt"]) { [string]$context.mergedAt } else { "" }))
                $repairReportPath = if ($context.PSObject.Properties["reportPath"]) { [string]$context.reportPath } else { Join-Path ([string]$policy.reportRoot) "release-$OperationId.json" }
                if (Test-Path -LiteralPath $repairReportPath -PathType Leaf) {
                    $repairReport = Get-Content -LiteralPath $repairReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ([string]$repairReport.status -eq "succeeded") {
                        Write-ReleaseLatestManifest -Policy $policy -Context $context -ReportPath $repairReportPath -Report $repairReport | Out-Null
                    }
                }
            }
            catch { Write-Host "成功 sidecar 补写失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        }
        else {
            Write-Host "队列已是 succeeded，但 context 阶段/产物未达到可修复条件；保持现场供人工审计。" -ForegroundColor Yellow
        }
    }
    else {
        $failureStatus = if ($recoverable) { "recoverable" } else { "failed" }
        # Mark the context before releasing the queue lease.  A later resume
        # then sees an explicit recoverable state even if the queue write is
        # interrupted or the lease has already expired.
        if ($recoverable) {
            try {
                $failedContext = Save-ResumeContext -Values @{ status = "recoverable"; finalization = [ordered]@{ state = "recoverable"; at = [DateTimeOffset]::UtcNow.ToString("o") }; recovery = [ordered]@{ resumable = $true; lastFailureStage = $message }; lastError = $message } -RemoveKeys @("terminalStatus", "completedAt")
            } catch { Write-Host "release context 恢复标记写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        }
        try {
            if (-not [string]::IsNullOrWhiteSpace($reservationPath)) {
                $failureExtra = @{ contextPath = $contextPath; artifactPath = [string]$context.artifactPath; releaseCommit = [string]$context.releaseCommit; treeSha = [string]$context.treeSha; lastError = $message }
                Set-ReleaseReservationStatus -ReservationPath $reservationPath -Status $failureStatus -Extra $failureExtra
            }
        } catch { Write-Host "reservation 状态写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        try {
            [void](Write-ResumeReleaseRecord -Status $failureStatus -TerminalStatus "pending" -Phase ([string]$context.phase))
        } catch { Write-Host "release record 恢复标记写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        try {
            Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $OperationId -Phase "failed" -Status $failureStatus -Version ([string]$context.version) -BaseHead ([string]$context.baseHead) -ErrorMessage $message -ContextPath $contextPath -ReservationPath $reservationPath -Lease $queueLease | Out-Null
        } catch { Write-Host "发布队列状态写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
    }
    throw
}
finally {
    if ($null -ne $queueHeartbeat -and (Get-Command Stop-ReleaseQueueLeaseHeartbeat -ErrorAction SilentlyContinue)) { Stop-ReleaseQueueLeaseHeartbeat -Heartbeat $queueHeartbeat }
    if ($null -ne $lock) { Exit-ReleaseLock -LockHandle $lock }
    # DevTools keeps a live reference to the imported release directory.  Keep
    # it after a successful preview sync so the simulator does not point at a
    # deleted worktree; a later maintenance pass can archive old preview trees.
    if (-not $KeepWorktree -and -not $Preview -and $completed -and -not [string]::IsNullOrWhiteSpace($worktree)) { Remove-ReleaseGateWorktree -CanonicalRepo $canonicalRepo -WorktreePath $worktree }
}
