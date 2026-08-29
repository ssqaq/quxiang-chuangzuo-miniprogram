<#!
.SYNOPSIS
    旧版发布记录入口（已封锁）。

.DESCRIPTION
    这个脚本曾经可以在没有锁、没有 reservation、没有 release context 的
    情况下直接写 release record，正是版本冲突和“看起来发布成功”的来源。
    保留文件名只是为了让旧命令得到明确错误；它不创建目录、不写文件、不
    修改 Git。正式记录只能由 scripts/release.ps1 或
    scripts/resume-release.ps1 在同一 release context 内生成。
#>

[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$CommitSha = "",
    [string]$TreeSha = "",
    [string]$SourceSha256 = "",
    [string]$PackagePath = "",
    [string]$Remote = "",
    [string]$OutputRoot = "",
    [string[]]$ChangedFile = @(),
    [string]$BaseHead = "",
    [int]$Attempt = 0,
    [int]$RetryCount = 0,
    [string[]]$GeneratedVersionPath = @(),
    [string]$ReleaseWorktree = "",
    [string]$ReleaseContext = "",
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$message = @"
禁止直接写 release record：旧入口 scripts/write-release-record.ps1 已封锁。
请使用 canonical 仓库的 scripts/release.ps1（正式发布）或
scripts/resume-release.ps1 -OperationId <operationId>（恢复原 context）。
这次调用没有写入任何文件，也没有修改 Git。
"@
if ($CheckOnly) {
    Write-Output "旧发布记录入口已封锁；只允许 release context 驱动的记录。"
    exit 1
}
throw $message.Trim()
