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
    [switch]$KeepWorktree
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
$ticket = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $OperationId
if ($null -eq $ticket) { throw "找不到可恢复的发布操作：$OperationId" }

$contextPath = if ($ticket.PSObject.Properties["contextPath"] -and $ticket.contextPath) {
    [IO.Path]::GetFullPath([string]$ticket.contextPath)
}
else {
    Join-Path ([string]$policy.contextRoot) "release-$OperationId.json"
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

$reservationPath = if ($ticket.PSObject.Properties["reservationPath"] -and $ticket.reservationPath) {
    [IO.Path]::GetFullPath([string]$ticket.reservationPath)
}
else { "" }
if (-not [string]::IsNullOrWhiteSpace($reservationPath) -and -not (Test-Path -LiteralPath $reservationPath -PathType Leaf)) {
    throw "恢复操作 reservation 不存在：$reservationPath；为避免版本重新占用，已拒绝恢复。"
}
if (-not [string]::IsNullOrWhiteSpace($reservationPath)) {
    try {
        $reservationCheck = Get-Content -LiteralPath $reservationPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($reservationCheck.PSObject.Properties["operationId"] -and [string]$reservationCheck.operationId -ne $OperationId) {
            throw "reservation operationId 与恢复请求不一致。"
        }
        $reservedVersion = if ($reservationCheck.PSObject.Properties["targetVersion"]) { [string]$reservationCheck.targetVersion } elseif ($reservationCheck.PSObject.Properties["version"]) { [string]$reservationCheck.version } else { "" }
        if (-not [string]::IsNullOrWhiteSpace($reservedVersion) -and $reservedVersion -ne [string]$context.version) {
            throw "reservation 版本与 release context 不一致：reservation=$reservedVersion，context=$($context.version)"
        }
    }
    catch {
        throw "reservation 校验失败：$($_.Exception.Message)"
    }
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
        catch { $record = [ordered]@{} }
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
    if ($context.PSObject.Properties["packageSha256"]) { $record.packageSha256 = [string]$context.packageSha256 }
    $record.contextPath = $contextPath
    $record.generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $record.releaseBranch = if ($context.PSObject.Properties["releaseBranch"]) { [string]$context.releaseBranch } else { "release/$($context.version)-$OperationId" }
    $record.pullRequest = if ($context.PSObject.Properties["pullRequest"]) { [string]$context.pullRequest } else { "" }
    if (-not [string]::IsNullOrWhiteSpace($MainCommit)) { $record.mainCommit = $MainCommit }
    elseif ($context.PSObject.Properties["mainCommit"]) { $record.mainCommit = [string]$context.mainCommit }
    if (-not [string]::IsNullOrWhiteSpace($MergedAt)) { $record.mergedAt = $MergedAt }
    elseif ($context.PSObject.Properties["mergedAt"]) { $record.mergedAt = [string]$context.mergedAt }
    $record.phase = if (-not [string]::IsNullOrWhiteSpace($Phase)) { $Phase } elseif ($context.PSObject.Properties["phase"]) { [string]$context.phase } else { "" }
    if ($context.PSObject.Properties["cloudReceipt"]) { $record.cloudReceipt = $context.cloudReceipt }
    Write-ReleaseGateJsonAtomic -Path $recordPath -Value $record
    return $recordPath
}

$logPath = New-ReleaseOperationLogPath -LogRoot ([string]$policy.logRoot) -OperationId $OperationId
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
    if (Test-Path -LiteralPath $qrPath -PathType Leaf) {
        if (-not (Test-Path -LiteralPath $infoPath -PathType Leaf)) { throw "已有二维码但缺少 info，拒绝覆盖：$qrPath" }
        $existingQrSha = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $existingInfo = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$existingInfo.qrSha256 -ne $existingQrSha) { throw "已有二维码 SHA 与 info 不一致，拒绝覆盖：$qrPath" }
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
        Move-Item -LiteralPath $tempQrPath -Destination $qrPath
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
    else { Write-ReleaseGateJsonAtomic -Path $infoPath -Value $identity }
    return [pscustomobject]@{ qrPath = $qrPath; infoPath = $infoPath; qrSha256 = [string]$identity.qrSha256 }
}

function Ensure-ResumeReleaseWorktree {
    param(
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][string]$ReleaseCommit,
        [Parameter(Mandatory = $true)][string]$Branch
    )
    $resolved = [IO.Path]::GetFullPath($WorktreePath)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        New-Item -ItemType Directory -Path ([string]$policy.worktreeRoot) -Force | Out-Null
        Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("fetch", "origin", "refs/heads/$Branch:refs/remotes/origin/$Branch") -AllowFailure | Out-Null
        Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("worktree", "add", "--detach", $resolved, $ReleaseCommit) | Out-Null
    }
    $head = (Invoke-ReleaseGit -WorkingDirectory $resolved -Arguments @("rev-parse", "HEAD") | Select-Object -Last 1).Trim()
    if (-not [string]::Equals($head, $ReleaseCommit, [StringComparison]::OrdinalIgnoreCase)) {
        throw "恢复工作树 HEAD=$head 与 context releaseCommit=$ReleaseCommit 不一致，拒绝继续。"
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
        $phase = if ($context.PSObject.Properties["phase"]) { [string]$context.phase } else { "merged" }
        if ($phase -notin @("merged", "deployed", "previewed", "succeeded")) {
            throw "合并后 context 阶段无效：$phase"
        }

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
            $context = Save-ResumeContext -Values @{ phase = "deployed"; cloudReceipt = $receipt; cloudDeployment = [ordered]@{ state = "verified"; idempotencyKey = $receipt.idempotencyKey; receipt = $receipt; updatedAt = [DateTimeOffset]::UtcNow.ToString("o") }; postMergeStatus = "running" }
            $phase = "deployed"
            $cloudReceiptValid = $true
        }
        elseif ($DeployCloud -and $cloudReceiptValid -and -not (Get-ResumeCloudOnlineMatch -WorktreePath $worktree -Context $context)) {
            throw "已有 CloudBase receipt 但线上构建身份不匹配，拒绝假设成功；请保留 context 现场审计。"
        }

        if ($Preview -and -not (Test-ResumeFinalPreview -Value $context)) {
            Write-ResumeLog "preview" "为已合并 context 生成或幂等复用最终二维码。"
            $preview = Write-ResumeFinalPreview -WorktreePath $worktree -Value $context -ReleaseCommit $releaseCommit -MainCommit $mergeCommit
            $qrPath = [string]$preview.qrPath
            $infoPath = [string]$preview.infoPath
            $context = Save-ResumeContext -Values @{ phase = "previewed"; previewQrPath = $qrPath; previewInfoPath = $infoPath; postMergeStatus = "running" }
            $phase = "previewed"
        }

        if (-not (Test-Path -LiteralPath ([string]$context.artifactPath) -PathType Leaf)) {
            throw "补做合并后步骤时找不到不可变发布包：$($context.artifactPath)"
        }
        $packageScript = Join-Path $scriptRoot "package-release.py"
        $packageCheck = & python $packageScript --check-only --release-context $contextPath 2>&1
        if ($LASTEXITCODE -ne 0) { throw "合并后 package/context 校验失败：$($packageCheck -join "`n")" }
        $postCompletedAt = [DateTimeOffset]::UtcNow.ToString("o")
        $context = Save-ResumeContext -Values @{ status = "succeeded"; terminalStatus = "succeeded"; postMergeStatus = "succeeded"; postMergeCompletedAt = $postCompletedAt; recovery = [ordered]@{ resumable = $true; lastFailureStage = "" } }
        $reservationExtra = @{ releaseCommit = $releaseCommit; treeSha = [string]$context.treeSha; contextPath = $contextPath; artifactPath = [string]$context.artifactPath; postMergeCompletedAt = $postCompletedAt }
        if ($context.PSObject.Properties["mainCommit"]) { $reservationExtra.mainCommit = [string]$context.mainCommit }
        if ($context.PSObject.Properties["cloudReceipt"]) { $reservationExtra.cloudReceipt = $context.cloudReceipt }
        if (-not [string]::IsNullOrWhiteSpace($reservationPath)) { Set-ReleaseReservationStatus -ReservationPath $reservationPath -Status "succeeded" -Extra $reservationExtra }
        [void](Write-ResumeReleaseRecord -Status "succeeded" -TerminalStatus "succeeded" -Phase ([string]$context.phase) -MainCommit $(if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }) -MergedAt $(if ($context.PSObject.Properties["mergedAt"]) { [string]$context.mergedAt } else { "" }))
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
    $queueLease = Claim-ReleaseQueueTicket -TicketId ([string]$ticket.ticketId) -LeaseOwner "release-resume/$PID/$OperationId" -LeaseSeconds $queueLeaseSeconds -AllowPrepared:$allowPreparedClaim -QueueRoot $queueRoot -WaitSeconds $LockWaitSeconds -PollMilliseconds $queuePollMilliseconds
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
    if (-not (Test-Path -LiteralPath $worktree -PathType Container)) {
        New-Item -ItemType Directory -Path ([string]$policy.worktreeRoot) -Force | Out-Null
        Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("fetch", "origin", "refs/heads/$branch:refs/remotes/origin/$branch") -AllowFailure | Out-Null
        Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("worktree", "add", "--detach", $worktree, $releaseCommit) | Out-Null
    }

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
            Assert-ResumeCloudReceipt -Receipt $receipt -Context $context | Out-Null
            $context = Save-ResumeContext -Values @{ phase = "deployed"; cloudReceipt = $receipt; cloudDeployment = [ordered]@{ state = "verified"; idempotencyKey = $receipt.idempotencyKey; receipt = $receipt; updatedAt = [DateTimeOffset]::UtcNow.ToString("o") } }
            Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $OperationId -Phase "deployed" -Status "running" -Version ([string]$context.version) -BaseHead ([string]$context.baseHead) -ContextPath $contextPath -Lease $queueLease | Out-Null
            $phase = "deployed"
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
        $preview = Write-ResumeFinalPreview -WorktreePath $worktree -Value $context -ReleaseCommit $releaseCommit -MainCommit $mergeCommit
        $qrPath = [string]$preview.qrPath
        $infoPath = [string]$preview.infoPath
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

    $completedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $context = Save-ResumeContext -Values @{ status = "succeeded"; terminalStatus = "succeeded"; completedAt = $completedAt; finalization = [ordered]@{ state = "committed"; completedAt = $completedAt } }
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
    $completed = $true
    Write-ResumeLog "done" "原发布操作已恢复完成：$OperationId"
    Write-Host "Context: $contextPath"
}
catch {
    $message = $_.Exception.Message
    try { Write-ResumeLog "failed" $message } catch { Write-Host "失败日志写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
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
    if (-not $KeepWorktree -and $completed -and -not [string]::IsNullOrWhiteSpace($worktree)) { Remove-ReleaseGateWorktree -CanonicalRepo $canonicalRepo -WorktreePath $worktree }
}
