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
    $policy | Add-Member -NotePropertyName policyPath -NotePropertyValue $path -Force
    return $policy
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
        [Parameter(Mandatory = $true)][string]$RepositoryRoot
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
    # 远端 tag 无法读取时必须失败关闭，不能在不完整的版本视图上分配新版本。
    $tagLines = Invoke-ReleaseGit -WorkingDirectory $RepositoryRoot -Arguments @("ls-remote", "--tags", "origin")
    foreach ($line in $tagLines) {
        if ([string]$line -match 'refs/tags/v?(\d+\.\d+\.\d+)(?:\^\{\})?$') { [void]$used.Add($Matches[1]) }
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
        createdAt = [DateTime]::UtcNow.ToString("o")
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
    $hash.updatedAt = [DateTime]::UtcNow.ToString("o")
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
            throw "无法从远端 URL 推导 Git 提交邮箱，请在隔离 worktree 配置有效 user.email。"
        }
        $email = "$owner@users.noreply.github.com"
    }
    if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($email)) {
        throw "Git 提交身份不完整。"
    }
    Invoke-ReleaseGit -WorkingDirectory $WorkingDirectory -Arguments @("config", "--local", "user.name", $name) | Out-Null
    Invoke-ReleaseGit -WorkingDirectory $WorkingDirectory -Arguments @("config", "--local", "user.email", $email) | Out-Null
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
    foreach ($directory in @(Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "wechat-miniapp*" })) {
        $path = ConvertTo-ReleaseFullPath -Path $directory.FullName
        $isCanonical = Test-ReleasePathEqual -Left $path -Right $canonical
        $gitRoot = (& git -C $path rev-parse --show-toplevel 2>$null | Out-String).Trim()
        $isGit = $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($gitRoot)
        $remote = if ($isGit) { (& git -C $path remote get-url origin 2>$null | Out-String).Trim() } else { "" }
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
    $manifest = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTime]::UtcNow.ToString("o")
        canonicalRepo = $canonical
        entries = [object[]]$entries.ToArray()
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
        [int]$ExpiresMinutes = 180
    )
    $context = [ordered]@{
        schemaVersion = 1
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
        createdAt = [DateTime]::UtcNow.ToString("o")
        expiresAt = [DateTime]::UtcNow.AddMinutes($ExpiresMinutes).ToString("o")
        status = "prepared"
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
    if ([int]$Context.schemaVersion -ne 1) { throw "不支持的 release context schemaVersion：$($Context.schemaVersion)" }
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
    $line = [ordered]@{ at = [DateTime]::UtcNow.ToString("o"); operationId = $OperationId; stage = $Stage; message = $Message } |
        ConvertTo-Json -Compress
    Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
}

function Remove-ReleaseGateWorktree {
    param([string]$CanonicalRepo, [string]$WorktreePath)
    if ([string]::IsNullOrWhiteSpace($WorktreePath)) { return }
    & git -C $CanonicalRepo worktree remove --force $WorktreePath 2>$null | Out-Null
    Remove-Item -LiteralPath $WorktreePath -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-ReleasePullRequest {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Branch,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OperationId,
    [Parameter(Mandatory = $true)][string]$CommitSha,
    [switch]$NoPush
    )
    if ($NoPush) {
        return [pscustomobject]@{ branch = $Branch; pushed = $false; pr = ""; status = "prepared" }
    }
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -eq $gh) {
        throw "发布模式需要 GitHub CLI gh；未推送 release 分支。"
    }
    & $gh.Source auth status --hostname github.com *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI 未认证；未推送 release 分支。请先执行 gh auth login。"
    }
    $push = & git -C $RepositoryRoot push origin "$CommitSha`:refs/heads/$Branch" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "PR 发布分支推送失败：$($push -join "`n")" }
    $title = "release: v$Version ($OperationId)"
    $body = "由统一发布闸门生成。operationId=$OperationId`nreleaseCommit=$CommitSha`n目标：main（PR-only）"
    $slug = Get-ReleaseGitHubSlug -RemoteUrl (Get-ReleaseGitValue -WorkingDirectory $RepositoryRoot -Arguments @("remote", "get-url", "origin"))
    if ([string]::IsNullOrWhiteSpace($slug)) { throw "无法从 origin URL 解析 GitHub owner/repository。" }
    $prOutput = & gh pr create --repo $slug `
        --base main --head $Branch --title $title --body $body 2>&1
    if ($LASTEXITCODE -ne 0) { throw "GitHub PR 创建失败：$($prOutput -join "`n")" }
    $prUrl = (($prOutput | Where-Object { [string]$_ -match '^https?://' }) | Select-Object -First 1)
    # Prefer GitHub's native auto-merge.  Some private repositories cannot enable
    # that setting; in that case wait for the required check and merge the PR
    # explicitly.  A successful publish must never be reported while the PR is
    # still open.
    $autoOutput = @(& $gh.Source pr merge $prUrl --auto --squash --delete-branch=false 2>&1)
    $autoExitCode = $LASTEXITCODE
    if ($autoOutput.Count -gt 0) { $autoOutput | ForEach-Object { Write-Host $_ } }
    if ($autoExitCode -eq 0) {
        $viewOutput = @(& $gh.Source pr view $prUrl --json state,mergeCommit,mergedAt 2>&1)
        if ($LASTEXITCODE -eq 0) {
            try {
                $view = ($viewOutput -join "`n") | ConvertFrom-Json
                if ([string]$view.state -eq "MERGED") {
                    return [pscustomobject]@{
                        branch = $Branch; pushed = $true; pr = [string]$prUrl; status = "merged"
                        mainCommit = [string]$view.mergeCommit.oid; mergedAt = [string]$view.mergedAt
                    }
                }
            }
            catch { Write-Host "PR 状态暂时无法解析，保留为 pr-opened。" -ForegroundColor Yellow }
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
    $mergedOutput = @(& $gh.Source pr view $prUrl --json state,mergeCommit,mergedAt 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "PR 已请求合并，但无法确认合并状态：$($mergedOutput -join "`n")" }
    try { $merged = ($mergedOutput -join "`n") | ConvertFrom-Json } catch { throw "PR 合并状态 JSON 无法解析：$($mergedOutput -join "`n")" }
    if ([string]$merged.state -ne "MERGED" -or [string]::IsNullOrWhiteSpace([string]$merged.mergeCommit.oid)) {
        throw "PR 合并命令返回成功，但远端状态不是 MERGED。"
    }
    return [pscustomobject]@{
        branch = $Branch; pushed = $true; pr = [string]$prUrl; status = "merged"
        mainCommit = [string]$merged.mergeCommit.oid; mergedAt = [string]$merged.mergedAt
    }
}
