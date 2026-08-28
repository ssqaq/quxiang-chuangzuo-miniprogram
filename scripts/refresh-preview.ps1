param(
  [string]$CliPath = "",
  [string]$SourcePath = "",
  [object[]]$IncludePath = @(),
  [string]$TargetVersion = "",
  [switch]$Publish
)

$ErrorActionPreference = "Stop"

# 预览不能再直接读取脏工作区、打包或覆盖 latest 文件。它只是统一发布
# 闸门的兼容入口，所有二维码和 info JSON 都由同一个 release context 生成。
# 旧文件名仅保留为静态校验标记，不会创建或覆盖：wechat-miniapp-preview-latest-qr.png
# 旧文件名仅保留为静态校验标记，不会创建或覆盖：wechat-miniapp-preview-latest-info.json
$releaseScript = Join-Path $PSScriptRoot "release.ps1"
if (-not (Test-Path -LiteralPath $releaseScript -PathType Leaf)) {
  throw "缺少统一预览发布入口：$releaseScript"
}
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  throw "预览必须提供 -SourcePath；请从发布源明确选择文件，避免把其他 worktree 脏改动带入。"
}
if (@($IncludePath).Count -eq 0) {
  throw "预览必须提供 -IncludePath；不允许从当前工作区隐式打包。"
}
if ([string]::IsNullOrWhiteSpace($CliPath)) {
  $CliPath = $env:WECHAT_DEVTOOLS_CLI
}
if ([string]::IsNullOrWhiteSpace($CliPath)) {
  throw "预览需要微信开发者工具 CLI，请通过 -CliPath 或 WECHAT_DEVTOOLS_CLI 指定。"
}
if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
  throw "找不到微信开发者工具 CLI：$CliPath；闸门尚未分配版本。"
}

$invoke = @{
  SourcePath = $SourcePath
  IncludePath = @($IncludePath)
  Preview = $true
  PreviewCliPath = $CliPath
  Publish = $Publish.IsPresent
}
if (-not [string]::IsNullOrWhiteSpace($TargetVersion)) {
  $invoke.TargetVersion = $TargetVersion
}

& $releaseScript @invoke
exit $LASTEXITCODE
