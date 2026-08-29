[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$IncludePath,

    [string]$TargetVersion = "",

    # 保留旧参数，避免旧调用立即报“参数不存在”；实际重试次数由统一
    # 队列策略控制，不能由旧入口自行改变并发语义。
    [ValidateRange(1, 100)]
    [int]$MaxAttempts = 3,

    [ValidateRange(1, 7200)]
    [int]$LockWaitSeconds = 1800,

    [string]$LockPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseGateScript = Join-Path $PSScriptRoot "release.ps1"

if (-not (Test-Path -LiteralPath $releaseGateScript -PathType Leaf)) {
    throw "缺少统一发布闸门：$releaseGateScript。旧 clone/worktree 不允许自行发布。"
}
if (-not [string]::IsNullOrWhiteSpace($LockPath)) {
    throw "统一发布闸门不接受自定义锁路径；请使用策略中的共享锁。"
}
if ($MaxAttempts -ne 3) {
    throw "MaxAttempts 已由统一发布队列策略管理，旧入口不允许覆盖该值。"
}

# 兼容旧命令名，但只做一件事：把参数原样交给 canonical 的 release.ps1。
# release.ps1 会再次校验策略、来源、队列、版本、PR-only 保护和 context，
# 因此这里不再保留任何独立的 git add/commit/push/打包逻辑。
$gateArguments = @{
    SourcePath = $repoRoot
    IncludePath = @($IncludePath)
    LockWaitSeconds = [Math]::Max($LockWaitSeconds, 1800)
    Publish = $true
}
if (-not [string]::IsNullOrWhiteSpace($TargetVersion)) {
    $gateArguments.TargetVersion = $TargetVersion
}

& $releaseGateScript @gateArguments
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }
exit $exitCode
