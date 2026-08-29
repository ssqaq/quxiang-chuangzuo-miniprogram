[CmdletBinding()]
param(
    [string]$OperationId = "",
    [string]$PolicyPath = "",
    [switch]$Json,
    [switch]$Report,
    [switch]$IncludeTerminal,
    [switch]$RecoverExpired,
    [switch]$NoWrite,
    [string]$JsonPath = "",
    [string]$MarkdownPath = "",
    [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
    [ValidateRange(25, 5000)][int]$PollMilliseconds = 250,
    [ValidateRange(1, 500)][int]$Limit = 0
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$reportScript = Join-Path $PSScriptRoot "release-report.ps1"
if (-not (Test-Path -LiteralPath $reportScript -PathType Leaf)) { throw "缺少发布报告工具：$reportScript" }
. $reportScript

# 生产状态入口继续复用 canonical 策略校验；报告聚合器本身只读，避免
# status 页面为了展示信息而偷偷领取租约或改写队列。
$gateScript = Join-Path $PSScriptRoot "release-gate.ps1"
$queueScript = Join-Path $PSScriptRoot "release-queue.ps1"
if (-not (Test-Path -LiteralPath $gateScript -PathType Leaf)) { throw "缺少发布闸门工具：$gateScript" }
if (-not (Test-Path -LiteralPath $queueScript -PathType Leaf)) { throw "缺少发布队列工具：$queueScript" }
. $gateScript
. $queueScript
$policy = Get-ReleaseGatePolicy -PolicyPath $PolicyPath -RepositoryRoot $repoRoot
Assert-ReleaseCanonicalPolicy -Policy $policy -RepositoryRoot $repoRoot | Out-Null

function Get-StatusQueueTickets {
    param([Parameter(Mandatory = $true)][object]$Policy)
    try {
        # IncludeTerminal 让状态面板同时看得到已完成/失败历史；不传
        # RecoverExpired 时完全只读，避免查看页面改变队列。
        $showTerminal = $IncludeTerminal -or -not [string]::IsNullOrWhiteSpace($OperationId)
        $items = @(Get-ReleaseQueueTickets -OperationId $OperationId -IncludeTerminal:$showTerminal -RecoverExpired:$RecoverExpired -Limit $Limit -QueueRoot ([string]$Policy.queueRoot) -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds)
        return $items
    }
    catch {
        # 队列文件刚好被创建/替换时，报告仍可从磁盘 sidecar 读取；把异常
        # 留给面板而不是直接吞掉。
        $fallback = Read-ReleaseReportQueueState -Policy $Policy
        if ($fallback.exists) { return @($fallback.tickets | Where-Object { [string](Get-ReleaseReportProperty $_ "operationId" "") -eq $OperationId -or [string]::IsNullOrWhiteSpace($OperationId) }) }
        throw
    }
}

function New-StatusFallbackReport {
    param([Parameter(Mandatory = $true)][object]$Ticket, [string]$Message = "")
    $op = [string](Get-ReleaseReportProperty $Ticket "operationId" "")
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        reportType = "wechat-miniapp-release-acceptance"
        operationId = $op
        version = [string](Get-ReleaseReportProperty $Ticket "version" "")
        status = "pending"
        verdict = "pending"
        operationStatus = [string](Get-ReleaseReportProperty $Ticket "status" "")
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        sourceCommit = ""; releaseCommit = ""; mainCommit = ""; treeSha = ""; sourceSha256 = ""; packageSha256 = ""; artifactPath = ""
        queue = [pscustomobject]@{ sequence = [int](Get-ReleaseReportProperty $Ticket "sequence" 0); ticketId = [string](Get-ReleaseReportProperty $Ticket "ticketId" ""); status = [string](Get-ReleaseReportProperty $Ticket "status" ""); phase = [string](Get-ReleaseReportProperty $Ticket "phase" ""); issues = @($Message) }
        context = [pscustomobject]@{ status = "pending"; issues = @($Message) }
        record = [pscustomobject]@{ status = "pending"; issues = @() }
        reservation = [pscustomobject]@{ status = ""; exists = $false }
        evidence = [pscustomobject]@{
            main = [pscustomobject]@{ status = "pending"; message = "无法生成报告"; issues = @($Message) }
            artifact = [pscustomobject]@{ status = "pending"; message = "无法生成报告"; issues = @($Message) }
            qr = [pscustomobject]@{ status = "pending"; message = "无法生成报告"; issues = @($Message) }
            previewImport = [pscustomobject]@{ status = "pending"; message = "无法生成报告"; issues = @($Message) }
            cloudbase = [pscustomobject]@{ status = "pending"; message = "无法生成报告"; issues = @($Message) }
            reservation = [pscustomobject]@{ status = "pending"; message = "无法生成报告"; issues = @($Message) }
        }
        summary = [pscustomobject]@{ total = 4; pass = 0; pending = 4; fail = 0 }
        issues = @($Message)
        paths = [pscustomobject]@{ report = ""; markdown = ""; latest = "" }
    }
}

function Get-StatusReports {
    param([Parameter(Mandatory = $true)][object]$Policy, [AllowEmptyCollection()][object[]]$Tickets = @())
    $reports = New-Object System.Collections.Generic.List[object]
    foreach ($ticket in @($Tickets)) {
        try {
            $item = Get-ReleaseReportData -Policy $Policy -OperationId ([string](Get-ReleaseReportProperty $ticket "operationId" "")) -Ticket $ticket
        }
        catch {
            $item = New-StatusFallbackReport -Ticket $ticket -Message (ConvertTo-ReleaseReportSafeText $_.Exception.Message)
        }
        [void]$reports.Add($item)
    }
    return [object[]]$reports.ToArray()
}

function Get-StatusIcon {
    param([string]$Status)
    switch ($Status.ToLowerInvariant()) {
        "pass" { return "✅" }
        "succeeded" { return "✅" }
        "pending" { return "⏳" }
        "skipped" { return "⏭️" }
        "recoverable" { return "⚠️" }
        "fail" { return "❌" }
        "failed" { return "❌" }
        default { return "•" }
    }
}

function Format-StatusHuman {
    param([AllowEmptyCollection()][object[]]$Reports = @(), [switch]$Single)
    $lines = New-Object System.Collections.Generic.List[string]
    [void]$lines.Add("微信小程序发布状态（只读汇总）")
    [void]$lines.Add("")
    [void]$lines.Add("| 序号 | 操作 ID | 版本 | 当前阶段 | 总状态 | GitHub main | ZIP | 开发者工具 | 二维码 | CloudBase |")
    [void]$lines.Add("|---:|---|---|---|---|---|---|---|---|---|")
    foreach ($report in @($Reports)) {
        $queue = $report.queue; $e = $report.evidence
        $sequence = [int](Get-ReleaseReportProperty $queue "sequence" 0)
        $op = [string](Get-ReleaseReportProperty $report "operationId" "")
        $shortOp = if ($op.Length -gt 28) { $op.Substring(0, 28) + "…" } else { $op }
        $phase = [string](Get-ReleaseReportProperty $queue "phase" (Get-ReleaseReportProperty $report.context "phase" ""))
        if ([string]::IsNullOrWhiteSpace($phase)) { $phase = [string](Get-ReleaseReportProperty $report "operationStatus" "pending") }
        $status = [string](Get-ReleaseReportProperty $report "status" "pending")
        $cell = @(
            (Get-ReleaseReportProperty $e.main "status" "pending"),
            (Get-ReleaseReportProperty $e.artifact "status" "pending"),
            (Get-ReleaseReportProperty $e.previewImport "status" "skipped"),
            (Get-ReleaseReportProperty $e.qr "status" "pending"),
            (Get-ReleaseReportProperty $e.cloudbase "status" "pending")
        ) | ForEach-Object { "$(Get-StatusIcon ([string]$_)) $($_)" }
        [void]$lines.Add("| $sequence | $shortOp | $([string](Get-ReleaseReportProperty $report "version" "-")) | $phase | $(Get-StatusIcon $status) $status | $($cell[0]) | $($cell[1]) | $($cell[2]) | $($cell[3]) | $($cell[4]) |")
    }
    if (@($Reports).Count -eq 0) { [void]$lines.Add("| - | - | - | - | ⏳ pending | pending | pending | pending | pending | pending |") }
    [void]$lines.Add("")
    if ($Single -and @($Reports).Count -gt 0) {
        $r = $Reports[0]
        $issueText = @((Get-ReleaseReportProperty $r "issues" @())) -join "；"
        if (-not [string]::IsNullOrWhiteSpace($issueText)) { [void]$lines.Add("说明：$issueText") }
        $reportPath = [string](Get-ReleaseReportProperty $r.paths "report" "")
        if (-not [string]::IsNullOrWhiteSpace($reportPath)) { [void]$lines.Add("验收报告：$reportPath") }
    }
    return (($lines.ToArray()) -join [Environment]::NewLine) + [Environment]::NewLine
}

function New-StatusJsonEnvelope {
    param([Parameter(Mandatory = $true)][object]$Policy, [AllowEmptyCollection()][object[]]$Reports = @())
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        canonicalRepo = [string]$Policy.canonicalRepo
        branch = [string]$Policy.branch
        queuePath = Join-Path ([string]$Policy.queueRoot) "queue.json"
        latestReleasePath = [string](Get-ReleaseReportProperty $Policy "latestReleasePath" "")
        total = @($Reports).Count
        operations = @($Reports)
    }
}

$tickets = @(Get-StatusQueueTickets -Policy $policy)
if (-not $IncludeTerminal -and [string]::IsNullOrWhiteSpace($OperationId)) {
    # 默认面板仍展示活动项；如果没有活动项，再展示最近一条成功/失败记录，
    # 这样新用户不会看到一块空白页面。
    $active = @($tickets | Where-Object { [string](Get-ReleaseReportProperty $_ "status" "") -in @("queued", "leased", "running") })
    if ($active.Count -gt 0) { $tickets = $active }
    else {
        # 当前没有运行中的任务时，保留最近一条终态，面板不会凭空显示空白。
        try {
            $tickets = @(Get-ReleaseQueueTickets -IncludeTerminal -NewestFirst -Limit 1 -QueueRoot ([string]$policy.queueRoot) -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds)
        }
        catch { $tickets = @() }
    }
}
$reports = @(Get-StatusReports -Policy $policy -Tickets $tickets)

if ($Report) {
    $writtenReports = New-Object System.Collections.Generic.List[object]
    foreach ($item in @($reports)) {
        if ($NoWrite) { [void]$writtenReports.Add($item); continue }
        $jsonForItem = if (@($reports).Count -eq 1) { $JsonPath } else { "" }
        $mdForItem = if (@($reports).Count -eq 1) { $MarkdownPath } else { "" }
        # 只有成功、失败或可恢复终态才落盘；pending/running 仅在面板显示，
        # 避免先写一份“半成品报告”把后面的最终报告挡住。
        $terminal = [string](Get-ReleaseReportProperty $item "status" "pending") -in @("succeeded", "failed", "recoverable")
        if ($terminal) {
            $saved = Write-ReleaseReportArtifacts -Policy $policy -Report $item -JsonPath $jsonForItem -MarkdownPath $mdForItem -UpdateLatest
            [void]$writtenReports.Add($saved.report)
        } else { [void]$writtenReports.Add($item) }
    }
    $reports = @($writtenReports.ToArray())
}

if ($Json) {
    if (-not [string]::IsNullOrWhiteSpace($OperationId) -and @($reports).Count -eq 1) {
        $reports[0] | ConvertTo-Json -Depth 60
    } else {
        (New-StatusJsonEnvelope -Policy $policy -Reports $reports) | ConvertTo-Json -Depth 60
    }
}
else {
    Write-Output (Format-StatusHuman -Reports $reports -Single:$(-not [string]::IsNullOrWhiteSpace($OperationId)))
}
