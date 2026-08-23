$ErrorActionPreference = "Stop"

Set-Location "D:\aips小程序\wechat-miniapp"

git pull --rebase --autostash origin main
git add -A

git diff --cached --quiet

if ($LASTEXITCODE -eq 0) {
    Write-Host "没有新的修改"
    exit 0
}

git commit -m "自动同步 $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
git push origin main

Write-Host "同步完成"
