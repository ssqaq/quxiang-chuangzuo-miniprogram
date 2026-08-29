param(
    [Parameter(Mandatory = $true)][ValidatePattern('^op-[A-Za-z0-9][A-Za-z0-9._-]{5,120}$')][string]$OperationId,
    [string]$PolicyPath = "",
    [switch]$Publish,
    [switch]$Preview,
    [string]$PreviewCliPath = "",
    [string]$PreviewClientName = "default",
    [switch]$DeployCloud,
    [ValidateRange(1, 7200)][int]$LockWaitSeconds = 1800,
    [switch]$KeepWorktree
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot
. (Join-Path $scriptRoot "release-gate.ps1")
. (Join-Path $scriptRoot "release-lock.ps1")
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
if ($terminal -eq "succeeded" -and [string]$ticket.status -eq "succeeded") {
    Write-Host "发布操作已经完成，无需重复执行：$OperationId"
    Write-Host "Context: $contextPath"
    exit 0
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
if (-not $Publish -and $initialPhase -notin @("merged", "deployed", "previewed")) {
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

try {
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
            & pwsh -NoProfile -ExecutionPolicy Bypass -File $deployScript -ProjectPath $worktree -ReleaseContext $contextPath -ReleaseGateLockHeld -DeployLockPath ([string]$policy.lockPath) -DeployTransport "auto" -LockWaitSeconds $LockWaitSeconds
            if ($LASTEXITCODE -ne 0) { throw "CloudBase 恢复部署失败；保留原 context。" }
            $receipt = [ordered]@{ operationId = $OperationId; version = [string]$context.version; releaseCommit = $releaseCommit; mainCommit = if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" }; verifiedAt = [DateTimeOffset]::UtcNow.ToString("o"); status = "verified" }
            $context = Save-ResumeContext -Values @{ phase = "deployed"; cloudReceipt = $receipt }
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
        if ([string]::IsNullOrWhiteSpace($PreviewCliPath)) { $PreviewCliPath = $env:WECHAT_DEVTOOLS_CLI }
        if ([string]::IsNullOrWhiteSpace($PreviewCliPath) -or -not (Test-Path -LiteralPath $PreviewCliPath -PathType Leaf)) { throw "找不到微信开发者工具 CLI，无法恢复二维码。" }
        $qrPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$($context.version)-$releaseCommit-qr.png"
        $infoPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$($context.version)-$releaseCommit-info.json"
        & $PreviewCliPath -c $PreviewClientName create_preview_qrcode --project $worktree --qr-format image --qr-output $qrPath 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $qrPath -PathType Leaf)) { throw "二维码恢复生成失败。" }
        Write-ReleaseGateJsonAtomic -Path $infoPath -Value ([ordered]@{ operationId = $OperationId; appVersion = [string]$context.version; gitCommit = $releaseCommit; treeSha = [string]$context.treeSha; sourceSha256 = [string]$context.sourceSha256; artifactPath = [string]$context.artifactPath; mainCommit = if ($context.PSObject.Properties["mainCommit"]) { [string]$context.mainCommit } else { "" } })
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
