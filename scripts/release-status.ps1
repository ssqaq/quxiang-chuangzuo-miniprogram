param(
    [string]$OperationId = "",
    [string]$PolicyPath = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release-gate.ps1")
$queueScript = Join-Path $PSScriptRoot "release-queue.ps1"
if (-not (Test-Path -LiteralPath $queueScript -PathType Leaf)) { throw "缺少发布队列工具：$queueScript" }
. $queueScript
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$policy = Get-ReleaseGatePolicy -PolicyPath $PolicyPath -RepositoryRoot $repoRoot
Assert-ReleaseCanonicalPolicy -Policy $policy -RepositoryRoot $repoRoot | Out-Null
$queueRoot = [string]$policy.queueRoot
if ([string]::IsNullOrWhiteSpace($OperationId)) {
    @(Get-ReleaseQueueTickets -QueueRoot $queueRoot) | ConvertTo-Json -Depth 12
}
else {
    $ticket = Get-ReleaseQueueTicket -QueueRoot $queueRoot -OperationId $OperationId
    if ($null -eq $ticket) { throw "找不到发布操作：$OperationId" }
    $ticket | ConvertTo-Json -Depth 12
}
