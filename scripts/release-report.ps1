<#
    发布验收报告与状态聚合器。

    这个文件只读取发布队列、release context、record、reservation、ZIP、二维码
    回执和本地 Git 引用，然后把四端证据归并成一个可审计对象。它不领取租约、
    不改变队列，也不触发 CloudBase/GitHub 操作。写报告时只写 report 目录；
    已有同名报告只有内容完全相同才允许复用。

    直接运行：
      pwsh -File scripts/release-report.ps1 -OperationId <op> -Json
      pwsh -File scripts/release-report.ps1 -OperationId <op> -Markdown

    被 release-status.ps1 dot-source 时，下面的命令行薄封装不会执行。
#>

param(
    [Alias("OperationId")][string]$RROperationId = "",
    [Alias("ContextPath")][string]$RRContextPath = "",
    [Alias("PolicyPath")][string]$RRPolicyPath = "",
    [Alias("JsonPath")][string]$RRJsonPath = "",
    [Alias("MarkdownPath")][string]$RRMarkdownPath = "",
    [Alias("Json")][switch]$RRJson,
    [Alias("Markdown")][switch]$RRMarkdown,
    [Alias("NoWrite")][switch]$RRNoWrite,
    [Alias("NoLatest")][switch]$RRNoLatest,
    [Alias("UpdateLatest")][switch]$RRUpdateLatest,
    [Alias("SkipGit")][switch]$RRSkipGit,
    [Alias("SkipZip")][switch]$RRSkipZip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The report command is also a write-capable latest-pointer repair entry point.
# Load the same gate/lock primitives as the main publisher so direct report or
# status invocations cannot update the shared pointer outside the release lock.
$reportGateScript = Join-Path $PSScriptRoot "release-gate.ps1"
$reportLockScript = Join-Path $PSScriptRoot "release-lock.ps1"
if (Test-Path -LiteralPath $reportGateScript -PathType Leaf) { . $reportGateScript }
if (Test-Path -LiteralPath $reportLockScript -PathType Leaf) { . $reportLockScript }

function Get-ReleaseReportProperty {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][object]$Default = $null
    )
    if ($null -eq $Object) { return $Default }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        $value = $Object[$Name]
        if ($null -eq $value) { return $Default }
        return $value
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Test-ReleaseReportProperty {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $Object) { return $false }
    if ($Object -is [System.Collections.IDictionary]) { return $Object.Contains($Name) }
    return $null -ne $Object.PSObject.Properties[$Name]
}

function ConvertTo-ReleaseReportFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Test-ReleaseReportPathEqual {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )
    try {
        return [string]::Equals(
            (ConvertTo-ReleaseReportFullPath $Left).TrimEnd('\', '/'),
            (ConvertTo-ReleaseReportFullPath $Right).TrimEnd('\', '/'),
            [StringComparison]::OrdinalIgnoreCase
        )
    }
    catch { return $false }
}

function Get-ReleaseReportDefaultPolicyPath {
    param([string]$RepositoryRoot = "")
    if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
        $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    }
    return Join-Path (Split-Path (ConvertTo-ReleaseReportFullPath $RepositoryRoot) -Parent) "wechat-miniapp-release-policy.json"
}

function Test-ReleaseReportPathInside {
    param(
        [AllowEmptyString()][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        $full = ConvertTo-ReleaseReportFullPath $Path
        $rootFull = (ConvertTo-ReleaseReportFullPath $Root).TrimEnd('\', '/')
        return [string]::Equals($full.TrimEnd('\', '/'), $rootFull, [StringComparison]::OrdinalIgnoreCase) -or
            $full.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
            $full.StartsWith($rootFull + [IO.Path]::AltDirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Assert-ReleaseReportPathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-ReleaseReportPathInside -Path $Path -Root $Root)) {
        throw "$Label 路径越过策略目录边界：$Path（允许目录：$Root）"
    }
    return (ConvertTo-ReleaseReportFullPath $Path)
}

function Assert-ReleaseReportPolicyShape {
    <#
      Keep the report CLI usable with an isolated test policy, while still
      preventing a copied policy or a ticket path containing .. from redirecting
      report/latest writes to an unrelated directory.  Production release.ps1
      additionally applies the stricter singleton assertion from release-gate.
    #>
    param([Parameter(Mandatory = $true)][object]$Policy)
    $canonical = ConvertTo-ReleaseReportFullPath ([string]$Policy.canonicalRepo)
    $parent = Split-Path $canonical -Parent
    foreach ($name in @('artifactRoot','contextRoot','recordRoot','reservationRoot','worktreeRoot','queueRoot','logRoot','reportRoot','backupRoot')) {
        $value = [string](Get-ReleaseReportProperty $Policy $name '')
        if ([string]::IsNullOrWhiteSpace($value)) { throw "发布策略缺少目录：$name" }
        $full = ConvertTo-ReleaseReportFullPath $value
        if (-not (Test-ReleaseReportPathInside -Path $full -Root $parent)) {
            throw "发布策略 $name 必须位于 canonical 仓库父目录内：$full"
        }
    }
    $lockPath = ConvertTo-ReleaseReportFullPath ([string]$Policy.lockPath)
    if (-not (Test-ReleaseReportPathInside -Path $lockPath -Root $parent)) { throw "发布策略 lockPath 越过 canonical 父目录：$lockPath" }
    $archivePath = ConvertTo-ReleaseReportFullPath ([string](Get-ReleaseReportProperty $Policy 'archiveManifestPath' (Join-Path $parent 'wechat-miniapp-release-archive.json')))
    if (-not (Test-ReleaseReportPathInside -Path $archivePath -Root $parent)) { throw "发布策略 archiveManifestPath 越过 canonical 父目录：$archivePath" }
    # latest-release.json is a single shared pointer.  Production keeps it
    # next to the other release state directories (the canonical repository's
    # parent), while isolated smoke policies may place it under reportRoot.
    # Accept either location, but never allow it outside the canonical parent.
    $latestPath = ConvertTo-ReleaseReportFullPath ([string]$Policy.latestReleasePath)
    if (-not (Test-ReleaseReportPathInside -Path $latestPath -Root $parent)) { throw "发布策略 latestReleasePath 必须位于 canonical 仓库父目录内：$latestPath" }
    $alertRoot = [string](Get-ReleaseReportProperty $Policy 'alertRoot' (Join-Path ([string]$Policy.logRoot) 'alerts'))
    if (-not (Test-ReleaseReportPathInside -Path $alertRoot -Root ([string]$Policy.logRoot))) { throw "发布策略 alertRoot 必须位于 logRoot 内：$alertRoot" }
    $remote = [string](Get-ReleaseReportProperty $Policy 'remote' '')
    if ([string]::IsNullOrWhiteSpace($remote)) { throw '发布策略 remote 不能为空。' }
    if ([string](Get-ReleaseReportProperty $Policy 'branch' 'main') -ne 'main') { throw '发布报告只允许读取 main 分支。' }
    return $true
}

function Read-ReleaseReportJsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $result = [ordered]@{
        path = $Path
        exists = $false
        value = $null
        error = ""
    }
    if ([string]::IsNullOrWhiteSpace($Path)) { return [pscustomobject]$result }
    try { $full = ConvertTo-ReleaseReportFullPath $Path } catch { $result.error = "路径无效"; return [pscustomobject]$result }
    $result.path = $full
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return [pscustomobject]$result }
    $result.exists = $true
    try {
        $raw = [IO.File]::ReadAllText($full, [Text.UTF8Encoding]::new($false))
        if ([string]::IsNullOrWhiteSpace($raw)) { throw "文件为空" }
        $result.value = $raw | ConvertFrom-Json
    }
    catch {
        $result.error = "JSON 读取失败：$($_.Exception.Message)"
    }
    return [pscustomobject]$result
}

function Get-ReleaseReportPolicy {
    [CmdletBinding()]
    param(
        [string]$PolicyPath = "",
        [string]$RepositoryRoot = ""
    )
    $path = if ([string]::IsNullOrWhiteSpace($PolicyPath)) {
        Get-ReleaseReportDefaultPolicyPath -RepositoryRoot $RepositoryRoot
    } else { ConvertTo-ReleaseReportFullPath $PolicyPath }
    $loaded = Read-ReleaseReportJsonFile -Path $path
    if (-not $loaded.exists -or $null -eq $loaded.value) {
        throw "缺少或无法读取发布策略：$path $($loaded.error)"
    }
    $policy = $loaded.value
    $canonical = [string](Get-ReleaseReportProperty $policy "canonicalRepo" $RepositoryRoot)
    if ([string]::IsNullOrWhiteSpace($canonical)) {
        $canonical = if (-not [string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot } else { Join-Path (Split-Path $path -Parent) "wechat-miniapp" }
    }
    $canonical = ConvertTo-ReleaseReportFullPath $canonical
    $parent = Split-Path $canonical -Parent
    $artifactRoot = [string](Get-ReleaseReportProperty $policy "artifactRoot" $parent)
    $contextRoot = [string](Get-ReleaseReportProperty $policy "contextRoot" (Join-Path $parent "wechat-miniapp-release-contexts"))
    $recordRoot = [string](Get-ReleaseReportProperty $policy "recordRoot" (Join-Path $parent "wechat-miniapp-release-records"))
    $reservationRoot = [string](Get-ReleaseReportProperty $policy "reservationRoot" (Join-Path $parent "wechat-miniapp-release-reservations"))
    $queueRoot = [string](Get-ReleaseReportProperty $policy "queueRoot" (Join-Path $parent "wechat-miniapp-release-queue"))
    $logRoot = [string](Get-ReleaseReportProperty $policy "logRoot" (Join-Path $parent "wechat-miniapp-release-logs"))
    $reportRoot = [string](Get-ReleaseReportProperty $policy "reportRoot" (Join-Path $parent "wechat-miniapp-release-reports"))
    $latestPath = [string](Get-ReleaseReportProperty $policy "latestReleasePath" (Join-Path $reportRoot "latest-release.json"))
    $backupRoot = [string](Get-ReleaseReportProperty $policy "backupRoot" (Join-Path $parent "wechat-miniapp-release-backups"))
    $alertRoot = [string](Get-ReleaseReportProperty $policy "alertRoot" (Join-Path $logRoot "alerts"))
    $archiveManifestPath = [string](Get-ReleaseReportProperty $policy "archiveManifestPath" (Join-Path $parent "wechat-miniapp-release-archive.json"))
    $worktreeRoot = [string](Get-ReleaseReportProperty $policy "worktreeRoot" (Join-Path $parent "wechat-miniapp-release-worktrees"))
    # Add normalized paths without changing the source policy file.
    $normalized = [pscustomobject][ordered]@{
        schemaVersion = [int](Get-ReleaseReportProperty $policy "schemaVersion" 1)
        policyPath = $path
        canonicalRepo = $canonical
        remote = [string](Get-ReleaseReportProperty $policy "remote" "")
        branch = [string](Get-ReleaseReportProperty $policy "branch" "main")
        lockPath = [string](Get-ReleaseReportProperty $policy "lockPath" (Join-Path $parent "wechat-miniapp-release.lock"))
        artifactRoot = (ConvertTo-ReleaseReportFullPath $artifactRoot)
        contextRoot = (ConvertTo-ReleaseReportFullPath $contextRoot)
        recordRoot = (ConvertTo-ReleaseReportFullPath $recordRoot)
        reservationRoot = (ConvertTo-ReleaseReportFullPath $reservationRoot)
        worktreeRoot = (ConvertTo-ReleaseReportFullPath $worktreeRoot)
        queueRoot = (ConvertTo-ReleaseReportFullPath $queueRoot)
        logRoot = (ConvertTo-ReleaseReportFullPath $logRoot)
        reportRoot = (ConvertTo-ReleaseReportFullPath $reportRoot)
        backupRoot = (ConvertTo-ReleaseReportFullPath $backupRoot)
        alertRoot = (ConvertTo-ReleaseReportFullPath $alertRoot)
        archiveManifestPath = (ConvertTo-ReleaseReportFullPath $archiveManifestPath)
        latestReleasePath = (ConvertTo-ReleaseReportFullPath $latestPath)
    }
    Assert-ReleaseReportPolicyShape -Policy $normalized | Out-Null
    return $normalized
}

function ConvertTo-ReleaseReportArray {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return @($Value) }
    return @($Value)
}

function Get-ReleaseReportJsonCandidates {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    try { return @(Get-ChildItem -LiteralPath $Root -Filter "*.json" -File -ErrorAction Stop | Sort-Object LastWriteTime -Descending) }
    catch { return @() }
}

function Read-ReleaseReportObjectsFromFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $loaded = Read-ReleaseReportJsonFile -Path $Path
    if (-not $loaded.exists -or $null -eq $loaded.value) { return @() }
    return (ConvertTo-ReleaseReportArray $loaded.value)
}

function Read-ReleaseReportQueueState {
    param([Parameter(Mandatory = $true)][object]$Policy)
    $queuePath = Join-Path ([string]$Policy.queueRoot) "queue.json"
    $loaded = Read-ReleaseReportJsonFile -Path $queuePath
    if (-not $loaded.exists -or $null -eq $loaded.value) {
        return [pscustomobject][ordered]@{ path = $queuePath; exists = $false; error = $loaded.error; tickets = @(); schemaVersion = 0; nextSequence = 0 }
    }
    $state = $loaded.value
    $tickets = ConvertTo-ReleaseReportArray (Get-ReleaseReportProperty $state "tickets" @())
    return [pscustomobject][ordered]@{
        path = $queuePath
        exists = $true
        error = ""
        schemaVersion = [int](Get-ReleaseReportProperty $state "schemaVersion" 0)
        nextSequence = [int](Get-ReleaseReportProperty $state "nextSequence" 0)
        tickets = $tickets
    }
}

function Find-ReleaseReportObjectByOperation {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [string[]]$PreferredPaths = @(),
        [switch]$ReturnPreferredOnMismatch
    )
    foreach ($preferred in @($PreferredPaths)) {
        if (-not [string]::IsNullOrWhiteSpace($preferred) -and (Test-Path -LiteralPath $preferred -PathType Leaf)) {
            $preferredItems = @(Read-ReleaseReportObjectsFromFile -Path $preferred)
            foreach ($item in $preferredItems) {
                if ([string](Get-ReleaseReportProperty $item "operationId" "") -eq $OperationId) { return [pscustomobject][ordered]@{ path = (ConvertTo-ReleaseReportFullPath $preferred); value = $item } }
            }
            # A ticket-provided path is evidence even when its contents were
            # tampered with. Returning it lets the report say “identity
            # mismatch” instead of incorrectly saying the reservation/record
            # is merely missing.
            if ($ReturnPreferredOnMismatch -and $preferredItems.Count -eq 1) {
                return [pscustomobject][ordered]@{ path = (ConvertTo-ReleaseReportFullPath $preferred); value = $preferredItems[0] }
            }
        }
    }
    foreach ($file in @(Get-ReleaseReportJsonCandidates -Root $Root)) {
        foreach ($item in @(Read-ReleaseReportObjectsFromFile -Path $file.FullName)) {
            if ([string](Get-ReleaseReportProperty $item "operationId" "") -eq $OperationId) {
                return [pscustomobject][ordered]@{ path = $file.FullName; value = $item }
            }
        }
    }
    return $null
}

function Resolve-ReleaseReportOperation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [string]$OperationId = "",
        [string]$ContextPath = "",
        [AllowNull()][object]$Ticket = $null
    )
    if (-not [string]::IsNullOrWhiteSpace($ContextPath)) {
        # Validate before reading a caller-supplied path (even when it is used
        # only to discover operationId), so an old clone cannot point the
        # aggregator at arbitrary files outside contextRoot.
        $ContextPath = Assert-ReleaseReportPathInside -Path $ContextPath -Root ([string]$Policy.contextRoot) -Label "ContextPath"
    }
    $queue = Read-ReleaseReportQueueState -Policy $Policy
    $selectedTicket = $Ticket
    if ($null -eq $selectedTicket -and -not [string]::IsNullOrWhiteSpace($OperationId)) {
        $selectedTicket = @($queue.tickets | Where-Object { [string](Get-ReleaseReportProperty $_ "operationId" "") -eq $OperationId } | Select-Object -First 1)
        if ($selectedTicket -is [System.Array]) { $selectedTicket = if ($selectedTicket.Count -gt 0) { $selectedTicket[0] } else { $null } }
    }
    if ($null -eq $selectedTicket -and [string]::IsNullOrWhiteSpace($OperationId)) {
        # Prefer the active/queued FIFO item, otherwise the most recent ticket.
        $selectedTicket = @($queue.tickets | Where-Object { [string](Get-ReleaseReportProperty $_ "status" "") -in @("queued", "leased", "running") } | Sort-Object {[int](Get-ReleaseReportProperty $_ "sequence" 0)} | Select-Object -First 1)
        if ($selectedTicket -is [System.Array]) { $selectedTicket = if ($selectedTicket.Count -gt 0) { $selectedTicket[0] } else { $null } }
        if ($null -eq $selectedTicket) { $selectedTicket = @($queue.tickets | Sort-Object {[int](Get-ReleaseReportProperty $_ "sequence" 0)} -Descending | Select-Object -First 1); if ($selectedTicket -is [System.Array]) { $selectedTicket = if ($selectedTicket.Count -gt 0) { $selectedTicket[0] } else { $null } } }
    }
    $op = if (-not [string]::IsNullOrWhiteSpace($OperationId)) { $OperationId } else { [string](Get-ReleaseReportProperty $selectedTicket "operationId" "") }
    if ([string]::IsNullOrWhiteSpace($op) -and -not [string]::IsNullOrWhiteSpace($ContextPath)) {
        $ctxProbe = Read-ReleaseReportJsonFile -Path $ContextPath
        $op = [string](Get-ReleaseReportProperty $ctxProbe.value "operationId" "")
    }
    if ([string]::IsNullOrWhiteSpace($op)) { throw "找不到发布操作；请提供 -OperationId 或 -ContextPath。" }

    $ctxPreferred = @()
    if (-not [string]::IsNullOrWhiteSpace($ContextPath)) {
        $ctxPreferred += Assert-ReleaseReportPathInside -Path $ContextPath -Root ([string]$Policy.contextRoot) -Label "ContextPath"
    }
    $ticketContext = [string](Get-ReleaseReportProperty $selectedTicket "contextPath" "")
    if (-not [string]::IsNullOrWhiteSpace($ticketContext)) {
        $ctxPreferred += Assert-ReleaseReportPathInside -Path $ticketContext -Root ([string]$Policy.contextRoot) -Label "队列 contextPath"
    }
    $ctxPreferred += (Join-Path ([string]$Policy.contextRoot) "release-$op.json")
    $contextMatch = Find-ReleaseReportObjectByOperation -Root ([string]$Policy.contextRoot) -OperationId $op -PreferredPaths $ctxPreferred -ReturnPreferredOnMismatch

    $recordPreferred = @()
    $ticketRecord = [string](Get-ReleaseReportProperty $selectedTicket "recordPath" "")
    if (-not [string]::IsNullOrWhiteSpace($ticketRecord)) {
        $recordPreferred += Assert-ReleaseReportPathInside -Path $ticketRecord -Root ([string]$Policy.recordRoot) -Label "队列 recordPath"
    }
    $recordMatch = Find-ReleaseReportObjectByOperation -Root ([string]$Policy.recordRoot) -OperationId $op -PreferredPaths $recordPreferred -ReturnPreferredOnMismatch

    $reservationPreferred = @()
    $ticketReservation = [string](Get-ReleaseReportProperty $selectedTicket "reservationPath" "")
    if (-not [string]::IsNullOrWhiteSpace($ticketReservation)) {
        $reservationPreferred += Assert-ReleaseReportPathInside -Path $ticketReservation -Root ([string]$Policy.reservationRoot) -Label "队列 reservationPath"
    }
    $reservationMatch = Find-ReleaseReportObjectByOperation -Root ([string]$Policy.reservationRoot) -OperationId $op -PreferredPaths $reservationPreferred -ReturnPreferredOnMismatch
    # reservation 文件路径由队列票据绑定。即使文件里的 operationId 被改坏，
    # 也要读出这份文件并明确报告“身份不一致”，不能把它误报成“文件缺失”。
    # 这样既能 fail-closed，又让排查者知道到底是哪一个字段错了。
    if ($null -eq $reservationMatch) {
        foreach ($preferred in @($reservationPreferred)) {
            if ([string]::IsNullOrWhiteSpace($preferred) -or -not (Test-Path -LiteralPath $preferred -PathType Leaf)) { continue }
            foreach ($item in @(Read-ReleaseReportObjectsFromFile -Path $preferred)) {
                $reservationMatch = [pscustomobject][ordered]@{
                    path = (ConvertTo-ReleaseReportFullPath $preferred)
                    value = $item
                }
                break
            }
            if ($null -ne $reservationMatch) { break }
        }
    }

    return [pscustomobject][ordered]@{
        operationId = $op
        queue = $queue
        ticket = $selectedTicket
        context = if ($null -ne $contextMatch) { $contextMatch.value } else { $null }
        contextPath = if ($null -ne $contextMatch) { $contextMatch.path } else { if ($ctxPreferred.Count -gt 0) { [string]$ctxPreferred[0] } else { "" } }
        record = if ($null -ne $recordMatch) { $recordMatch.value } else { $null }
        recordPath = if ($null -ne $recordMatch) { $recordMatch.path } else { "" }
        reservation = if ($null -ne $reservationMatch) { $reservationMatch.value } else { $null }
        reservationPath = if ($null -ne $reservationMatch) { $reservationMatch.path } else { "" }
    }
}

function Get-ReleaseReportIdentity {
    param([Parameter(Mandatory = $true)][object]$Operation)
    $ctx = $Operation.context
    $record = $Operation.record
    $ticket = $Operation.ticket
    $pick = {
        param([string]$Name, [string]$Fallback = "")
        $v = [string](Get-ReleaseReportProperty $ctx $Name "")
        if ([string]::IsNullOrWhiteSpace($v)) { $v = [string](Get-ReleaseReportProperty $record $Name "") }
        if ([string]::IsNullOrWhiteSpace($v)) { $v = [string](Get-ReleaseReportProperty $ticket $Name "") }
        if ([string]::IsNullOrWhiteSpace($v)) { $v = $Fallback }
        return $v
    }
    $version = & $pick "version"
    if ([string]::IsNullOrWhiteSpace($version)) { $version = & $pick "targetVersion" }
    $artifactPath = & $pick "artifactPath"
    if ([string]::IsNullOrWhiteSpace($artifactPath)) { $artifactPath = & $pick "packagePath" }
    return [pscustomobject][ordered]@{
        operationId = [string]$Operation.operationId
        version = [string]$version
        sourceCommit = [string](& $pick "sourceCommit")
        releaseCommit = [string](& $pick "releaseCommit")
        treeSha = [string](& $pick "treeSha")
        sourceSha256 = [string](& $pick "sourceSha256")
        packageSha256 = [string](& $pick "packageSha256")
        mainCommit = [string](& $pick "mainCommit")
        artifactPath = [string]$artifactPath
        branch = [string](& $pick "branch" "main")
        remote = [string](& $pick "remote")
        expiresAt = [string](& $pick "expiresAt")
        releaseBranch = [string](& $pick "releaseBranch")
        pullRequest = [string](& $pick "pullRequest")
    }
}

function New-ReleaseReportEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [ValidateSet("pass", "pending", "fail")][string]$Status = "pending",
        [string]$Message = "",
        [hashtable]$Values = @{},
        [string[]]$Issues = @()
    )
    $ordered = [ordered]@{ name = $Name; status = $Status; message = $Message; issues = @($Issues) }
    foreach ($key in $Values.Keys) {
        # status/message/issues 是报告本身的判定字段，不能被 Values 里用于
        # 描述“观测到的原始状态”同名字段覆盖（否则 reservation=fail 会
        # 被空的 reservation.status 覆掉，整体误报 succeeded）。
        if ($key -eq "status") { $ordered["observedStatus"] = $Values[$key] }
        elseif ($key -eq "message") { $ordered["observedMessage"] = $Values[$key] }
        elseif ($key -eq "issues") { $ordered["observedIssues"] = $Values[$key] }
        else { $ordered[$key] = $Values[$key] }
    }
    return [pscustomobject]$ordered
}

function Add-ReleaseReportIssue {
    param([Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$List, [AllowNull()][object]$Value)
    if ($null -eq $Value) { return }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    # 报告可以给人看，但绝不能把 token/密钥原文写进外部状态目录。
    $text = $text -replace '(?i)(token|secret|password|cookie|authorization|api[_-]?key|appsecret|private[_-]?key)\s*[=:：]\s*[^\s,;，；]+', '$1=[已隐藏]'
    $text = $text -replace '(?i)(ghp_|github_pat_|sk-[A-Za-z0-9_-]+)[A-Za-z0-9_-]*', '[已隐藏]'
    [void]$List.Add($text)
}

function ConvertTo-ReleaseReportSafeText {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return "" }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return "" }
    $text = $text -replace '(?i)(token|secret|password|cookie|authorization|api[_-]?key|appsecret|private[_-]?key)\s*[=:：]\s*[^\s,;，；]+', '$1=[已隐藏]'
    $text = $text -replace '(?i)(ghp_|github_pat_|sk-[A-Za-z0-9_-]+)[A-Za-z0-9_-]*', '[已隐藏]'
    return $text
}

function Get-ReleaseReportGitValue {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot, [Parameter(Mandatory = $true)][string[]]$Arguments)
    if (-not (Test-Path -LiteralPath $RepositoryRoot -PathType Container)) { return [pscustomobject]@{ ok = $false; value = ""; error = "仓库目录不存在" } }
    try {
        $output = @(& git -C $RepositoryRoot @Arguments 2>$null)
        $exit = $LASTEXITCODE
        $value = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
        if ($exit -ne 0) { return [pscustomobject]@{ ok = $false; value = $value; error = "git 命令失败" } }
        return [pscustomobject]@{ ok = $true; value = $value; error = "" }
    }
    catch { return [pscustomobject]@{ ok = $false; value = ""; error = "git 不可用" } }
}

function Get-ReleaseReportMainEvidence {
    param([Parameter(Mandatory = $true)][object]$Policy, [Parameter(Mandatory = $true)][object]$Identity, [Parameter(Mandatory = $true)][object]$Operation)
    $issues = [System.Collections.Generic.List[string]]::new()
    $mainCommitExpected = [string]$Identity.mainCommit
    $releaseCommit = [string]$Identity.releaseCommit
    $ref = "refs/remotes/origin/$([string]$Policy.branch)"
    $head = Get-ReleaseReportGitValue -RepositoryRoot ([string]$Policy.canonicalRepo) -Arguments @("rev-parse", $ref)
    if (-not $head.ok) {
        [void]$issues.Add("无法读取 origin/$([string]$Policy.branch)，只读环境或远端引用尚未同步")
        return New-ReleaseReportEvidence -Name "GitHub main" -Status "pending" -Message "缺少 main 实际引用" -Values @{ expectedCommit = $mainCommitExpected; releaseCommit = $releaseCommit; observedCommit = ""; branch = [string]$Policy.branch } -Issues $issues.ToArray()
    }
    $observed = $head.value.Trim()
    if (-not [string]::IsNullOrWhiteSpace($mainCommitExpected) -and -not [string]::Equals($observed, $mainCommitExpected, [StringComparison]::OrdinalIgnoreCase)) {
        [void]$issues.Add("origin/main=$observed，与 context mainCommit=$mainCommitExpected 不一致")
        return New-ReleaseReportEvidence -Name "GitHub main" -Status "fail" -Message "主线提交不一致" -Values @{ expectedCommit = $mainCommitExpected; releaseCommit = $releaseCommit; observedCommit = $observed; branch = [string]$Policy.branch } -Issues $issues.ToArray()
    }
    if ([string]::IsNullOrWhiteSpace($mainCommitExpected) -and [string]::IsNullOrWhiteSpace($releaseCommit)) {
        [void]$issues.Add("没有 releaseCommit/mainCommit，无法证明主线包含本次发布")
        return New-ReleaseReportEvidence -Name "GitHub main" -Status "pending" -Message "缺少提交证据" -Values @{ expectedCommit = ""; releaseCommit = ""; observedCommit = $observed; branch = [string]$Policy.branch } -Issues $issues.ToArray()
    }
    if ([string]::IsNullOrWhiteSpace($mainCommitExpected)) {
        $ancestor = Get-ReleaseReportGitValue -RepositoryRoot ([string]$Policy.canonicalRepo) -Arguments @("merge-base", "--is-ancestor", $releaseCommit, $observed)
        if (-not $ancestor.ok) {
            [void]$issues.Add("origin/main 尚未确认包含 releaseCommit=$releaseCommit")
            return New-ReleaseReportEvidence -Name "GitHub main" -Status "pending" -Message "尚未确认 PR 合并" -Values @{ expectedCommit = ""; releaseCommit = $releaseCommit; observedCommit = $observed; branch = [string]$Policy.branch } -Issues $issues.ToArray()
        }
    }
    # 若能读取主线 config.js，再核对主线版本；读取失败不把未验证当成功。
    $versionProbe = Get-ReleaseReportGitValue -RepositoryRoot ([string]$Policy.canonicalRepo) -Arguments @("show", "$ref`:config.js")
    $mainVersion = ""
    if ($versionProbe.ok) {
        $m = [regex]::Match($versionProbe.value, '(?m)\b(?:appVersion|APP_VERSION|version)\s*[:=]\s*["''](\d+\.\d+\.\d+)["'']')
        if ($m.Success) { $mainVersion = $m.Groups[1].Value }
    }
    if (-not [string]::IsNullOrWhiteSpace($mainVersion) -and -not [string]::IsNullOrWhiteSpace([string]$Identity.version) -and $mainVersion -ne [string]$Identity.version) {
        [void]$issues.Add("main config.js 版本=$mainVersion，与发布版本=$($Identity.version) 不一致")
        return New-ReleaseReportEvidence -Name "GitHub main" -Status "fail" -Message "主线版本不一致" -Values @{ expectedCommit = $mainCommitExpected; releaseCommit = $releaseCommit; observedCommit = $observed; mainVersion = $mainVersion; branch = [string]$Policy.branch } -Issues $issues.ToArray()
    }
    if (-not $versionProbe.ok) { [void]$issues.Add("未能读取 main 上的 config.js 版本") }
    $status = if ($versionProbe.ok -and ([string]::IsNullOrWhiteSpace($mainVersion) -or $mainVersion -eq [string]$Identity.version)) { "pass" } else { "pending" }
    $message = if ($status -eq "pass") { "main 提交和版本已核对" } else { "提交已核对，版本证据不完整" }
    return New-ReleaseReportEvidence -Name "GitHub main" -Status $status -Message $message -Values @{ expectedCommit = $mainCommitExpected; releaseCommit = $releaseCommit; observedCommit = $observed; mainVersion = $mainVersion; branch = [string]$Policy.branch } -Issues $issues.ToArray()
}

function Get-ReleaseReportZipManifest {
    param([Parameter(Mandatory = $true)][string]$Path)
    $result = [ordered]@{ ok = $false; manifestPath = ""; values = [ordered]@{}; error = ""; entries = 0 }
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $archive = [IO.Compression.ZipFile]::OpenRead($Path)
        try {
            $result.entries = $archive.Entries.Count
            $entry = @($archive.Entries | Where-Object { $_.FullName -ieq "RELEASE-MANIFEST.txt" -or $_.FullName -ieq "release-manifest.json" -or $_.FullName -ieq "manifest.json" } | Select-Object -First 1)
            if ($entry.Count -eq 0) { throw "ZIP 内缺少 RELEASE-MANIFEST.txt/manifest.json" }
            $result.manifestPath = [string]$entry[0].FullName
            $reader = [IO.StreamReader]::new($entry[0].Open(), [Text.Encoding]::UTF8, $true, 65536)
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
            if ($text.Length -gt 262144) { throw "manifest 过大" }
            if ($result.manifestPath -like "*.json") {
                $json = $text | ConvertFrom-Json
                foreach ($name in @("schemaVersion", "operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "packageSha256", "mainCommit", "artifactPath")) {
                    if (Test-ReleaseReportProperty $json $name) { $result.values[$name] = Get-ReleaseReportProperty $json $name "" }
                }
            }
            else {
                $patterns = [ordered]@{
                    operationId = '(?m)^操作\s*ID\s*[：:]\s*(.+?)\s*$'
                    version = '(?m)^版本\s*[：:]\s*(.+?)\s*$'
                    sourceCommit = '(?m)^源提交\s*SHA\s*[：:]\s*(.+?)\s*$'
                    releaseCommit = '(?m)^提交\s*SHA\s*[：:]\s*(.+?)\s*$'
                    treeSha = '(?m)^Git\s*tree\s*SHA\s*[：:]\s*(.+?)\s*$'
                    sourceSha256 = '(?m)^源码内容\s*SHA256\s*[：:]\s*(.+?)\s*$'
                    artifactPath = '(?m)^产物文件名\s*[：:]\s*(.+?)\s*$'
                    mainCommit = '(?m)^主线提交\s*SHA\s*[：:]\s*(.+?)\s*$'
                }
                foreach ($name in $patterns.Keys) { $m = [regex]::Match($text, $patterns[$name]); if ($m.Success) { $result.values[$name] = $m.Groups[1].Value.Trim() } }
            }
            $result.ok = $true
        }
        finally { $archive.Dispose() }
    }
    catch { $result.error = [string]$_.Exception.Message }
    return [pscustomobject]$result
}

function Get-ReleaseReportArtifactEvidence {
    param([Parameter(Mandatory = $true)][object]$Policy, [Parameter(Mandatory = $true)][object]$Identity)
    $issues = [System.Collections.Generic.List[string]]::new()
    $path = [string]$Identity.artifactPath
    if ([string]::IsNullOrWhiteSpace($path)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$Identity.version)) {
            $pattern = "wechat-miniapp-release-v$([string]$Identity.version)-*.zip"
            $candidates = @(Get-ChildItem -LiteralPath ([string]$Policy.artifactRoot) -Filter $pattern -File -ErrorAction SilentlyContinue)
            if ($candidates.Count -eq 1) { $path = $candidates[0].FullName }
            elseif ($candidates.Count -gt 1) {
                [void]$issues.Add("发现多个同版本 ZIP，无法安全选择产物")
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        [void]$issues.Add("找不到不可变 ZIP 产物")
        return New-ReleaseReportEvidence -Name "ZIP" -Status "pending" -Message "缺少产物" -Values @{ path = $path; exists = $false; sizeBytes = 0; sha256 = ""; expectedSha256 = [string]$Identity.packageSha256; manifest = $null } -Issues $issues.ToArray()
    }
    $full = ConvertTo-ReleaseReportFullPath $path
    if (-not (Test-ReleaseReportPathInside -Path $full -Root ([string]$Policy.artifactRoot))) {
        [void]$issues.Add("ZIP 路径越过 artifactRoot")
    }
    $item = Get-Item -LiteralPath $full
    $actualSha = ""
    try { $actualSha = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() } catch { [void]$issues.Add("无法计算 ZIP SHA256") }
    $name = [IO.Path]::GetFileName($full)
    $namePattern = "^wechat-miniapp-release-v$([regex]::Escape([string]$Identity.version))-(?<commit>[0-9a-fA-F]{7,64})\.zip$"
    $nameMatch = [regex]::Match($name, $namePattern)
    if (-not [string]::IsNullOrWhiteSpace([string]$Identity.version) -and -not $nameMatch.Success) {
        [void]$issues.Add("ZIP 文件名没有绑定版本/commit：$name")
    }
    elseif ($nameMatch.Success -and -not [string]::IsNullOrWhiteSpace([string]$Identity.releaseCommit) -and
        -not [string]::Equals($nameMatch.Groups['commit'].Value, [string]$Identity.releaseCommit, [StringComparison]::OrdinalIgnoreCase)) {
        [void]$issues.Add("ZIP 文件名 commit 与 releaseCommit 不一致")
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Identity.packageSha256) -and $actualSha -ne [string]$Identity.packageSha256.ToLowerInvariant()) { [void]$issues.Add("ZIP SHA256 与 context 不一致") }
    $manifest = Get-ReleaseReportZipManifest -Path $full
    if (-not $manifest.ok) { [void]$issues.Add("ZIP manifest 校验失败：$($manifest.error)") }
    $manifestValues = $manifest.values
    foreach ($pair in @(@("operationId", $Identity.operationId), @("version", $Identity.version), @("releaseCommit", $Identity.releaseCommit), @("treeSha", $Identity.treeSha), @("sourceSha256", $Identity.sourceSha256))) {
        $key = [string]$pair[0]; $expected = [string]$pair[1]; $actual = [string](Get-ReleaseReportProperty $manifestValues $key "")
        if (-not [string]::IsNullOrWhiteSpace($expected) -and [string]::IsNullOrWhiteSpace($actual)) { [void]$issues.Add("ZIP manifest 缺少 $key") }
        elseif (-not [string]::IsNullOrWhiteSpace($expected) -and $actual -ne $expected) { [void]$issues.Add("ZIP manifest $key 不一致") }
    }
    $status = if ($issues.Count -eq 0 -and $manifest.ok -and -not [string]::IsNullOrWhiteSpace($actualSha)) { "pass" } else { "fail" }
    $message = if ($status -eq "pass") { "产物、SHA 和 manifest 已核对" } else { "产物存在但证据不一致" }
    return New-ReleaseReportEvidence -Name "ZIP" -Status $status -Message $message -Values @{ path = $full; exists = $true; sizeBytes = [int64]$item.Length; sha256 = $actualSha; expectedSha256 = [string]$Identity.packageSha256; manifest = [pscustomobject]@{ path = [string]$manifest.manifestPath; values = [pscustomobject]$manifestValues; entries = [int]$manifest.entries } } -Issues $issues.ToArray()
}

function Resolve-ReleaseReportQrPaths {
    param([Parameter(Mandatory = $true)][object]$Policy, [Parameter(Mandatory = $true)][object]$Operation, [Parameter(Mandatory = $true)][object]$Identity)
    $ctx = $Operation.context
    $record = $Operation.record
    $pick = {
        param([string]$Name)
        $v = [string](Get-ReleaseReportProperty $ctx $Name "")
        if ([string]::IsNullOrWhiteSpace($v)) { $v = [string](Get-ReleaseReportProperty $record $Name "") }
        return $v
    }
    $info = & $pick "previewInfoPath"
    $qr = & $pick "previewQrPath"
    if ([string]::IsNullOrWhiteSpace($info) -and -not [string]::IsNullOrWhiteSpace([string]$Identity.version) -and -not [string]::IsNullOrWhiteSpace([string]$Identity.releaseCommit)) {
        $expectedInfoName = "wechat-miniapp-preview-v$([string]$Identity.version)-$([string]$Identity.releaseCommit)-info.json"
        $found = @(Get-ChildItem -LiteralPath ([string]$Policy.artifactRoot) -Filter $expectedInfoName -File -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($found.Count -gt 0) { $info = $found[0].FullName }
    }
    if ([string]::IsNullOrWhiteSpace($qr) -and -not [string]::IsNullOrWhiteSpace($info)) { $qr = $info -replace '-info\.json$', '-qr.png' }
    return [pscustomobject]@{ qrPath = $qr; infoPath = $info }
}

function Get-ReleaseReportQrEvidence {
    param([Parameter(Mandatory = $true)][object]$Policy, [Parameter(Mandatory = $true)][object]$Operation, [Parameter(Mandatory = $true)][object]$Identity)
    $issues = [System.Collections.Generic.List[string]]::new()
    $paths = Resolve-ReleaseReportQrPaths -Policy $Policy -Operation $Operation -Identity $Identity
    $qr = [string]$paths.qrPath; $info = [string]$paths.infoPath
    if (-not [string]::IsNullOrWhiteSpace($qr) -and -not (Test-ReleaseReportPathInside -Path $qr -Root ([string]$Policy.artifactRoot))) { [void]$issues.Add("二维码路径越过 artifactRoot") }
    if (-not [string]::IsNullOrWhiteSpace($info) -and -not (Test-ReleaseReportPathInside -Path $info -Root ([string]$Policy.artifactRoot))) { [void]$issues.Add("二维码 info 路径越过 artifactRoot") }
    if (-not [string]::IsNullOrWhiteSpace($Identity.version) -and -not [string]::IsNullOrWhiteSpace($Identity.releaseCommit)) {
        $expectedQrName = "wechat-miniapp-preview-v$([string]$Identity.version)-$([string]$Identity.releaseCommit)-qr.png"
        $expectedInfoName = "wechat-miniapp-preview-v$([string]$Identity.version)-$([string]$Identity.releaseCommit)-info.json"
        if (-not [string]::IsNullOrWhiteSpace($qr) -and [IO.Path]::GetFileName((ConvertTo-ReleaseReportFullPath $qr)) -ne $expectedQrName) { [void]$issues.Add("二维码文件名未绑定版本/commit") }
        if (-not [string]::IsNullOrWhiteSpace($info) -and [IO.Path]::GetFileName((ConvertTo-ReleaseReportFullPath $info)) -ne $expectedInfoName) { [void]$issues.Add("二维码 info 文件名未绑定版本/commit") }
    }
    if ([string]::IsNullOrWhiteSpace($qr) -or -not (Test-Path -LiteralPath $qr -PathType Leaf)) { [void]$issues.Add("找不到二维码图片") }
    if ([string]::IsNullOrWhiteSpace($info) -or -not (Test-Path -LiteralPath $info -PathType Leaf)) { [void]$issues.Add("找不到二维码 info JSON") }
    if (-not [string]::IsNullOrWhiteSpace($qr) -and (Test-Path -LiteralPath $qr -PathType Leaf)) {
        try { if ((Get-Item -LiteralPath $qr).Length -le 0) { [void]$issues.Add("二维码图片为空") } } catch { [void]$issues.Add("无法读取二维码大小") }
    }
    $receipt = $null
    if ($issues.Count -eq 0) {
        $loaded = Read-ReleaseReportJsonFile -Path $info
        if ($null -eq $loaded.value) { [void]$issues.Add("二维码 info JSON 无法解析") } else { $receipt = $loaded.value }
    }
    if ($null -ne $receipt) {
        if (-not (Test-ReleaseReportProperty $receipt "schemaVersion") -or [int](Get-ReleaseReportProperty $receipt "schemaVersion" 0) -ne 1) { [void]$issues.Add("二维码 info schemaVersion 无效") }
        foreach ($pair in @(@("operationId", $Identity.operationId), @("appVersion", $Identity.version), @("gitCommit", $Identity.releaseCommit), @("treeSha", $Identity.treeSha), @("sourceSha256", $Identity.sourceSha256), @("artifactPath", $Identity.artifactPath), @("mainCommit", $Identity.mainCommit))) {
            $key = [string]$pair[0]; $expected = [string]$pair[1]; $actual = [string](Get-ReleaseReportProperty $receipt $key "")
            if ([string]::IsNullOrWhiteSpace($expected)) { [void]$issues.Add("发布身份缺少 $key") }
            elseif ([string]::IsNullOrWhiteSpace($actual)) { [void]$issues.Add("二维码 info 缺少 $key") }
            elseif ($actual -ne $expected) { [void]$issues.Add("二维码 info $key 不一致") }
        }
        if (-not (Test-ReleaseReportProperty $receipt "qrSha256") -or [string]::IsNullOrWhiteSpace([string](Get-ReleaseReportProperty $receipt "qrSha256" ""))) { [void]$issues.Add("二维码 info 缺少 qrSha256") }
        elseif (-not [string]::IsNullOrWhiteSpace($qr)) {
            try { $qrActual = (Get-FileHash -LiteralPath $qr -Algorithm SHA256).Hash.ToLowerInvariant(); if ($qrActual -ne ([string]$receipt.qrSha256).ToLowerInvariant()) { [void]$issues.Add("二维码 SHA256 与 info 不一致") } } catch { [void]$issues.Add("无法计算二维码 SHA256") }
        }
    }
    $qrExists = [bool]($qr -and (Test-Path -LiteralPath $qr -PathType Leaf) -and $info -and (Test-Path -LiteralPath $info -PathType Leaf))
    $status = if ($issues.Count -eq 0 -and $null -ne $receipt) { "pass" } elseif (($qr -and (Test-Path -LiteralPath $qr -PathType Leaf)) -or ($info -and (Test-Path -LiteralPath $info -PathType Leaf))) { "fail" } else { "pending" }
    $message = if ($status -eq "pass") { "二维码与 info 身份一致" } else { "二维码证据不完整或不一致" }
    $receiptSummary = $null
    if ($null -ne $receipt) { $receiptSummary = [pscustomobject]@{ schemaVersion = [int](Get-ReleaseReportProperty $receipt "schemaVersion" 0); operationId = [string](Get-ReleaseReportProperty $receipt "operationId" ""); appVersion = [string](Get-ReleaseReportProperty $receipt "appVersion" ""); gitCommit = [string](Get-ReleaseReportProperty $receipt "gitCommit" ""); mainCommit = [string](Get-ReleaseReportProperty $receipt "mainCommit" ""); treeSha = [string](Get-ReleaseReportProperty $receipt "treeSha" ""); sourceSha256 = [string](Get-ReleaseReportProperty $receipt "sourceSha256" ""); artifactPath = [string](Get-ReleaseReportProperty $receipt "artifactPath" ""); qrSha256 = [string](Get-ReleaseReportProperty $receipt "qrSha256" "") } }
    return New-ReleaseReportEvidence -Name "二维码" -Status $status -Message $message -Values @{ qrPath = $qr; infoPath = $info; exists = $qrExists; receipt = $receiptSummary } -Issues $issues.ToArray()
}

function Get-ReleaseReportCloudEvidence {
    param([Parameter(Mandatory = $true)][object]$Operation, [Parameter(Mandatory = $true)][object]$Identity)
    $issues = [System.Collections.Generic.List[string]]::new()
    $ctx = $Operation.context; $record = $Operation.record
    $receipt = Get-ReleaseReportProperty $ctx "cloudReceipt" $null
    if ($null -eq $receipt) { $deployment = Get-ReleaseReportProperty $ctx "cloudDeployment" $null; $receipt = Get-ReleaseReportProperty $deployment "receipt" $null }
    if ($null -eq $receipt) { $receipt = Get-ReleaseReportProperty $record "cloudReceipt" $null }
    if ($null -eq $receipt) {
        return New-ReleaseReportEvidence -Name "CloudBase" -Status "pending" -Message "尚未找到线上核验回执" -Values @{ receipt = $null; onlineBuildVersion = ""; onlineBuildMarker = "" } -Issues @("缺少 CloudBase verified receipt")
    }
    $receiptStatus = [string](Get-ReleaseReportProperty $receipt "status" (Get-ReleaseReportProperty $receipt "state" ""))
    if (-not (Test-ReleaseReportProperty $receipt "schemaVersion") -or [int](Get-ReleaseReportProperty $receipt "schemaVersion" 0) -ne 1) { [void]$issues.Add("CloudBase 回执 schemaVersion 无效") }
    foreach ($pair in @(@("operationId", $Identity.operationId), @("version", $Identity.version), @("releaseCommit", $Identity.releaseCommit), @("treeSha", $Identity.treeSha), @("sourceSha256", $Identity.sourceSha256), @("packageSha256", $Identity.packageSha256), @("mainCommit", $Identity.mainCommit))) {
        $key = [string]$pair[0]; $expected = [string]$pair[1]; $actual = [string](Get-ReleaseReportProperty $receipt $key "")
        if ([string]::IsNullOrWhiteSpace($expected)) { [void]$issues.Add("发布身份缺少 $key") }
        elseif ([string]::IsNullOrWhiteSpace($actual)) { [void]$issues.Add("CloudBase 回执缺少 $key") }
        elseif ($actual -ne $expected) { [void]$issues.Add("CloudBase 回执 $key 不一致") }
    }
    $onlineVersion = [string](Get-ReleaseReportProperty $receipt "onlineBuildVersion" "")
    $marker = [string](Get-ReleaseReportProperty $receipt "onlineBuildMarker" "")
    if ([string]::IsNullOrWhiteSpace($onlineVersion)) { [void]$issues.Add("CloudBase 回执缺少 onlineBuildVersion") }
    elseif ($onlineVersion -ne [string]$Identity.version) { [void]$issues.Add("线上 API build version=$onlineVersion，与发布版本=$($Identity.version) 不一致") }
    if ([string]::IsNullOrWhiteSpace($marker)) { [void]$issues.Add("CloudBase 回执缺少 onlineBuildMarker") }
    if ($receiptStatus -ne "verified") { [void]$issues.Add("CloudBase 回执状态=$receiptStatus（必须为 verified）") }
    if ($issues.Count -gt 0) { $status = "fail" } else { $status = "pass" }
    $message = if ($status -eq "pass") { "线上版本和构建标记已核对" } else { "线上核验未完成或不一致" }
    return New-ReleaseReportEvidence -Name "CloudBase" -Status $status -Message $message -Values @{ receipt = [pscustomobject]@{ schemaVersion = [int](Get-ReleaseReportProperty $receipt "schemaVersion" 0); status = $receiptStatus; operationId = [string](Get-ReleaseReportProperty $receipt "operationId" ""); version = [string](Get-ReleaseReportProperty $receipt "version" ""); releaseCommit = [string](Get-ReleaseReportProperty $receipt "releaseCommit" ""); mainCommit = [string](Get-ReleaseReportProperty $receipt "mainCommit" ""); treeSha = [string](Get-ReleaseReportProperty $receipt "treeSha" ""); sourceSha256 = [string](Get-ReleaseReportProperty $receipt "sourceSha256" ""); packageSha256 = [string](Get-ReleaseReportProperty $receipt "packageSha256" "") }; onlineBuildVersion = $onlineVersion; onlineBuildMarker = $marker } -Issues $issues.ToArray()
}

function Get-ReleaseReportOperationStatus {
    param([Parameter(Mandatory = $true)][object]$Operation)
    foreach ($source in @($Operation.ticket, $Operation.context, $Operation.record)) {
        $status = [string](Get-ReleaseReportProperty $source "terminalStatus" "")
        if ([string]::IsNullOrWhiteSpace($status)) { $status = [string](Get-ReleaseReportProperty $source "status" "") }
        if (-not [string]::IsNullOrWhiteSpace($status)) { return $status.ToLowerInvariant() }
    }
    return "pending"
}

function Get-ReleaseReportState {
    param([AllowNull()][object]$Object)
    if ($null -eq $Object) { return "" }
    # status 是当前状态，terminalStatus 是终态快照。优先读 status，
    # 避免旧 terminalStatus 残留把 prepared/running 误判成 succeeded；
    # 两者冲突时由上层状态一致性检查关闸。
    $state = [string](Get-ReleaseReportProperty $Object "status" "")
    if ([string]::IsNullOrWhiteSpace($state)) { $state = [string](Get-ReleaseReportProperty $Object "terminalStatus" "") }
    if ([string]::IsNullOrWhiteSpace($state)) { return "" }
    switch ($state.Trim().ToLowerInvariant()) {
        "success" { return "succeeded" }
        "successful" { return "succeeded" }
        "已推送" { return "succeeded" }
        "done" { return "succeeded" }
        "error" { return "failed" }
        default { return $state.Trim().ToLowerInvariant() }
    }
}

function Compare-ReleaseReportVersion {
    param([Parameter(Mandatory = $true)][string]$Left, [Parameter(Mandatory = $true)][string]$Right)
    $leftMatch = [regex]::Match($Left.Trim(), '^(\d+)\.(\d+)\.(\d+)$')
    $rightMatch = [regex]::Match($Right.Trim(), '^(\d+)\.(\d+)\.(\d+)$')
    if (-not $leftMatch.Success -or -not $rightMatch.Success) { throw "无法比较无效版本：$Left / $Right" }
    for ($i = 1; $i -le 3; $i += 1) {
        $l = [int]$leftMatch.Groups[$i].Value; $r = [int]$rightMatch.Groups[$i].Value
        if ($l -lt $r) { return -1 }
        if ($l -gt $r) { return 1 }
    }
    return 0
}

function Get-ReleaseReportData {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [string]$OperationId = "",
        [string]$ContextPath = "",
        [AllowNull()][object]$Ticket = $null,
        [switch]$SkipGit,
        [switch]$SkipZip
    )
    $operation = Resolve-ReleaseReportOperation -Policy $Policy -OperationId $OperationId -ContextPath $ContextPath -Ticket $Ticket
    $identity = Get-ReleaseReportIdentity -Operation $operation
    $contextState = Get-ReleaseReportState $operation.context
    $recordState = Get-ReleaseReportState $operation.record
    $queueState = Get-ReleaseReportState $operation.ticket
    $contextIssues = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $operation.context) { [void]$contextIssues.Add("找不到 release context") }
    else {
        foreach ($key in @("operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "packageSha256", "artifactPath")) { if ([string]::IsNullOrWhiteSpace([string](Get-ReleaseReportProperty $operation.context $key ""))) { [void]$contextIssues.Add("context 缺少 $key") } }
        if ([string](Get-ReleaseReportProperty $operation.context "operationId" "") -ne $identity.operationId) { [void]$contextIssues.Add("context operationId 不一致") }
        $ctxArtifact = [string](Get-ReleaseReportProperty $operation.context "artifactPath" "")
        if (-not [string]::IsNullOrWhiteSpace($ctxArtifact) -and -not (Test-ReleaseReportPathInside -Path $ctxArtifact -Root ([string]$Policy.artifactRoot))) { [void]$contextIssues.Add("context artifactPath 越过 artifactRoot") }
    }
    $recordIssues = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $operation.record) { [void]$recordIssues.Add("找不到 release record") }
    else {
        foreach ($key in @("operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "packageSha256", "packagePath")) { if ([string]::IsNullOrWhiteSpace([string](Get-ReleaseReportProperty $operation.record $key ""))) { [void]$recordIssues.Add("record 缺少 $key") } }
        if ([string](Get-ReleaseReportProperty $operation.record "operationId" "") -ne $identity.operationId) { [void]$recordIssues.Add("record operationId 不一致") }
        $recordArtifact = [string](Get-ReleaseReportProperty $operation.record "packagePath" "")
        if (-not [string]::IsNullOrWhiteSpace($recordArtifact) -and -not (Test-ReleaseReportPathInside -Path $recordArtifact -Root ([string]$Policy.artifactRoot))) { [void]$recordIssues.Add("record packagePath 越过 artifactRoot") }
    }
    $queueTicket = $operation.ticket
    $queueIssues = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $queueTicket) { [void]$queueIssues.Add("队列中没有该操作") }
    else {
        if ([string](Get-ReleaseReportProperty $queueTicket "operationId" "") -ne $identity.operationId) { [void]$queueIssues.Add("队列 operationId 不一致") }
        $queueVersion = [string](Get-ReleaseReportProperty $queueTicket "version" "")
        if (-not [string]::IsNullOrWhiteSpace($queueVersion) -and $queueVersion -ne $identity.version) { [void]$queueIssues.Add("队列版本与 context 不一致") }
    }

    # 队列、context、record 是同一个状态机的三份副本。若其中一份已经说
    # “成功”，另外一份却仍是 prepared/running/缺失，报告必须关闸，不能
    # 只看某一份的 succeeded 字段。
    if ($queueState -eq "succeeded") {
        if ($contextState -ne "succeeded") { [void]$contextIssues.Add("队列已 succeeded，但 context 状态是 $([string]$contextState)") }
        if ($recordState -ne "succeeded") { [void]$recordIssues.Add("队列已 succeeded，但 record 状态是 $([string]$recordState)") }
    }
    $terminalStates = @("succeeded", "failed", "cancelled", "expired")
    foreach ($pair in @(@("queue", $queueState), @("context", $contextState), @("record", $recordState))) {
        $name = [string]$pair[0]; $state = [string]$pair[1]
        if ([string]::IsNullOrWhiteSpace($state) -or $terminalStates -notcontains $state) { continue }
        foreach ($other in @(@("queue", $queueState), @("context", $contextState), @("record", $recordState))) {
            $otherName = [string]$other[0]; $otherState = [string]$other[1]
            if ($otherName -eq $name -or [string]::IsNullOrWhiteSpace($otherState) -or $terminalStates -notcontains $otherState -or $otherState -eq $state) { continue }
            $message = "状态副本不一致：$name=$state，$otherName=$otherState"
            if ($name -eq "queue" -or $otherName -eq "queue") { [void]$queueIssues.Add($message) }
            if ($name -eq "context" -or $otherName -eq "context") { [void]$contextIssues.Add($message) }
            if ($name -eq "record" -or $otherName -eq "record") { [void]$recordIssues.Add($message) }
        }
    }
    $contextStatus = if ($null -eq $operation.context) { "pending" } elseif ($contextIssues.Count -eq 0) { "pass" } else { "fail" }
    $contextMessage = if ($contextIssues.Count -eq 0) { "context 身份字段完整" } else { "context 不完整或状态冲突" }
    $contextEvidence = New-ReleaseReportEvidence -Name "release context" -Status $contextStatus -Message $contextMessage -Values @{ path = [string]$operation.contextPath; exists = $null -ne $operation.context; phase = [string](Get-ReleaseReportProperty $operation.context "phase" ""); status = [string](Get-ReleaseReportProperty $operation.context "status" "") } -Issues $contextIssues.ToArray()
    $recordStatus = if ($null -eq $operation.record) { "pending" } elseif ($recordIssues.Count -eq 0) { "pass" } else { "fail" }
    $recordMessage = if ($recordIssues.Count -eq 0) { "record 身份字段完整" } else { "record 不完整或状态冲突" }
    $recordEvidence = New-ReleaseReportEvidence -Name "release record" -Status $recordStatus -Message $recordMessage -Values @{ path = [string]$operation.recordPath; exists = $null -ne $operation.record; status = [string](Get-ReleaseReportProperty $operation.record "status" ""); terminalStatus = [string](Get-ReleaseReportProperty $operation.record "terminalStatus" "") } -Issues $recordIssues.ToArray()
    $queueStatus = if ($null -eq $queueTicket) { "pending" } elseif ($queueIssues.Count -eq 0) { "pass" } else { "fail" }
    $queueMessage = if ($queueIssues.Count -eq 0) { "队列票据已找到" } else { "队列票据不一致或状态冲突" }
    $queueEvidence = New-ReleaseReportEvidence -Name "发布队列" -Status $queueStatus -Message $queueMessage -Values @{ sequence = [int](Get-ReleaseReportProperty $queueTicket "sequence" 0); ticketId = [string](Get-ReleaseReportProperty $queueTicket "ticketId" ""); status = [string](Get-ReleaseReportProperty $queueTicket "status" ""); phase = [string](Get-ReleaseReportProperty $queueTicket "phase" ""); updatedAt = [string](Get-ReleaseReportProperty $queueTicket "updatedAt" ""); lastError = ConvertTo-ReleaseReportSafeText (Get-ReleaseReportProperty $queueTicket "lastError" "") } -Issues $queueIssues.ToArray()

    $reservationIssues = [System.Collections.Generic.List[string]]::new()
    $reservation = $operation.reservation
    if ($null -eq $reservation) { [void]$reservationIssues.Add("找不到 reservation") }
    else {
        $reservationOp = [string](Get-ReleaseReportProperty $reservation "operationId" "")
        $reservationVersion = [string](Get-ReleaseReportProperty $reservation "targetVersion" (Get-ReleaseReportProperty $reservation "version" ""))
        if ([string]::IsNullOrWhiteSpace($reservationOp) -or $reservationOp -ne $identity.operationId) { [void]$reservationIssues.Add("reservation operationId 不一致") }
        if ([string]::IsNullOrWhiteSpace($reservationVersion) -or $reservationVersion -ne $identity.version) { [void]$reservationIssues.Add("reservation version 不一致") }
    }
    $reservationState = Get-ReleaseReportState $reservation
    $reservationStatus = if ($null -eq $reservation) { "fail" } elseif ($reservationIssues.Count -gt 0) { "fail" } elseif ($reservationState -eq "succeeded") { "pass" } elseif ($reservationState -in @("failed", "cancelled", "expired", "recoverable")) { "fail" } else { "pending" }
    if ($reservationStatus -eq "pending" -and $queueState -eq "succeeded") { [void]$reservationIssues.Add("队列已 succeeded，但 reservation 尚未 succeeded"); $reservationStatus = "fail" }
    $reservationMessage = if ($reservationStatus -eq "pass") { "reservation 身份和状态已核对" } elseif ($reservationStatus -eq "pending") { "reservation 尚未完成" } else { "reservation 缺失或不一致" }
    $reservationEvidence = New-ReleaseReportEvidence -Name "reservation" -Status $reservationStatus -Message $reservationMessage -Values @{ path = [string]$operation.reservationPath; exists = $null -ne $reservation; status = [string](Get-ReleaseReportProperty $reservation "status" ""); targetVersion = [string](Get-ReleaseReportProperty $reservation "targetVersion" (Get-ReleaseReportProperty $reservation "version" "")) } -Issues $reservationIssues.ToArray()

    $mainEvidence = if ($SkipGit) { New-ReleaseReportEvidence -Name "GitHub main" -Status "pending" -Message "跳过 Git 读取" } else { Get-ReleaseReportMainEvidence -Policy $Policy -Identity $identity -Operation $operation }
    $artifactEvidence = if ($SkipZip) { New-ReleaseReportEvidence -Name "ZIP" -Status "pending" -Message "跳过 ZIP 读取" } else { Get-ReleaseReportArtifactEvidence -Policy $Policy -Identity $identity }
    $qrEvidence = Get-ReleaseReportQrEvidence -Policy $Policy -Operation $operation -Identity $identity
    $cloudEvidence = Get-ReleaseReportCloudEvidence -Operation $operation -Identity $identity
    $evidence = [ordered]@{ main = $mainEvidence; artifact = $artifactEvidence; qr = $qrEvidence; cloudbase = $cloudEvidence; reservation = $reservationEvidence }
    $all = @($contextEvidence, $recordEvidence, $queueEvidence, $reservationEvidence, $mainEvidence, $artifactEvidence, $qrEvidence, $cloudEvidence)
    $failCount = @($all | Where-Object { $_.status -eq "fail" }).Count
    $pendingCount = @($all | Where-Object { $_.status -eq "pending" }).Count
    $operationStatus = Get-ReleaseReportOperationStatus -Operation $operation
    $verdict = if ($failCount -gt 0 -or $operationStatus -in @("failed", "cancelled", "expired")) { "failed" } elseif ($pendingCount -gt 0 -or $operationStatus -in @("queued", "leased", "running", "prepared", "recoverable", "pending", "finalizing")) { "pending" } else { "succeeded" }
    if ($operationStatus -eq "recoverable" -and $verdict -eq "pending") { $verdict = "recoverable" }
    $issues = @($all | ForEach-Object { @($_.issues) } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    $ctx = $operation.context
    $recordForTime = $operation.record
    $stableGeneratedAt = [string](Get-ReleaseReportProperty $ctx "completedAt" "")
    if ([string]::IsNullOrWhiteSpace($stableGeneratedAt)) { $stableGeneratedAt = [string](Get-ReleaseReportProperty $recordForTime "completedAt" "") }
    if ([string]::IsNullOrWhiteSpace($stableGeneratedAt)) { $stableGeneratedAt = [string](Get-ReleaseReportProperty $ctx "generatedAt" "") }
    if ([string]::IsNullOrWhiteSpace($stableGeneratedAt)) { $stableGeneratedAt = [string](Get-ReleaseReportProperty $recordForTime "generatedAt" "") }
    if ([string]::IsNullOrWhiteSpace($stableGeneratedAt)) { $stableGeneratedAt = [DateTimeOffset]::UtcNow.ToString("o") }
    $report = [pscustomobject][ordered]@{
        schemaVersion = 1
        reportType = "wechat-miniapp-release-acceptance"
        operationId = $identity.operationId
        version = $identity.version
        status = $verdict
        verdict = $verdict
        operationStatus = $operationStatus
        # 优先沿用 context/record 的固定时间，重复查看同一操作时报告内容
        # 保持相同，才能安全幂等复用不可变报告文件。
        generatedAt = $stableGeneratedAt
        expiresAt = $identity.expiresAt
        canonicalRepo = [string]$Policy.canonicalRepo
        remote = [string]$Policy.remote
        branch = [string]$Policy.branch
        sourceCommit = $identity.sourceCommit
        releaseCommit = $identity.releaseCommit
        mainCommit = $identity.mainCommit
        treeSha = $identity.treeSha
        sourceSha256 = $identity.sourceSha256
        packageSha256 = $identity.packageSha256
        artifactPath = $identity.artifactPath
        releaseBranch = $identity.releaseBranch
        pullRequest = $identity.pullRequest
        queue = $queueEvidence
        context = $contextEvidence
        record = $recordEvidence
        reservation = $reservationEvidence
        evidence = [pscustomobject]$evidence
        summary = [pscustomobject][ordered]@{ total = $all.Count; pass = @($all | Where-Object status -eq "pass").Count; pending = $pendingCount; fail = $failCount }
        issues = @($issues | Select-Object -Unique)
        paths = [pscustomobject][ordered]@{ context = [string]$operation.contextPath; record = [string]$operation.recordPath; reservation = [string]$operation.reservationPath; log = (Join-Path ([string]$Policy.logRoot) "release-$($identity.operationId).log"); report = ""; markdown = ""; latest = [string]$Policy.latestReleasePath }
    }
    return $report
}

function ConvertTo-ReleaseReportMarkdown {
    param([Parameter(Mandatory = $true)][object]$Report)
    $icon = @{ succeeded = "✅"; pass = "✅"; pending = "⏳"; recoverable = "⚠️"; failed = "❌"; fail = "❌" }
    $statusText = [string](Get-ReleaseReportProperty $Report "status" "pending")
    $rows = New-Object System.Collections.Generic.List[string]
    [void]$rows.Add("# 微信小程序发布验收报告")
    [void]$rows.Add("")
    [void]$rows.Add("- 结果：$($icon[$statusText]) $statusText")
    [void]$rows.Add("- 操作 ID：$([string]$Report.operationId)")
    [void]$rows.Add("- 版本：$([string]$Report.version)")
    [void]$rows.Add("- release commit：$([string]$Report.releaseCommit)")
    [void]$rows.Add("- tree：$([string]$Report.treeSha)")
    [void]$rows.Add("- 源码 SHA256：$([string]$Report.sourceSha256)")
    [void]$rows.Add("")
    [void]$rows.Add("| 检查项 | 状态 | 说明 |")
    [void]$rows.Add("|---|---|---|")
    foreach ($entry in @(@("队列", $Report.queue), @("release context", $Report.context), @("release record", $Report.record), @("reservation", $Report.evidence.reservation), @("GitHub main", $Report.evidence.main), @("ZIP", $Report.evidence.artifact), @("二维码", $Report.evidence.qr), @("CloudBase", $Report.evidence.cloudbase))) {
        $name = [string]$entry[0]; $value = $entry[1]; $s = [string](Get-ReleaseReportProperty $value "status" "pending"); $msg = [string](Get-ReleaseReportProperty $value "message" "")
        $issues = @((Get-ReleaseReportProperty $value "issues" @())) -join "；"
        if (-not [string]::IsNullOrWhiteSpace($issues)) { $msg = "$msg：$issues" }
        $msg = $msg.Replace("|", "\\|").Replace("`r", " ").Replace("`n", " ")
        [void]$rows.Add("| $name | $($icon[$s]) $s | $msg |")
    }
    [void]$rows.Add("")
    [void]$rows.Add("汇总：通过 $([int]$Report.summary.pass)，待核对 $([int]$Report.summary.pending)，失败 $([int]$Report.summary.fail)。")
    return (($rows.ToArray()) -join [Environment]::NewLine) + [Environment]::NewLine
}

function Get-ReleaseReportSha256Text {
    param([Parameter(Mandatory = $true)][string]$Text)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($bytes)) -replace "-", "").ToLowerInvariant() } finally { $hash.Dispose() }
}

function Write-ReleaseReportImmutableText {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Text)
    $full = ConvertTo-ReleaseReportFullPath $Path
    $parent = Split-Path $full -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $desiredSha = Get-ReleaseReportSha256Text -Text $Text
    if (Test-Path -LiteralPath $full -PathType Leaf) {
        $existing = [IO.File]::ReadAllText($full, [Text.UTF8Encoding]::new($false))
        $existingSha = Get-ReleaseReportSha256Text -Text $existing
        if ($existingSha -eq $desiredSha) { return [pscustomobject]@{ path = $full; sha256 = $desiredSha; reused = $true } }
        throw "报告同名文件内容不同，禁止覆盖：$full"
    }
    $temp = "$full.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temp, $Text, [Text.UTF8Encoding]::new($false))
        try { [IO.File]::Move($temp, $full) }
        catch {
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                $existing = [IO.File]::ReadAllText($full, [Text.UTF8Encoding]::new($false))
                if ((Get-ReleaseReportSha256Text $existing) -eq $desiredSha) { return [pscustomobject]@{ path = $full; sha256 = $desiredSha; reused = $true } }
            }
            throw
        }
        return [pscustomobject]@{ path = $full; sha256 = $desiredSha; reused = $false }
    }
    finally { if (Test-Path -LiteralPath $temp -PathType Leaf) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue } }
}

function Enter-ReleaseReportLatestGuard {
    <# 与 release-gate.ps1 共用这一把 latest 指针互斥体。不要改名，
       否则 status/report 与正式发布会再次出现两套锁。 #>
    param([ValidateRange(1, 120)][int]$WaitSeconds = 30)
    $mutex = $null
    $owns = $false
    try {
        $mutex = [Threading.Mutex]::new($false, 'Local\wechat-miniapp-release-latest')
        try { $owns = $mutex.WaitOne([TimeSpan]::FromSeconds($WaitSeconds)) }
        catch [Threading.AbandonedMutexException] { $owns = $true }
        if (-not $owns) { throw "等待 latest 指针写入锁超时。" }
        return [pscustomobject]@{ mutex = $mutex; owns = $true }
    }
    catch {
        if ($null -ne $mutex) {
            try { if ($owns) { $mutex.ReleaseMutex() } } catch {}
            try { $mutex.Dispose() } catch {}
        }
        throw
    }
}

function Exit-ReleaseReportLatestGuard {
    param([AllowNull()][object]$Guard)
    if ($null -eq $Guard) { return }
    try { if ($Guard.owns -and $null -ne $Guard.mutex) { $Guard.mutex.ReleaseMutex() } } catch {}
    finally { try { if ($null -ne $Guard.mutex) { $Guard.mutex.Dispose() } } catch {} }
}

function Write-ReleaseReportLatestAtomic {
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][object]$Report,
        [Parameter(Mandatory = $true)][string]$ReportPath,
        [Parameter(Mandatory = $true)][string]$MarkdownPath,
        [switch]$LatestLockHeld
    )
    if ([string]$Report.status -ne "succeeded") { return [pscustomobject]@{ updated = $false; path = [string]$Policy.latestReleasePath; reason = "失败或待核对报告不能覆盖 latest" } }
    $candidateVersion = [string](Get-ReleaseReportProperty $Report "version" "")
    if ([string]::IsNullOrWhiteSpace($candidateVersion)) { throw "成功报告缺少版本，不能更新 latest" }
    $path = ConvertTo-ReleaseReportFullPath ([string]$Policy.latestReleasePath)
    $canonicalParent = Split-Path (ConvertTo-ReleaseReportFullPath ([string]$Policy.canonicalRepo)) -Parent
    if (-not (Test-ReleaseReportPathInside -Path $path -Root $canonicalParent)) { throw "latest 路径越过 canonical 仓库父目录，拒绝写入：$path" }
    $guard = $null
    try {
        if (-not $LatestLockHeld) { $guard = Enter-ReleaseReportLatestGuard }

        # Re-read all mutable state only after taking the shared guard.  The
        # pre-check and replacement therefore form one CAS-like critical
        # section even when status/report and release-gate run together.
        $oldLoaded = $null
        $oldSha = ""
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $oldLoaded = Read-ReleaseReportJsonFile -Path $path
            if ($null -eq $oldLoaded.value) { throw "已有 latest-release.json 无法解析，拒绝覆盖：$path" }
            $oldSha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            $oldVersion = [string](Get-ReleaseReportProperty $oldLoaded.value "version" "")
            if (-not [string]::IsNullOrWhiteSpace($oldVersion)) {
                $comparison = Compare-ReleaseReportVersion -Left $candidateVersion -Right $oldVersion
                if ($comparison -lt 0) { return [pscustomobject]@{ updated = $false; path = $path; reason = "候选版本低于当前 latest，保持原指针" } }
                if ($comparison -eq 0) {
                    $sameIdentity = $true
                    foreach ($key in @("operationId", "releaseCommit", "mainCommit", "treeSha", "sourceSha256", "packageSha256", "artifactPath")) {
                        $left = [string](Get-ReleaseReportProperty $Report $key "")
                        $right = [string](Get-ReleaseReportProperty $oldLoaded.value $key "")
                        # Older latest pointers did not carry mainCommit.  A
                        # missing legacy value is safe to backfill when every
                        # other identity field matches; a non-empty mismatch
                        # remains a hard conflict.
                        if ($key -eq "mainCommit" -and [string]::IsNullOrWhiteSpace($right)) { continue }
                        if ($left -ne $right) { $sameIdentity = $false; break }
                    }
                    if ($sameIdentity) { return [pscustomobject]@{ updated = $false; path = $path; reason = "同版本同身份，幂等复用 latest" } }
                    throw "latest 同版本但身份不同，拒绝覆盖：$path"
                }
            }
        }
        $latest = [pscustomobject][ordered]@{
            schemaVersion = 1
            reportType = "wechat-miniapp-latest-release"
            operationId = [string]$Report.operationId
            version = [string]$Report.version
            releaseCommit = [string]$Report.releaseCommit
            mainCommit = [string](Get-ReleaseReportProperty $Report "mainCommit" "")
            treeSha = [string]$Report.treeSha
            sourceSha256 = [string]$Report.sourceSha256
            packageSha256 = [string]$Report.packageSha256
            artifactPath = [string]$Report.artifactPath
            reportPath = (Assert-ReleaseReportPathInside -Path $ReportPath -Root ([string]$Policy.reportRoot) -Label "报告 JSON")
            markdownPath = (Assert-ReleaseReportPathInside -Path $MarkdownPath -Root ([string]$Policy.reportRoot) -Label "报告 Markdown")
            updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        }
        $latestText = ($latest | ConvertTo-Json -Depth 12) + [Environment]::NewLine
        $parent = Split-Path $path -Parent
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        $temp = "$path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
        # File.Replace is atomic on NTFS but requires a real backup filename.
        # Keep the backup beside the destination and remove it only after the
        # replacement/fallback has completed; never pass $null, which makes
        # Windows reject the call on some versions of .NET.
        $backup = "$path.$PID.$([guid]::NewGuid().ToString('N')).bak"
        try {
            [IO.File]::WriteAllText($temp, $latestText, [Text.UTF8Encoding]::new($false))
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                # CAS guard: an out-of-band writer changed the file after the
                # snapshot; never replace its newer pointer.
                $beforeReplace = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($beforeReplace -ne $oldSha) { throw "latest 在写入前发生变化，拒绝覆盖：$path" }
                try { [IO.File]::Replace($temp, $path, $backup, $true) }
                catch [PlatformNotSupportedException] { [IO.File]::Move($temp, $path, $true) }
                catch [NotSupportedException] { [IO.File]::Move($temp, $path, $true) }
            }
            else {
                try { [IO.File]::Move($temp, $path) }
                catch {
                    if (Test-Path -LiteralPath $path -PathType Leaf) {
                        $winner = Read-ReleaseReportJsonFile -Path $path
                        if ($null -ne $winner.value -and [string](Get-ReleaseReportProperty $winner.value "operationId" "") -eq [string]$Report.operationId -and [string](Get-ReleaseReportProperty $winner.value "version" "") -eq $candidateVersion) {
                            return [pscustomobject]@{ updated = $false; path = $path; reason = "并发写入同一版本，幂等复用 latest" }
                        }
                    }
                    throw
                }
            }
            return [pscustomobject]@{ updated = $true; path = $path; reason = "" }
        }
        finally {
            if (Test-Path -LiteralPath $temp -PathType Leaf) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
        }
    }
    finally { if (-not $LatestLockHeld) { Exit-ReleaseReportLatestGuard -Guard $guard } }
}

function Write-ReleaseReportArtifacts {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][object]$Report,
        [string]$JsonPath = "",
        [string]$MarkdownPath = "",
        [switch]$UpdateLatest,
        [switch]$LatestLockHeld
    )
    $root = [string]$Policy.reportRoot
    if ([string]::IsNullOrWhiteSpace($JsonPath)) { $JsonPath = Join-Path $root "release-$([string]$Report.operationId).json" }
    if ([string]::IsNullOrWhiteSpace($MarkdownPath)) { $MarkdownPath = Join-Path $root "release-$([string]$Report.operationId).md" }
    $JsonPath = Assert-ReleaseReportPathInside -Path $JsonPath -Root $root -Label "报告 JSON"
    $MarkdownPath = Assert-ReleaseReportPathInside -Path $MarkdownPath -Root $root -Label "报告 Markdown"
    if ($Report -is [System.Collections.IDictionary]) {
        if (-not $Report.Contains("paths") -or $null -eq $Report["paths"]) { $Report["paths"] = [pscustomobject][ordered]@{} }
    }
    elseif ($null -eq $Report.PSObject.Properties["paths"] -or $null -eq $Report.paths) {
        $Report | Add-Member -NotePropertyName paths -NotePropertyValue ([pscustomobject][ordered]@{}) -Force
    }
    # 路径属于报告身份的一部分，先写入对象再序列化，避免磁盘上的 JSON
    # 和命令返回值出现空 paths.report/paths.markdown。
    $Report.paths.report = (ConvertTo-ReleaseReportFullPath $JsonPath)
    $Report.paths.markdown = (ConvertTo-ReleaseReportFullPath $MarkdownPath)
    $jsonText = ($Report | ConvertTo-Json -Depth 60) + [Environment]::NewLine
    $mdText = ConvertTo-ReleaseReportMarkdown -Report $Report
    $jsonResult = Write-ReleaseReportImmutableText -Path $JsonPath -Text $jsonText
    $mdResult = Write-ReleaseReportImmutableText -Path $MarkdownPath -Text $mdText
    $Report.paths.report = $jsonResult.path
    $Report.paths.markdown = $mdResult.path
    $latestResult = if ($UpdateLatest) { Write-ReleaseReportLatestAtomic -Policy $Policy -Report $Report -ReportPath $jsonResult.path -MarkdownPath $mdResult.path -LatestLockHeld:$LatestLockHeld } else { [pscustomobject]@{ updated = $false; path = [string]$Policy.latestReleasePath; reason = "未请求更新 latest" } }
    return [pscustomobject][ordered]@{ report = $Report; json = $jsonResult; markdown = $mdResult; latest = $latestResult }
}

function Format-ReleaseReportStatusLine {
    param([Parameter(Mandatory = $true)][object]$Report)
    $e = $Report.evidence
    return [pscustomobject][ordered]@{
        sequence = [int](Get-ReleaseReportProperty $Report.queue "sequence" 0)
        operationId = [string]$Report.operationId
        version = [string]$Report.version
        phase = [string](Get-ReleaseReportProperty $Report.queue "phase" (Get-ReleaseReportProperty $Report.context "phase" ""))
        status = [string]$Report.status
        main = [string](Get-ReleaseReportProperty $e.main "status" "pending")
        artifact = [string](Get-ReleaseReportProperty $e.artifact "status" "pending")
        qr = [string](Get-ReleaseReportProperty $e.qr "status" "pending")
        cloudbase = [string](Get-ReleaseReportProperty $e.cloudbase "status" "pending")
        reportPath = [string](Get-ReleaseReportProperty $Report.paths "report" "")
    }
}

# 命令行薄封装。参数名前缀避免 dot-source 到 release-status.ps1 时覆盖调用方变量。
if ($MyInvocation.InvocationName -ne ".") {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $policy = Get-ReleaseReportPolicy -PolicyPath $RRPolicyPath -RepositoryRoot $repoRoot
    $report = Get-ReleaseReportData -Policy $policy -OperationId $RROperationId -ContextPath $RRContextPath -SkipGit:$RRSkipGit -SkipZip:$RRSkipZip
    $written = $null
    if (-not $RRNoWrite) { $written = Write-ReleaseReportArtifacts -Policy $policy -Report $report -JsonPath $RRJsonPath -MarkdownPath $RRMarkdownPath -UpdateLatest:$(-not $RRNoLatest) }
    if ($null -ne $written) { $report = $written.report }
    if ($RRMarkdown) { if ($null -ne $written -and (Test-Path -LiteralPath $written.markdown.path -PathType Leaf)) { Get-Content -LiteralPath $written.markdown.path -Raw -Encoding UTF8 } else { ConvertTo-ReleaseReportMarkdown -Report $report } }
    elseif ($RRJson -or $true) { $report | ConvertTo-Json -Depth 60 }
}
