param(
    [string]$SourcePath = "",

    [object[]]$IncludePath = @(),

    [string]$TargetVersion = "",

    [string]$PolicyPath = "",

    [ValidateRange(1, 7200)]
    [int]$LockWaitSeconds = 1800,

    # Preparation is the default.  Only an explicit -Publish may push a branch
    # and create/auto-merge a PR into main.
    [switch]$Publish,

    [switch]$Preview,

    [string]$PreviewCliPath = "",

    [string]$PreviewClientName = "default",

    [switch]$DeployCloud,

    [switch]$ResumePendingDeploy,

    [switch]$KeepWorktree,

    [string]$ResumeOperation = "",
    [string]$OperationId = "",
    [switch]$Status
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot
. (Join-Path $scriptRoot "release-gate.ps1")
. (Join-Path $scriptRoot "release-lock.ps1")
. (Join-Path $scriptRoot "release-version.ps1")
$queueScript = Join-Path $scriptRoot "release-queue.ps1"
if (-not (Test-Path -LiteralPath $queueScript -PathType Leaf)) { throw "缺少发布队列工具：$queueScript" }
# Dot-source at script scope.  Loading it inside an `if {}` block creates a
# child scope in PowerShell; callbacks inside the queue would then lose their
# helper functions (for example Get-ReleaseQueueTicketIndex).
. $queueScript

$canonicalGuess = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$policy = Get-ReleaseGatePolicy -PolicyPath $PolicyPath -RepositoryRoot $canonicalGuess
Assert-ReleaseCanonicalPolicy -Policy $policy -RepositoryRoot $canonicalGuess | Out-Null
if (-not (Test-ReleasePathEqual -Left $canonicalGuess -Right ([string]$policy.canonicalRepo))) {
    throw "旧 clone/worktree 不允许直接调用发布入口，请从 canonical 仓库执行：$([string]$policy.canonicalRepo)"
}
$canonicalRepo = ConvertTo-ReleaseFullPath -Path ([string]$policy.canonicalRepo)
$queueRoot = if ($policy.PSObject.Properties["queueRoot"]) { [string]$policy.queueRoot } else { Join-Path (Split-Path ([string]$policy.lockPath) -Parent) "wechat-miniapp-release-queue" }

if ($Status) {
    $statusId = if (-not [string]::IsNullOrWhiteSpace($OperationId)) { $OperationId } else { $ResumeOperation }
    if (-not [string]::IsNullOrWhiteSpace($statusId)) {
        $statusRecord = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $statusId
        if ($null -eq $statusRecord) { throw "找不到发布操作：$statusId" }
        $statusRecord | ConvertTo-Json -Depth 12
    }
    else {
        @(Get-ReleaseQueueTickets -QueueRoot $queueRoot) | ConvertTo-Json -Depth 12
    }
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($ResumeOperation)) {
    $resumeScript = Join-Path $scriptRoot "resume-release.ps1"
    if (-not (Test-Path -LiteralPath $resumeScript -PathType Leaf)) {
        throw "恢复入口不存在：$resumeScript"
    }
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $resumeScript `
        -OperationId $ResumeOperation `
        -PolicyPath ([string]$policy.policyPath) `
        -Publish:$Publish `
        -Preview:$Preview `
        -PreviewCliPath $PreviewCliPath `
        -PreviewClientName $PreviewClientName `
        -DeployCloud:$DeployCloud `
        -ResumePendingDeploy:$ResumePendingDeploy `
        -LockWaitSeconds $LockWaitSeconds `
        -KeepWorktree:$KeepWorktree
    exit $LASTEXITCODE
}

if ([string]::IsNullOrWhiteSpace($SourcePath)) { throw "普通发布必须提供 -SourcePath。" }
if ($null -eq $IncludePath -or @($IncludePath).Count -eq 0) { throw "普通发布必须显式提供 -IncludePath。" }
$includePaths = @(Normalize-ReleaseIncludePaths -InputPath $IncludePath)
if ($Preview) {
    if ([string]::IsNullOrWhiteSpace($PreviewCliPath)) { $PreviewCliPath = $env:WECHAT_DEVTOOLS_CLI }
    if ([string]::IsNullOrWhiteSpace($PreviewCliPath) -or -not (Test-Path -LiteralPath $PreviewCliPath -PathType Leaf)) {
        throw "已要求生成预览码，但找不到微信开发者工具 CLI；闸门尚未分配版本。"
    }
}
# Check the remote guard before creating a queue lease or reserving a version.
# A known GitHub-plan/API failure must not burn an attempt or leave a new
# ticket blocking FIFO.  The later PR call repeats the check under the lock to
# close the time-of-check/time-of-use window.
if ($Publish -and [bool]$policy.mainProtection.enforceOnPublish) {
    Test-ReleaseGitHubProtection -RepositoryRoot $canonicalRepo -Policy $policy | Out-Null
}
$operationId = if ([string]::IsNullOrWhiteSpace($OperationId)) {
    "op-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
}
else {
    $OperationId.Trim()
}
if ($operationId -notmatch '^op-[A-Za-z0-9][A-Za-z0-9._-]{5,120}$') {
    throw "OperationId 格式无效：$operationId"
}
$logPath = New-ReleaseOperationLogPath -LogRoot ([string]$policy.logRoot) -OperationId $operationId
$lockHandle = $null
$reservation = $null
$releaseWorktree = ""
$contextPath = ""
$recordPath = ""
$finalCommit = ""
$target = ""
$baseHead = ""
$failureAfterCommit = $false
$completed = $false
$queueTicket = $null
$queueLease = $null
$queueHeartbeat = $null
$queueLeaseSeconds = if ($policy.queue -and $policy.queue.PSObject.Properties["leaseSeconds"]) { [int]$policy.queue.leaseSeconds } else { 180 }
$releaseToolPaths = @(
    "scripts/release-gate.ps1",
    "scripts/release.ps1",
    "scripts/package-release.py",
    "scripts/package-release-smoke.py",
    "scripts/release-lock.ps1",
    "scripts/release-lock-smoke.js",
    "scripts/release-version.ps1",
    "scripts/release-safety-smoke.js",
    "scripts/version-concurrency-smoke.js",
    "scripts/release-gate-smoke.js",
    "scripts/deploy-and-verify-api.ps1",
    "scripts/npm-dependency-cache.ps1",
    "scripts/npm-dependency-cache-smoke.js",
    "scripts/cloud-deploy-safety.ps1",
    "scripts/cloud-deploy-safety-smoke.js",
    "scripts/deployment-script-smoke.js",
    "scripts/deploy-api-cloudbase-cli.ps1",
    "scripts/refresh-preview.ps1",
    "scripts/configure-github-protection.ps1",
    "scripts/release-queue.ps1",
    "scripts/release-queue-smoke.js",
    "scripts/resume-release.ps1",
    "scripts/resume-release-smoke.js",
    "scripts/release-status.ps1",
    "scripts/release-workflow-smoke.js",
    "scripts/sync-to-github.ps1",
    ".github/workflows/release-gate.yml",
    "docs/superpowers/specs/2026-08-28-release-gate-design.md"
)

function Write-GateHost {
    param([string]$Stage, [string]$Message)
    Write-Host "[$Stage] $Message"
    Write-ReleaseOperationLog -Path $logPath -Stage $Stage -Message $Message -OperationId $operationId
}

function Set-GateQueueStage {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [string]$Status = ""
    )
    if ($null -ne $lockHandle) {
        Update-ReleaseLockOwner -LockHandle $lockHandle -TargetVersion $(if ($TargetVersion) { $TargetVersion } else { "auto" }) -Stage $Stage
    }
    if ($null -ne $queueTicket -and (Get-Command Set-ReleaseQueuePhase -ErrorAction SilentlyContinue)) {
        $nextStatus = if ([string]::IsNullOrWhiteSpace($Status)) { $Stage } else { $Status }
        $queueTicket = Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $operationId -Phase $Stage -Status $nextStatus -Version $(if ($target) { $target } else { "" }) -BaseHead $(if ($baseHead) { $baseHead } else { "" }) -ContextPath $contextPath -ReservationPath $(if ($null -ne $reservation) { [string]$reservation.Path } else { "" }) -Lease $queueLease -WaitSeconds $LockWaitSeconds -PollMilliseconds ([int]$policy.queue.pollMilliseconds)
    }
    Write-GateHost "phase" "阶段=$Stage，状态=$(if ($Status) { $Status } else { $Stage })。"
}

function Get-GateConfigTextAt {
    param([string]$Repository, [string]$Revision)
    return ((Invoke-ReleaseGit -WorkingDirectory $Repository -Arguments @("show", "$Revision`:config.js")) -join "`n")
}

function Get-GateVersionFromText {
    param([string]$Text, [string]$Source)
    $match = [regex]::Match($Text, 'appVersion:\s*"([^"]+)"')
    if (-not $match.Success) { throw "无法从 $Source 读取 appVersion。" }
    return $match.Groups[1].Value
}

function Get-GatePackageSummary {
    param([string[]]$Output)
    $text = ($Output -join "`n").Trim()
    # The hardened package script emits a JSON summary.  Locate the last JSON
    # object so human-readable diagnostic lines before it remain useful.
    $lines = @($text -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') -and $_.Trim().EndsWith('}') })
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        try { return ($lines[$i] | ConvertFrom-Json) } catch { }
    }
    $shaMatch = [regex]::Match($text, '(?:sourceSha256|源码内容 SHA256)\s*[:：]\s*([0-9a-fA-F]{64})')
    if ($shaMatch.Success) { return [pscustomobject]@{ sourceSha256 = $shaMatch.Groups[1].Value.ToLowerInvariant() } }
    return $null
}

function Invoke-GatePython {
    param([string]$ScriptRoot, [string[]]$Arguments)
    $output = & python (Join-Path $ScriptRoot "scripts/package-release.py") @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "package-release.py 失败：$($output -join "`n")"
    }
    return @($output)
}

function Add-GateUniquePath {
    param([System.Collections.Generic.List[string]]$List, [string]$Path)
    if (-not $List.Contains($Path)) { [void]$List.Add($Path) }
}

try {
    Write-GateHost "queue" "操作号 $operationId，开始进入统一发布队列。"
    if (Get-Command Recover-ReleaseQueueTickets -ErrorAction SilentlyContinue) {
        Recover-ReleaseQueueTickets -QueueRoot $queueRoot -WaitSeconds $LockWaitSeconds -PollMilliseconds ([int]$policy.queue.pollMilliseconds) | Out-Null
    }
    $queueTicket = New-ReleaseQueueTicket `
        -QueueRoot $queueRoot `
        -OperationId $operationId `
        -RequestedVersion $TargetVersion `
        -SourcePath $SourcePath `
        -IncludePath $includePaths `
        -CreatedBy "release-gate/$PID" `
        -Metadata ([ordered]@{ publish = [bool]$Publish; preview = [bool]$Preview; deployCloud = [bool]$DeployCloud }) `
        -WaitSeconds $LockWaitSeconds `
        -PollMilliseconds ([int]$policy.queue.pollMilliseconds)
    if ($null -eq $queueTicket) { throw "发布队列未返回票据。" }
    if ([bool]$queueTicket.wasReused -and [string]$queueTicket.status -eq "succeeded") {
        Write-GateHost "queue" "操作号已完成，幂等复用成功票据：$operationId"
        $completed = $true
        return
    }
    if ([string]$queueTicket.status -in @("leased", "running")) {
        throw "操作号已有活动租约，不能并发重复执行：$operationId；请使用 -ResumeOperation。"
    }
    if ([string]$queueTicket.status -in @("failed", "cancelled", "expired", "recoverable")) {
        throw "操作号处于终态 $($queueTicket.status)，不能从普通入口重用；请新建操作号或用恢复入口。"
    }
    Set-GateQueueStage -Stage "queued" -Status "queued"
    $sourceRepo = Assert-ReleaseGitRepository -RepositoryPath $SourcePath -Policy $policy -AllowSourceWorktree
    $canonical = Assert-ReleaseCanonicalRepository -RepositoryPath $canonicalRepo -Policy $policy
    if (-not (Test-Path -LiteralPath ([string]$policy.contextRoot) -PathType Container)) {
        New-Item -ItemType Directory -Path ([string]$policy.contextRoot) -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath ([string]$policy.artifactRoot) -PathType Container)) {
        New-Item -ItemType Directory -Path ([string]$policy.artifactRoot) -Force | Out-Null
    }

    $lockTargetVersion = if ([string]::IsNullOrWhiteSpace($TargetVersion)) { "auto" } else { $TargetVersion }
    $lockHandle = Enter-ReleaseLock `
        -ProjectPath $canonicalRepo `
        -TargetVersion $lockTargetVersion `
        -TargetType "release-gate" `
        -WaitSeconds $LockWaitSeconds `
        -LockPath ([string]$policy.lockPath) `
        -ProjectId $operationId `
        -LeaseSeconds $queueLeaseSeconds `
        -Stage "running"
    Write-GateHost "queue" "已取得发布锁：$($lockHandle.LockPath)"
    # The archive manifest is shared release state too.  Write it only after
    # the same exclusive lock is held, so two publishers cannot race a
    # partially scanned clone/worktree inventory.
    $archiveManifestPath = Update-ReleaseArchiveManifest -Policy $policy
    Write-GateHost "archive" "已更新旧 clone/worktree 封存清单：$archiveManifestPath"
    $leaseOwner = "release-gate/$PID/$operationId"
    $queueLease = Claim-ReleaseQueueTicket `
        -TicketId ([string]$queueTicket.ticketId) `
        -LeaseOwner $leaseOwner `
        -LeaseSeconds $queueLeaseSeconds `
        -QueueRoot $queueRoot `
        -WaitSeconds $LockWaitSeconds `
        -PollMilliseconds ([int]$policy.queue.pollMilliseconds)
    if ($null -eq $queueLease) { throw "发布队列未能领取票据，可能仍有更早操作排队。" }
    $queueLease = Start-ReleaseQueueTicket `
        -TicketId ([string]$queueLease.ticketId) `
        -LeaseId ([string]$queueLease.leaseId) `
        -LeaseOwner ([string]$queueLease.leaseOwner) `
        -QueueRoot $queueRoot `
        -WaitSeconds $LockWaitSeconds `
        -PollMilliseconds ([int]$policy.queue.pollMilliseconds)
    if (Get-Command Start-ReleaseQueueLeaseHeartbeat -ErrorAction SilentlyContinue) {
        $queueHeartbeat = Start-ReleaseQueueLeaseHeartbeat `
            -TicketId ([string]$queueLease.ticketId) `
            -LeaseId ([string]$queueLease.leaseId) `
            -LeaseOwner ([string]$queueLease.leaseOwner) `
            -QueueRoot $queueRoot `
            -LeaseSeconds $queueLeaseSeconds `
            -IntervalSeconds ([Math]::Max(5, [int]($queueLeaseSeconds / 3))) `
            -WaitSeconds $LockWaitSeconds `
            -PollMilliseconds ([int]$policy.queue.pollMilliseconds)
    }
    Set-GateQueueStage -Stage "running" -Status "running"

    # The lock covers fetch, reservation, package, preview, cloud handoff and
    # GitHub operations.  No other entry point may safely interleave here.
    $sourceSnapshot = Get-ReleaseFileSnapshot -SourceRoot $sourceRepo.Root -RelativePath $includePaths
    foreach ($entry in $sourceSnapshot.GetEnumerator()) {
        if (-not [bool]$entry.Value.exists) {
            throw "发布源文件不存在：$($entry.Key)"
        }
    }
    # 发布器本身来自 canonical 仓库，避免旧 source clone 携带旧的打包器/闸门。
    $toolSnapshot = Get-ReleaseFileSnapshot -SourceRoot $canonicalRepo -RelativePath $releaseToolPaths
    foreach ($entry in $toolSnapshot.GetEnumerator()) {
        if (-not [bool]$entry.Value.exists) {
            throw "canonical 发布工具文件不存在：$($entry.Key)"
        }
    }
    $sourceCommit = $sourceRepo.Commit
    Set-GateQueueStage -Stage "source" -Status "running"
    Write-GateHost "source" "来源 $($sourceRepo.Root)，提交 $sourceCommit，文件 $($includePaths.Count) 个。"

    Write-GateHost "fetch" "刷新 origin/$($policy.branch)。"
    Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("fetch", "origin", "refs/heads/$($policy.branch):refs/remotes/origin/$($policy.branch)") | ForEach-Object { Write-Host $_ }
    $baseHead = Get-ReleaseGitValue -WorkingDirectory $canonicalRepo -Arguments @("rev-parse", "origin/$($policy.branch)")
    $baseVersion = Get-GateVersionFromText -Text (Get-GateConfigTextAt -Repository $canonicalRepo -Revision "origin/$($policy.branch)") -Source "origin/$($policy.branch):config.js"
    $usedVersions = Get-ReleaseUsedVersions `
        -ReservationRoot ([string]$policy.reservationRoot) `
        -RecordRoot ([string]$policy.recordRoot) `
        -RepositoryRoot $canonicalRepo `
        -QueueRoot $queueRoot `
        -ContextRoot ([string]$policy.contextRoot)
    $target = Resolve-ReleaseVersion -BaseVersion $baseVersion -RequestedVersion $TargetVersion -UsedVersions $usedVersions
    Update-ReleaseLockOwner -LockHandle $lockHandle -TargetVersion $target -Stage "version"
    Set-GateQueueStage -Stage "version" -Status "running"
    Write-GateHost "version" "远端基线 $baseVersion ($baseHead)，分配版本 $target。"

    $reservation = New-ReleaseReservation `
        -ReservationRoot ([string]$policy.reservationRoot) `
        -OperationId $operationId `
        -Version $target `
        -BaseHead $baseHead `
        -IncludePath $includePaths `
        -SourcePath $sourceRepo.Root
    Write-GateHost "version" "已原子写入 reservation：$($reservation.Path)"

    New-Item -ItemType Directory -Path ([string]$policy.worktreeRoot) -Force | Out-Null
    $releaseWorktree = Join-Path ([string]$policy.worktreeRoot) "release-$operationId"
    Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("worktree", "add", "--detach", $releaseWorktree, "origin/$($policy.branch)") | ForEach-Object { Write-Host $_ }
    Write-GateHost "worktree" "隔离发布工作树：$releaseWorktree"
    Set-GateQueueStage -Stage "worktree" -Status "running"
    Copy-ReleaseFileSnapshot -TargetRoot $releaseWorktree -Snapshot $sourceSnapshot
    Copy-ReleaseFileSnapshot -TargetRoot $releaseWorktree -Snapshot $toolSnapshot

    $versionPaths = Get-ReleaseVersionPaths -SourceRoot $releaseWorktree
    foreach ($versionPath in $versionPaths) {
        $versionFile = Join-Path $releaseWorktree ($versionPath.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) { throw "版本组文件不存在：$versionPath" }
        $oldText = Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8
        $newText = Set-VersionText -RelativePath $versionPath -Text $oldText -TargetVersion $target
        [IO.File]::WriteAllText($versionFile, $newText, [Text.UTF8Encoding]::new($false))
    }

    $allowed = New-Object System.Collections.Generic.List[string]
    foreach ($path in $includePaths) { Add-GateUniquePath -List $allowed -Path $path }
    foreach ($path in $releaseToolPaths) { Add-GateUniquePath -List $allowed -Path $path }
    foreach ($path in $versionPaths) { Add-GateUniquePath -List $allowed -Path $path }
    $literal = @($allowed | ForEach-Object { ":(literal)$_" })
    # Source worktrees may inherit a different core.autocrlf setting.  Normalize
    # through Git's index for this command only; never modify shared repo config.
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments (@("-c", "core.autocrlf=true", "add", "--all", "--") + $literal) | ForEach-Object { Write-Host $_ }
    $staged = @((Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--name-only")) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($staged.Count -eq 0) { throw "没有可发布的变化；闸门不会创建空提交。" }
    $outside = @($staged | Where-Object { $_ -notin @($allowed) })
    if ($outside.Count -gt 0) { throw "隔离发布工作树出现未授权文件：$($outside -join '；')" }
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--check") | ForEach-Object { Write-Host $_ }
    Write-GateHost "stage" "已暂存 $($staged.Count) 个授权文件。"
    Set-GateQueueStage -Stage "staged" -Status "running"

    # Read-only validation happens before commit.  The package script supplied
    # by the package-hardening change must support this explicit interface.
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--check") | Out-Null
    Invoke-GatePython -ScriptRoot $canonicalRepo -Arguments @("--check-only", "--source-tree", $releaseWorktree) | ForEach-Object { Write-Host $_ }
    Write-GateHost "check" "发布前只读校验通过。"
    Set-GateQueueStage -Stage "checked" -Status "running"
    Assert-ReleaseFileSnapshotStable -SourceRoot $sourceRepo.Root -Snapshot $sourceSnapshot
    Assert-ReleaseFileSnapshotStable -SourceRoot $canonicalRepo -Snapshot $toolSnapshot

    $identity = Resolve-ReleaseIdentity -WorkingDirectory $releaseWorktree -RemoteUrl ([string]$policy.remote)
    $commitMessage = "release: v$target via release gate"
    $oldSkip = $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT
    $oldAllow = $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT
    $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = "1"
    $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT = "1"
    try {
        Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @(
            "-c", "user.name=$($identity.Name)",
            "-c", "user.email=$($identity.Email)",
            "commit", "-m", $commitMessage,
            "-m", "operationId=$operationId`nbaseHead=$baseHead`nversion=$target"
        ) | ForEach-Object { Write-Host $_ }
    }
    finally {
        if ($null -eq $oldSkip) { Remove-Item Env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT -ErrorAction SilentlyContinue } else { $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = $oldSkip }
        if ($null -eq $oldAllow) { Remove-Item Env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT -ErrorAction SilentlyContinue } else { $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT = $oldAllow }
    }
    $finalCommit = Get-ReleaseGitValue -WorkingDirectory $releaseWorktree -Arguments @("rev-parse", "HEAD")
    $finalTree = Get-ReleaseGitValue -WorkingDirectory $releaseWorktree -Arguments @("rev-parse", "$finalCommit^{tree}")
    $failureAfterCommit = $true
    Write-GateHost "commit" "隔离提交完成：$finalCommit，tree=$finalTree，身份=$($identity.Name) <$($identity.Email)>。"
    Set-GateQueueStage -Stage "committed" -Status "running"

    $finalCheck = Invoke-GatePython -ScriptRoot $canonicalRepo -Arguments @("--check-only", "--source-tree", $finalCommit)
    $finalSummary = Get-GatePackageSummary -Output $finalCheck
    $shaProperty = if ($null -ne $finalSummary) { $finalSummary.PSObject.Properties["sourceSha256"] } else { $null }
    if ($null -eq $shaProperty -or [string]::IsNullOrWhiteSpace([string]$shaProperty.Value)) {
        throw "打包检查没有返回最终提交源码 SHA256，拒绝生成 context。"
    }
    $preSha = [string]$shaProperty.Value
    if ($preSha -notmatch '^[0-9a-fA-F]{64}$') { throw "打包检查返回的源码 SHA256 无效：$preSha" }
    Write-GateHost "check" "最终提交校验通过，源码 SHA256=$preSha。"

    $artifactPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-release-v$target-$finalCommit.zip"
    $contextPath = Join-Path ([string]$policy.contextRoot) "release-$operationId.json"
    $context = New-ReleaseContext `
        -Path $contextPath `
        -OperationId $operationId `
        -Policy $policy `
        -Version $target `
        -SourceCommit $sourceCommit `
        -ReleaseCommit $finalCommit `
        -TreeSha $finalTree `
        -SourceSha256 $preSha `
        -ArtifactPath $artifactPath `
        -BaseHead $baseHead `
        -QueueTicketPath (Join-Path $queueRoot "queue.json") `
        -Phase "prepared"
    Assert-ReleaseContextShape -Context $context -Policy $policy | Out-Null
    Write-GateHost "context" "release context 已生成：$contextPath"

    $packageOutput = Invoke-GatePython -ScriptRoot $canonicalRepo -Arguments @("--release-context", $contextPath)
    $packageSummary = Get-GatePackageSummary -Output $packageOutput
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw "打包脚本返回成功但产物不存在：$artifactPath" }
    $artifact = Get-Item -LiteralPath $artifactPath
    if ($artifact.Length -le 0) { throw "发布包为空：$artifactPath" }
    $packageSha = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $contextHash = [ordered]@{}
    foreach ($prop in $context.PSObject.Properties) { $contextHash[$prop.Name] = $prop.Value }
    $contextHash.packageSha256 = $packageSha
    $contextHash.packageSizeBytes = [int64]$artifact.Length
    $contextHash.status = "prepared"
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    Write-GateHost "package" "不可变发布包已生成：$artifactPath（$($artifact.Length) bytes，SHA256=$packageSha）。"
    Set-GateQueueStage -Stage "packaged" -Status "running"

    if ($Preview -and -not $Publish) {
        if ([string]::IsNullOrWhiteSpace($PreviewCliPath)) { $PreviewCliPath = $env:WECHAT_DEVTOOLS_CLI }
        if ([string]::IsNullOrWhiteSpace($PreviewCliPath) -or -not (Test-Path -LiteralPath $PreviewCliPath -PathType Leaf)) {
            throw "已要求生成预览码，但找不到微信开发者工具 CLI。"
        }
        # A preview generated before the PR is merged is evidence for review,
        # not the production receipt.  Keep it under a distinct immutable
        # name so a later resume cannot mistake it for the final QR or
        # overwrite it in place.
        $qrPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-premerge-qr.png"
        $infoPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-premerge-info.json"
        $previewOutput = & $PreviewCliPath -c $PreviewClientName create_preview_qrcode `
            --project $releaseWorktree `
            --qr-format image `
            --qr-output $qrPath 2>&1
        $previewExitCode = $LASTEXITCODE
        $previewText = ($previewOutput | ForEach-Object { [string]$_ }) -join "`n"
        $previewSummary = "WechatIDE create_preview_qrcode 已返回。"
        try {
            $jsonStart = $previewText.IndexOf("{")
            if ($jsonStart -ge 0) {
                $previewResult = $previewText.Substring($jsonStart) | ConvertFrom-Json
                $previewOk = if ($previewResult.PSObject.Properties["ok"]) { [bool]$previewResult.ok } else { $false }
                $previewSummary = "WechatIDE create_preview_qrcode ok=$previewOk。"
            }
        }
        catch {
            $previewSummary = "WechatIDE 已返回，结果 JSON 未解析；继续以退出码和二维码文件校验。"
        }
        Write-Host $previewSummary
        if ($previewExitCode -ne 0 -or -not (Test-Path -LiteralPath $qrPath -PathType Leaf)) {
            throw "预览码生成失败，未发布到远端。"
        }
        $info = [pscustomobject]@{}
        if (Test-Path -LiteralPath $infoPath -PathType Leaf) {
            try { $info = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $info = [pscustomobject]@{} }
        }
        $infoHash = [ordered]@{}
        foreach ($prop in $info.PSObject.Properties) { $infoHash[$prop.Name] = $prop.Value }
        $infoHash.operationId = $operationId; $infoHash.appVersion = $target; $infoHash.gitCommit = $finalCommit; $infoHash.treeSha = $finalTree; $infoHash.sourceSha256 = $preSha; $infoHash.artifactPath = $artifactPath
        Write-ReleaseGateJsonAtomic -Path $infoPath -Value $infoHash
        $contextHash.premergePreviewQrPath = $qrPath; $contextHash.premergePreviewInfoPath = $infoPath
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
        Write-GateHost "preview" "预览二维码已生成：$qrPath"
    }

    if ($DeployCloud -and -not $Publish) {
        throw "CloudBase 正式部署必须在 PR 合并后执行；先用 -Publish 生成并合并 PR，再用 -ResumeOperation 配合 -DeployCloud。"
    }

    # Phase 1 ends at the immutable package and PR.  Production CloudBase is
    # deliberately after the merge confirmation so online code can never lead
    # GitHub main.
    $pr = Invoke-ReleasePullRequest -RepositoryRoot $releaseWorktree -Branch "release/$target-$operationId" -Version $target -OperationId $operationId -CommitSha $finalCommit -Policy $policy -NoPush:(-not $Publish)
    $contextHash.status = [string]$pr.status
    $contextHash.releaseBranch = $pr.branch
    $contextHash.pullRequest = $pr.pr
    if ($pr.PSObject.Properties["mainCommit"] -and -not [string]::IsNullOrWhiteSpace([string]$pr.mainCommit)) { $contextHash.mainCommit = [string]$pr.mainCommit }
    if ($pr.PSObject.Properties["mergedAt"] -and -not [string]::IsNullOrWhiteSpace([string]$pr.mergedAt)) { $contextHash.mergedAt = [string]$pr.mergedAt }
    $contextHash.phase = if ([string]$pr.status -eq "merged") { "merged" } else { "pr-opened" }
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    # Queue statuses stay in the small state machine vocabulary.  "prepared"
    # and "pr-opened" describe phases, so they are recorded as running until
    # the terminal succeeded transition below.
    $queuePrStatus = if ([string]$pr.status -in @("merged", "succeeded", "failed", "cancelled", "expired", "recoverable")) { [string]$pr.status } else { "running" }
    Set-GateQueueStage -Stage $contextHash.phase -Status $queuePrStatus

    # Preparation is deliberately resumable.  A dry run creates an immutable
    # commit/package/context and reserves the version, but it must not consume
    # the operation as terminal success: the same operationId must still be
    # able to push/merge its PR later.  Release the queue lease by returning the
    # ticket to queued (FIFO remains blocked until this operation resumes).
    if (-not $Publish) {
        if ($null -ne $queueHeartbeat -and (Get-Command Stop-ReleaseQueueLeaseHeartbeat -ErrorAction SilentlyContinue)) {
            Stop-ReleaseQueueLeaseHeartbeat -Heartbeat $queueHeartbeat
            $queueHeartbeat = $null
        }
        $contextHash.status = "prepared"
        $contextHash.phase = "prepared"
        if ($contextHash.Contains("terminalStatus")) { $contextHash.Remove("terminalStatus") }
        if ($contextHash.Contains("completedAt")) { $contextHash.Remove("completedAt") }
        $contextHash.recovery = [ordered]@{ resumable = $true; lastFailureStage = "" }
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
        Set-GateQueueStage -Stage "prepared" -Status "queued"
        $preparedExtra = @{ releaseCommit = $finalCommit; treeSha = $finalTree; contextPath = $contextPath; artifactPath = $artifactPath }
        Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status "prepared" -Extra $preparedExtra
        $preparedRecordPath = Join-Path ([string]$policy.recordRoot) "release-v$target-$finalCommit.json"
        $preparedRecord = [ordered]@{
            schemaVersion = 2; operationId = $operationId; status = "prepared"; terminalStatus = "pending"; version = $target
            baseHead = $baseHead; sourceCommit = $sourceCommit; releaseCommit = $finalCommit; treeSha = $finalTree
            sourceSha256 = $preSha; packageSha256 = $packageSha; packagePath = $artifactPath; contextPath = $contextPath
            changedFiles = @($allowed); generatedAt = [DateTimeOffset]::UtcNow.ToString("o"); releaseBranch = $pr.branch; pullRequest = $pr.pr
            phase = "prepared"
        }
        Write-ReleaseGateJsonAtomic -Path $preparedRecordPath -Value $preparedRecord
        $completed = $true
        Write-GateHost "done" "准备完成；版本已保留，未推送。需要发布时用 -ResumeOperation $operationId -Publish，继续使用同一 context。"
        Write-Host "Context: $contextPath"
        Write-Host "Artifact: $artifactPath"
        return
    }

    if ($Publish -and [string]$pr.status -ne "merged") {
        throw "PR 尚未合并，已保留 context 供 -ResumeOperation 继续；禁止提前部署 CloudBase 或生成最终二维码。"
    }

    if ($DeployCloud) {
        $env:RELEASE_GATE_CONTEXT = $contextPath
        $deployScript = Join-Path $releaseWorktree "scripts/deploy-and-verify-api.ps1"
        if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) {
            throw "缺少统一 CloudBase 部署入口：$deployScript"
        }
        Write-GateHost "cloud" "PR 已合并，使用同一 release context 部署 CloudBase：$contextPath"
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $deployScript `
            -ProjectPath $releaseWorktree `
            -ReleaseContext $contextPath `
            -ReleaseGateLockHeld `
            -ReleaseGateLockToken ([string]$lockHandle.Owner.handoffToken) `
            -DeployLockPath ([string]$policy.lockPath) `
            -DeployTransport "auto" `
            -LockWaitSeconds $LockWaitSeconds
        if ($LASTEXITCODE -ne 0) {
            throw "CloudBase 部署或核验失败；保留原 release context，不重新占用版本。"
        }
        $contextHash.phase = "deployed"
        $contextHash.cloudReceipt = [ordered]@{
            schemaVersion = 1
            operationId = $operationId
            version = $target
            releaseCommit = $finalCommit
            treeSha = $finalTree
            sourceSha256 = $preSha
            packageSha256 = $packageSha
            mainCommit = if ($contextHash.Contains("mainCommit")) { [string]$contextHash.mainCommit } else { "" }
            idempotencyKey = "cloud:$operationId`:$finalCommit`:$finalTree"
            onlineBuildVersion = $target
            onlineBuildMarker = if ($contextHash.Contains("apiBuildMarker")) { [string]$contextHash.apiBuildMarker } else { "" }
            verifiedAt = [DateTimeOffset]::UtcNow.ToString("o")
            status = "verified"
        }
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
        Set-GateQueueStage -Stage "deployed" -Status "running"
    }

    $hasFinalPreview = $false
    if ($contextHash.Contains("previewQrPath") -and $contextHash.Contains("previewInfoPath") -and
        (Test-Path -LiteralPath ([string]$contextHash.previewQrPath) -PathType Leaf) -and
        (Test-Path -LiteralPath ([string]$contextHash.previewInfoPath) -PathType Leaf)) {
        try {
            $previewReceipt = Get-Content -LiteralPath ([string]$contextHash.previewInfoPath) -Raw -Encoding UTF8 | ConvertFrom-Json
            $receiptMain = if ($previewReceipt.PSObject.Properties["mainCommit"]) { [string]$previewReceipt.mainCommit } else { "" }
            $expectedMain = if ($contextHash.Contains("mainCommit")) { [string]$contextHash.mainCommit } else { "" }
            $hasFinalPreview = -not [string]::IsNullOrWhiteSpace($receiptMain) -and
                -not [string]::IsNullOrWhiteSpace($expectedMain) -and
                [string]::Equals($receiptMain, $expectedMain, [StringComparison]::OrdinalIgnoreCase) -and
                [string]$previewReceipt.appVersion -eq $target -and
                [string]$previewReceipt.gitCommit -eq $finalCommit -and
                [string]$previewReceipt.treeSha -eq $finalTree -and
                [string]$previewReceipt.sourceSha256 -eq $preSha
        }
        catch { $hasFinalPreview = $false }
    }
    if ($Preview -and $Publish -and -not $hasFinalPreview) {
        # Generate the final QR only after the PR/main commit is confirmed.
        if ([string]::IsNullOrWhiteSpace($PreviewCliPath)) { $PreviewCliPath = $env:WECHAT_DEVTOOLS_CLI }
        if ([string]::IsNullOrWhiteSpace($PreviewCliPath) -or -not (Test-Path -LiteralPath $PreviewCliPath -PathType Leaf)) {
            throw "已要求生成最终预览码，但找不到微信开发者工具 CLI。"
        }
        $qrPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-qr.png"
        $infoPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-info.json"
        $infoHash = [ordered]@{ schemaVersion = 1; operationId = $operationId; appVersion = $target; gitCommit = $finalCommit; treeSha = $finalTree; sourceSha256 = $preSha; artifactPath = $artifactPath; mainCommit = if ($contextHash.Contains("mainCommit")) { [string]$contextHash.mainCommit } else { "" } }
        if (Test-Path -LiteralPath $qrPath -PathType Leaf) {
            $existingQrSha = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if (-not (Test-Path -LiteralPath $infoPath -PathType Leaf)) { throw "已有二维码但缺少 info，拒绝复用或覆盖：$qrPath" }
            $existingInfo = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$existingInfo.qrSha256 -ne $existingQrSha) { throw "已有二维码 SHA 与 info 不一致，拒绝覆盖：$qrPath" }
            foreach ($key in @("operationId", "appVersion", "gitCommit", "treeSha", "sourceSha256", "artifactPath", "mainCommit")) {
                if ([string]$existingInfo.$key -ne [string]$infoHash[$key]) { throw "已有二维码 info 与当前发布不一致，拒绝覆盖：$infoPath" }
            }
        }
        else {
            $tempQrPath = "$qrPath.$PID.$([guid]::NewGuid().ToString('N')).tmp.png"
            try {
                $previewOutput = & $PreviewCliPath -c $PreviewClientName create_preview_qrcode --project $releaseWorktree --qr-format image --qr-output $tempQrPath 2>&1
                if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempQrPath -PathType Leaf)) { throw "最终预览码生成失败；保留原 release context。" }
                if ((Get-Item -LiteralPath $tempQrPath).Length -le 0) { throw "最终预览码为空；保留原 release context。" }
                Move-Item -LiteralPath $tempQrPath -Destination $qrPath
            }
            finally {
                if (Test-Path -LiteralPath $tempQrPath -PathType Leaf) { Remove-Item -LiteralPath $tempQrPath -Force -ErrorAction SilentlyContinue }
            }
            $infoHash.qrSha256 = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
            Write-ReleaseGateJsonAtomic -Path $infoPath -Value $infoHash
        }
        $contextHash.previewQrPath = $qrPath; $contextHash.previewInfoPath = $infoPath; $contextHash.phase = "previewed"
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
        Set-GateQueueStage -Stage "previewed" -Status "running"
    }
    # Finalization is a small two-phase commit across context, reservation,
    # record and queue.  Persist a non-terminal barrier first; queue=succeeded
    # is written last so a crash cannot leave a successful queue ticket with a
    # missing artifact/record.  If the last queue write fails, catch marks all
    # four views recoverable and the same context can be resumed.
    $contextHash.status = "finalizing"
    if ($contextHash.Contains("terminalStatus")) { $contextHash.Remove("terminalStatus") }
    if ($contextHash.Contains("completedAt")) { $contextHash.Remove("completedAt") }
    $contextHash.finalization = [ordered]@{ state = "pending"; startedAt = [DateTimeOffset]::UtcNow.ToString("o") }
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    Set-GateQueueStage -Stage "finalizing" -Status "running"

    $reservationExtra = @{ releaseCommit = $finalCommit; treeSha = $finalTree; contextPath = $contextPath; artifactPath = $artifactPath }
    if ($contextHash.Contains("mainCommit")) { $reservationExtra.mainCommit = [string]$contextHash.mainCommit }
    if ($contextHash.Contains("mergedAt")) { $reservationExtra.mergedAt = [string]$contextHash.mergedAt }
    Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status "finalizing" -Extra $reservationExtra

    $recordPath = Join-Path ([string]$policy.recordRoot) "release-v$target-$finalCommit.json"
    $record = [ordered]@{
        schemaVersion = 2; operationId = $operationId; status = "finalizing"; terminalStatus = "pending"; version = $target
        baseHead = $baseHead; sourceCommit = $sourceCommit; releaseCommit = $finalCommit; treeSha = $finalTree
        sourceSha256 = $preSha; packageSha256 = $packageSha; packagePath = $artifactPath; contextPath = $contextPath
        changedFiles = @($allowed); generatedAt = [DateTimeOffset]::UtcNow.ToString("o"); releaseBranch = $pr.branch; pullRequest = $pr.pr
    }
    if ($contextHash.Contains("mainCommit")) { $record.mainCommit = [string]$contextHash.mainCommit }
    if ($contextHash.Contains("mergedAt")) { $record.mergedAt = [string]$contextHash.mergedAt }
    $record.phase = [string]$contextHash.phase
    if ($contextHash.Contains("cloudReceipt")) { $record.cloudReceipt = $contextHash.cloudReceipt }
    Write-ReleaseGateJsonAtomic -Path $recordPath -Value $record

    $contextHash.status = "succeeded"
    $contextHash.terminalStatus = "succeeded"
    $contextHash.completedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $contextHash.finalization = [ordered]@{ state = "committed"; completedAt = $contextHash.completedAt }
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status "succeeded" -Extra $reservationExtra
    $record.status = $contextHash.status
    $record.terminalStatus = "succeeded"
    $record.generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    Write-ReleaseGateJsonAtomic -Path $recordPath -Value $record

    # This is the sole terminal queue transition, deliberately last.
    Set-GateQueueStage -Stage "succeeded" -Status "succeeded"
    $terminalQueue = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $operationId -WaitSeconds $LockWaitSeconds -PollMilliseconds ([int]$policy.queue.pollMilliseconds)
    if ($null -eq $terminalQueue -or [string]$terminalQueue.status -ne "succeeded") {
        throw "发布队列未确认 succeeded，保留原 context 供恢复。"
    }
    $completed = $true
    $doneMessage = if (-not $Publish) { "准备完成；默认未推送。需要发布时显式加 -Publish。" } elseif ([string]$pr.status -eq "merged") { "发布完成，PR 已合并：$($pr.pr)" } else { "发布分支和 PR 已创建，等待 GitHub 必需检查：$($pr.pr)" }
    Write-GateHost "done" $doneMessage
    Write-Host "Context: $contextPath"
    Write-Host "Artifact: $artifactPath"
}
catch {
    $message = $_.Exception.Message
    try { Write-ReleaseOperationLog -Path $logPath -Stage "failed" -Message $message -OperationId $operationId }
    catch { Write-Host "失败日志写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }

    # Check the queue before attempting recovery.  The terminal queue write is
    # intentionally last; if it already succeeded (for example, a process was
    # interrupted while printing the final message), never downgrade it to a
    # failed state.  Instead retry the durable sidecars below.
    $queueSucceeded = $false
    try {
        $observedTicket = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $operationId -WaitSeconds $LockWaitSeconds -PollMilliseconds ([int]$policy.queue.pollMilliseconds)
        $queueSucceeded = $null -ne $observedTicket -and [string]$observedTicket.status -eq "succeeded"
    }
    catch { }

    if ($queueSucceeded) {
        # Queue success is authoritative for a completed operation.  Sidecar
        # writes are retried idempotently so a transient disk error cannot
        # strand a successful ticket without reservation/record evidence.
        $repairPhase = ""
        $repairAllowed = $false
        if (-not [string]::IsNullOrWhiteSpace($contextPath) -and (Test-Path -LiteralPath $contextPath -PathType Leaf)) {
            try {
                $repairContext = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $repairPhase = if ($repairContext.PSObject.Properties["phase"]) { [string]$repairContext.phase } else { "" }
                $repairAllowed = $repairPhase -in @("merged", "deployed", "previewed") -and (Test-Path -LiteralPath ([string]$repairContext.artifactPath) -PathType Leaf)
            }
            catch { $repairAllowed = $false }
        }
        if ($repairAllowed -and $null -ne $reservation) {
            try {
                $extra = @{ releaseCommit = $finalCommit; treeSha = $finalTree; contextPath = $contextPath; artifactPath = $artifactPath }
                Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status "succeeded" -Extra $extra
            }
            catch { Write-Host "成功 reservation 补写失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        }
        elseif (-not $repairAllowed) {
            Write-Host "队列已是 succeeded，但 context 阶段/产物未达到可修复条件；保持现场供人工审计。" -ForegroundColor Yellow
        }
    }
    else {
        $failedStatus = if ($failureAfterCommit) { "recoverable" } else { "failed" }
        $failureStatus = $failedStatus
        if ($null -ne $reservation) {
            try {
                $extra = @{}
                if ($failureAfterCommit) { $extra.releaseCommit = $finalCommit; if ($contextPath) { $extra.contextPath = $contextPath } }
                if ($failureAfterCommit) {
                    Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status "recoverable" -Extra $extra
                }
                else {
                    Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status "failed" -Extra $extra
                }
            }
            catch { Write-Host "reservation 状态写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        }

        # A post-commit failure must leave the context explicitly resumable;
        # otherwise resume-release sees a stale prepared/succeeded document and
        # cannot tell whether it is safe to retry.
        if ($failureAfterCommit -and -not [string]::IsNullOrWhiteSpace($contextPath) -and (Test-Path -LiteralPath $contextPath -PathType Leaf)) {
            try {
                $savedContext = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $contextHash = [ordered]@{}
                foreach ($property in $savedContext.PSObject.Properties) { $contextHash[$property.Name] = $property.Value }
                $contextHash.status = "recoverable"
                if ($contextHash.Contains("terminalStatus")) { $contextHash.Remove("terminalStatus") }
                if ($contextHash.Contains("completedAt")) { $contextHash.Remove("completedAt") }
                $recovery = [ordered]@{ resumable = $true; lastFailureStage = $message }
                if ($contextHash.Contains("recovery") -and $null -ne $contextHash.recovery) {
                    foreach ($property in $contextHash.recovery.PSObject.Properties) { $recovery[$property.Name] = $property.Value }
                    $recovery.resumable = $true; $recovery.lastFailureStage = $message
                }
                $contextHash.recovery = $recovery
                $contextHash.lastError = $message
                Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
            }
            catch { Write-Host "release context 恢复标记写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        }
        if ($failureAfterCommit -and -not [string]::IsNullOrWhiteSpace($recordPath) -and (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
            try {
                $savedRecord = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $recordHash = [ordered]@{}
                foreach ($property in $savedRecord.PSObject.Properties) { $recordHash[$property.Name] = $property.Value }
                $recordHash.status = "recoverable"; $recordHash.terminalStatus = "pending"; $recordHash.lastError = $message
                Write-ReleaseGateJsonAtomic -Path $recordPath -Value $recordHash
            }
            catch { Write-Host "release record 恢复标记写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        }
        if (Get-Command Set-ReleaseQueuePhase -ErrorAction SilentlyContinue) {
            try {
                Set-ReleaseQueuePhase -QueueRoot $queueRoot -OperationId $operationId -Phase "failed" -Status $failureStatus -Version $target -BaseHead $baseHead -ErrorMessage $message -ContextPath $contextPath -ReservationPath $(if ($null -ne $reservation) { [string]$reservation.Path } else { "" }) -Lease $queueLease | Out-Null
            }
            catch { Write-Host "发布队列状态写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
        }
    }
    Write-Host "发布闸门失败：$message" -ForegroundColor Red
    throw
}
finally {
    if (-not $KeepWorktree -and -not [string]::IsNullOrWhiteSpace($releaseWorktree) -and ($completed -or -not $failureAfterCommit)) {
        Remove-ReleaseGateWorktree -CanonicalRepo $canonicalRepo -WorktreePath $releaseWorktree
    }
    if ($null -ne $queueHeartbeat -and (Get-Command Stop-ReleaseQueueLeaseHeartbeat -ErrorAction SilentlyContinue)) { Stop-ReleaseQueueLeaseHeartbeat -Heartbeat $queueHeartbeat }
    if ($null -ne $lockHandle) { Exit-ReleaseLock -LockHandle $lockHandle }
}
