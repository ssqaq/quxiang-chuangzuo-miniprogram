param(
    [string]$SourcePath = "",

    [object[]]$IncludePath = @(),

    [string]$TargetVersion = "",

    [string]$PolicyPath = "",

    [ValidateRange(1, 7200)]
    [int]$LockWaitSeconds = 1800,

    # A normal release is automatic: publish the protected release branch/PR
    # and sync the merged source to WeChat DevTools.  Use -PrepareOnly when a
    # local immutable package/context is needed without remote side effects.
    [switch]$Publish,

    [switch]$PrepareOnly,

    [switch]$Preview,

    [switch]$SkipDevTools,

    [string]$PreviewCliPath = "",

    [string]$PreviewClientName = "default",

    [switch]$DeployCloud,

    [switch]$ResumePendingDeploy,

    [switch]$KeepWorktree,

    # 仅在明确指定时允许本次发布越过队列中等待恢复的 prepared 票据。
    # 默认仍严格按 FIFO，避免普通发布误碰其他操作。
    [switch]$AllowOutOfOrder,

    # 当前工作区可能暂存一份尚未配齐依赖的发布工作流；显式使用时，
    # 让发布工作树保留 origin/main 的已验证工作流，避免把别的票据带入本次发布。
    [switch]$UseBaseWorkflow,

    # 让已经在隔离来源树中成套验证过的发布工具一起进入发布树，避免
    # 用脏的 canonical 工具覆盖来源树里的配对校验器和工作流。
    [switch]$UseSourceTooling,

    [string]$ResumeOperation = "",
    [string]$OperationId = "",
    [switch]$Status,
    [ValidateSet("Https", "Ssh443")][string]$GitTransport = "Https",
    [string]$SshKeyPath = ""
)

$ErrorActionPreference = "Stop"
# 隐藏/分离 PowerShell 进程可能沿用系统代码页，Git 返回中文路径时会
# 被错误解码成乱码并导致根目录比较失败。发布器统一要求原生命令使用 UTF-8。
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
}
catch { }
$scriptRoot = $PSScriptRoot
. (Join-Path $scriptRoot "release-gate.ps1")
. (Join-Path $scriptRoot "release-lock.ps1")
. (Join-Path $scriptRoot "release-version.ps1")
Set-ReleaseGitTransport -Transport $GitTransport -SshKeyPath $SshKeyPath
$queueScript = Join-Path $scriptRoot "release-queue.ps1"
if (-not (Test-Path -LiteralPath $queueScript -PathType Leaf)) { throw "缺少发布队列工具：$queueScript" }
# Dot-source at script scope.  Loading it inside an `if {}` block creates a
# child scope in PowerShell; callbacks inside the queue would then lose their
# helper functions (for example Get-ReleaseQueueTicketIndex).
. $queueScript

if ($Publish.IsPresent -and $PrepareOnly.IsPresent) { throw "-Publish 与 -PrepareOnly 不能同时使用。" }
if ($Preview.IsPresent -and $SkipDevTools.IsPresent) { throw "-Preview 与 -SkipDevTools 不能同时使用。" }
$effectivePublish = [bool]($Publish.IsPresent -or -not $PrepareOnly.IsPresent)
$effectivePreview = [bool]($Preview.IsPresent -or ($effectivePublish -and -not $SkipDevTools.IsPresent))

$canonicalGuess = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$policy = Get-ReleaseGatePolicy -PolicyPath $PolicyPath -RepositoryRoot $canonicalGuess
Assert-ReleaseCanonicalPolicy -Policy $policy -RepositoryRoot $canonicalGuess | Out-Null
if (-not (Test-ReleasePathEqual -Left $canonicalGuess -Right ([string]$policy.canonicalRepo))) {
    throw "旧 clone/worktree 不允许直接调用发布入口，请从 canonical 仓库执行：$([string]$policy.canonicalRepo)"
}
$canonicalRepo = ConvertTo-ReleaseFullPath -Path ([string]$policy.canonicalRepo)
    $canonicalVersionConflict = Get-CanonicalVersionConflict -RepositoryPath $canonicalRepo
if ($canonicalVersionConflict.conflict) {
    Write-Host "[canonical] CANONICAL_VERSION_CONFLICT：仅记录冲突，不修改 canonical；继续使用干净 release worktree。"
}
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
        -GitTransport $GitTransport `
        -SshKeyPath $SshKeyPath `
        -PolicyPath ([string]$policy.policyPath) `
        -Publish:$effectivePublish `
        -Preview:$effectivePreview `
        -PreviewCliPath $PreviewCliPath `
        -PreviewClientName $PreviewClientName `
        -DeployCloud:$DeployCloud `
        -ResumePendingDeploy:$ResumePendingDeploy `
        -LockWaitSeconds $LockWaitSeconds `
        -KeepWorktree:$KeepWorktree `
        -AllowOutOfOrder:$AllowOutOfOrder `
        -AllowPrepared:$AllowOutOfOrder
    exit $LASTEXITCODE
}

# Publish must never start while an old owner still points at a non-terminal
# operation.  This is a read-only preflight; Enter-ReleaseLock remains the
# final race-safe arbiter immediately before the critical section.
if ($effectivePublish) {
    $lockHealthStaleAfter = if ($policy.queue.PSObject.Properties["staleAfterSeconds"]) { [int]$policy.queue.staleAfterSeconds } else { 600 }
    $lockHealth = Assert-ReleasePublishLockHealth -Policy $policy -StaleAfterSeconds $lockHealthStaleAfter
    Write-Host "[lock-health] 发布前锁健康检查通过：$($lockHealth.reason)。"
}

if ([string]::IsNullOrWhiteSpace($SourcePath)) { throw "普通发布必须提供 -SourcePath。" }
if ($null -eq $IncludePath -or @($IncludePath).Count -eq 0) { throw "普通发布必须显式提供 -IncludePath。" }
$includePaths = @(Normalize-ReleaseIncludePaths -InputPath $IncludePath)
if ($effectivePreview) {
    $PreviewCliPath = Resolve-ReleaseDevToolsCli -CliPath $PreviewCliPath
}
# Check the remote guard before creating a queue lease or reserving a version.
# A known GitHub-plan/API failure must not burn an attempt or leave a new
# ticket blocking FIFO.  The later PR call repeats the check under the lock to
# close the time-of-check/time-of-use window.
if ($effectivePublish -and [bool]$policy.mainProtection.enforceOnPublish) {
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
$reportPath = ""
$backupPath = ""
$finalCommit = ""
$target = ""
$baseHead = ""
$failureAfterCommit = $false
$completed = $false
$queueTicket = $null
$queueLease = $null
$queueHeartbeat = $null
$previewSourceBudget = $null
$baseToolSnapshot = $null
$missingToolPaths = @()
$queueLeaseSeconds = if ($policy.queue -and $policy.queue.PSObject.Properties["leaseSeconds"]) { [int]$policy.queue.leaseSeconds } else { 180 }
$releaseToolPaths = @(
    "scripts/release-gate.ps1",
    "scripts/release.ps1",
    "scripts/package-release.py",
    "scripts/package-release-smoke.py",
    "scripts/release-lock.ps1",
    "scripts/release-lock-smoke.js",
    "scripts/release-lock-health-smoke.js",
    "scripts/user-center-version-smoke.js",
    "scripts/release-version.ps1",
    "scripts/release-safety-smoke.js",
    "scripts/version-concurrency-smoke.js",
    "scripts/release-gate-smoke.js",
    "scripts/deploy-and-verify-api.ps1",
    "scripts/deploy-payment-production.ps1",
    "scripts/payment-production-deploy-smoke.js",
    "scripts/npm-dependency-cache.ps1",
    "scripts/npm-dependency-cache-smoke.js",
    "scripts/cloud-deploy-safety.ps1",
    "scripts/cloud-deploy-safety-smoke.js",
    "scripts/deployment-script-smoke.js",
    "scripts/deploy-api-cloudbase-cli.ps1",
    "scripts/refresh-preview.ps1",
    "scripts/check-devtools.ps1",
    "scripts/configure-github-protection.ps1",
    "scripts/release-queue.ps1",
    "scripts/release-queue-smoke.js",
    "scripts/resume-release.ps1",
    "scripts/resume-release-smoke.js",
    "scripts/release-status.ps1",
    "scripts/release-status.html",
    "scripts/check-cloudbase-env.ps1",
    "scripts/check-utf8.js",
    "scripts/release-report.ps1",
    "scripts/release-report-smoke.js",
    "scripts/qr-decode.js",
    "scripts/qr-decode-smoke.js",
    "scripts/vendor/qrcode-reader.js",
    "scripts/admin-v2-pixel-regression.js",
    "scripts/admin-v2-pixel-regression-smoke.js",
    "scripts/admin-v2-pixel-baseline.js",
    "scripts/admin-v2-pixel-baseline-smoke.js",
    "scripts/admin-v2-pixel-diff-report.js",
    "scripts/admin-v2-pixel-diff-report-smoke.js",
    "scripts/admin-v2-same-device-baseline.js",
    "scripts/admin-v2-same-device-baseline-smoke.js",
    "scripts/admin-v2-layout-contract.js",
    "scripts/admin-v2-layout-contract-smoke.js",
    "scripts/admin-v2-font-contract.js",
    "scripts/admin-v2-font-contract-smoke.js",
    "scripts/admin-v2-visual-archive.js",
    "scripts/admin-v2-visual-archive-smoke.js",
    "scripts/admin-v2-release-evidence-check.js",
    "scripts/admin-v2-release-evidence-check-smoke.js",
    "scripts/admin-provider-interaction-regression.js",
    "scripts/admin-provider-interaction-regression-smoke.js",
    "scripts/admin-v2-runtime-geometry-probe.js",
    "scripts/admin-v2-runtime-geometry-probe-smoke.js",
    "scripts/admin-v2-runtime-font-probe.js",
    "scripts/admin-v2-runtime-font-probe-smoke.js",
    "scripts/admin-v2-post-release-visual-check.js",
    "scripts/admin-v2-post-release-visual-check-smoke.js",
    "scripts/admin-v2-state-matrix.js",
    "scripts/admin-v2-state-matrix-smoke.js",
    "scripts/admin-v2-device-matrix.js",
    "scripts/admin-v2-device-matrix-smoke.js",
    "scripts/admin-v2-visual-capture-gate.js",
    "scripts/admin-v2-visual-capture-gate-smoke.js",
    "scripts/admin-v2-visual-runner.js",
    "scripts/admin-v2-visual-runner.ps1",
    "scripts/admin-v2-visual-runner-smoke.js",
    "scripts/admin-v2-devtools-cli-capture.js",
    "scripts/admin-v2-devtools-cli-capture-smoke.js",
    "scripts/admin-v2-visual-sensitive-data.js",
    "scripts/admin-v2-visual-sensitive-data-smoke.js",
    "scripts/ensure-devtools-9437.ps1",
    "scripts/ensure-devtools-9437-smoke.js",
    "scripts/admin-v2-visual-index.js",
    "scripts/admin-v2-visual-index-smoke.js",
    "scripts/admin-v2-preview-entry.js",
    "scripts/admin-v2-preview-entry-smoke.js",
    "scripts/preview-source-budget.js",
    "scripts/preview-source-budget-smoke.js",
    "scripts/admin-v2-visual-capture.js",
    "scripts/admin-provider-chinese-regression-smoke.js",
    "scripts/devtools-9437-watch.ps1",
    "scripts/devtools-9437-watch-smoke.js",
    "scripts/cloudbase-health-smoke.js",
    "scripts/admin-preview-fixtures-smoke.js",
    "scripts/admin-preview-pages-runtime-smoke.js",
    "scripts/release-maintenance.ps1",
    "scripts/release-maintenance-smoke.js",
    "scripts/rollback-release.ps1",
    "scripts/rollback-release-smoke.js",
    "scripts/release-hooks-smoke.js",
    "scripts/install-git-hooks.ps1",
    "scripts/install-git-hooks.cmd",
    "scripts/write-release-record.ps1",
    "scripts/release-workflow-smoke.js",
    "scripts/sync-to-github.ps1",
    "一键刷新预览.cmd",
    ".github/workflows/release-gate.yml",
    ".github/workflows/admin-visual-cleanup.yml",
    "visual-evidence/admin-v2-same-device-manifest.json",
    "visual-evidence/admin-v2-pixel-manifest-current.json",
    "visual-evidence/admin-v2-release-evidence-manifest.json",
    "visual-evidence/admin-v2-state-matrix.json",
    "visual-evidence/admin-v2-device-matrix.json",
    "visual-evidence/provider-tc3-regression.json",
    "visual-evidence/admin-v2-preview-entry.json",
    "visual-evidence/admin-v2-preview-entry.html",
    # These reports are regenerated by the release preflight itself.  Keep
    # them in the immutable release commit so the post-commit worktree stays
    # clean and a later resume can verify the exact evidence snapshot.
    "visual-evidence/layout-contract.json",
    "visual-evidence/font-contract.json",
    "visual-evidence/runtime-geometry/geometry-contract.json",
    ".github/workflows/admin-visual-capture.yml",
    ".github/workflows/admin-visual-cleanup.yml",
    ".githooks/pre-commit",
    ".githooks/post-commit",
    ".githooks/pre-push",
    ".githooks/post-checkout",
    "docs/superpowers/specs/2026-08-28-release-gate-design.md"
)

if ($UseBaseWorkflow) {
    # The workflow smoke is coupled to the workflow text.  Keep both files
    # from origin/main when the source workspace has an unpaired newer copy.
    $releaseToolPaths = @($releaseToolPaths | Where-Object {
            $_ -ne ".github/workflows/release-gate.yml" -and
            $_ -ne "scripts/release-workflow-smoke.js"
        })
}

function Write-GateHost {
    param([string]$Stage, [string]$Message)
    Write-Host "[$Stage] $Message"
    Write-ReleaseOperationLog -Path $logPath -Stage $Stage -Message $Message -OperationId $operationId
}

function Assert-GatePaymentDeploymentReceipt {
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
        $expectedProperty = $Context.PSObject.Properties[$field]
        if ($null -eq $expectedProperty -or
            [string]::IsNullOrWhiteSpace([string]$expectedProperty.Value) -or
            -not [string]::Equals([string]$Receipt.$field, [string]$expectedProperty.Value, [StringComparison]::OrdinalIgnoreCase)) {
            throw "支付生产部署回执 $field 与 release context 不一致。"
        }
    }
    $expectedEnvironment = ""
    if ($Context.PSObject.Properties["cloudbaseEnvironment"] -and $null -ne $Context.cloudbaseEnvironment) {
        $environmentProperty = $Context.cloudbaseEnvironment.PSObject.Properties["environmentId"]
        if ($null -ne $environmentProperty) { $expectedEnvironment = [string]$environmentProperty.Value }
    }
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

function Set-GateQueueStage {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [string]$Status = ""
    )
    if ($null -ne $lockHandle) {
        $ownerVersion = if (-not [string]::IsNullOrWhiteSpace([string]$target)) { [string]$target } elseif (-not [string]::IsNullOrWhiteSpace([string]$TargetVersion)) { [string]$TargetVersion } else { "auto" }
        Update-ReleaseLockOwner -LockHandle $lockHandle -TargetVersion $ownerVersion -Stage $Stage
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

function Test-ReleaseGitBlobAtRevision {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Revision,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )
    $spec = "$Revision`:$RelativePath"
    $typeOutput = & git -C $RepositoryRoot cat-file -t $spec 2>$null
    $exitCode = $LASTEXITCODE
    $type = ($typeOutput -join "`n").Trim()
    return ($exitCode -eq 0 -and $type -eq "blob")
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

function Invoke-GateDependencyPreflight {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)
    $checker = Join-Path $SourceRoot "scripts/check-cloudfunction-dependencies.js"
    $apiRoot = Join-Path $SourceRoot "cloudfunctions/api"
    if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
        Write-GateHost "preflight" "来源未带依赖检查脚本，已用 package/package-lock 结构检查代替。"
        if (-not (Test-Path -LiteralPath (Join-Path $apiRoot "package.json") -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $apiRoot "package-lock.json") -PathType Leaf)) { throw "来源缺少 API 依赖清单。" }
        return
    }
    # node_modules intentionally never enters a release snapshot.  有依赖缓存
    # 时做完整 require 检查；没有缓存时至少解析源码和 JSON，不能因发布
    # 包排除了 node_modules 而把预检变成必然失败。
    $nodeModules = Join-Path $apiRoot "node_modules"
    if (Test-Path -LiteralPath $nodeModules -PathType Container) {
        $output = & node $checker --api-root $apiRoot 2>&1
        if ($LASTEXITCODE -ne 0) { throw "云函数依赖预检失败：$($output -join "`n")" }
        Write-GateHost "preflight" "云函数依赖完整检查通过。"
    }
    else {
        # npm lockfile 可能合法地使用空字符串作为 packages 的根键；
        # PowerShell ConvertFrom-Json 在遇到该键时会拒绝解析，改用 Node
        # 原生 JSON.parse 做纯语法校验，避免把有效 lockfile 误判为坏包。
        foreach ($jsonPath in @(
                (Join-Path $apiRoot "package.json"),
                (Join-Path $apiRoot "package-lock.json")
            )) {
            $parseOutput = & node -e "const fs=require('fs'); JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));" -- $jsonPath 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "云函数 JSON 预检失败：$jsonPath`n$($parseOutput -join "`n")"
            }
        }
        $syntax = & node --check (Join-Path $apiRoot "index.js") 2>&1
        if ($LASTEXITCODE -ne 0) { throw "云函数 index.js 语法预检失败：$($syntax -join "`n")" }
        Write-GateHost "preflight" "未发现 node_modules，已完成 JSON/语法预检；CI 或部署阶段再做完整依赖检查。"
    }
}

function Invoke-GatePreviewSourceBudget {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $checker = Join-Path $ProjectRoot "scripts/preview-source-budget.js"
    if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
        throw "来源缺少预览源码预算脚本：$checker"
    }
    # 预算按微信开发者工具的裸源码字节口径；压缩值只在 JSON 中作为诊断。
    # 2 MiB 是硬上限，超限在二维码前失败。
    $output = @(& node $checker --project-root $ProjectRoot --metric raw --max-bytes 2097152 --warn-bytes 1887436 2>&1)
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "预览源码预算超限或检查失败：$text" }
    try { $result = $text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "预览源码预算没有返回 JSON：$text" }
    if ([string]$result.status -ne "pass" -or -not [bool]$result.ok) {
        throw "预览源码预算未通过：$text"
    }
    $rawBytes = [int64]$result.rawBytes
    $transferBytes = [int64]$result.estimatedTransferBytes
    if ([bool]$result.warning) {
        Write-GateHost "preflight" "预览源码预算通过但已接近上限：裸源码=$rawBytes bytes，压缩诊断=$transferBytes bytes。"
    }
    else {
        Write-GateHost "preflight" "预览源码预算通过：裸源码=$rawBytes bytes，压缩诊断=$transferBytes bytes。"
    }
    return $result
}

function Invoke-GateLayoutContract {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $checker = Join-Path $ProjectRoot "scripts/admin-v2-layout-contract.js"
    if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
        throw "来源缺少布局合同脚本：$checker"
    }
    $reportPath = Join-Path $ProjectRoot "visual-evidence/layout-contract.json"
    $output = @(& node $checker --root $ProjectRoot --output $reportPath 2>&1)
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "布局合同检查失败：$text" }
    try { $result = $text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "布局合同没有返回 JSON：$text" }
    if ([string]$result.status -ne "pass") { throw "布局合同未通过：$text" }
    Write-GateHost "preflight" "四页布局合同通过：$(@($result.pages).Count) 个页面。"
    return $result
}

function Invoke-GateRuntimeGeometryContract {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $checker = Join-Path $ProjectRoot "scripts/admin-v2-runtime-geometry-probe.js"
    $inputPath = Join-Path $ProjectRoot "visual-evidence/runtime-geometry/browser-probe.json"
    $reportPath = Join-Path $ProjectRoot "visual-evidence/runtime-geometry/geometry-contract.json"
    if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
        throw "来源缺少运行时几何合同脚本：$checker"
    }
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
        throw "来源缺少 390x844 运行时几何证据：$inputPath"
    }
    $output = @(& node $checker --root $ProjectRoot --input $inputPath --output $reportPath 2>&1)
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "运行时几何合同检查失败：$text" }
    try { $result = $text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "运行时几何合同没有返回 JSON：$text" }
    if ([string]$result.status -ne "pass" -or -not [bool]$result.ok) {
        throw "运行时几何合同未通过：$text"
    }
    $provider = @($result.pages | Where-Object { [string]$_.name -eq "provider" })[0]
    if (-not $provider -or -not [bool]$provider.blankSpace.pass) {
        throw "供应商空白高度合同未通过：$text"
    }
    $metrics = $provider.blankSpace.metrics
    Write-GateHost "preflight" "供应商空白高度合同通过：说明到按钮=$($metrics.noteToActions)px，按钮到底部=$($metrics.actionsToCardBottom)px，列表到底部=$($metrics.listToDirectoryBottom)px，双栏高度差=$($metrics.columnHeightDelta)px。"
    return $result
}

function Invoke-GateFontContract {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $checker = Join-Path $ProjectRoot "scripts/admin-v2-font-contract.js"
    if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
        throw "来源缺少字体合同脚本：$checker"
    }
    $reportPath = Join-Path $ProjectRoot "visual-evidence/font-contract.json"
    $output = @(& node $checker --root $ProjectRoot --output $reportPath 2>&1)
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "字体合同检查失败：$text" }
    try { $result = $text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "字体合同没有返回 JSON：$text" }
    if ([string]$result.status -ne "pass") { throw "字体合同未通过：$text" }
    Write-GateHost "preflight" "四页字体合同通过：字体档案 $([string]$result.profile)。"
    return $result
}

function Invoke-GateUtf8Preflight {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)
    $checker = Join-Path $SourceRoot "scripts/check-utf8.js"
    if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
        throw "来源缺少 UTF-8 检查脚本：$checker"
    }
    $output = & node $checker $SourceRoot 2>&1
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "UTF-8/乱码预检失败：$text" }
    try { $result = $text | ConvertFrom-Json } catch { throw "UTF-8 检查没有返回 JSON：$text" }
    if ([string]$result.status -ne "succeeded") { throw "UTF-8 检查未通过：$text" }
    Write-GateHost "preflight" "UTF-8 和乱码检查通过，共扫描 $([int]$result.scanned) 个文本文件。"
    return $result
}

function Invoke-GateCloudBasePreflight {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $checker = Join-Path $ProjectRoot "scripts/check-cloudbase-env.ps1"
    if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
        Write-GateHost "preflight" "未找到 CloudBase 环境检查脚本，状态记为 missing。"
        return [pscustomobject]@{ status = "missing"; configured = $false; source = ""; environmentId = ""; appId = ""; projectPath = $ProjectRoot; message = "缺少检查脚本" }
    }
    $output = & pwsh -NoProfile -ExecutionPolicy Bypass -File $checker -ProjectPath $ProjectRoot 2>&1
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "CloudBase 环境检查失败：$text" }
    try { $result = $text | ConvertFrom-Json } catch { throw "CloudBase 环境检查没有返回 JSON：$text" }
    if ([string]$result.status -eq "configured") {
        Write-GateHost "preflight" "CloudBase 环境已配置：$([string]$result.environmentId)。"
    }
    else {
        Write-GateHost "preflight" "CloudBase 环境未配置；本次仍可打包，部署 CloudBase 时会阻止继续。"
    }
    return $result
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
        -Metadata ([ordered]@{ publish = $effectivePublish; preview = $effectivePreview; deployCloud = [bool]$DeployCloud }) `
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
    $archivedReservationCount = Invoke-ReleaseReservationMaintenanceInline -Policy $policy -OlderThanHours 24
    Write-GateHost "reservation-maintenance" "已检查历史 reservation，新增归档 $archivedReservationCount 条；历史版本仍不可复用。"
    $leaseOwner = "release-gate/$PID/$operationId"
    $queueLease = Claim-ReleaseQueueTicket `
        -TicketId ([string]$queueTicket.ticketId) `
        -AllowOutOfOrder:$AllowOutOfOrder `
        -AllowPrepared:$AllowOutOfOrder `
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
    # 默认仍只信任 canonical 工具；canonical 暂时缺失的工具延后到锁定
    # origin/main 后从同一基线工作树继承。显式使用来源工具时仍要求来源树
    # 自身带齐整套工具，避免混用不同发布代的校验器。
    $toolSnapshotRoot = if ($UseSourceTooling) { $sourceRepo.Root } else { $canonicalRepo }
    $canonicalToolSnapshot = Get-ReleaseFileSnapshot -SourceRoot $toolSnapshotRoot -RelativePath $releaseToolPaths
    $toolSnapshot = [ordered]@{}
    foreach ($entry in $canonicalToolSnapshot.GetEnumerator()) {
        if ([bool]$entry.Value.exists) {
            $toolSnapshot[$entry.Key] = $entry.Value
        }
        elseif ($UseSourceTooling) {
            throw "发布工具文件不存在：$($entry.Key)（来源：$toolSnapshotRoot）"
        }
        else {
            $missingToolPaths += [string]$entry.Key
        }
    }
    $sourceCommit = $sourceRepo.Commit
    Set-GateQueueStage -Stage "source" -Status "running"
    Write-GateHost "source" "来源 $($sourceRepo.Root)，提交 $sourceCommit，文件 $($includePaths.Count) 个。"
    Invoke-GateDependencyPreflight -SourceRoot $sourceRepo.Root

    Write-GateHost "fetch" "刷新 origin/$($policy.branch)。"
    Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("fetch", "origin", "refs/heads/$($policy.branch):refs/remotes/origin/$($policy.branch)") | ForEach-Object { Write-Host $_ }
    $baseHead = Get-ReleaseGitValue -WorkingDirectory $canonicalRepo -Arguments @("rev-parse", "origin/$($policy.branch)")
    if (-not $UseSourceTooling -and $missingToolPaths.Count -gt 0) {
        $missingAtBase = @($missingToolPaths | Where-Object {
                -not (Test-ReleaseGitBlobAtRevision -RepositoryRoot $canonicalRepo -Revision $baseHead -RelativePath $_)
            })
        if ($missingAtBase.Count -gt 0) {
            throw "发布工具文件不存在：$($missingAtBase -join '、')（canonical 与锁定基线 $baseHead 均不存在）"
        }
        Write-GateHost "tools" "canonical 缺少 $($missingToolPaths.Count) 个工具，已从锁定基线 $baseHead 继承：$($missingToolPaths -join '、')。"
    }
    $baseVersion = Get-GateVersionFromText -Text (Get-GateConfigTextAt -Repository $canonicalRepo -Revision $baseHead) -Source "${baseHead}:config.js"
    $usedVersions = Get-ReleaseUsedVersions `
        -ReservationRoot ([string]$policy.reservationRoot) `
        -RecordRoot ([string]$policy.recordRoot) `
        -RepositoryRoot $canonicalRepo `
        -QueueRoot $queueRoot `
        -ContextRoot ([string]$policy.contextRoot) `
        -ExcludeOperationId $operationId
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
    Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("worktree", "add", "--detach", $releaseWorktree, $baseHead) | ForEach-Object { Write-Host $_ }
    Write-GateHost "worktree" "隔离发布工作树：$releaseWorktree"
    Set-GateQueueStage -Stage "worktree" -Status "running"
    if (-not $UseSourceTooling -and $missingToolPaths.Count -gt 0) {
        # The worktree is checked out at the exact baseHead above.  Snapshot the
        # inherited files before copying source/canonical snapshots so later
        # stability checks prove that no other tree silently replaced them.
        $baseToolSnapshot = Get-ReleaseFileSnapshot -SourceRoot $releaseWorktree -RelativePath $missingToolPaths
        foreach ($entry in $baseToolSnapshot.GetEnumerator()) {
            if (-not [bool]$entry.Value.exists) {
                throw "锁定基线工作树缺少发布工具：$($entry.Key)（基线：$baseHead）"
            }
        }
    }
    Copy-ReleaseFileSnapshot -TargetRoot $releaseWorktree -Snapshot $sourceSnapshot
    Copy-ReleaseFileSnapshot -TargetRoot $releaseWorktree -Snapshot $toolSnapshot
    $packageToolRoot = if ($UseSourceTooling) { $releaseWorktree } else { $canonicalRepo }
    $versionToolRoot = if ($UseSourceTooling) { $releaseWorktree } else { $canonicalRepo }
    . (Join-Path $versionToolRoot "scripts/release-version.ps1")

    $versionPaths = Get-ReleaseVersionPaths -SourceRoot $releaseWorktree
    foreach ($versionPath in $versionPaths) {
        $versionFile = Join-Path $releaseWorktree ($versionPath.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) { throw "版本组文件不存在：$versionPath" }
        $oldText = Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8
        $newText = Set-VersionText -RelativePath $versionPath -Text $oldText -TargetVersion $target
        [IO.File]::WriteAllText($versionFile, $newText, [Text.UTF8Encoding]::new($false))
    }

    $previewSourceBudget = Invoke-GatePreviewSourceBudget -ProjectRoot $releaseWorktree
    $layoutContract = Invoke-GateLayoutContract -ProjectRoot $releaseWorktree
    $runtimeGeometryContract = Invoke-GateRuntimeGeometryContract -ProjectRoot $releaseWorktree
    $fontContract = Invoke-GateFontContract -ProjectRoot $releaseWorktree
    $utf8Preflight = Invoke-GateUtf8Preflight -SourceRoot $releaseWorktree
    $cloudbasePreflight = Invoke-GateCloudBasePreflight -ProjectRoot $releaseWorktree

    $allowed = New-Object System.Collections.Generic.List[string]
    foreach ($path in $includePaths) { Add-GateUniquePath -List $allowed -Path $path }
    foreach ($path in $releaseToolPaths) { Add-GateUniquePath -List $allowed -Path $path }
    foreach ($path in $versionPaths) { Add-GateUniquePath -List $allowed -Path $path }
    $literal = @($allowed | ForEach-Object { ":(literal)$_" })
    # Source worktrees may inherit a different core.autocrlf setting.  Normalize
    # through Git's index for this command only; never modify shared repo config.
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments (@("-c", "core.autocrlf=true", "add", "--all", "--") + $literal) | ForEach-Object { Write-Host $_ }
    # Git quotes non-ASCII names by default (for example the Chinese one-click
    # preview launcher).  Disable quotePath for this machine-readable list so
    # the whitelist comparison uses the actual repository-relative path.
    $staged = @((Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("-c", "core.quotePath=false", "diff", "--cached", "--name-only")) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($staged.Count -eq 0) { throw "没有可发布的变化；闸门不会创建空提交。" }
    $outside = @($staged | Where-Object { $_ -notin @($allowed) })
    if ($outside.Count -gt 0) { throw "隔离发布工作树出现未授权文件：$($outside -join '；')" }
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--check") | ForEach-Object { Write-Host $_ }
    Write-GateHost "stage" "已暂存 $($staged.Count) 个授权文件。"
    Set-GateQueueStage -Stage "staged" -Status "running"

    # Read-only validation happens before commit.  The package script supplied
    # by the package-hardening change must support this explicit interface.
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--check") | Out-Null
    Invoke-GatePython -ScriptRoot $packageToolRoot -Arguments @("--check-only", "--source-tree", $releaseWorktree) | ForEach-Object { Write-Host $_ }
    Write-GateHost "check" "发布前只读校验通过。"
    Set-GateQueueStage -Stage "checked" -Status "running"
    Assert-ReleaseFileSnapshotStable -SourceRoot $sourceRepo.Root -Snapshot $sourceSnapshot
    Assert-ReleaseFileSnapshotStable -SourceRoot $toolSnapshotRoot -Snapshot $canonicalToolSnapshot
    if ($null -ne $baseToolSnapshot) {
        Assert-ReleaseFileSnapshotStable -SourceRoot $releaseWorktree -Snapshot $baseToolSnapshot
    }

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

    $finalCheck = Invoke-GatePython -ScriptRoot $packageToolRoot -Arguments @("--check-only", "--source-tree", $finalCommit)
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
    $reportPath = Join-Path ([string]$policy.reportRoot) "release-$operationId.json"
    $context = New-ReleaseContext `
        -Path $contextPath `
        -OperationId $operationId `
        -Policy $policy `
        -SourceInputPath ([IO.Path]::GetFullPath($SourcePath)) `
        -SourcePath $releaseWorktree `
        -SourceDirty ([bool]$sourceRepo.Dirty) `
        -SourceSnapshotSha256 (Get-ReleaseSnapshotSha256 -Snapshot $sourceSnapshot) `
        -Version $target `
        -SourceCommit $sourceCommit `
        -ReleaseCommit $finalCommit `
        -TreeSha $finalTree `
        -SourceSha256 $preSha `
        -ArtifactPath $artifactPath `
        -RemoteName "origin" `
        -RemoteUrl ([string]$policy.remote) `
        -AppId (Get-ReleaseProjectConfigAppId -ProjectPath $releaseWorktree) `
        -ExpectedAppId (Get-ReleaseProjectConfigAppId -ProjectPath $releaseWorktree) `
        -BaseHead $baseHead `
        -QueueTicketPath (Join-Path $queueRoot "queue.json") `
        -ReleaseWorktree $releaseWorktree `
        -Phase "prepared" `
        -LogPath $logPath `
        -ReportPath $reportPath
    Assert-ReleaseContextShape -Context $context -Policy $policy | Out-Null
    Write-GateHost "context" "release context 已生成：$contextPath"

    $packageOutput = Invoke-GatePython -ScriptRoot $packageToolRoot -Arguments @("--release-context", $contextPath)
    $packageSummary = Get-GatePackageSummary -Output $packageOutput
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw "打包脚本返回成功但产物不存在：$artifactPath" }
    $artifact = Get-Item -LiteralPath $artifactPath
    if ($artifact.Length -le 0) { throw "发布包为空：$artifactPath" }
    $packageSha = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $contextHash = [ordered]@{}
    foreach ($prop in $context.PSObject.Properties) { $contextHash[$prop.Name] = $prop.Value }
    $contextHash.releaseWorktree = [IO.Path]::GetFullPath($releaseWorktree)
    $contextHash.packageSha256 = $packageSha
    $contextHash.packageSizeBytes = [int64]$artifact.Length
    if ($null -ne $previewSourceBudget) {
        $contextHash["previewSourceBudget"] = [ordered]@{
            schemaVersion = [int]$previewSourceBudget.schemaVersion
            status = [string]$previewSourceBudget.status
            metric = [string]$previewSourceBudget.metric
            maxBytes = [int64]$previewSourceBudget.maxBytes
            warnBytes = [int64]$previewSourceBudget.warnBytes
            measuredBytes = [int64]$previewSourceBudget.measuredBytes
            rawBytes = [int64]$previewSourceBudget.rawBytes
            estimatedTransferBytes = [int64]$previewSourceBudget.estimatedTransferBytes
            fileCount = [int]$previewSourceBudget.fileCount
            largestFiles = @($previewSourceBudget.largestFiles | Select-Object -First 10)
            checkedAt = [string]$previewSourceBudget.checkedAt
        }
    }
    $contextHash.utf8Preflight = $utf8Preflight
    $contextHash.cloudbaseEnvironment = $cloudbasePreflight
    $contextHash.gitTransport = $script:GitTransportState
    $contextHash.canonicalVersionConflict = [bool]$canonicalVersionConflict.conflict
    $contextHash.canonicalConflictFiles = @($canonicalVersionConflict.files)
    $contextHash.canonicalConflictValues = $canonicalVersionConflict.values
    $contextHash.sourceWorktreeClean = -not [bool]$sourceRepo.Dirty
    $contextHash.sourceWorktreeHead = [string]$sourceCommit
    $contextHash.resumeReleaseSha256 = if (Test-Path -LiteralPath (Join-Path $releaseWorktree "scripts/resume-release.ps1") -PathType Leaf) { (Get-FileHash -LiteralPath (Join-Path $releaseWorktree "scripts/resume-release.ps1") -Algorithm SHA256).Hash.ToLowerInvariant() } else { "" }
    $contextHash.includedTooling = @($releaseToolPaths)
    $contextHash.status = "prepared"
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    Write-GateHost "package" "不可变发布包已生成：$artifactPath（$($artifact.Length) bytes，SHA256=$packageSha）。"
    Set-GateQueueStage -Stage "packaged" -Status "running"

    if ($effectivePreview -and -not $effectivePublish) {
        # A preview generated before the PR is merged is evidence for review,
        # not the production receipt.  Keep it under a distinct immutable
        # name so a later resume cannot mistake it for the final QR or
        # overwrite it in place.
        $qrPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-premerge-qr.png"
        $infoPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-premerge-info.json"
        if (-not (Test-Path -LiteralPath $qrPath -PathType Leaf)) {
            $tempQrPath = "$qrPath.$PID.$([guid]::NewGuid().ToString('N')).tmp.png"
            try {
                $previewOutput = & $PreviewCliPath -c $PreviewClientName create_preview_qrcode `
                    --project $releaseWorktree `
                    --qr-format image `
                    --qr-output $tempQrPath 2>&1
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
                catch { $previewSummary = "WechatIDE 已返回，结果 JSON 未解析；继续以退出码和二维码文件校验。" }
                Write-Host $previewSummary
                if ($previewExitCode -ne 0 -or -not (Test-Path -LiteralPath $tempQrPath -PathType Leaf)) { throw "预览码生成失败，未发布到远端。" }
                if ((Get-Item -LiteralPath $tempQrPath).Length -le 0) { throw "预览码为空，未发布到远端。" }
                Write-ReleaseImmutableFile -SourcePath $tempQrPath -DestinationPath $qrPath | Out-Null
            }
            finally {
                if (Test-Path -LiteralPath $tempQrPath -PathType Leaf) { Remove-Item -LiteralPath $tempQrPath -Force -ErrorAction SilentlyContinue }
            }
        }
        elseif ((Get-Item -LiteralPath $qrPath).Length -le 0) { throw "已有预览码为空，拒绝继续。" }
        $info = [pscustomobject]@{}
        if (Test-Path -LiteralPath $infoPath -PathType Leaf) {
            try { $info = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw "已有预览二维码 info 无法解析，拒绝覆盖：$infoPath" }
        }
        $infoHash = [ordered]@{}
        foreach ($prop in $info.PSObject.Properties) { $infoHash[$prop.Name] = $prop.Value }
        $infoHash.schemaVersion = 1; $infoHash.operationId = $operationId; $infoHash.appVersion = $target; $infoHash.gitCommit = $finalCommit; $infoHash.treeSha = $finalTree; $infoHash.sourceSha256 = $preSha; $infoHash.artifactPath = $artifactPath; $infoHash.phase = "premerge"; $infoHash.qrSha256 = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-ReleaseImmutableJson -Path $infoPath -Value $infoHash | Out-Null
        $contextHash.premergePreviewQrPath = $qrPath; $contextHash.premergePreviewInfoPath = $infoPath
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
        Write-GateHost "preview" "预览二维码已生成：$qrPath"
    }

    if ($DeployCloud -and -not $effectivePublish) {
        throw "CloudBase 正式部署必须在 PR 合并后执行；先完成自动发布合并，再用 -ResumeOperation 配合 -DeployCloud。"
    }

    # Phase 1 ends at the immutable package and PR.  Production CloudBase is
    # deliberately after the merge confirmation so online code can never lead
    # GitHub main.
    $pr = Invoke-ReleasePullRequest -RepositoryRoot $releaseWorktree -Branch "release/$target-$operationId" -Version $target -OperationId $operationId -CommitSha $finalCommit -Policy $policy -NoPush:(-not $effectivePublish)
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
    if (-not $effectivePublish) {
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
            logPath = $logPath; reportPath = $reportPath
            phase = "prepared"
        }
        Write-ReleaseGateJsonAtomic -Path $preparedRecordPath -Value $preparedRecord
        $completed = $true
        Write-GateHost "done" "准备完成；版本已保留，未推送。需要发布时用 -ResumeOperation $operationId -Publish，继续使用同一 context。"
        Write-Host "Context: $contextPath"
        Write-Host "Artifact: $artifactPath"
        return
    }

    if ($effectivePublish -and [string]$pr.status -ne "merged") {
        throw "PR 尚未合并，已保留 context 供 -ResumeOperation 继续；禁止提前部署 CloudBase 或生成最终二维码。"
    }

    # 登记上一版可用证据。该清单只引用旧的不可变产物，不复制也不删除；
    # 即使后续 CloudBase/二维码失败，恢复入口仍能沿用同一 context。
    $backup = Write-ReleaseBackupManifest -Policy $policy -OperationId $operationId -Version $target
    $backupPath = [string]$backup.Path
    $contextHash.backupPath = $backupPath
    $contextHash.backupManifest = $backup.Manifest
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    Write-GateHost "backup" "已登记上一版备份清单：$backupPath"

    $apiMarkerPath = Join-Path $releaseWorktree "cloudfunctions\api\index.js"
    $apiMarkerText = if (Test-Path -LiteralPath $apiMarkerPath -PathType Leaf) {
        Get-Content -LiteralPath $apiMarkerPath -Raw -Encoding UTF8
    } else { "" }
    $apiMarkerMatch = [regex]::Match($apiMarkerText, 'const API_BUILD_MARKER = "([^"]+)"')
    if (-not $apiMarkerMatch.Success -or [string]::IsNullOrWhiteSpace($apiMarkerMatch.Groups[1].Value)) {
        throw "最终发布树缺少 API_BUILD_MARKER，拒绝生成无构建标记的 CloudBase 回执。"
    }
    # contextHash is an OrderedDictionary.  Use its indexer when adding a new
    # key; the PowerShell property adapter silently drops unknown dot members.
    $contextHash["apiBuildMarker"] = $apiMarkerMatch.Groups[1].Value
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash

    if ($effectivePreview) {
        # 每次正式更新都先把同一隔离工作树导入微信开发者工具，再生成
        # 绑定 commit 的二维码；导入失败会保留原 context 供恢复，不会换号重打。
        Write-GateHost "preview-import" "把本次版本导入微信开发者工具项目列表。"
        $importReceipt = Invoke-ReleasePreviewImport -CliPath $PreviewCliPath -ClientName $PreviewClientName -ProjectPath $releaseWorktree
        $contextHash.previewImport = [ordered]@{
            status = [string]$importReceipt.status
            projectPath = [string]$importReceipt.projectPath
            operationId = $operationId
            version = $target
            releaseCommit = $finalCommit
            treeSha = $finalTree
            sourceSha256 = $preSha
            importedAt = [string]$importReceipt.importedAt
            openStatus = [string]$importReceipt.openStatus
            openResponse = $importReceipt.openResponse
            compileStatus = [string]$importReceipt.compileStatus
            compileTriggeredAt = [string]$importReceipt.compileTriggeredAt
            compileResponse = $importReceipt.compileResponse
            steps = @($importReceipt.steps)
            response = $importReceipt.response
        }
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
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

        # Save the API receipt before payment deployment. If payment fails, the
        # same operation can resume without uploading the already-verified API.
        $apiContext = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-ReleaseContextShape -Context $apiContext -Policy $policy | Out-Null
        if ([string]$apiContext.operationId -ne $operationId -or [string]$apiContext.releaseCommit -ne $finalCommit) {
            throw "API 部署后 release context 身份漂移，拒绝继续支付部署。"
        }
        if ($apiContext.PSObject.Properties["cloudDeployment"] -and $null -ne $apiContext.cloudDeployment) {
            $contextHash["cloudDeployment"] = $apiContext.cloudDeployment
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
            onlineBuildMarker = [string]$contextHash["apiBuildMarker"]
            verifiedAt = [DateTimeOffset]::UtcNow.ToString("o")
            status = "verified"
        }
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash

        $paymentDeployScript = Join-Path $releaseWorktree "scripts/deploy-payment-production.ps1"
        if (-not (Test-Path -LiteralPath $paymentDeployScript -PathType Leaf)) {
            throw "缺少支付生产部署入口：$paymentDeployScript"
        }
        Write-GateHost "payment-cloud" "API 已核验，使用同一 release context 部署支付生产资源与开关。"
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $paymentDeployScript `
            -ProjectPath $releaseWorktree `
            -ReleaseContext $contextPath `
            -ReleaseGateLockHeld `
            -ReleaseGateLockToken ([string]$lockHandle.Owner.handoffToken) `
            -DeployLockPath ([string]$policy.lockPath) `
            -LockWaitSeconds $LockWaitSeconds `
            -AllowPostMergeRecovery:$false
        if ($LASTEXITCODE -ne 0) {
            throw "支付生产部署或核验失败；API 回执已保留，可用同一 operationId 只补支付。"
        }
        $paymentContext = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-ReleaseContextShape -Context $paymentContext -Policy $policy | Out-Null
        if ([string]$paymentContext.operationId -ne $operationId -or [string]$paymentContext.releaseCommit -ne $finalCommit) {
            throw "支付部署后 release context 身份漂移，拒绝写入成功状态。"
        }
        if (-not ($paymentContext.PSObject.Properties["paymentDeployment"] -and $null -ne $paymentContext.paymentDeployment)) {
            throw "支付生产部署未写入 paymentDeployment 回执。"
        }
        $paymentReceipt = Assert-GatePaymentDeploymentReceipt -Receipt $paymentContext.paymentDeployment -Context $paymentContext
        $contextHash["paymentDeployment"] = $paymentReceipt
        if ($paymentContext.PSObject.Properties["cloudDeployment"] -and $null -ne $paymentContext.cloudDeployment) {
            $contextHash["cloudDeployment"] = $paymentContext.cloudDeployment
        }
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
        if ([bool]$paymentReceipt.credentialsConfigured -eq $false) {
            Write-GateHost "payment-cloud" "支付资源与开关已核验；生产凭据未配置，provider 保持失败关闭。"
        }
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
    if ($effectivePreview -and $effectivePublish -and -not $hasFinalPreview) {
        # Generate the final QR only after the PR/main commit is confirmed.
        $qrPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-qr.png"
        $infoPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-info.json"
        $infoHash = [ordered]@{ schemaVersion = 1; operationId = $operationId; appVersion = $target; gitCommit = $finalCommit; treeSha = $finalTree; sourceSha256 = $preSha; artifactPath = $artifactPath; mainCommit = if ($contextHash.Contains("mainCommit")) { [string]$contextHash.mainCommit } else { "" } }
        if (-not (Test-Path -LiteralPath $qrPath -PathType Leaf) -and (Test-Path -LiteralPath $infoPath -PathType Leaf)) {
            throw "已有二维码 info 但二维码文件缺失，拒绝重新生成或覆盖：$infoPath"
        }
        if (Test-Path -LiteralPath $qrPath -PathType Leaf) {
            $existingQrSha = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if (-not (Test-Path -LiteralPath $infoPath -PathType Leaf)) { throw "已有二维码但缺少 info，拒绝复用或覆盖：$qrPath" }
            $existingInfo = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([int]$existingInfo.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string]$existingInfo.qrSha256) -or [string]$existingInfo.qrSha256 -ne $existingQrSha) { throw "已有二维码 SHA/schema 与 info 不一致，拒绝覆盖：$qrPath" }
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
                Write-ReleaseImmutableFile -SourcePath $tempQrPath -DestinationPath $qrPath | Out-Null
            }
            finally {
                if (Test-Path -LiteralPath $tempQrPath -PathType Leaf) { Remove-Item -LiteralPath $tempQrPath -Force -ErrorAction SilentlyContinue }
            }
            $infoHash.qrSha256 = (Get-FileHash -LiteralPath $qrPath -Algorithm SHA256).Hash.ToLowerInvariant()
            Write-ReleaseImmutableJson -Path $infoPath -Value $infoHash | Out-Null
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
    if ($contextHash.Contains("utf8Preflight")) { $record.utf8Preflight = $contextHash.utf8Preflight }
    if ($contextHash.Contains("previewSourceBudget")) { $record["previewSourceBudget"] = $contextHash["previewSourceBudget"] }
    if ($contextHash.Contains("cloudbaseEnvironment")) { $record.cloudbaseEnvironment = $contextHash.cloudbaseEnvironment }
    if ($contextHash.Contains("mainCommit")) { $record.mainCommit = [string]$contextHash.mainCommit }
    if ($contextHash.Contains("mergedAt")) { $record.mergedAt = [string]$contextHash.mergedAt }
    $record.phase = [string]$contextHash.phase
    if ($contextHash.Contains("cloudReceipt")) { $record.cloudReceipt = $contextHash.cloudReceipt }
    if ($contextHash.Contains("paymentDeployment")) { $record["paymentDeployment"] = $contextHash.paymentDeployment }
    Write-ReleaseGateJsonAtomic -Path $recordPath -Value $record

    # 先做四端验收，再把 context/record/queue 变成终态。这样“文件写完”
    # 不会被误报成“发布成功”。
    $reportContext = [pscustomobject]$contextHash
    $acceptance = Write-ReleaseAcceptanceReport -Policy $policy -Context $reportContext -ContextPath $contextPath -RequireCloud:$DeployCloud -RequirePreview:$effectivePreview
    if ($null -eq $acceptance -or $null -eq $acceptance.Report -or [string]$acceptance.Report.status -ne "succeeded") {
        throw "发布验收报告未通过，拒绝写入 succeeded：$($acceptance.Report.status)"
    }
    $contextHash.reportPath = [string]$acceptance.Path
    $contextHash.reportMarkdownPath = [string]$acceptance.MarkdownPath
    $contextHash.status = "succeeded"
    if ($contextHash.Contains("lastError")) { $contextHash.Remove("lastError") }
    if ($contextHash.Contains("recovery") -and $null -ne $contextHash.recovery) {
        $contextHash.recovery.resumable = $true
        $contextHash.recovery.lastFailureStage = ""
    }
    $contextHash.terminalStatus = "succeeded"
    $contextHash.completedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $contextHash.finalization = [ordered]@{ state = "committed"; completedAt = $contextHash.completedAt }
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status "succeeded" -Extra $reservationExtra
    $record.status = $contextHash.status
    $record.terminalStatus = "succeeded"
    $record.generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $record.reportPath = [string]$acceptance.Path
    $record.reportMarkdownPath = [string]$acceptance.MarkdownPath
    $record.backupPath = $backupPath
    Write-ReleaseGateJsonAtomic -Path $recordPath -Value $record
    Write-GateHost "report" "四端验收通过，报告已生成：$($acceptance.Path)"

    # This is the sole terminal queue transition, deliberately last.
    Set-GateQueueStage -Stage "succeeded" -Status "succeeded"
    $terminalQueue = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $operationId -WaitSeconds $LockWaitSeconds -PollMilliseconds ([int]$policy.queue.pollMilliseconds)
    if ($null -eq $terminalQueue -or [string]$terminalQueue.status -ne "succeeded") {
        throw "发布队列未确认 succeeded，保留原 context 供恢复。"
    }
    # Only move the mutable latest pointer after the durable queue says
    # succeeded.  If this final pointer write is interrupted, the catch block
    # can repair it without downgrading the already-successful release.
    Write-ReleaseLatestManifest -Policy $policy -Context ([pscustomobject]$contextHash) -ReportPath ([string]$acceptance.Path) -Report $acceptance.Report | Out-Null
    Write-GateHost "latest" "最新版本指针已更新：$([string]$policy.latestReleasePath)"
    # 成功指针落盘后再做发布后视觉检查；检查失败只记录告警，不回滚已确认成功的发布。
    $postReleaseVisualScript = Join-Path $sourceRepo.Root "scripts/admin-v2-post-release-visual-check.js"
    if (Test-Path -LiteralPath $postReleaseVisualScript -PathType Leaf) {
        try {
            $visualArgs = @("--root", $sourceRepo.Root, "--version", $target, "--retain-days", "3")
            if ([string]$env:ADMIN_POST_RELEASE_CAPTURE -eq "1") {
                $visualArgs += @("--capture", "--cli-capture", "--project", $sourceRepo.Root, "--cli", $PreviewCliPath)
            }
            else { $visualArgs += "--allow-existing" }
            $visualOutput = @(& node $postReleaseVisualScript @visualArgs 2>&1)
            $visualText = ($visualOutput | ForEach-Object { [string]$_ }) -join "`n"
            $visualResult = $visualText | ConvertFrom-Json -ErrorAction Stop
            $contextHash.postReleaseVisual = [ordered]@{
                status = [string]$visualResult.status
                captureStatus = [string]$visualResult.capture.status
                reportPath = Join-Path $sourceRepo.Root "visual-evidence/post-release/v$target/visual-check.json"
                archiveManifestPath = [string]$visualResult.archive.manifestPath
                checkedAt = [string]$visualResult.checkedAt
            }
            Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
            Write-GateHost "visual" "发布后视觉检查完成：$([string]$visualResult.status)，截图=$([string]$visualResult.capture.status)。"
        }
        catch {
            $contextHash.postReleaseVisual = [ordered]@{ status = "fail"; error = $_.Exception.Message; checkedAt = [DateTimeOffset]::UtcNow.ToString("o") }
            Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
            Write-Host "发布后视觉检查失败，已记录告警但不回滚已成功发布：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    $completed = $true
    $doneMessage = if (-not $effectivePublish) { "准备完成；未推送。需要发布时去掉 -PrepareOnly 或显式加 -Publish。" } elseif ([string]$pr.status -eq "merged") { "发布完成，PR 已合并：$($pr.pr)" } else { "发布分支和 PR 已创建，等待 GitHub 必需检查：$($pr.pr)" }
    Write-GateHost "done" $doneMessage
    Write-Host "Context: $contextPath"
    Write-Host "Artifact: $artifactPath"
}
catch {
    $message = $_.Exception.Message
    try { Write-ReleaseOperationLog -Path $logPath -Stage "failed" -Message $message -OperationId $operationId }
    catch { Write-Host "失败日志写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
    try {
        $alertPath = Write-ReleaseFailureAlert -Policy $policy -OperationId $operationId -Version $target -Stage "failed" -Message $message -ContextPath $contextPath -LogPath $logPath
        Write-Host "失败告警已记录：$alertPath" -ForegroundColor Yellow
    }
    catch { Write-Host "失败告警处理失败：$($_.Exception.Message)" -ForegroundColor Yellow }

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
        if ($repairAllowed) {
            try {
                $reportFile = if ($repairContext.PSObject.Properties["reportPath"]) { [string]$repairContext.reportPath } else { Join-Path ([string]$policy.reportRoot) "release-$operationId.json" }
                if (Test-Path -LiteralPath $reportFile -PathType Leaf) {
                    $repairReport = Get-Content -LiteralPath $reportFile -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ([string]$repairReport.status -eq "succeeded") {
                        Write-ReleaseLatestManifest -Policy $policy -Context $repairContext -ReportPath $reportFile -Report $repairReport | Out-Null
                        Write-Host "成功 latest 指针已补写：$([string]$policy.latestReleasePath)" -ForegroundColor Yellow
                    }
                }
            }
            catch { Write-Host "成功 latest 指针补写失败：$($_.Exception.Message)" -ForegroundColor Yellow }
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
    # DevTools uses the imported directory as its project source.  Retain a
    # successful preview worktree so the newly compiled simulator has a live
    # path; old preview worktrees are handled by release maintenance.
    if (-not $KeepWorktree -and -not $effectivePreview -and -not [string]::IsNullOrWhiteSpace($releaseWorktree) -and ($completed -or -not $failureAfterCommit)) {
        Remove-ReleaseGateWorktree -CanonicalRepo $canonicalRepo -WorktreePath $releaseWorktree
    }
    if ($null -ne $queueHeartbeat -and (Get-Command Stop-ReleaseQueueLeaseHeartbeat -ErrorAction SilentlyContinue)) { Stop-ReleaseQueueLeaseHeartbeat -Heartbeat $queueHeartbeat }
    if ($null -ne $lockHandle) { Exit-ReleaseLock -LockHandle $lockHandle }
}
