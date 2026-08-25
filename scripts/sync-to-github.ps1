param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$IncludePath
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoName = Split-Path $repoRoot -Leaf
$branch = "main"
$logRoot = Join-Path (Split-Path $repoRoot -Parent) "wechat-miniapp-sync-logs"
$logFile = Join-Path $logRoot ("sync-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
$lockPath = Join-Path (Split-Path $repoRoot -Parent) "$repoName-release.lock"
$packageScript = Join-Path $repoRoot "scripts/package-release.py"

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = & git @Arguments 2>&1
    if (-not $AllowFailure -and $LASTEXITCODE -ne 0) {
        throw "Git 命令失败：git $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return @($output)
}

function Get-GitValue {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    return ((Invoke-Git -Arguments $Arguments) -join "`n").Trim()
}

function Resolve-GitPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([IO.Path]::IsPathRooted($Path)) {
        return [IO.Path]::GetFullPath($Path)
    }
    return [IO.Path]::GetFullPath((Join-Path $repoRoot $Path))
}

function Get-ReleaseVersion {
    $configPath = Join-Path $repoRoot "config.js"
    $configText = Get-Content -LiteralPath $configPath -Raw
    $match = [regex]::Match($configText, 'appVersion:\s*"([^"]+)"')
    if (-not $match.Success) {
        throw "config.js 没有找到 appVersion，无法生成发布包。"
    }
    return $match.Groups[1].Value
}

function Normalize-RelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([IO.Path]::IsPathRooted($Path)) {
        throw "IncludePath 必须是仓库内相对路径：$Path"
    }
    $normalized = $Path.Replace("\", "/")
    if ($normalized -match '(^|/)\.\.(?:/|$)') {
        throw "IncludePath 不是安全的仓库相对路径：$Path"
    }
    while ($normalized.StartsWith("./", [StringComparison]::Ordinal)) {
        $normalized = $normalized.Substring(2)
    }
    if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized -match '(^|/)\.\.(?:/|$)') {
        throw "IncludePath 不是安全的仓库相对路径：$Path"
    }
    if ($normalized -match '^(?:\.git|\.worktrees)(?:/|$)') {
        throw "IncludePath 不允许指向 Git 内部目录或 worktree：$Path"
    }
    return $normalized
}

function Get-IncludePaths {
    $paths = @(
        $IncludePath |
            ForEach-Object { Normalize-RelativePath -Path $_ } |
            Select-Object -Unique
    )
    if ($paths.Count -eq 0) {
        throw "必须显式指定本次要同步的文件，禁止使用 git add -A。"
    }
    return $paths
}

function Get-WorktreeSignature {
    $trackedDiff = (Invoke-Git -Arguments @("diff", "--no-ext-diff", "--binary", "HEAD")) -join "`n"
    $untracked = @(
        Invoke-Git -Arguments @(
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--others",
            "--exclude-standard"
        )
    ) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Sort-Object
    $untrackedHashes = @()
    foreach ($path in $untracked) {
        $fullPath = Join-Path $repoRoot $path
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash
            $untrackedHashes += "$path=$hash"
        }
        else {
            $untrackedHashes += "$path=<missing>"
        }
    }
    return (($trackedDiff.Trim()) + "`n" + ($untrackedHashes -join "`n")).Trim()
}

function Get-CommitMetadata {
    $entries = @(Invoke-Git -Arguments @("diff", "--cached", "--name-status"))
    if ($entries.Count -eq 0) {
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

function Assert-ReleaseState {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedHead,
        [Parameter(Mandatory = $true)][string]$ExpectedTree,
        [Parameter(Mandatory = $true)][string]$ExpectedWorktree,
        [Parameter(Mandatory = $true)][string]$Stage
    )

    $actualHead = Get-GitValue -Arguments @("rev-parse", "HEAD")
    if ($actualHead -ne $ExpectedHead) {
        throw "$Stage 前后 Git SHA 变化：预期 $ExpectedHead，实际 $actualHead。检测到并行提交，已停止。"
    }
    $actualTree = Get-GitValue -Arguments @("write-tree")
    if ($actualTree -ne $ExpectedTree) {
        throw "$Stage 前后暂存 tree SHA 变化：预期 $ExpectedTree，实际 $actualTree。检测到并行改动，已停止。"
    }
    $actualWorktree = Get-WorktreeSignature
    if ($actualWorktree -ne $ExpectedWorktree) {
        throw "$Stage 前后工作区状态变化，检测到并行改动，已停止。"
    }
}

function Acquire-ReleaseLock {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $stream = [IO.File]::Open(
            $Path,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
        $stream.SetLength(0)
        $payload = [Text.Encoding]::UTF8.GetBytes(
            "PID=$PID`n开始时间=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n仓库=$repoRoot`n"
        )
        $stream.Write($payload, 0, $payload.Length)
        $stream.Flush()
        return $stream
    }
    catch [IO.IOException] {
        throw "发布锁已被占用：$Path。请等另一个发布任务结束后重试。"
    }
}

$includePaths = Get-IncludePaths
Set-Location $repoRoot
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

$lockStream = $null
$transcriptStarted = $false
try {
    $gitRoot = Get-GitValue -Arguments @("rev-parse", "--show-toplevel")
    if ([IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($repoRoot)) {
        throw "同步脚本必须从主仓库根目录运行。当前目录：$gitRoot"
    }
    $currentBranch = Get-GitValue -Arguments @("branch", "--show-current")
    if ($currentBranch -ne $branch) {
        throw "发布同步只允许在 main 执行，当前分支：$currentBranch"
    }
    $expectedGitDir = [IO.Path]::GetFullPath((Join-Path $repoRoot ".git"))
    $actualGitDir = Resolve-GitPath -Path (Get-GitValue -Arguments @("rev-parse", "--git-dir"))
    $actualCommonDir = Resolve-GitPath -Path (Get-GitValue -Arguments @("rev-parse", "--git-common-dir"))
    if (($actualGitDir -ne $expectedGitDir) -or ($actualCommonDir -ne $expectedGitDir)) {
        throw "禁止从 worktree 执行 main 发布同步。请回到主仓库目录：$repoRoot"
    }

    $lockStream = Acquire-ReleaseLock -Path $lockPath
    Start-Transcript -Path $logFile -Append | Out-Null
    $transcriptStarted = $true

    Write-Host "同步时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Host "同步仓库：$repoRoot"
    Write-Host "发布锁：$lockPath"
    Write-Host "本次文件：$($includePaths -join '；')"
    Write-Host "检查远端最新代码：origin/$branch"
    Invoke-Git -Arguments @("fetch", "origin", "refs/heads/$branch`:refs/remotes/origin/$branch") | Write-Host
    $localHead = Get-GitValue -Arguments @("rev-parse", "HEAD")
    $remoteHeadBefore = Get-GitValue -Arguments @("rev-parse", "origin/$branch")
    if ($localHead -ne $remoteHeadBefore) {
        throw "本地 main 与 origin/main 不一致：本地 $localHead，远端 $remoteHeadBefore。请先在干净主目录同步后重试。"
    }

    $cachedBefore = @(
        Invoke-Git -Arguments @("diff", "--cached", "--name-only")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $outsideCached = @($cachedBefore | Where-Object { $_ -notin $includePaths })
    if ($outsideCached.Count -gt 0) {
        throw "暂存区已有未列入本次发布的文件：$($outsideCached -join '；')。请先处理，避免串提交。"
    }

    $literalPaths = @($includePaths | ForEach-Object { ":(literal)$_" })
    Invoke-Git -Arguments (@("add", "--") + $literalPaths) | Write-Host
    $cachedPaths = @(
        Invoke-Git -Arguments @("diff", "--cached", "--name-only")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $outsideCached = @($cachedPaths | Where-Object { $_ -notin $includePaths })
    if ($outsideCached.Count -gt 0) {
        throw "暂存后发现未授权文件：$($outsideCached -join '；')。已停止提交。"
    }
    if ($cachedPaths.Count -eq 0) {
        Write-Host "指定文件没有新修改，安全退出。"
        return
    }

    $baseHead = Get-GitValue -Arguments @("rev-parse", "HEAD")
    $stagedTree = Get-GitValue -Arguments @("write-tree")
    $expectedWorktree = Get-WorktreeSignature
    $version = Get-ReleaseVersion
    $releasePackage = Join-Path (Split-Path $repoRoot -Parent) "wechat-miniapp-release-v$version.zip"
    Write-Host "校验暂存 tree：$stagedTree"
    Write-Host "生成提交前发布包：$releasePackage"
    Invoke-Git -Arguments @("diff", "--cached", "--check") | Write-Host
    & python $packageScript `
        --source-tree $stagedTree `
        --tree-sha $stagedTree `
        --commit-sha "提交前暂存版本" `
        --source-label "提交前 Git tree：$stagedTree" `
        --output $releasePackage
    if ($LASTEXITCODE -ne 0) {
        throw "提交前发布包生成失败，已停止提交和推送。"
    }
    Assert-ReleaseState -ExpectedHead $baseHead -ExpectedTree $stagedTree -ExpectedWorktree $expectedWorktree -Stage "提交前打包"

    $commitMetadata = Get-CommitMetadata
    $commitMessage = $commitMetadata.Subject
    $commitBody = @(
        $commitMetadata.Body
        "版本：$version"
        "提交前暂存 tree：$stagedTree"
        "发布包：$releasePackage"
        "同步时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    ) -join "`n"

    $previousHookSetting = $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT
    $previousMainCommitSetting = $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT
    $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = "1"
    $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT = "1"
    try {
        Invoke-Git -Arguments @("commit", "-m", $commitMessage, "-m", $commitBody) | Write-Host
    }
    finally {
        if ($null -eq $previousHookSetting) {
            Remove-Item Env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT -ErrorAction SilentlyContinue
        }
        else {
            $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = $previousHookSetting
        }
        if ($null -eq $previousMainCommitSetting) {
            Remove-Item Env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT -ErrorAction SilentlyContinue
        }
        else {
            $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT = $previousMainCommitSetting
        }
    }

    $finalHead = Get-GitValue -Arguments @("rev-parse", "HEAD")
    $finalTree = Get-GitValue -Arguments @("rev-parse", "$finalHead^{tree}")
    if ($finalHead -eq $baseHead) {
        throw "提交后 HEAD 没有变化，已停止推送。"
    }
    Write-Host "最终提交 SHA：$finalHead"
    Write-Host "最终 Git tree SHA：$finalTree"

    $expectedPostCommitWorktree = Get-WorktreeSignature
    Write-Host "从最终提交重新生成正式发布包"
    & python $packageScript `
        --source-tree $finalHead `
        --tree-sha $finalTree `
        --commit-sha $finalHead `
        --source-label "最终提交：$finalHead" `
        --output $releasePackage
    if ($LASTEXITCODE -ne 0) {
        throw "正式发布包生成失败。提交已保留但未推送，请修复后重试。"
    }
    Assert-ReleaseState `
        -ExpectedHead $finalHead `
        -ExpectedTree $finalTree `
        -ExpectedWorktree $expectedPostCommitWorktree `
        -Stage "正式打包"

    Write-Host "推送到 GitHub：origin/$branch"
    Invoke-Git -Arguments @("push", "origin", $branch) | Write-Host
    $remoteHead = Get-GitValue -Arguments @("rev-parse", "origin/$branch")
    if ($remoteHead -ne $finalHead) {
        throw "推送后远端 SHA 不一致：本地 $finalHead，远端 $remoteHead。"
    }
    Write-Host "同步完成：$commitMessage"
    Write-Host "本地 HEAD 与 origin/$branch 一致：$finalHead"
}
catch {
    Write-Host "同步失败：$($_.Exception.Message)" -ForegroundColor Red
    throw
}
finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
    }
}
