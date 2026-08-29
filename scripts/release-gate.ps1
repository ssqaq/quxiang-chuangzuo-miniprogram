Set-StrictMode -Version Latest

# Shared release-gate primitives.  The orchestration entry point is release.ps1.

function Get-ReleaseGateDefaultPolicyPath {
    param([string]$RepositoryRoot = "")
    if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
        $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    }
    return Join-Path (Split-Path ([IO.Path]::GetFullPath($RepositoryRoot)) -Parent) "wechat-miniapp-release-policy.json"
}

function Get-ReleaseGatePolicy {
    param(
        [string]$PolicyPath = "",
        [string]$RepositoryRoot = ""
    )

    $path = if ([string]::IsNullOrWhiteSpace($PolicyPath)) {
        Get-ReleaseGateDefaultPolicyPath -RepositoryRoot $RepositoryRoot
    } else {
        [IO.Path]::GetFullPath($PolicyPath)
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "缺少发布策略文件：$path"
    }
    try {
        $policy = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "发布策略文件不是有效 JSON：$path。$($_.Exception.Message)"
    }
    foreach ($name in @("canonicalRepo", "remote", "branch", "lockPath", "artifactRoot", "reservationRoot", "worktreeRoot", "recordRoot", "contextRoot", "logRoot", "archiveManifestPath")) {
        $property = $policy.PSObject.Properties[$name]
        if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
            throw "发布策略缺少必填字段：$name"
        }
    }
    if ([string]$policy.branch -ne "main") {
        throw "发布闸门只允许 main 作为目标分支。策略值：$($policy.branch)"
    }
    # schema 1 policies created before the durable queue enhancement remain
    # readable; derive the queue directory beside the lock when absent.
    if ($null -eq $policy.PSObject.Properties["queueRoot"] -or [string]::IsNullOrWhiteSpace([string]$policy.queueRoot)) {
        $parent = Split-Path ([IO.Path]::GetFullPath([string]$policy.lockPath)) -Parent
        $policy | Add-Member -NotePropertyName queueRoot -NotePropertyValue (Join-Path $parent "wechat-miniapp-release-queue") -Force
    }
    if ($null -eq $policy.PSObject.Properties["queue"]) {
        $policy | Add-Member -NotePropertyName queue -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $queueDefaults = @{ waitSeconds = 1800; pollMilliseconds = 500; leaseSeconds = 180; staleAfterSeconds = 600 }
    foreach ($key in $queueDefaults.Keys) {
        if ($null -eq $policy.queue.PSObject.Properties[$key]) {
            $policy.queue | Add-Member -NotePropertyName $key -NotePropertyValue $queueDefaults[$key] -Force
        }
    }
    if ($null -eq $policy.PSObject.Properties["mainProtection"]) {
        $policy | Add-Member -NotePropertyName mainProtection -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if ($null -eq $policy.mainProtection.PSObject.Properties["enforceOnPublish"]) {
        $policy.mainProtection | Add-Member -NotePropertyName enforceOnPublish -NotePropertyValue $true -Force
    }
    $policy | Add-Member -NotePropertyName policyPath -NotePropertyValue $path -Force
    return $policy
}

function Assert-ReleaseCanonicalPolicy {
    <#
      Production entry points must all resolve the same external policy.  A
      stale clone can otherwise pass its own -PolicyPath and silently create a
      second lock/queue.  CI may use a generated policy, but it still has to
      name the canonical checkout and the standard state-directory basenames.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot
    )
    $repo = ConvertTo-ReleaseFullPath -Path $RepositoryRoot
    $canonical = ConvertTo-ReleaseFullPath -Path ([string]$Policy.canonicalRepo)
    if (-not (Test-ReleasePathEqual -Left $repo -Right $canonical)) {
        throw "发布策略 canonicalRepo 与当前仓库不一致：策略=$canonical，当前=$repo"
    }
    $repoName = Split-Path $canonical -Leaf
    if (-not [string]::Equals($repoName, "wechat-miniapp", [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝使用非 canonical 发布仓库：$canonical"
    }
    $policyName = Split-Path ([IO.Path]::GetFullPath([string]$Policy.policyPath)) -Leaf
    if (-not [string]::Equals($policyName, "wechat-miniapp-release-policy.json", [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝使用旧/临时发布策略文件：$($Policy.policyPath)"
    }
    # Names alone are not enough: a copied policy under another parent could
    # otherwise create a second lock/queue with the same leaf names.  Every
    # state path is anchored to the canonical repository's parent, and the
    # remote is fixed as well.  This makes the policy a singleton, not merely
    # a schema-shaped suggestion.
    $canonicalParent = Split-Path $canonical -Parent
    $expectedPaths = [ordered]@{
        policyPath = Join-Path $canonicalParent "wechat-miniapp-release-policy.json"
        lockPath = Join-Path $canonicalParent "wechat-miniapp-release.lock"
        artifactRoot = $canonicalParent
        reservationRoot = Join-Path $canonicalParent "wechat-miniapp-release-reservations"
        worktreeRoot = Join-Path $canonicalParent "wechat-miniapp-release-worktrees"
        recordRoot = Join-Path $canonicalParent "wechat-miniapp-release-records"
        contextRoot = Join-Path $canonicalParent "wechat-miniapp-release-contexts"
        logRoot = Join-Path $canonicalParent "wechat-miniapp-release-logs"
        queueRoot = Join-Path $canonicalParent "wechat-miniapp-release-queue"
        archiveManifestPath = Join-Path $canonicalParent "wechat-miniapp-release-archive.json"
    }
    foreach ($name in $expectedPaths.Keys) {
        $property = $Policy.PSObject.Properties[$name]
        if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
            throw "发布策略缺少唯一状态路径：$name"
        }
        if (-not (Test-ReleasePathEqual -Left ([string]$property.Value) -Right ([string]$expectedPaths[$name]))) {
            throw "发布策略 $name 必须固定为 $($expectedPaths[$name])，实际为 $($property.Value)"
        }
    }
    $expectedRemote = "https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git"
    if (-not [string]::Equals(([string]$Policy.remote).TrimEnd('/'), $expectedRemote.TrimEnd('/'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "发布策略 remote 不是唯一允许的仓库：$($Policy.remote)"
    }
    if ($null -ne $Policy.PSObject.Properties["mainProtection"] -and
        $null -ne $Policy.mainProtection.PSObject.Properties["mode"] -and
        [string]$Policy.mainProtection.mode -ne "pr-only") {
        throw "发布策略 mainProtection.mode 必须是 pr-only。"
    }
    return $true
}

function ConvertTo-ReleaseFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Test-ReleasePathEqual {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )
    return [string]::Equals(
        (ConvertTo-ReleaseFullPath -Path $Left).TrimEnd('\', '/'),
        (ConvertTo-ReleaseFullPath -Path $Right).TrimEnd('\', '/'),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Invoke-ReleaseGit {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    $output = & git -C $WorkingDirectory @Arguments 2>&1
    if (-not $AllowFailure -and $LASTEXITCODE -ne 0) {
        throw "Git 命令失败：git -C $WorkingDirectory $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return @($output)
}

function Get-ReleaseGitValue {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    return ((Invoke-ReleaseGit -WorkingDirectory $WorkingDirectory -Arguments $Arguments) -join "`n").Trim()
}

function Assert-ReleaseGitRepository {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][object]$Policy,
        [switch]$AllowSourceWorktree
    )

    $path = ConvertTo-ReleaseFullPath -Path $RepositoryPath
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "仓库目录不存在：$path"
    }
    $root = Get-ReleaseGitValue -WorkingDirectory $path -Arguments @("rev-parse", "--show-toplevel")
    $root = ConvertTo-ReleaseFullPath -Path $root
    if (-not (Test-ReleasePathEqual -Left $root -Right $path)) {
        throw "SourcePath 必须指向 Git 仓库根目录：$path（实际根目录：$root）"
    }
    $remote = Get-ReleaseGitValue -WorkingDirectory $path -Arguments @("remote", "get-url", "origin")
    $expectedRemote = [string]$Policy.remote
    if (-not [string]::Equals($remote.TrimEnd('/'), $expectedRemote.TrimEnd('/'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "仓库 origin 不符合发布策略：$remote；期望：$expectedRemote"
    }
    $gitDir = Get-ReleaseGitValue -WorkingDirectory $path -Arguments @("rev-parse", "--git-dir")
    $commonDir = Get-ReleaseGitValue -WorkingDirectory $path -Arguments @("rev-parse", "--git-common-dir")
    $gitDirFull = if ([IO.Path]::IsPathRooted($gitDir)) { ConvertTo-ReleaseFullPath -Path $gitDir } else { ConvertTo-ReleaseFullPath -Path (Join-Path $root $gitDir) }
    $commonDirFull = if ([IO.Path]::IsPathRooted($commonDir)) { ConvertTo-ReleaseFullPath -Path $commonDir } else { ConvertTo-ReleaseFullPath -Path (Join-Path $root $commonDir) }
    $expectedGitDir = ConvertTo-ReleaseFullPath -Path (Join-Path $root ".git")
    $isWorktree = -not (Test-ReleasePathEqual -Left $expectedGitDir -Right $gitDirFull)
    if (-not $AllowSourceWorktree -and $isWorktree) {
        throw "发布源不能从 worktree 直接发布；请通过 release.ps1 的 SourcePath 读取文件。"
    }
    $branch = Get-ReleaseGitValue -WorkingDirectory $path -Arguments @("branch", "--show-current")
    return [pscustomobject]@{
        Path = $path
        Root = $root
        Remote = $remote.Trim()
        Branch = $branch.Trim()
        IsWorktree = $isWorktree
        Commit = Get-ReleaseGitValue -WorkingDirectory $path -Arguments @("rev-parse", "HEAD")
        CommonDir = $commonDirFull
    }
}

function Assert-ReleaseCanonicalRepository {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][object]$Policy
    )
    $expected = ConvertTo-ReleaseFullPath -Path ([string]$Policy.canonicalRepo)
    $actual = ConvertTo-ReleaseFullPath -Path $RepositoryPath
    if (-not (Test-ReleasePathEqual -Left $expected -Right $actual)) {
        throw "发布操作必须使用 canonical 仓库：$expected；收到：$actual"
    }
    $repo = Assert-ReleaseGitRepository -RepositoryPath $actual -Policy $Policy
    if ($repo.IsWorktree) {
        throw "canonical 仓库不能是 Git worktree：$actual"
    }
    # The canonical checkout may be dirty or on a development branch.  The
    # gate never reads its branch as the release baseline; it fetches and uses
    # origin/main below.  Keeping this checkout untouched is what makes the
    # gate safe to run while developers have uncommitted work in progress.
    return $repo
}

function Normalize-ReleaseIncludePaths {
    param(
        [Parameter(Mandatory = $true)][object[]]$InputPath
    )
    $result = New-Object System.Collections.Generic.List[string]
    foreach ($rawItem in @($InputPath)) {
        if ($null -eq $rawItem) { throw "IncludePath 不能包含空值。" }
        $raw = [string]$rawItem
        # Older callers passed one comma-separated scalar.  Keep compatibility,
        # but commas are never valid in a repository filename for this interface.
        $parts = if ($raw.Contains(',')) { $raw.Split(',') } else { @($raw) }
        foreach ($part in $parts) {
            $value = ([string]$part).Trim()
            if ([string]::IsNullOrWhiteSpace($value)) {
                throw "IncludePath 不能包含空项。"
            }
            if ($value.Contains(',')) {
                throw "IncludePath 不允许逗号文件名：$value"
            }
            if ([IO.Path]::IsPathRooted($value) -or $value -match '^[A-Za-z]:') {
                throw "IncludePath 必须是仓库内相对路径：$value"
            }
            $normalized = $value.Replace('\', '/')
            while ($normalized.StartsWith('./', [StringComparison]::Ordinal)) {
                $normalized = $normalized.Substring(2)
            }
            if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized -match '(^|/)\.\.(?:/|$)') {
                throw "IncludePath 不是安全的仓库相对路径：$value"
            }
            if ($normalized -match '(^|/)\.(?:git|worktrees)(?:/|$)') {
                throw "IncludePath 不允许指向 Git 内部目录或 worktree：$value"
            }
            if ($normalized -match '[*?\[\]]') {
                throw "IncludePath 不允许通配符：$value"
            }
            if ($normalized -match '(^|/)(?:\.env(?:\..*)?|project\.private\.config\.json|.*(?:secret|apikey|api_key|appsecret).*)$') {
                throw "IncludePath 疑似包含敏感文件，已拒绝：$value"
            }
            if (-not $result.Contains($normalized)) {
                [void]$result.Add($normalized)
            }
        }
    }
    if ($result.Count -eq 0) {
        throw "必须显式指定至少一个 IncludePath；禁止全量发布。"
    }
    # Cast at the boundary so callers always receive a real string array.
    return [string[]]$result.ToArray()
}

function Get-ReleaseFileSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string[]]$RelativePath
    )
    $snapshot = [ordered]@{}
    foreach ($path in $RelativePath) {
        $full = Join-Path $SourceRoot ($path.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $bytes = [IO.File]::ReadAllBytes($full)
            $snapshot[$path] = [pscustomobject]@{
                exists = $true
                sha256 = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
                bytes = $bytes
            }
        }
        else {
            $snapshot[$path] = [pscustomobject]@{ exists = $false; sha256 = "<missing>"; bytes = @() }
        }
    }
    return $snapshot
}

function Assert-ReleaseFileSnapshotStable {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][object]$Snapshot
    )
    foreach ($entry in $Snapshot.GetEnumerator()) {
        $path = [string]$entry.Key
        $expected = $entry.Value
        $full = Join-Path $SourceRoot ($path.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $exists = Test-Path -LiteralPath $full -PathType Leaf
        if ($exists -ne [bool]$expected.exists) {
            throw "发布源在执行期间发生变化：$path"
        }
        if ($exists) {
            $actual = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne [string]$expected.sha256) {
                throw "发布源在执行期间发生变化：$path"
            }
        }
    }
}

function Copy-ReleaseFileSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][object]$Snapshot
    )
    foreach ($entry in $Snapshot.GetEnumerator()) {
        $path = [string]$entry.Key
        $item = $entry.Value
        $target = Join-Path $TargetRoot ($path.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if ($item.exists) {
            New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
            $extension = [IO.Path]::GetExtension($path).ToLowerInvariant()
            $textExtensions = @('.js', '.json', '.wxml', '.wxss', '.css', '.md', '.ps1', '.py', '.cmd', '.yml', '.yaml', '.txt', '.xml', '.html', '.ts')
            if ($extension -in $textExtensions) {
                # Normalize only known text files.  This avoids importing a
                # CRLF-only dirty clone as trailing whitespace into the index.
                $text = [Text.Encoding]::UTF8.GetString([byte[]]$item.bytes) -replace "`r`n?", "`n"
                [IO.File]::WriteAllText($target, $text, [Text.UTF8Encoding]::new($false))
            } else {
                [IO.File]::WriteAllBytes($target, [byte[]]$item.bytes)
            }
        }
        elseif (Test-Path -LiteralPath $target -PathType Leaf) {
            Remove-Item -LiteralPath $target -Force
        }
    }
}

function Get-ReleaseVersionPaths {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)
    $paths = @(
        "config.js",
        "cloudfunctions/api/index.js",
        "cloudfunctions/api/package.json",
        "cloudfunctions/api/package-lock.json",
        "media-worker/package.json",
        "media-worker/package-lock.json"
    )
    if (Test-Path -LiteralPath (Join-Path $SourceRoot "cloudfunctions/watermark-gateway/package.json") -PathType Leaf) {
        $paths += "cloudfunctions/watermark-gateway/package.json"
    }
    return @($paths)
}

function Get-ReleaseConfigVersion {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)
    $path = Join-Path $SourceRoot "config.js"
    $match = [regex]::Match((Get-Content -LiteralPath $path -Raw -Encoding UTF8), 'appVersion:\s*"([^"]+)"')
    if (-not $match.Success) { throw "config.js 没有找到 appVersion：$path" }
    return $match.Groups[1].Value
}

function ConvertTo-ReleaseVersionParts {
    param([Parameter(Mandatory = $true)][string]$Version)
    $match = [regex]::Match($Version.Trim(), '^(\d+)\.(\d+)\.(\d+)$')
    if (-not $match.Success) { throw "版本号不是三段式语义版本：$Version" }
    return @([int64]$match.Groups[1].Value, [int64]$match.Groups[2].Value, [int64]$match.Groups[3].Value)
}

function Get-ReleaseNextPatchVersion {
    param([Parameter(Mandatory = $true)][string]$BaseVersion)
    $parts = ConvertTo-ReleaseVersionParts -Version $BaseVersion
    if ($parts[2] -eq [int64]::MaxValue) { throw "补丁版本已达到最大值：$BaseVersion" }
    return "$($parts[0]).$($parts[1]).$($parts[2] + 1)"
}

function Test-ReleaseVersionGreater {
    param([Parameter(Mandatory = $true)][string]$Candidate, [Parameter(Mandatory = $true)][string]$Base)
    $a = ConvertTo-ReleaseVersionParts -Version $Candidate
    $b = ConvertTo-ReleaseVersionParts -Version $Base
    for ($i = 0; $i -lt 3; $i++) {
        if ($a[$i] -gt $b[$i]) { return $true }
        if ($a[$i] -lt $b[$i]) { return $false }
    }
    return $false
}

function Get-ReleaseUsedVersions {
    param(
        [Parameter(Mandatory = $true)][string]$ReservationRoot,
        [Parameter(Mandatory = $true)][string]$RecordRoot,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [string]$QueueRoot = "",
        [string]$ContextRoot = ""
    )
    $used = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    foreach ($root in @($ReservationRoot, $RecordRoot)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($file in Get-ChildItem -LiteralPath $root -Filter '*.json' -File -ErrorAction SilentlyContinue) {
            try {
                $record = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                $targetProperty = $record.PSObject.Properties["targetVersion"]
                $versionProperty = $record.PSObject.Properties["version"]
                $value = if ($null -ne $targetProperty -and $targetProperty.Value) { [string]$targetProperty.Value } elseif ($null -ne $versionProperty -and $versionProperty.Value) { [string]$versionProperty.Value } else { "" }
                if ($value -match '^\d+\.\d+\.\d+$') { [void]$used.Add($value) }
            } catch { throw "发布记录/ reservation 无法解析：$($file.FullName)" }
        }
    }
    # The queue ticket receives the allocated version before the reservation
    # sidecar is written.  A crash in that small window must still block the
    # version on the next operation; otherwise two publishers can allocate the
    # same number even though only one reservation file exists.
    if (-not [string]::IsNullOrWhiteSpace($QueueRoot)) {
        $queuePath = Join-Path (ConvertTo-ReleaseFullPath -Path $QueueRoot) "queue.json"
        if (Test-Path -LiteralPath $queuePath -PathType Leaf) {
            try {
                $queue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
                foreach ($ticket in @($queue.tickets)) {
                    $value = [string]$ticket.version
                    if ($value -match '^\d+\.\d+\.\d+$') { [void]$used.Add($value) }
                    $requested = [string]$ticket.requestedVersion
                    if ($requested -match '^\d+\.\d+\.\d+$') { [void]$used.Add($requested) }
                }
            }
            catch { throw "发布队列无法解析，拒绝分配新版本：$queuePath。$($_.Exception.Message)" }
        }
    }
    # Context is another durable write-ahead record.  Include it as a
    # defensive fallback for a crash after context creation but before the
    # reservation/record sidecars are flushed.
    if (-not [string]::IsNullOrWhiteSpace($ContextRoot)) {
        $resolvedContextRoot = ConvertTo-ReleaseFullPath -Path $ContextRoot
        if (Test-Path -LiteralPath $resolvedContextRoot -PathType Container) {
            foreach ($file in Get-ChildItem -LiteralPath $resolvedContextRoot -Filter '*.json' -File -ErrorAction SilentlyContinue) {
                try {
                    $context = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                    $value = [string]$context.version
                    if ($value -match '^\d+\.\d+\.\d+$') { [void]$used.Add($value) }
                }
                catch { throw "release context 无法解析，拒绝分配新版本：$($file.FullName)。$($_.Exception.Message)" }
            }
        }
    }
    # 远端 tag 无法读取时必须失败关闭，不能在不完整的版本视图上分配新版本。
    $tagLines = Invoke-ReleaseGit -WorkingDirectory $RepositoryRoot -Arguments @("ls-remote", "--tags", "origin")
    foreach ($line in $tagLines) {
        if ([string]$line -match 'refs/tags/v?(\d+\.\d+\.\d+)(?:\^\{\})?$') { [void]$used.Add($Matches[1]) }
    }
    # A pushed release branch may exist even when the process died before its
    # PR/record write.  Treat its version as reserved; never overwrite or
    # reuse that branch on a later operation.
    $branchLines = Invoke-ReleaseGit -WorkingDirectory $RepositoryRoot -Arguments @("ls-remote", "--heads", "origin", "refs/heads/release/*")
    foreach ($line in $branchLines) {
        if ([string]$line -match 'refs/heads/release/(\d+\.\d+\.\d+)(?:-|$)') { [void]$used.Add($Matches[1]) }
    }
    return ,$used
}

function New-ReleaseReservation {
    param(
        [Parameter(Mandatory = $true)][string]$ReservationRoot,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$BaseHead,
        [Parameter(Mandatory = $true)][string[]]$IncludePath,
        [Parameter(Mandatory = $true)][string]$SourcePath
    )
    New-Item -ItemType Directory -Path $ReservationRoot -Force | Out-Null
    $target = Join-Path $ReservationRoot "reservation-$Version-$OperationId.json"
    if (Test-Path -LiteralPath $target) { throw "reservation 文件已存在：$target" }
    $record = [ordered]@{
        schemaVersion = 1
        operationId = $OperationId
        status = "reserved"
        targetVersion = $Version
        baseHead = $BaseHead
        sourcePath = $SourcePath
        includePaths = @($IncludePath)
        createdAt = [DateTimeOffset]::UtcNow.ToString("o")
    }
    $temp = "$target.$PID.tmp"
    [IO.File]::WriteAllText($temp, ($record | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $target
    return [pscustomobject]@{ Path = $target; Record = [pscustomobject]$record }
}

function Set-ReleaseReservationStatus {
    param(
        [Parameter(Mandatory = $true)][string]$ReservationPath,
        [Parameter(Mandatory = $true)][string]$Status,
        [hashtable]$Extra = @{}
    )
    if (-not (Test-Path -LiteralPath $ReservationPath -PathType Leaf)) { return }
    $record = Get-Content -LiteralPath $ReservationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $hash = [ordered]@{}
    foreach ($property in $record.PSObject.Properties) { $hash[$property.Name] = $property.Value }
    $hash.status = $Status
    $hash.updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    foreach ($key in $Extra.Keys) { $hash[$key] = $Extra[$key] }
    $temp = "$ReservationPath.$PID.tmp"
    [IO.File]::WriteAllText($temp, ($hash | ConvertTo-Json -Depth 10) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $ReservationPath -Force
}

function Resolve-ReleaseVersion {
    param(
        [Parameter(Mandatory = $true)][string]$BaseVersion,
        [string]$RequestedVersion = "",
        [Parameter(Mandatory = $true)][object]$UsedVersions
    )
    $candidate = Get-ReleaseNextPatchVersion -BaseVersion $BaseVersion
    while ($UsedVersions.Contains($candidate)) {
        $candidate = Get-ReleaseNextPatchVersion -BaseVersion $candidate
    }
    if (-not [string]::IsNullOrWhiteSpace($RequestedVersion)) {
        $requested = $RequestedVersion.Trim()
        if (-not (Test-ReleaseVersionGreater -Candidate $requested -Base $BaseVersion)) {
            throw "指定发布版本必须高于远端基线 $BaseVersion：$requested"
        }
        if ($requested -ne $candidate) {
            throw "指定发布版本 $requested 不是闸门分配的下一个可用版本 $candidate。"
        }
    }
    return $candidate
}

function Get-ReleaseRemoteOwner {
    param([Parameter(Mandatory = $true)][string]$RemoteUrl)
    $value = $RemoteUrl.Trim()
    $match = [regex]::Match($value, 'github\.com[/:]([^/]+)/[^/]+?(?:\.git)?$')
    if (-not $match.Success) { return "" }
    return $match.Groups[1].Value
}

function Get-ReleaseGitHubSlug {
    param([Parameter(Mandatory = $true)][string]$RemoteUrl)
    $value = $RemoteUrl.Trim()
    $match = [regex]::Match($value, 'github\.com[/:]([^/]+/[^/]+?)(?:\.git)?$')
    if (-not $match.Success) { return "" }
    return $match.Groups[1].Value
}

function Resolve-ReleaseIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$RemoteUrl
    )
    $nameOutput = Invoke-ReleaseGit -WorkingDirectory $WorkingDirectory -Arguments @("config", "--get", "user.name") -AllowFailure
    $emailOutput = Invoke-ReleaseGit -WorkingDirectory $WorkingDirectory -Arguments @("config", "--get", "user.email") -AllowFailure
    $name = (($nameOutput | Where-Object { $_ -is [string] }) -join "`n").Trim()
    $email = (($emailOutput | Where-Object { $_ -is [string] }) -join "`n").Trim()
    $placeholder = [string]::IsNullOrWhiteSpace($email) -or
        $email -match '你的GitHub邮箱|your.*email|example\.(com|invalid)$|^placeholder@'
    if (-not $placeholder -and $email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { $placeholder = $true }
    $owner = Get-ReleaseRemoteOwner -RemoteUrl $RemoteUrl
    if ([string]::IsNullOrWhiteSpace($name)) { $name = $owner }
    if ($placeholder) {
        if ([string]::IsNullOrWhiteSpace($owner)) {
            throw "无法从远端 URL 推导 Git 提交邮箱，请在发布命令中提供有效身份。"
        }
        $email = "$owner@users.noreply.github.com"
    }
    if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($email)) {
        throw "Git 提交身份不完整。"
    }
    # Do not write `git config --local` here.  Linked worktrees without
    # extensions.worktreeConfig resolve --local to the shared common config,
    # which would silently mutate the developer's canonical checkout.  The
    # caller passes this identity as per-command `git -c` values for commit.
    return [pscustomobject]@{ Name = $name; Email = $email; Derived = $placeholder }
}

function Get-ReleaseSourceSha256 {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)
    $excluded = @("node_modules", ".git", ".superpowers", ".worktrees", ".githooks", "__pycache__")
    $files = Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $relative = $_.FullName.Substring($SourceRoot.TrimEnd('\', '/').Length).TrimStart('\', '/') -replace '\\', '/'
            $parts = $relative.Split('/')
            @($parts | Where-Object { $_ -in $excluded }).Count -eq 0 -and
                $relative -ne "project.private.config.json" -and
                $_.Extension.ToLowerInvariant() -notin @('.zip', '.tgz', '.pyc') -and
                @($parts | Where-Object { $_ -like '_tmp_*' }).Count -eq 0
        } | Sort-Object { $_.FullName.Substring($SourceRoot.Length).Replace('\', '/') }
    $hash = [Security.Cryptography.SHA256]::Create()
    [byte[]]$zero = @(0)
    [byte[]]$empty = @()
    try {
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($SourceRoot.TrimEnd('\', '/').Length).TrimStart('\', '/') -replace '\\', '/'
            $prefix = [Text.Encoding]::UTF8.GetBytes($relative + "`0")
            $bytes = [IO.File]::ReadAllBytes($file.FullName)
            $suffix = [byte]0
            [void]$hash.TransformBlock($prefix, 0, $prefix.Length, $prefix, 0)
            if ($bytes.Length -gt 0) { [void]$hash.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0) }
            [void]$hash.TransformBlock($zero, 0, 1, $zero, 0)
        }
        [void]$hash.TransformFinalBlock($empty, 0, 0)
        return ([BitConverter]::ToString($hash.Hash) -replace '-', '').ToLowerInvariant()
    }
    finally { $hash.Dispose() }
}

function Write-ReleaseGateJsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $parent = Split-Path ([IO.Path]::GetFullPath($Path)) -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temp = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 15) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Update-ReleaseArchiveManifest {
    param([Parameter(Mandatory = $true)][object]$Policy)
    $canonical = ConvertTo-ReleaseFullPath -Path ([string]$Policy.canonicalRepo)
    $parent = Split-Path $canonical -Parent
    $entries = New-Object System.Collections.Generic.List[object]
    $seen = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    $expectedRemote = ([string]$Policy.remote).TrimEnd('/')

    # Do not infer publishability from a directory name.  The old tree contains
    # both `wechat-miniapp-*` and `_provider-*`/`_watermark-*` clones, and a
    # worktree root can itself contain another level of detached worktrees.  We
    # inspect Git metadata and keep only repositories pointing at this release
    # remote (plus the canonical path).  Reparse points are skipped so an
    # archive run cannot walk a junction outside the project area.
    $candidates = New-Object System.Collections.Generic.List[string]
    [void]$candidates.Add($canonical)
    foreach ($directory in @(Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction SilentlyContinue)) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        [void]$candidates.Add((ConvertTo-ReleaseFullPath -Path $directory.FullName))
        $name = [string]$directory.Name
        $looksLikeWorktreeRoot = $name -match '(?i)(release-worktrees|worktrees|release-contexts|release-records|release-reservations)$'
        if ($looksLikeWorktreeRoot) {
            foreach ($nested in @(Get-ChildItem -LiteralPath $directory.FullName -Directory -Force -ErrorAction SilentlyContinue)) {
                if (($nested.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                [void]$candidates.Add((ConvertTo-ReleaseFullPath -Path $nested.FullName))
            }
        }
    }
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        $path = ConvertTo-ReleaseFullPath -Path ([string]$candidate)
        if (-not $seen.Add($path)) { continue }
        $isCanonical = Test-ReleasePathEqual -Left $path -Right $canonical
        $gitRoot = (& git -C $path rev-parse --show-toplevel 2>$null | Out-String).Trim()
        $isGit = $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($gitRoot)
        if (-not $isGit -and -not $isCanonical) { continue }
        $remote = if ($isGit) { (& git -C $path remote get-url origin 2>$null | Out-String).Trim() } else { "" }
        $remoteMatches = $isCanonical -or [string]::Equals($remote.TrimEnd('/'), $expectedRemote, [StringComparison]::OrdinalIgnoreCase)
        if (-not $remoteMatches) { continue }
        $branch = if ($isGit) { (& git -C $path branch --show-current 2>$null | Out-String).Trim() } else { "" }
        $head = if ($isGit) { (& git -C $path rev-parse HEAD 2>$null | Out-String).Trim() } else { "" }
        [void]$entries.Add([ordered]@{
            path = $path
            canonical = $isCanonical
            gitRepository = $isGit
            remote = $remote
            branch = $branch
            head = $head
            publishable = $isCanonical
            reason = if ($isCanonical) { "唯一 canonical 发布源" } else { "历史 clone/worktree 仅封存，不允许发布" }
        })
    }
    $sortedEntries = @($entries | Sort-Object -Property path)
    $manifest = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        canonicalRepo = $canonical
        entries = [object[]]$sortedEntries
    }
    Write-ReleaseGateJsonAtomic -Path ([string]$Policy.archiveManifestPath) -Value $manifest
    return [string]$Policy.archiveManifestPath
}

function New-ReleaseContext {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$SourceCommit,
        [Parameter(Mandatory = $true)][string]$ReleaseCommit,
        [Parameter(Mandatory = $true)][string]$TreeSha,
        [Parameter(Mandatory = $true)][string]$SourceSha256,
        [Parameter(Mandatory = $true)][string]$ArtifactPath,
        [int]$ExpiresMinutes = 180,
        [string]$BaseHead = "",
        [string]$QueueTicketPath = "",
        [string]$Phase = "prepared"
    )
    $context = [ordered]@{
        schemaVersion = 2
        operationId = $OperationId
        canonicalRepo = [IO.Path]::GetFullPath([string]$Policy.canonicalRepo)
        remote = [string]$Policy.remote
        branch = [string]$Policy.branch
        version = $Version
        sourceCommit = $SourceCommit
        releaseCommit = $ReleaseCommit
        treeSha = $TreeSha
        sourceSha256 = $SourceSha256.ToLowerInvariant()
        artifactPath = [IO.Path]::GetFullPath($ArtifactPath)
        baseHead = $BaseHead
        queueTicketPath = if ([string]::IsNullOrWhiteSpace($QueueTicketPath)) { "" } else { [IO.Path]::GetFullPath($QueueTicketPath) }
        createdAt = [DateTimeOffset]::UtcNow.ToString("o")
        expiresAt = [DateTimeOffset]::UtcNow.AddMinutes($ExpiresMinutes).ToString("o")
        phase = $Phase
        status = "prepared"
        receipts = [ordered]@{}
        recovery = [ordered]@{ resumable = $true; lastFailureStage = "" }
    }
    Write-ReleaseGateJsonAtomic -Path $Path -Value $context
    return [pscustomobject]$context
}

function Assert-ReleaseContextShape {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][object]$Policy
    )
    foreach ($name in @("schemaVersion", "operationId", "canonicalRepo", "version", "sourceCommit", "releaseCommit", "treeSha", "sourceSha256", "artifactPath", "expiresAt")) {
        if ($null -eq $Context.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$Context.$name)) {
            throw "release context 缺少字段：$name"
        }
    }
    if ([int]$Context.schemaVersion -notin @(1, 2)) { throw "不支持的 release context schemaVersion：$($Context.schemaVersion)" }
    if (-not (Test-ReleasePathEqual -Left ([string]$Context.canonicalRepo) -Right ([string]$Policy.canonicalRepo))) { throw "release context canonicalRepo 不匹配策略。" }
    $remoteProperty = $Context.PSObject.Properties["remote"]
    if ($null -ne $remoteProperty -and -not [string]::Equals([string]$remoteProperty.Value, [string]$Policy.remote, [StringComparison]::OrdinalIgnoreCase)) {
        throw "release context remote 不匹配策略。"
    }
    $branchProperty = $Context.PSObject.Properties["branch"]
    if ($null -ne $branchProperty -and [string]$branchProperty.Value -ne [string]$Policy.branch) {
        throw "release context branch 不匹配策略。"
    }
    if ([string]$Context.version -notmatch '^\d+\.\d+\.\d+$') { throw "release context 版本号无效：$($Context.version)" }
    if ([string]$Context.sourceSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "release context 源码 SHA256 无效。" }
    if ([string]$Context.releaseCommit -notmatch '^[0-9a-fA-F]{7,64}$') { throw "release context releaseCommit 无效。" }
    if ([string]$Context.treeSha -notmatch '^[0-9a-fA-F]{7,64}$') { throw "release context treeSha 无效。" }
    if ([int]$Context.schemaVersion -ge 2) {
        if ($null -eq $Context.PSObject.Properties["phase"] -or [string]::IsNullOrWhiteSpace([string]$Context.phase)) { throw "release context v2 缺少 phase。" }
        if ($null -eq $Context.PSObject.Properties["baseHead"] -or [string]$Context.baseHead -notmatch '^[0-9a-fA-F]{7,64}$') { throw "release context v2 baseHead 无效。" }
    }
    $expires = ConvertTo-ReleaseUtcDateTime -Value $Context.expiresAt
    if ($expires -le [DateTime]::UtcNow) { throw "release context 已过期。" }
    return $true
}

function New-ReleaseOperationLogPath {
    param(
        [Parameter(Mandatory = $true)][string]$LogRoot,
        [Parameter(Mandatory = $true)][string]$OperationId
    )
    New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
    return Join-Path $LogRoot "release-$OperationId.log"
}

function Write-ReleaseOperationLog {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$OperationId = ""
    )
    $line = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString("o"); operationId = $OperationId; stage = $Stage; message = $Message } |
        ConvertTo-Json -Compress
    Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
}

function Set-ReleaseQueuePhase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$QueueRoot,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$Phase,
        [string]$Status = "",
        [string]$Version = "",
        [string]$BaseHead = "",
        [string]$ContextPath = "",
        [string]$ReservationPath = "",
        [string]$ErrorMessage = "",
        [object]$Lease = $null,
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )

    $phaseValue = ([string]$Phase).Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($phaseValue) -or $phaseValue -match '[\r\n]' -or $phaseValue.Length -gt 200) {
        throw "发布阶段为空、过长或包含换行：$Phase"
    }
    if (-not (Get-Command Get-ReleaseQueueTicket -ErrorAction SilentlyContinue)) { return $null }
    $ticket = Get-ReleaseQueueTicket -QueueRoot $QueueRoot -OperationId $OperationId -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
    if ($null -eq $ticket) { return $null }
    # Preserve the original request metadata (publish/preview/deploy flags)
    # while adding the current phase.  The queue state machine deliberately
    # stays small; detailed release phases live in metadata.
    # Update-ReleaseQueueTicket remains available for administrative edits;
    # normal phase writes below use Set-ReleaseQueueTicketStatus so metadata
    # and status commit in one transaction.
    # Complete-ReleaseQueueTicket and Renew-ReleaseQueueLease remain the public
    # terminal/heartbeat APIs; this adapter delegates their state transition to
    # the same status primitive to keep the write atomic.
    $metadata = [ordered]@{}
    if ($ticket.PSObject.Properties["metadata"] -and $null -ne $ticket.metadata) {
        if ($ticket.metadata -is [Collections.IDictionary]) {
            foreach ($entry in $ticket.metadata.GetEnumerator()) { $metadata[[string]$entry.Key] = $entry.Value }
        }
        else {
            foreach ($property in $ticket.metadata.PSObject.Properties) { $metadata[$property.Name] = $property.Value }
        }
    }
    $metadata.phase = $phaseValue
    $metadata.stage = $phaseValue
    if (-not [string]::IsNullOrWhiteSpace($Version)) { $metadata.version = $Version }
    elseif (-not $metadata.Contains('version') -and -not [string]::IsNullOrWhiteSpace([string]$ticket.version)) { $metadata.version = [string]$ticket.version }
    if (-not [string]::IsNullOrWhiteSpace($BaseHead)) { $metadata.baseHead = $BaseHead }
    elseif (-not $metadata.Contains('baseHead') -and -not [string]::IsNullOrWhiteSpace([string]$ticket.baseHead)) { $metadata.baseHead = [string]$ticket.baseHead }
    if (-not [string]::IsNullOrWhiteSpace($ContextPath)) { $metadata.contextPath = $ContextPath }
    elseif (-not $metadata.Contains('contextPath') -and -not [string]::IsNullOrWhiteSpace([string]$ticket.contextPath)) { $metadata.contextPath = [string]$ticket.contextPath }
    if (-not [string]::IsNullOrWhiteSpace($ReservationPath)) { $metadata.reservationPath = $ReservationPath }
    elseif (-not $metadata.Contains('reservationPath') -and -not [string]::IsNullOrWhiteSpace([string]$ticket.reservationPath)) { $metadata.reservationPath = [string]$ticket.reservationPath }
    if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $metadata.lastError = $ErrorMessage }
    $metadata.updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    if ($Status.Trim().ToLowerInvariant() -in @("failed", "recoverable")) {
        $metadata.recoveryStatus = $Status.Trim().ToLowerInvariant()
    }
    $ticketId = [string]$ticket.ticketId
    # Accept either a full queue ticket or a compact {id, owner} lease object.
    $leaseId = ""
    $leaseOwner = ""
    $leaseSeconds = 180
    if ($null -ne $Lease) {
        $leaseId = [string](Get-ReleaseQueueProperty -Object $Lease -Name "leaseId" -Default "")
        if ([string]::IsNullOrWhiteSpace($leaseId)) { $leaseId = [string](Get-ReleaseQueueProperty -Object $Lease -Name "id" -Default "") }
        $leaseOwner = [string](Get-ReleaseQueueProperty -Object $Lease -Name "leaseOwner" -Default "")
        if ([string]::IsNullOrWhiteSpace($leaseOwner)) { $leaseOwner = [string](Get-ReleaseQueueProperty -Object $Lease -Name "owner" -Default "") }
        $nestedLease = Get-ReleaseQueueProperty -Object $Lease -Name "lease" -Default $null
        if ($null -ne $nestedLease) {
            if ([string]::IsNullOrWhiteSpace($leaseId)) { $leaseId = [string](Get-ReleaseQueueProperty -Object $nestedLease -Name "id" -Default "") }
            if ([string]::IsNullOrWhiteSpace($leaseOwner)) { $leaseOwner = [string](Get-ReleaseQueueProperty -Object $nestedLease -Name "owner" -Default "") }
        }
        $leaseSecondsValue = Get-ReleaseQueueProperty -Object $Lease -Name "leaseSeconds" -Default 180
        if ([int]$leaseSecondsValue -gt 0) { $leaseSeconds = [int]$leaseSecondsValue }
    }

    $desired = if ([string]::IsNullOrWhiteSpace($Status)) { [string]$ticket.status } else { $Status.Trim().ToLowerInvariant() }
    if ($desired -notin (Get-ReleaseQueueStatusList) -and $desired -notin @("reserved", "prepared", "pr-opened", "merged", "deployed", "previewed", "finalizing")) {
        throw "未知队列状态：$Status"
    }
    $setArgs = @{
        TicketId = $ticketId
        Status = $desired
        Stage = $phaseValue
        QueueRoot = $QueueRoot
        WaitSeconds = $WaitSeconds
        PollMilliseconds = $PollMilliseconds
        Metadata = $metadata
    }
    if (-not [string]::IsNullOrWhiteSpace($OperationId)) { $setArgs.OperationId = $OperationId }
    if (-not [string]::IsNullOrWhiteSpace($Version)) { $setArgs.Version = $Version }
    if (-not [string]::IsNullOrWhiteSpace($BaseHead)) { $setArgs.BaseHead = $BaseHead }
    if (-not [string]::IsNullOrWhiteSpace($ContextPath)) { $setArgs.ContextPath = $ContextPath }
    if (-not [string]::IsNullOrWhiteSpace($ReservationPath)) { $setArgs.ReservationPath = $ReservationPath }
    if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $setArgs.ErrorMessage = $ErrorMessage }
    if (-not [string]::IsNullOrWhiteSpace($leaseId)) { $setArgs.LeaseId = $leaseId }
    if (-not [string]::IsNullOrWhiteSpace($leaseOwner)) { $setArgs.LeaseOwner = $leaseOwner }
    return Set-ReleaseQueueTicketStatus @setArgs
}

function Remove-ReleaseGateWorktree {
    param([string]$CanonicalRepo, [string]$WorktreePath)
    if ([string]::IsNullOrWhiteSpace($WorktreePath)) { return }
    & git -C $CanonicalRepo worktree remove --force $WorktreePath 2>$null | Out-Null
    Remove-Item -LiteralPath $WorktreePath -Recurse -Force -ErrorAction SilentlyContinue
}

function Test-ReleaseGitHubProtection {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][object]$Policy,
        [switch]$AllowUnavailable
    )

    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -eq $gh) {
        if ($AllowUnavailable) { return [pscustomobject]@{ available = $false; enforced = $false; reason = "gh 不存在" } }
        throw "发布保护预检失败：找不到 GitHub CLI gh。[RELEASE_PROTECTION_UNAVAILABLE]"
    }
    & $gh.Source auth status --hostname github.com *> $null
    if ($LASTEXITCODE -ne 0) {
        if ($AllowUnavailable) { return [pscustomobject]@{ available = $false; enforced = $false; reason = "gh 未认证" } }
        throw "发布保护预检失败：GitHub CLI 未认证。[RELEASE_PROTECTION_UNAVAILABLE]"
    }
    $remote = Get-ReleaseGitValue -WorkingDirectory $RepositoryRoot -Arguments @("remote", "get-url", "origin")
    $slug = Get-ReleaseGitHubSlug -RemoteUrl $remote
    if ([string]::IsNullOrWhiteSpace($slug)) {
        if ($AllowUnavailable) { return [pscustomobject]@{ available = $false; enforced = $false; reason = "无法解析仓库" } }
        throw "发布保护预检失败：无法从 origin 解析 GitHub 仓库。[RELEASE_PROTECTION_UNAVAILABLE]"
    }
    $branch = [string]$Policy.branch
    $path = "repos/$slug/branches/$branch/protection"
    $output = @(& $gh.Source api $path --header "Accept: application/vnd.github+json" 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $text = ($output -join "`n")
        $reason = if ($text -match "Upgrade to GitHub Pro|make this repository public|403") {
            "当前 GitHub 套餐不允许启用主线保护"
        }
        else {
            "GitHub protection API 返回错误"
        }
        if ($AllowUnavailable) { return [pscustomobject]@{ available = $false; enforced = $false; reason = $reason; raw = $text } }
        throw "发布保护预检失败：$reason。[RELEASE_PROTECTION_UNAVAILABLE]"
    }
    try { $protection = ($output -join "`n") | ConvertFrom-Json }
    catch {
        if ($AllowUnavailable) { return [pscustomobject]@{ available = $false; enforced = $false; reason = "保护响应不是 JSON" } }
        throw "发布保护预检失败：GitHub protection 响应无法解析。[RELEASE_PROTECTION_INVALID]"
    }
    $requiredWorkflow = [string]$Policy.mainProtection.requiredWorkflow
    $contexts = @()
    $requiredChecksProperty = $protection.PSObject.Properties["required_status_checks"]
    if ($null -ne $requiredChecksProperty -and $null -ne $requiredChecksProperty.Value) {
        $requiredChecks = $requiredChecksProperty.Value
        $contextsProperty = $requiredChecks.PSObject.Properties["contexts"]
        if ($null -ne $contextsProperty -and $null -ne $contextsProperty.Value) {
            $contexts = @($contextsProperty.Value | ForEach-Object { [string]$_ })
        }
        $checksProperty = $requiredChecks.PSObject.Properties["checks"]
        if ($contexts.Count -eq 0 -and $null -ne $checksProperty -and $null -ne $checksProperty.Value) {
            $contexts = @($checksProperty.Value | ForEach-Object { [string]$_.context })
        }
    }
    $hasRequired = $contexts -contains "release-gate" -or $contexts -contains $requiredWorkflow
    $admins = $false
    $adminsProperty = $protection.PSObject.Properties["enforce_admins"]
    if ($null -ne $adminsProperty -and $null -ne $adminsProperty.Value) {
        $enabledProperty = $adminsProperty.Value.PSObject.Properties["enabled"]
        if ($null -ne $enabledProperty) { $admins = [bool]$enabledProperty.Value }
    }
    $enforced = $hasRequired -and $admins
    if (-not $enforced -and -not $AllowUnavailable) {
        throw "发布保护预检失败：main 未强制要求 release-gate 或未对管理员生效。[RELEASE_PROTECTION_INVALID]"
    }
    return [pscustomobject]@{
        available = $true
        enforced = $enforced
        requiredChecks = $contexts
        enforceAdmins = $admins
        branch = $branch
        repository = $slug
    }
}

function Get-ReleasePullRequestString {
    <#
      gh returns a PSCustomObject whose optional fields become absent/null
      depending on the PR state (for example mergeCommit is null while a PR
      is open).  StrictMode makes direct access to a missing property throw,
      so all integrity checks go through this small, null-safe accessor.
    #>
    param(
        [object]$PullRequest,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $PullRequest) { return "" }
    $property = $PullRequest.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return "" }
    return ([string]$property.Value).Trim()
}

function Get-ReleasePullRequestMergeOid {
    param([object]$PullRequest)
    if ($null -eq $PullRequest) { return "" }
    $mergeProperty = $PullRequest.PSObject.Properties["mergeCommit"]
    if ($null -eq $mergeProperty -or $null -eq $mergeProperty.Value) { return "" }
    return Get-ReleasePullRequestString -PullRequest $mergeProperty.Value -Name "oid"
}

function Assert-ReleasePullRequestHead {
    <#
      A release branch is immutable for one operation.  Reusing a PR whose
      head moved to another commit would make the context/ZIP disagree with
      what GitHub actually merged, so a missing or mismatched headRefOid is a
      hard failure (never a warning).
    #>
    param(
        [Parameter(Mandatory = $true)][object]$PullRequest,
        [Parameter(Mandatory = $true)][string]$CommitSha,
        [string]$Label = "release PR"
    )
    $headOid = Get-ReleasePullRequestString -PullRequest $PullRequest -Name "headRefOid"
    if ([string]::IsNullOrWhiteSpace($headOid)) {
        throw "$Label 缺少 headRefOid，无法证明它对应当前 releaseCommit=$CommitSha。"
    }
    if (-not [string]::Equals($headOid, $CommitSha, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label headRefOid=$headOid 与 releaseCommit=$CommitSha 不一致，拒绝复用/合并。"
    }
    return $headOid
}

function Assert-ReleasePullRequestBase {
    <#
      The branch name contains the operation id, but a user can still
      retarget a PR in the GitHub UI.  A release is valid only when the exact
      PR targets the policy's protected main branch.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$PullRequest,
        [string]$ExpectedBase = "main",
        [string]$Label = "release PR"
    )
    $baseRef = Get-ReleasePullRequestString -PullRequest $PullRequest -Name "baseRefName"
    if ([string]::IsNullOrWhiteSpace($baseRef)) {
        throw "$Label 缺少 baseRefName，无法证明它指向 $ExpectedBase。"
    }
    if (-not [string]::Equals($baseRef, $ExpectedBase, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label baseRefName=$baseRef，不是受保护目标分支 $ExpectedBase，拒绝继续。"
    }
    return $baseRef
}

function Assert-ReleaseMainContainsCommit {
    <#
      Fetch the protected main ref while the release lock is held and verify
      that the commit just checked in the PR is represented there.  GitHub's
      default merge mode is squash: in that mode releaseCommit itself is not
      an ancestor of main, while the PR's mergeCommit is.  We therefore accept
      either relation, but only after headRefOid == releaseCommit was proven.
      This prevents a false failure for squash merges without weakening the
      identity check that binds the merged result to this context.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ReleaseCommit,
        [string]$MergeCommit = ""
    )
    if ($ReleaseCommit -notmatch '^[0-9a-fA-F]{7,64}$') {
        throw "releaseCommit 不是有效 Git SHA：$ReleaseCommit"
    }
    if (-not [string]::IsNullOrWhiteSpace($MergeCommit) -and $MergeCommit -notmatch '^[0-9a-fA-F]{7,64}$') {
        throw "PR mergeCommit 不是有效 Git SHA：$MergeCommit"
    }

    # Explicit refspec avoids accidentally updating a developer checkout's
    # current branch and makes the exact origin/main evidence auditable.
    $null = Invoke-ReleaseGit -WorkingDirectory $RepositoryRoot -Arguments @(
        "fetch", "origin", "refs/heads/main:refs/remotes/origin/main"
    )
    $mainHead = Get-ReleaseGitValue -WorkingDirectory $RepositoryRoot -Arguments @(
        "rev-parse", "refs/remotes/origin/main"
    )
    if ([string]::IsNullOrWhiteSpace($mainHead) -or $mainHead -notmatch '^[0-9a-fA-F]{7,64}$') {
        throw "fetch 后无法解析 refs/remotes/origin/main。"
    }

    # Validate both objects before asking merge-base.  This turns a missing
    # shallow object into a clear recovery error instead of a misleading PR
    # success result.
    $releaseObjectCheck = @(& git -C $RepositoryRoot cat-file -e "${ReleaseCommit}^{commit}" 2>&1)
    $releaseObjectExit = $LASTEXITCODE
    if ($releaseObjectExit -ne 0) {
        throw "本地缺少 releaseCommit 对象 $ReleaseCommit，无法核验 origin/main。"
    }
    $directCheck = @(& git -C $RepositoryRoot merge-base --is-ancestor $ReleaseCommit $mainHead 2>&1)
    $directExit = $LASTEXITCODE
    if ($directExit -eq 0) {
        return [pscustomobject]@{ mainHead = $mainHead; relation = "release-ancestor"; mergeCommit = $MergeCommit }
    }

    # Squash/rebase PRs replace the source commit with a new merge commit.  A
    # valid merged PR must still leave that merge commit in origin/main.
    if (-not [string]::IsNullOrWhiteSpace($MergeCommit)) {
        $mergeObjectCheck = @(& git -C $RepositoryRoot cat-file -e "${MergeCommit}^{commit}" 2>&1)
        $mergeObjectExit = $LASTEXITCODE
        if ($mergeObjectExit -ne 0) {
            throw "本地缺少 PR mergeCommit 对象 $MergeCommit，无法核验 origin/main。"
        }
        $mergeCheck = @(& git -C $RepositoryRoot merge-base --is-ancestor $MergeCommit $mainHead 2>&1)
        $mergeExit = $LASTEXITCODE
        if ($mergeExit -eq 0) {
            return [pscustomobject]@{ mainHead = $mainHead; relation = "pr-merge-ancestor"; mergeCommit = $MergeCommit }
        }
    }
    throw "origin/main ($mainHead) 不包含 releaseCommit=$ReleaseCommit（也未包含 PR mergeCommit=$MergeCommit），拒绝报告发布成功。"
}

function Invoke-ReleasePullRequest {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Branch,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$CommitSha,
        [object]$Policy = $null,
        [switch]$NoPush
    )
    if ($NoPush) {
        return [pscustomobject]@{ branch = $Branch; pushed = $false; pr = ""; status = "prepared" }
    }
    if ($null -ne $Policy -and [bool]$Policy.mainProtection.enforceOnPublish) {
        Test-ReleaseGitHubProtection -RepositoryRoot $RepositoryRoot -Policy $Policy | Out-Null
    }
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -eq $gh) {
        throw "发布模式需要 GitHub CLI gh；未推送 release 分支。"
    }
    & $gh.Source auth status --hostname github.com *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI 未认证；未推送 release 分支。请先执行 gh auth login。"
    }
    $slug = Get-ReleaseGitHubSlug -RemoteUrl (Get-ReleaseGitValue -WorkingDirectory $RepositoryRoot -Arguments @("remote", "get-url", "origin"))
    if ([string]::IsNullOrWhiteSpace($slug)) { throw "无法从 origin URL 解析 GitHub owner/repository。" }
    $owner = ($slug -split '/', 2)[0]
    $headRef = "{0}:{1}" -f $owner, $Branch
    $targetBase = if ($null -ne $Policy -and $Policy.PSObject.Properties["branch"] -and -not [string]::IsNullOrWhiteSpace([string]$Policy.branch)) { [string]$Policy.branch } else { "main" }

    # Resume is deliberately idempotent.  A process can crash after pushing
    # the release branch or after creating the PR; look up that exact head
    # before creating anything new.  The operation id is part of the branch
    # name, so two operations cannot accidentally share a PR.
    $listOutput = @(& $gh.Source pr list --repo $slug --head $headRef --state all --json number,url,state,baseRefName,headRefOid,mergeCommit,mergedAt 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "无法查询既有 release PR；未推送 release 分支：$($listOutput -join "`n")"
    }
    $existing = @()
    if (($listOutput -join "`n").Trim().Length -gt 0) {
        try { $existing = @((($listOutput -join "`n") | ConvertFrom-Json)) }
        catch { throw "既有 release PR 查询结果不是有效 JSON：$($listOutput -join "`n")" }
    }
    $existingPr = $existing | Select-Object -First 1
    $prUrl = if ($null -ne $existingPr) { Get-ReleasePullRequestString -PullRequest $existingPr -Name "url" } else { "" }
    if ($null -ne $existingPr) {
        # Validate the branch head before looking at state.  This catches a
        # stale/open PR that was retargeted to another commit as well as an
        # already-merged PR whose branch was recreated by a third party.
        Assert-ReleasePullRequestHead -PullRequest $existingPr -CommitSha $CommitSha -Label "既有 release PR" | Out-Null
        Assert-ReleasePullRequestBase -PullRequest $existingPr -ExpectedBase $targetBase -Label "既有 release PR" | Out-Null
    }
    if ($null -ne $existingPr -and (Get-ReleasePullRequestString -PullRequest $existingPr -Name "state").ToUpperInvariant() -eq "MERGED") {
        $mergeOid = Get-ReleasePullRequestMergeOid -PullRequest $existingPr
        $null = Assert-ReleaseMainContainsCommit -RepositoryRoot $RepositoryRoot -ReleaseCommit $CommitSha -MergeCommit $mergeOid
        return [pscustomobject]@{
            branch = $Branch; pushed = $false; pr = $prUrl; status = "merged"
            mainCommit = $mergeOid; mergedAt = Get-ReleasePullRequestString -PullRequest $existingPr -Name "mergedAt"; reused = $true
        }
    }
    if ($null -ne $existingPr -and (Get-ReleasePullRequestString -PullRequest $existingPr -Name "state").ToUpperInvariant() -eq "CLOSED") {
        $reopen = @(& $gh.Source pr reopen $prUrl 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "既有 release PR 已关闭且无法重新打开：$($reopen -join "`n")" }
    }

    # Never force-push.  The branch is immutable for an operation; a non-fast
    # forward error means the remote branch was tampered with and must be
    # investigated instead of overwritten.
    $push = & git -C $RepositoryRoot push origin "$CommitSha`:refs/heads/$Branch" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "PR 发布分支推送失败：$($push -join "`n")" }
    if ([string]::IsNullOrWhiteSpace($prUrl)) {
        $title = "release: v$Version ($OperationId)"
        $body = "由统一发布闸门生成。operationId=$OperationId`nreleaseCommit=$CommitSha`n目标：main（PR-only）"
        $prOutput = & $gh.Source pr create --repo $slug `
            --base $targetBase --head $Branch --title $title --body $body 2>&1
        if ($LASTEXITCODE -ne 0) { throw "GitHub PR 创建失败：$($prOutput -join "`n")" }
        $prUrl = (($prOutput | Where-Object { [string]$_ -match '^https?://' }) | Select-Object -First 1)
        if ([string]::IsNullOrWhiteSpace([string]$prUrl)) {
            $lookup = @(& $gh.Source pr list --repo $slug --head $headRef --state open --json url 2>&1)
            if ($LASTEXITCODE -eq 0) {
                try { $prUrl = [string](@((($lookup -join "`n") | ConvertFrom-Json)) | Select-Object -First 1).url } catch { }
            }
        }
        if ([string]::IsNullOrWhiteSpace([string]$prUrl)) { throw "GitHub PR 已创建但未返回 URL，无法继续确认合并状态。" }
    }
    # Re-read the PR after push/create.  The branch can be rewritten by a
    # concurrent actor between `git push` and `gh pr create`; only continue if
    # GitHub still reports the exact releaseCommit as headRefOid.
    $headViewOutput = @(& $gh.Source pr view $prUrl --json state,baseRefName,headRefOid,mergeCommit,mergedAt 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "无法读取 release PR headRefOid；拒绝继续合并：$($headViewOutput -join "`n")" }
    try { $headView = ($headViewOutput -join "`n") | ConvertFrom-Json }
    catch { throw "release PR 状态 JSON 无法解析，拒绝继续合并：$($headViewOutput -join "`n")" }
    Assert-ReleasePullRequestHead -PullRequest $headView -CommitSha $CommitSha -Label "当前 release PR" | Out-Null
    Assert-ReleasePullRequestBase -PullRequest $headView -ExpectedBase $targetBase -Label "当前 release PR" | Out-Null

    # If the PR became merged while we were reading it (for example an
    # already-enabled auto-merge job), verify main before returning success.
    if ((Get-ReleasePullRequestString -PullRequest $headView -Name "state").ToUpperInvariant() -eq "MERGED") {
        $mergeOid = Get-ReleasePullRequestMergeOid -PullRequest $headView
        $null = Assert-ReleaseMainContainsCommit -RepositoryRoot $RepositoryRoot -ReleaseCommit $CommitSha -MergeCommit $mergeOid
        return [pscustomobject]@{
            branch = $Branch; pushed = $true; pr = [string]$prUrl; status = "merged"
            mainCommit = $mergeOid; mergedAt = Get-ReleasePullRequestString -PullRequest $headView -Name "mergedAt"
            reused = $true
        }
    }
    # Prefer GitHub's native auto-merge.  Some private repositories cannot enable
    # that setting; in that case wait for the required check and merge the PR
    # explicitly.  A successful publish must never be reported while the PR is
    # still open.
    $autoOutput = @(& $gh.Source pr merge $prUrl --auto --squash --delete-branch=false 2>&1)
    $autoExitCode = $LASTEXITCODE
    if ($autoOutput.Count -gt 0) { $autoOutput | ForEach-Object { Write-Host $_ } }
    if ($autoExitCode -eq 0) {
        $viewOutput = @(& $gh.Source pr view $prUrl --json state,baseRefName,headRefOid,mergeCommit,mergedAt 2>&1)
        if ($LASTEXITCODE -eq 0) {
            $view = $null
            try {
                $view = ($viewOutput -join "`n") | ConvertFrom-Json
            }
            catch { Write-Host "PR 状态暂时无法解析，保留为 pr-opened。" -ForegroundColor Yellow }
            if ($null -ne $view) {
                # Integrity failures must propagate; do not let the generic
                # JSON warning path downgrade a mismatched head to pr-opened.
                Assert-ReleasePullRequestHead -PullRequest $view -CommitSha $CommitSha -Label "自动合并后的 release PR" | Out-Null
                Assert-ReleasePullRequestBase -PullRequest $view -ExpectedBase $targetBase -Label "自动合并后的 release PR" | Out-Null
                if ((Get-ReleasePullRequestString -PullRequest $view -Name "state").ToUpperInvariant() -eq "MERGED") {
                    $mergeOid = Get-ReleasePullRequestMergeOid -PullRequest $view
                    $null = Assert-ReleaseMainContainsCommit -RepositoryRoot $RepositoryRoot -ReleaseCommit $CommitSha -MergeCommit $mergeOid
                    return [pscustomobject]@{
                        branch = $Branch; pushed = $true; pr = [string]$prUrl; status = "merged"
                        mainCommit = $mergeOid; mergedAt = Get-ReleasePullRequestString -PullRequest $view -Name "mergedAt"
                    }
                }
            }
        }
        return [pscustomobject]@{ branch = $Branch; pushed = $true; pr = [string]$prUrl; status = "pr-opened" }
    }

    Write-Host "GitHub 自动合并不可用，改为等待 release-gate 通过后执行 PR 合并。" -ForegroundColor Yellow
    $checkDeadline = [DateTime]::UtcNow.AddMinutes(30)
    $checksReady = $false
    $lastCheckOutput = @()
    while ([DateTime]::UtcNow -lt $checkDeadline) {
        $lastCheckOutput = @(& $gh.Source pr checks $prUrl 2>&1)
        $probeExitCode = $LASTEXITCODE
        $probeText = ($lastCheckOutput -join "`n")
        if ($probeExitCode -eq 0 -or ($lastCheckOutput.Count -gt 0 -and $probeText -notmatch "no checks reported")) {
            $checksReady = $true
            break
        }
        Start-Sleep -Seconds 5
    }
    if (-not $checksReady) {
        throw "PR 在等待窗口内没有创建必需检查：$($lastCheckOutput -join "`n")"
    }
    $checkOutput = @(& $gh.Source pr checks $prUrl --watch --fail-fast 2>&1)
    if ($checkOutput.Count -gt 0) { $checkOutput | ForEach-Object { Write-Host $_ } }
    if ($LASTEXITCODE -ne 0) {
        throw "PR 必需检查未通过，发布未合并：$($checkOutput -join "`n")"
    }
    $mergeOutput = @(& $gh.Source pr merge $prUrl --squash --delete-branch=false 2>&1)
    if ($mergeOutput.Count -gt 0) { $mergeOutput | ForEach-Object { Write-Host $_ } }
    if ($LASTEXITCODE -ne 0) {
        throw "PR 检查已通过但合并失败：$($mergeOutput -join "`n")"
    }
    $mergedOutput = @(& $gh.Source pr view $prUrl --json state,baseRefName,headRefOid,mergeCommit,mergedAt 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "PR 已请求合并，但无法确认合并状态：$($mergedOutput -join "`n")" }
    try { $merged = ($mergedOutput -join "`n") | ConvertFrom-Json } catch { throw "PR 合并状态 JSON 无法解析：$($mergedOutput -join "`n")" }
    Assert-ReleasePullRequestHead -PullRequest $merged -CommitSha $CommitSha -Label "合并后的 release PR" | Out-Null
    Assert-ReleasePullRequestBase -PullRequest $merged -ExpectedBase $targetBase -Label "合并后的 release PR" | Out-Null
    $mergeOid = Get-ReleasePullRequestMergeOid -PullRequest $merged
    if ((Get-ReleasePullRequestString -PullRequest $merged -Name "state").ToUpperInvariant() -ne "MERGED" -or [string]::IsNullOrWhiteSpace($mergeOid)) {
        throw "PR 合并命令返回成功，但远端状态不是 MERGED。"
    }
    $null = Assert-ReleaseMainContainsCommit -RepositoryRoot $RepositoryRoot -ReleaseCommit $CommitSha -MergeCommit $mergeOid
    return [pscustomobject]@{
        branch = $Branch; pushed = $true; pr = [string]$prUrl; status = "merged"
        mainCommit = $mergeOid; mergedAt = Get-ReleasePullRequestString -PullRequest $merged -Name "mergedAt"
    }
}
