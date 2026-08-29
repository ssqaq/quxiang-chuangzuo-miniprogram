param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$hooksRoot = Join-Path $repoRoot ".githooks"
$expectedHookPath = ".githooks"
$requiredHooks = @("pre-commit", "post-commit", "pre-push", "post-checkout")

function Get-GitValue {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Git 命令失败：git $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return ($output -join "`n").Trim()
}

$gitRoot = Get-GitValue -Arguments @("-C", $repoRoot, "rev-parse", "--show-toplevel")
if ([IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($repoRoot)) {
    throw "脚本必须从仓库根目录安装 hooks：$repoRoot"
}

foreach ($hook in $requiredHooks) {
    $hookPath = Join-Path $hooksRoot $hook
    if (-not (Test-Path -LiteralPath $hookPath -PathType Leaf)) {
        throw "缺少 hook 文件：$hookPath"
    }
    if ((Get-Item -LiteralPath $hookPath).Length -le 0) {
        throw "hook 文件为空：$hookPath"
    }
}

# Fail early when a checkout has an old/incomplete hook set.  This is more
# useful than silently installing only commit hooks and then discovering that
# a direct `git push main` was not intercepted.
$prePushText = Get-Content -LiteralPath (Join-Path $hooksRoot "pre-push") -Raw -Encoding UTF8
if ($prePushText -notmatch "MINIPROGRAM_SYNC_ALLOW_MAIN_PUSH" -or
    $prePushText -notmatch "refs/heads/main") {
    throw "pre-push hook 缺少 main 发布保护契约：$hooksRoot"
}
$postCheckoutText = Get-Content -LiteralPath (Join-Path $hooksRoot "post-checkout") -Raw -Encoding UTF8
if ($postCheckoutText -notmatch "git lfs post-checkout") {
    throw "post-checkout hook 缺少 Git LFS 转发：$hooksRoot"
}

$configured = (& git -C $repoRoot config --local --get core.hooksPath 2>$null) -join "`n"
$configured = $configured.Trim()
$configuredAbsolute = if ([string]::IsNullOrWhiteSpace($configured)) {
    ""
}
elseif ([IO.Path]::IsPathRooted($configured)) {
    [IO.Path]::GetFullPath($configured)
}
else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $configured))
}
$expectedAbsolute = [IO.Path]::GetFullPath($hooksRoot)

if ((-not [string]::IsNullOrWhiteSpace($configured)) -and
    ($configured -ne $expectedHookPath) -and
    ($configuredAbsolute -ne $expectedAbsolute) -and
    (-not $Force)) {
    throw "当前 core.hooksPath 已配置为 $configured。若确认要替换，请加 -Force。"
}

Get-GitValue -Arguments @("-C", $repoRoot, "config", "--local", "core.hooksPath", $expectedHookPath) | Out-Null
$actual = Get-GitValue -Arguments @("-C", $repoRoot, "config", "--local", "--get", "core.hooksPath")
if ($actual -ne $expectedHookPath) {
    throw "hooks 安装后校验失败：预期 $expectedHookPath，实际 $actual"
}

Write-Host "Git hooks 安装完成：$repoRoot"
Write-Host "core.hooksPath=$actual"
Write-Host "已校验 hooks：$($requiredHooks -join ', ')"
