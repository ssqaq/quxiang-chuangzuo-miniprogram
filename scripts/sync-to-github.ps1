$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$branch = "main"
$commitMessage = "自动同步 $(Get-Date -Format 'yyyy-MM-dd HH:mm')"

Set-Location $repoRoot

Write-Host "同步仓库：$repoRoot"
Write-Host "拉取远端最新代码：origin/$branch"
git pull --rebase --autostash origin $branch
if ($LASTEXITCODE -ne 0) {
    throw "拉取远端代码失败，已停止自动同步。请先处理冲突后重试。"
}

git add -A
git diff --cached --quiet

if ($LASTEXITCODE -eq 0) {
    Write-Host "没有新的修改"
    exit 0
}

# 当前脚本会在提交后显式 push；避免 post-commit hook 重复推送。
$previousHookSetting = $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT
$env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = "1"
try {
    git commit -m $commitMessage
    if ($LASTEXITCODE -ne 0) {
        throw "提交修改失败，已停止自动同步。"
    }
}
finally {
    if ($null -eq $previousHookSetting) {
        Remove-Item Env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT -ErrorAction SilentlyContinue
    }
    else {
        $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = $previousHookSetting
    }
}

Write-Host "推送到 GitHub：origin/$branch"
git push origin $branch
if ($LASTEXITCODE -ne 0) {
    throw "推送到 GitHub 失败。请检查网络、登录状态或远端冲突。"
}

Write-Host "同步完成：$commitMessage"