param(
  [string]$CliPath = "",
  [string]$ClientName = "default",
  [string]$SourcePath = "",
  [object[]]$IncludePath = @(),
  [string]$TargetVersion = "",
  [switch]$Publish
)

$ErrorActionPreference = "Stop"

# 预览不能再直接读取脏工作区、打包或覆盖 latest 文件。它只是统一发布
# 闸门的兼容入口：每次预览都会先导入新的隔离项目，再由同一个
# release context 生成二维码和 info JSON。
# 旧文件名仅保留为静态校验标记，不会创建或覆盖：wechat-miniapp-preview-latest-qr.png
# 旧文件名仅保留为静态校验标记，不会创建或覆盖：wechat-miniapp-preview-latest-info.json
$releaseScript = Join-Path $PSScriptRoot "release.ps1"
if (-not (Test-Path -LiteralPath $releaseScript -PathType Leaf)) {
  throw "缺少统一预览发布入口：$releaseScript"
}
. (Join-Path $PSScriptRoot "release-gate.ps1")
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  throw "预览必须提供 -SourcePath；请从发布源明确选择文件，避免把其他 worktree 脏改动带入。"
}
if (@($IncludePath).Count -eq 0) {
  throw "预览必须提供 -IncludePath；不允许从当前工作区隐式打包。"
}
if ([string]::IsNullOrWhiteSpace($CliPath)) {
  $CliPath = Resolve-ReleaseDevToolsCli
}
else {
  $CliPath = Resolve-ReleaseDevToolsCli -CliPath $CliPath
}

$invoke = @{
  SourcePath = $SourcePath
  IncludePath = @($IncludePath)
  Preview = $true
  PreviewCliPath = $CliPath
  PreviewClientName = $ClientName
  Publish = $Publish.IsPresent
  PrepareOnly = -not $Publish.IsPresent
}
if (-not [string]::IsNullOrWhiteSpace($TargetVersion)) {
  $invoke.TargetVersion = $TargetVersion
}

& $releaseScript @invoke
exit $LASTEXITCODE
