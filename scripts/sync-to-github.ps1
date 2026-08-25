param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$IncludePath,

    [ValidateRange(1, 5)]
    [int]$MaxAttempts = 3,

    [ValidateRange(1, 300)]
    [int]$LockWaitSeconds = 60
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoName = Split-Path $repoRoot -Leaf
$branch = "main"
$parentRoot = Split-Path $repoRoot -Parent
$logRoot = Join-Path $parentRoot "wechat-miniapp-sync-logs"
$logFile = Join-Path $logRoot ("sync-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
$lockPath = Join-Path $parentRoot "$repoName-release.lock"
$reservationRoot = Join-Path $parentRoot "$repoName-release-reservations"
$releaseWorktreeRoot = Join-Path $parentRoot "$repoName-release-worktrees"
$packageScriptName = "scripts/package-release.py"
$releaseRecordScriptName = "scripts/write-release-record.ps1"
$versionScriptName = "scripts/release-version.ps1"

$versionScript = Join-Path $repoRoot $versionScriptName

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

function Invoke-GitAt {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = & git -C $WorkingDirectory @Arguments 2>&1
    if (-not $AllowFailure -and $LASTEXITCODE -ne 0) {
        throw "Git 命令失败：git -C $WorkingDirectory $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return @($output)
}

function Get-GitValue {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    return ((Invoke-Git -Arguments $Arguments) -join "`n").Trim()
}

function Get-GitValueAt {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    return ((Invoke-GitAt -WorkingDirectory $WorkingDirectory -Arguments $Arguments) -join "`n").Trim()
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
    return @($paths)
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

function Get-FileSnapshot {
    param([Parameter(Mandatory = $true)][string[]]$Paths)

    $snapshot = @{}
    foreach ($path in $Paths) {
        $fullPath = Join-Path $repoRoot $path
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            $bytes = [IO.File]::ReadAllBytes($fullPath)
            $snapshot[$path] = [pscustomobject]@{
                Exists = $true
                Bytes = $bytes
                Sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash
            }
        }
        else {
            $snapshot[$path] = [pscustomobject]@{
                Exists = $false
                Bytes = @()
                Sha256 = "<missing>"
            }
        }
    }
    return $snapshot
}

function Assert-FileSnapshotStable {
    param([Parameter(Mandatory = $true)][hashtable]$Snapshot)

    foreach ($entry in $Snapshot.GetEnumerator()) {
        $path = [string]$entry.Key
        $expected = $entry.Value
        $fullPath = Join-Path $repoRoot $path
        $exists = Test-Path -LiteralPath $fullPath -PathType Leaf
        if ($exists -ne [bool]$expected.Exists) {
            throw "本地文件在发布过程中变化：$path"
        }
        if ($exists) {
            $actual = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash
            if ($actual -ne $expected.Sha256) {
                throw "本地文件在发布过程中变化：$path"
            }
        }
    }
}

function Copy-SnapshotToWorktree {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][hashtable]$Snapshot
    )

    foreach ($entry in $Snapshot.GetEnumerator()) {
        $path = [string]$entry.Key
        $item = $entry.Value
        $target = Join-Path $TargetRoot $path
        if ($item.Exists) {
            $parent = Split-Path $target -Parent
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            [IO.File]::WriteAllBytes($target, $item.Bytes)
        }
        elseif (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Force
        }
    }
}

function Copy-GeneratedVersionFilesToMain {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseWorktree,
        [Parameter(Mandatory = $true)][string[]]$VersionPaths,
        [Parameter(Mandatory = $true)][hashtable]$InitialVersionSnapshot,
        [Parameter(Mandatory = $true)][string]$BaseHead
    )

    foreach ($path in $VersionPaths) {
        $fullPath = Join-Path $repoRoot $path
        & git cat-file -e "$BaseHead`:$path" 2>$null
        $trackedAtBase = $LASTEXITCODE -eq 0
        $wasExplicit = $includePaths -contains $path
        $isCleanAtBase = $false
        if ($trackedAtBase -and $InitialVersionSnapshot.ContainsKey($path)) {
            $item = $InitialVersionSnapshot[$path]
            & git diff --quiet $BaseHead -- $path
            $isCleanAtBase = $item.Exists -and ($LASTEXITCODE -eq 0)
        }
        if ($wasExplicit -or $isCleanAtBase) {
            $source = Join-Path $ReleaseWorktree $path
            if (Test-Path -LiteralPath $source -PathType Leaf) {
                $parent = Split-Path $fullPath -Parent
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
                [IO.File]::WriteAllBytes($fullPath, [IO.File]::ReadAllBytes($source))
            }
        }
    }
}

function Acquire-ReleaseLock {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$WaitSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    do {
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
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "发布锁等待超时：$Path。请检查是否有其他发布任务卡住。"
            }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
}

function Get-CommitMetadataAt {
    param([Parameter(Mandatory = $true)][string]$WorkingDirectory)

    $entries = @(Invoke-GitAt -WorkingDirectory $WorkingDirectory -Arguments @("diff", "--cached", "--name-status"))
    if ($entries.Count -eq 0) {
        throw "无法读取临时发布工作树的暂存文件。"
    }

    $areaCounts = [ordered]@{
        "页面" = 0
        "云函数" = 0
        "脚本" = 0
        "配置" = 0
        "文档" = 0
        "其他" = 0
    }
    $paths = @()
    foreach ($entry in $entries) {
        if ([string]::IsNullOrWhiteSpace($entry)) { continue }
        $parts = $entry -split "`t"
        $path = [string]$parts[$parts.Count - 1]
        $paths += $path
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
    $areaSummary = ($areaCounts.GetEnumerator() | Where-Object Value -gt 0 | ForEach-Object { "$($_.Key) $($_.Value)" }) -join "、"
    $pathSummary = if ($paths.Count -le 6) { $paths -join "；" } else { (($paths | Select-Object -First 6) -join "；") + "；等 $($paths.Count) 个文件" }
    return [pscustomobject]@{
        Subject = "自动同步：$($paths.Count) 个文件（$areaSummary）"
        Body = "文件：$pathSummary"
        Paths = @($paths)
    }
}

function New-VersionReservation {
    param(
        [Parameter(Mandatory = $true)][string]$BaseHead,
        [Parameter(Mandatory = $true)][string]$TargetVersion,
        [Parameter(Mandatory = $true)][int]$Attempt,
        [Parameter(Mandatory = $true)][string[]]$Paths
    )

    New-Item -ItemType Directory -Path $reservationRoot -Force | Out-Null
    $id = "reserve-$TargetVersion-$PID-$([guid]::NewGuid().ToString('N'))"
    $path = Join-Path $reservationRoot "$id.json"
    $record = [ordered]@{
        baseHead = $BaseHead
        targetVersion = $TargetVersion
        attempt = $Attempt
        pid = $PID
        createdAt = (Get-Date).ToString("o")
        includePaths = @($Paths)
    }
    $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding utf8NoBOM
    return $path
}

function Remove-SafePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Remove-ReleaseWorktree {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    & git worktree remove --force $Path 2>$null | Out-Null
    Remove-SafePath -Path $Path
}

function Invoke-NodeScriptAt {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$RelativeScript
    )
    $script = Join-Path $WorkingDirectory $RelativeScript
    $output = & node $script 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$RelativeScript 校验失败：$($output -join "`n")"
    }
    $output | Write-Host
}

$includePaths = Get-IncludePaths
Set-Location $repoRoot
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
New-Item -ItemType Directory -Path $releaseWorktreeRoot -Force | Out-Null

$lockStream = $null
$transcriptStarted = $false
$releaseSucceeded = $false
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
    $actualGitDir = [IO.Path]::GetFullPath((Get-GitValue -Arguments @("rev-parse", "--git-dir")))
    $actualCommonDir = [IO.Path]::GetFullPath((Get-GitValue -Arguments @("rev-parse", "--git-common-dir")))
    if (($actualGitDir -ne $expectedGitDir) -or ($actualCommonDir -ne $expectedGitDir)) {
        throw "禁止从 worktree 执行 main 发布同步。请回到主仓库目录：$repoRoot"
    }
    if (-not (Test-Path -LiteralPath $versionScript -PathType Leaf)) {
        throw "缺少版本处理器：$versionScript"
    }
    . $versionScript

    $lockStream = Acquire-ReleaseLock -Path $lockPath -WaitSeconds $LockWaitSeconds
    Start-Transcript -Path $logFile -Append | Out-Null
    $transcriptStarted = $true

    $cachedBefore = @(@(Invoke-Git -Arguments @("diff", "--cached", "--name-only")) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($cachedBefore.Count -gt 0) {
        throw "暂存区已有文件：$($cachedBefore -join '；')。请先处理，避免并发任务串提交。"
    }

    $initialHead = Get-GitValue -Arguments @("rev-parse", "HEAD")
    $initialWorktree = Get-WorktreeSignature
    $initialSnapshot = Get-FileSnapshot -Paths $includePaths
    Invoke-NodeScriptAt -WorkingDirectory $repoRoot -RelativeScript "scripts/validate.js"
    Invoke-NodeScriptAt -WorkingDirectory $repoRoot -RelativeScript "scripts/version-concurrency-smoke.js"

    Write-Host "同步仓库：$repoRoot"
    Write-Host "发布锁：$lockPath"
    Write-Host "本次文件：$($includePaths -join '；')"

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
        $releaseWorktree = $null
        $reservationPath = $null
        $retryRemote = $false
        try {
            Assert-FileSnapshotStable -Snapshot $initialSnapshot
            if ((Get-WorktreeSignature) -ne $initialWorktree) {
                throw "本地工作区在发布开始前已变化，请重新执行发布。"
            }

            Invoke-Git -Arguments @("fetch", "origin", "refs/heads/$branch`:refs/remotes/origin/$branch") | Write-Host
            $baseHead = Get-GitValue -Arguments @("rev-parse", "origin/$branch")
            $localHead = Get-GitValue -Arguments @("rev-parse", "HEAD")
            if ($localHead -ne $baseHead) {
                throw "本地 main 与 origin/main 不一致：本地 $localHead，远端 $baseHead。请先同步主分支后重试。"
            }

            $releaseWorktree = Join-Path $releaseWorktreeRoot ("attempt-{0}-{1}" -f $attempt, [guid]::NewGuid().ToString("N"))
            Invoke-Git -Arguments @("worktree", "add", "--detach", $releaseWorktree, $baseHead) | Write-Host
            $baseConfigText = Get-Content -LiteralPath (Join-Path $releaseWorktree "config.js") -Raw
            $baseVersionMatch = [regex]::Match($baseConfigText, 'appVersion:\s*"([^"]+)"')
            if (-not $baseVersionMatch.Success) {
                throw "远端基线 config.js 没有找到 appVersion。"
            }
            $targetVersion = Get-NextPatchVersion -BaseVersion $baseVersionMatch.Groups[1].Value
            $versionPaths = Get-VersionGroupPaths -SourceRoot $releaseWorktree
            $initialVersionSnapshot = Get-FileSnapshot -Paths $versionPaths
            Copy-SnapshotToWorktree -TargetRoot $releaseWorktree -Snapshot $initialSnapshot

            foreach ($path in $versionPaths) {
                $fullPath = Join-Path $releaseWorktree $path
                if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
                    throw "版本组文件不存在：$path"
                }
                $text = [IO.File]::ReadAllText($fullPath)
                $updated = Set-VersionText -RelativePath $path -Text $text -TargetVersion $targetVersion
                [IO.File]::WriteAllText($fullPath, $updated, [Text.UTF8Encoding]::new($false))
            }
            $reservationPath = New-VersionReservation -BaseHead $baseHead -TargetVersion $targetVersion -Attempt $attempt -Paths $includePaths
            $allowedPaths = @($includePaths + $versionPaths | Select-Object -Unique)
            $literalPaths = @($allowedPaths | ForEach-Object { ":(literal)$_" })
            Invoke-GitAt -WorkingDirectory $releaseWorktree -Arguments (@("add", "--") + $literalPaths) | Write-Host
            $cachedPaths = @(@(Invoke-GitAt -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--name-only")) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            $outsideCached = @($cachedPaths | Where-Object { $_ -notin $allowedPaths })
            if ($outsideCached.Count -gt 0) {
                throw "临时发布工作树出现未授权文件：$($outsideCached -join '；')"
            }
            $stagedTree = Get-GitValueAt -WorkingDirectory $releaseWorktree -Arguments @("write-tree")
            Invoke-GitAt -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--check") | Write-Host
            Invoke-NodeScriptAt -WorkingDirectory $releaseWorktree -RelativeScript "scripts/version-concurrency-smoke.js"
            Assert-FileSnapshotStable -Snapshot $initialSnapshot
            if ((Get-WorktreeSignature) -ne $initialWorktree) {
                throw "主工作区在临时发布准备期间发生变化，已停止提交。"
            }

            $releasePackage = Join-Path $parentRoot "wechat-miniapp-release-v$targetVersion.zip"
            & python (Join-Path $releaseWorktree $packageScriptName) `
                --source-tree $stagedTree `
                --tree-sha $stagedTree `
                --commit-sha "提交前暂存版本" `
                --source-label "提交前 Git tree：$stagedTree" `
                --output $releasePackage
            if ($LASTEXITCODE -ne 0) {
                throw "提交前发布包生成失败，已停止提交和推送。"
            }

            $metadata = Get-CommitMetadataAt -WorkingDirectory $releaseWorktree
            $commitBody = @(
                $metadata.Body
                "版本：$targetVersion"
                "基础远端 SHA：$baseHead"
                "尝试次数：$attempt"
                "提交前暂存 tree：$stagedTree"
                "发布包：$releasePackage"
                "同步时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
            ) -join "`n"
            $previousHookSetting = $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT
            $previousMainCommitSetting = $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT
            $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = "1"
            $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT = "1"
            try {
                Invoke-GitAt -WorkingDirectory $releaseWorktree -Arguments @("commit", "-m", $metadata.Subject, "-m", $commitBody) | Write-Host
            }
            finally {
                if ($null -eq $previousHookSetting) { Remove-Item Env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT -ErrorAction SilentlyContinue } else { $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = $previousHookSetting }
                if ($null -eq $previousMainCommitSetting) { Remove-Item Env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT -ErrorAction SilentlyContinue } else { $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT = $previousMainCommitSetting }
            }

            $finalHead = Get-GitValueAt -WorkingDirectory $releaseWorktree -Arguments @("rev-parse", "HEAD")
            $finalTree = Get-GitValueAt -WorkingDirectory $releaseWorktree -Arguments @("rev-parse", "$finalHead^{tree}")
            $expectedWorktree = Get-WorktreeSignature
            & python (Join-Path $releaseWorktree $packageScriptName) `
                --source-tree $finalHead `
                --tree-sha $finalTree `
                --commit-sha $finalHead `
                --source-label "最终提交：$finalHead" `
                --output $releasePackage
            if ($LASTEXITCODE -ne 0) {
                throw "正式发布包生成失败，提交尚未推送。"
            }
            if ((Get-WorktreeSignature) -ne $expectedWorktree) {
                throw "正式打包期间主工作区发生变化，已停止推送。"
            }

            Invoke-Git -Arguments @("fetch", "origin", "refs/heads/$branch`:refs/remotes/origin/$branch") | Write-Host
            if ((Get-GitValue -Arguments @("rev-parse", "origin/$branch")) -ne $baseHead) {
                $retryRemote = $true
                throw "远端在发布期间发生变化，本轮重新读取版本后重试。"
            }
            $pushOutput = & git -C $releaseWorktree push origin "HEAD:$branch" 2>&1
            if ($LASTEXITCODE -ne 0) {
                $remoteAfterPushFailure = Get-GitValue -Arguments @("rev-parse", "origin/$branch")
                if ($remoteAfterPushFailure -ne $baseHead) {
                    $retryRemote = $true
                    throw "远端抢先推送，本轮重新读取版本后重试。"
                }
                throw "推送失败：$($pushOutput -join "`n")"
            }
            $remoteHead = Get-GitValue -Arguments @("rev-parse", "origin/$branch")
            if ($remoteHead -ne $finalHead) {
                throw "推送后远端 SHA 不一致：本地 $finalHead，远端 $remoteHead。"
            }

            if ((Get-GitValue -Arguments @("rev-parse", "HEAD")) -ne $baseHead) {
                throw "推送后本地 main 已被其他提交改变，未自动移动本地分支引用。"
            }
            Invoke-Git -Arguments @("update-ref", "refs/heads/$branch", $finalHead, $baseHead) | Write-Host
            Copy-GeneratedVersionFilesToMain -ReleaseWorktree $releaseWorktree -VersionPaths $versionPaths -InitialVersionSnapshot $initialVersionSnapshot -BaseHead $baseHead
            Invoke-Git -Arguments @("read-tree", $finalHead) | Write-Host

            $manifestShaOutput = & python -c "from zipfile import ZipFile; import sys; m=ZipFile(sys.argv[1]).read('RELEASE-MANIFEST.txt').decode('utf-8'); print(next(line.split('：', 1)[1].strip() for line in m.splitlines() if line.startswith('源码内容 SHA256：')))" $releasePackage 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "已推送但无法读取正式包源码 SHA256：$($manifestShaOutput -join "`n")"
            }
            $manifestSourceSha = ($manifestShaOutput -join "`n").Trim()
            $releaseRecordScript = Join-Path $repoRoot $releaseRecordScriptName
            & $releaseRecordScript `
                -Version $targetVersion `
                -CommitSha $finalHead `
                -TreeSha $finalTree `
                -SourceSha256 $manifestSourceSha `
                -PackagePath $releasePackage `
                -Remote "origin/$branch" `
                -ChangedFile $allowedPaths `
                -BaseHead $baseHead `
                -Attempt $attempt `
                -RetryCount ($attempt - 1) `
                -GeneratedVersionPath $versionPaths `
                -ReleaseWorktree $releaseWorktree
            if ($LASTEXITCODE -ne 0) {
                throw "已推送但发布记录生成失败。"
            }
            $releaseSucceeded = $true
            Write-Host "同步完成：$($metadata.Subject)"
            Write-Host "版本：$targetVersion"
            Write-Host "提交：$finalHead"
            Write-Host "本地 HEAD 与 origin/$branch 一致：$finalHead"
            break
        }
        catch {
            $message = $_.Exception.Message
            if ($retryRemote -and $attempt -lt $MaxAttempts) {
                Write-Host "第 $attempt 次发布遇到远端并发，准备第 $($attempt + 1) 次重试。" -ForegroundColor Yellow
                Remove-ReleaseWorktree -Path $releaseWorktree
                Remove-SafePath -Path $reservationPath
                Invoke-Git -Arguments @("fetch", "origin", "refs/heads/$branch`:refs/remotes/origin/$branch") | Write-Host
                $newBase = Get-GitValue -Arguments @("rev-parse", "origin/$branch")
                if ((Get-GitValue -Arguments @("rev-parse", "HEAD")) -ne $baseHead) {
                    throw "远端重试前本地 main 已变化，停止自动重试。"
                }
                Invoke-Git -Arguments @("update-ref", "refs/heads/$branch", $newBase, $baseHead) | Write-Host
                Start-Sleep -Milliseconds 250
                continue
            }
            Remove-ReleaseWorktree -Path $releaseWorktree
            Remove-SafePath -Path $reservationPath
            throw $message
        }
        finally {
            if ($releaseSucceeded) {
                Remove-ReleaseWorktree -Path $releaseWorktree
                Remove-SafePath -Path $reservationPath
            }
        }
    }
    if (-not $releaseSucceeded) {
        throw "发布重试达到上限，未完成同步。"
    }
}
catch {
    Write-Host "同步失败：$($_.Exception.Message)" -ForegroundColor Red
    throw
}
finally {
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
    if ($null -ne $lockStream) { $lockStream.Dispose() }
}
