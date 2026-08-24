$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$branch = "main"
$logRoot = Join-Path (Split-Path $repoRoot -Parent) "wechat-miniapp-sync-logs"
$logFile = Join-Path $logRoot ("sync-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
$packageScript = Join-Path $repoRoot "scripts/package-release.py"

function Get-ReleaseVersion {
    $configPath = Join-Path $repoRoot "config.js"
    $configText = Get-Content -LiteralPath $configPath -Raw
    $match = [regex]::Match($configText, 'appVersion:\s*"([^"]+)"')
    if (-not $match.Success) {
        throw "config.js 没有找到 appVersion，无法生成发布包。"
    }
    return $match.Groups[1].Value
}

function Get-CommitMetadata {
    $entries = @(git diff --cached --name-status)
    if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) {
        throw "无法读取已暂存文件，无法生成提交摘要。"
    }

    $areaCounts = [ordered]@{
        "页面" = 0
        "云函数" = 0
        "脚本" = 0
        "配置" = 0
        "文档" = 0
        "其他" = 0
    }
    $changeCounts = [ordered]@{
        "新增" = 0
        "修改" = 0
        "删除" = 0
        "重命名" = 0
    }
    $paths = @()

    foreach ($entry in $entries) {
        if ([string]::IsNullOrWhiteSpace($entry)) {
            continue
        }

        $parts = $entry -split "`t"
        $status = [string]$parts[0]
        $path = [string]$parts[$parts.Count - 1]
        $paths += $path

        $changeType = switch -Regex ($status) {
            "^A" { "新增"; break }
            "^D" { "删除"; break }
            "^R" { "重命名"; break }
            default { "修改" }
        }
        $changeCounts[$changeType]++

        $area = switch -Regex ($path) {
            "^pages[\\/]" { "页面"; break }
            "^cloudfunctions[\\/]" { "云函数"; break }
            "^scripts[\\/]|^\.githooks[\\/]" { "脚本"; break }
            "^(app|config|project)(\.|[\\/])|package(-lock)?\.json$" { "配置"; break }
            "^README\.md$|^docs[\\/]|^AGENTS\.md$" { "文档"; break }
            default { "其他" }
        }
        $areaCounts[$area]++
    }

    $areaSummary = ($areaCounts.GetEnumerator() |
        Where-Object { $_.Value -gt 0 } |
        ForEach-Object { "$($_.Key) $($_.Value)" }) -join "、"
    $changeSummary = ($changeCounts.GetEnumerator() |
        Where-Object { $_.Value -gt 0 } |
        ForEach-Object { "$($_.Key) $($_.Value)" }) -join "、"
    $pathSummary = if ($paths.Count -le 6) {
        $paths -join "；"
    }
    else {
        (($paths | Select-Object -First 6) -join "；") + "；等 $($paths.Count) 个文件"
    }

    return [pscustomobject]@{
        Subject = "自动同步：$($paths.Count) 个文件（$areaSummary）"
        Body = "变更：$changeSummary`n文件：$pathSummary"
    }
}

Set-Location $repoRoot

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$transcriptStarted = $false
try {
    Start-Transcript -Path $logFile -Append | Out-Null
    $transcriptStarted = $true

    Write-Host "同步时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
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
        return
    }

    $version = Get-ReleaseVersion
    $releasePackage = Join-Path (Split-Path $repoRoot -Parent) "wechat-miniapp-release-v$version.zip"
    Write-Host "生成发布包：$releasePackage"
    & python $packageScript
    if ($LASTEXITCODE -ne 0) {
        throw "发布包生成失败，已停止提交和推送。"
    }
    if (-not (Test-Path -LiteralPath $releasePackage)) {
        throw "发布包生成命令结束，但找不到产物：$releasePackage"
    }
    $packageSize = (Get-Item -LiteralPath $releasePackage).Length
    if ($packageSize -le 0) {
        throw "发布包是空文件：$releasePackage"
    }
    Write-Host "发布包已生成：$packageSize bytes"

    $commitMetadata = Get-CommitMetadata
    $commitMessage = $commitMetadata.Subject
    $commitBody = @(
        $commitMetadata.Body
        "版本：$version"
        "发布包：$releasePackage"
        "同步时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    ) -join "`n"

    # 当前脚本会在提交后显式 push；避免 post-commit hook 重复推送。
    $previousHookSetting = $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT
    $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = "1"
    try {
        git commit -m $commitMessage -m $commitBody
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
}
catch {
    Write-Host "同步失败：$($_.Exception.Message)" -ForegroundColor Red
    throw
}
finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
}
