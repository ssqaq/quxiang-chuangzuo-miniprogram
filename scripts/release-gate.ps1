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
    $parent = Split-Path ([IO.Path]::GetFullPath([string]$policy.lockPath)) -Parent
    if ($null -eq $policy.PSObject.Properties["queueRoot"] -or [string]::IsNullOrWhiteSpace([string]$policy.queueRoot)) {
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
    # These paths were added after schema 1.  Derive them for old policy files
    # so every caller still writes to the one canonical state directory.
    $derivedStatePaths = @{
        reportRoot = Join-Path $parent "wechat-miniapp-release-reports"
        backupRoot = Join-Path $parent "wechat-miniapp-release-backups"
        alertRoot = Join-Path ([string]$policy.logRoot) "alerts"
        latestReleasePath = Join-Path $parent "wechat-miniapp-latest-release.json"
    }
    foreach ($key in $derivedStatePaths.Keys) {
        if ($null -eq $policy.PSObject.Properties[$key] -or [string]::IsNullOrWhiteSpace([string]$policy.$key)) {
            $policy | Add-Member -NotePropertyName $key -NotePropertyValue $derivedStatePaths[$key] -Force
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
        reportRoot = Join-Path $canonicalParent "wechat-miniapp-release-reports"
        backupRoot = Join-Path $canonicalParent "wechat-miniapp-release-backups"
        alertRoot = Join-Path (Join-Path $canonicalParent "wechat-miniapp-release-logs") "alerts"
        latestReleasePath = Join-Path $canonicalParent "wechat-miniapp-latest-release.json"
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

$script:ReleaseGitTransport = "Https"
$script:GitSshKeyPath = ""
$script:GitTransportState = [ordered]@{ transport = "Https"; host = "github.com"; sshPort = 22; proxyConfigured = $false; connectTimeout = 21; retryCount = 0; remoteRefVerified = $false; sshKeyHash = "" }

function Set-ReleaseGitTransport {
    param([ValidateSet("Https", "Ssh443")][string]$Transport = "Https", [string]$SshKeyPath = "")
    if ($Transport -eq "Ssh443") {
        if ([string]::IsNullOrWhiteSpace($SshKeyPath)) { throw "Ssh443 transport requires -SshKeyPath." }
        $resolved = [IO.Path]::GetFullPath($SshKeyPath)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "SSH key file does not exist: $resolved" }
        $script:GitSshKeyPath = $resolved
        $script:GitTransportState.transport = "Ssh443"
        $script:GitTransportState.host = "ssh.github.com"
        $script:GitTransportState.sshPort = 443
        $script:GitTransportState.connectTimeout = 10
        $script:GitTransportState.sshKeyHash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
    }
    # Keep the internal state name distinct from release.ps1's public
    # -GitTransport parameter; dot-sourcing this file must not overwrite it.
    $script:ReleaseGitTransport = $Transport
    $script:GitTransportState.transport = $Transport
}

function Test-ReleaseGitNetworkCommand {
    param([string[]]$Arguments)
    return $Arguments.Count -gt 0 -and @("fetch", "ls-remote", "push") -contains [string]$Arguments[0]
}

function Invoke-ReleaseGit {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    $effectiveArguments = @($Arguments)
    $oldSsh = $env:GIT_SSH_COMMAND; $oldPrompt = $env:GIT_TERMINAL_PROMPT; $oldGcm = $env:GCM_INTERACTIVE
    try {
        if (($script:ReleaseGitTransport -eq "Ssh443" -or -not [string]::IsNullOrWhiteSpace($env:GIT_SSH_COMMAND)) -and (Test-ReleaseGitNetworkCommand -Arguments $Arguments)) {
            $effectiveArguments = @("-c", "url.ssh://git@ssh.github.com:443/ssqaq/quxiang-chuangzuo-miniprogram.git.insteadOf=https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git") + $effectiveArguments
            if ([string]::IsNullOrWhiteSpace($script:GitSshKeyPath) -and -not [string]::IsNullOrWhiteSpace($env:GIT_SSH_COMMAND)) {
                # Keep the caller-provided, already validated SSH command when
                # a nested release process only inherited the environment.
                $env:GIT_SSH_COMMAND = $env:GIT_SSH_COMMAND
            }
            else {
                $env:GIT_SSH_COMMAND = "ssh -o IdentitiesOnly=yes -o ConnectTimeout=10 -i $($script:GitSshKeyPath.Replace('\','/')) -p 443"
            }
            $env:GIT_TERMINAL_PROMPT = "0"
            $env:GCM_INTERACTIVE = "never"
        }
        $output = & git -C $WorkingDirectory @effectiveArguments 2>&1
    }
    finally {
        $env:GIT_SSH_COMMAND = $oldSsh; $env:GIT_TERMINAL_PROMPT = $oldPrompt; $env:GCM_INTERACTIVE = $oldGcm
    }
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
    $dirtyLines = @(Invoke-ReleaseGit -WorkingDirectory $path -Arguments @("status", "--porcelain") -AllowFailure | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    return [pscustomobject]@{
        Path = $path
        Root = $root
        Remote = $remote.Trim()
        Branch = $branch.Trim()
        Dirty = $dirtyLines.Count -gt 0
        IsWorktree = $isWorktree
        Commit = Get-ReleaseGitValue -WorkingDirectory $path -Arguments @("rev-parse", "HEAD")
        CommonDir = $commonDirFull
        DirtyFiles = @($dirtyLines | ForEach-Object { [string]$_ })
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
            if ($normalized -match '(^|/)(?:\.env$|\.env\.(?!example$)[^/]+|project\.private\.config\.json|.*(?:secret|apikey|api_key|appsecret).*)$') {
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

function Get-CanonicalVersionConflict {
    param([Parameter(Mandatory = $true)][string]$RepositoryPath)
    $values = [ordered]@{}
    $files = @(
        @{ Path = "config.js"; Pattern = 'appVersion:\s*"([^"]+)"' },
        @{ Path = "cloudfunctions/api/index.js"; Pattern = 'API_BUILD_VERSION\s*=\s*"([^"]+)"' }
    )
    foreach ($item in $files) {
        $full = Join-Path $RepositoryPath $item.Path
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $text = Get-Content -LiteralPath $full -Raw -Encoding UTF8
            $match = [regex]::Match($text, $item.Pattern)
            if ($match.Success) { $values[$item.Path] = $match.Groups[1].Value }
        }
    }
    $distinct = @($values.Values | Sort-Object -Unique)
    return [pscustomobject]@{
        conflict = $distinct.Count -gt 1
        files = @($values.Keys)
        values = $values
    }
}

function Get-ReleaseSnapshotSha256 {
    param([Parameter(Mandatory = $true)][object]$Snapshot)
    $items = @($Snapshot.GetEnumerator() | ForEach-Object {
        [ordered]@{ path = [string]$_.Key; exists = [bool]$_.Value.exists; sha256 = [string]$_.Value.sha256 }
    } | Sort-Object path)
    return Get-ReleaseCanonicalJsonSha256 -Value ([ordered]@{ files = $items })
}

function Get-ReleaseCanonicalJsonSha256 {
    param([Parameter(Mandatory = $true)][object]$Value)
    $json = $Value | ConvertTo-Json -Depth 40 -Compress
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-ReleaseProjectConfigAppId {
    param([Parameter(Mandatory = $true)][string]$ProjectPath)
    $configPath = Join-Path ([IO.Path]::GetFullPath($ProjectPath)) "project.config.json"
    try { $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "预览项目配置无法读取。" }
    $appId = [string]$config.appid
    if ($appId -notmatch '^wx[a-f0-9]{13,}$') { throw "预览项目 AppID 格式无效。" }
    return $appId
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
    $versionGroupCommand = Get-Command "Get-VersionGroupPaths" -CommandType Function -ErrorAction SilentlyContinue
    if ($null -ne $versionGroupCommand) {
        return @(Get-VersionGroupPaths -SourceRoot $SourceRoot)
    }
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
    $paymentManifestRelative = "scripts/payment-cloudfunctions.json"
    $paymentManifestPath = Join-Path $SourceRoot $paymentManifestRelative
    if (Test-Path -LiteralPath $paymentManifestPath -PathType Leaf) {
        try {
            $paymentManifest = Get-Content -LiteralPath $paymentManifestPath -Raw -Encoding UTF8 |
                ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw "支付云函数清单不是有效 JSON：$paymentManifestPath"
        }
        if ([int]$paymentManifest.schemaVersion -ne 1 -or @($paymentManifest.functions).Count -ne 3) {
            throw "支付云函数清单版本或函数数量无效：$paymentManifestPath"
        }
        $paths += $paymentManifestRelative
        $paths += [string]$paymentManifest.sharedCore.packageJson
        foreach ($paymentFunction in @($paymentManifest.functions)) {
            $paths += [string]$paymentFunction.packageJson
            $paths += [string]$paymentFunction.packageLock
            $paths += [string]$paymentFunction.config
            $paths += ([string]$paymentFunction.vendoredCoreRoot).TrimEnd('/', '\') + "/package.json"
        }
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
        [string]$ContextRoot = "",
        # New queue tickets carry an explicit requested version as a durable
        # write-ahead claim.  When the current operation is resolving that
        # claim under the release lock, do not count its own ticket as a
        # competing reservation; otherwise every explicit TargetVersion is
        # rejected as "not the next available version" before a reservation
        # can ever be written.
        [string]$ExcludeOperationId = ""
    )
    $used = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    foreach ($root in @($ReservationRoot, $RecordRoot)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($file in Get-ChildItem -LiteralPath $root -Filter '*.json' -File -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '(?i)[\\/]node_modules[\\/]' }) {
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
                    if (-not [string]::IsNullOrWhiteSpace($ExcludeOperationId) -and
                        [string]$ticket.operationId -eq $ExcludeOperationId) {
                        continue
                    }
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
    # Reservation creation is write-once.  Use a per-attempt name and never
    # force-replace an existing reservation: a concurrent allocator must fail
    # closed instead of silently stealing another operation's version.
    $temp = "$target.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temp, ($record | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        try { [IO.File]::Move($temp, $target) }
        catch [IO.IOException] {
            if (Test-Path -LiteralPath $target -PathType Leaf) { throw "reservation 文件并发冲突，拒绝覆盖：$target" }
            throw
        }
    }
    finally {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
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
    if ([string]$Status -eq "succeeded" -and -not $Extra.ContainsKey("lastError")) {
        if ($hash.Contains("lastError")) { $hash.Remove("lastError") }
    }
    # Status changes are mutable, but readers must see either the old complete
    # JSON or the new complete JSON.  The shared atomic writer also avoids the
    # old Move-Item -Force race with queue/status readers.
    Write-ReleaseGateJsonAtomic -Path $ReservationPath -Value $hash | Out-Null
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
    $backup = "$Path.$PID.$([guid]::NewGuid().ToString('N')).replace.bak"
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 15) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    # Replace in the same directory so readers never observe a partial JSON.
    # File.Replace preserves the destination ACL and is atomic on NTFS; the
    # fallback is only for filesystems that do not implement Replace.
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try { [IO.File]::Replace($temp, $Path, $backup, $true) }
            catch [PlatformNotSupportedException] { [IO.File]::Move($temp, $Path, $true) }
            catch [NotSupportedException] { [IO.File]::Move($temp, $Path, $true) }
        }
        else {
            [IO.File]::Move($temp, $Path)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temp -PathType Leaf) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $backup -PathType Leaf) {
            Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-ReleaseImmutableJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $new = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $parent = Split-Path ([IO.Path]::GetFullPath($Path)) -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temp = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllBytes($temp, $bytes)
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $old = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($old -ne $new) { throw "不可变状态文件同名但内容不同，拒绝覆盖：$Path" }
            return "reused"
        }
        try {
            [IO.File]::Move($temp, $Path)
            return "created"
        }
        catch [IO.IOException] {
            # Another writer may have won the create race.  Same bytes are
            # idempotent; different bytes remain a hard failure.
            if (Test-Path -LiteralPath $Path -PathType Leaf) {
                $old = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($old -eq $new) { return "reused" }
                throw "不可变状态文件同名但内容不同，拒绝覆盖：$Path"
            }
            throw
        }
    }
    finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}

function Write-ReleaseImmutableFile {
    <# Move a generated binary into its final name without ever overwriting a
       different byte stream.  Same SHA is idempotent; a different SHA is a
       hard conflict. #>
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )
    $source = [IO.Path]::GetFullPath($SourcePath)
    $destination = [IO.Path]::GetFullPath($DestinationPath)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "不可变文件源不存在：$source" }
    $sourceItem = Get-Item -LiteralPath $source
    if ($sourceItem.Length -le 0) { throw "不可变文件为空：$source" }
    $sourceSha = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $parent = Split-Path $destination -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $oldItem = Get-Item -LiteralPath $destination
        if ($oldItem.Length -le 0) { throw "不可变文件目标为空，拒绝覆盖：$destination" }
        $oldSha = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($oldSha -ne $sourceSha) { throw "不可变文件同名但内容不同，拒绝覆盖：$destination" }
        return [pscustomobject]@{ Status = "reused"; Path = $destination; Sha256 = $oldSha; SizeBytes = [int64]$oldItem.Length }
    }
    try {
        [IO.File]::Move($source, $destination)
        return [pscustomobject]@{ Status = "created"; Path = $destination; Sha256 = $sourceSha; SizeBytes = [int64]$sourceItem.Length }
    }
    catch [IO.IOException] {
        # Another process may have won the create race.  It is safe to reuse
        # only if the bytes are exactly identical.
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            $oldItem = Get-Item -LiteralPath $destination
            $oldSha = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($oldSha -eq $sourceSha) {
                return [pscustomobject]@{ Status = "reused"; Path = $destination; Sha256 = $oldSha; SizeBytes = [int64]$oldItem.Length }
            }
            throw "不可变文件同名但内容不同，拒绝覆盖：$destination"
        }
        throw
    }
    finally {
        Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-ReleaseDevToolsCli {
    <# 优先使用传入/环境变量，其次查找新版 wechatide.cmd。旧 cli.bat
       没有 project_import/open_project_window/simulator_refresh，不能用于自动编译。 #>
    param([string]$CliPath = "")
    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($CliPath)) { [void]$candidates.Add($CliPath) }
    if (-not [string]::IsNullOrWhiteSpace($env:WECHAT_DEVTOOLS_CLI)) { [void]$candidates.Add($env:WECHAT_DEVTOOLS_CLI) }
    # 兼容旧脚本已经使用的环境变量名，避免升级后本机配置失效。
    if (-not [string]::IsNullOrWhiteSpace($env:WECHATIDE_CLI)) { [void]$candidates.Add($env:WECHATIDE_CLI) }
    $command = Get-Command wechatide.cmd -ErrorAction SilentlyContinue
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) { [void]$candidates.Add([string]$command.Source) }
    foreach ($known in @("D:\微信web开发者工具\wechatide.cmd", "C:\Program Files\微信web开发者工具\wechatide.cmd", "C:\Program Files (x86)\微信web开发者工具\wechatide.cmd")) {
        [void]$candidates.Add($known)
    }
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        try {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $candidate).Path)
            }
        }
        catch { }
    }
    throw "微信开发者工具 CLI 不存在。请安装新版开发者工具，或设置 WECHAT_DEVTOOLS_CLI/WECHATIDE_CLI 指向 wechatide.cmd。"
}

function Invoke-ReleaseDevToolsCommand {
    param(
        [Parameter(Mandatory = $true)][string]$CliPath,
        [Parameter(Mandatory = $true)][string]$ClientName,
        [Parameter(Mandatory = $true)][string]$ToolName,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$Label
    )
    $output = & $CliPath -c $ClientName $ToolName @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($exitCode -ne 0) { throw "${Label}失败：$text" }
    $response = $null
    # wechatide prints a human-readable prefix followed by pretty-printed
    # multi-line JSON, so parsing one line at a time silently loses ok:false.
    $jsonStart = $text.IndexOf("{")
    $jsonEnd = $text.LastIndexOf("}")
    if ($jsonStart -ge 0 -and $jsonEnd -gt $jsonStart) {
        try { $response = $text.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json } catch { }
    }
    if ($null -eq $response) {
        throw "${Label}未返回可解析的 JSON，原始输出：$text"
    }
    if (-not $response.PSObject.Properties["ok"]) {
        throw "${Label}返回格式不完整（缺少 ok）：$text"
    }
    if (-not [bool]$response.ok) {
        throw "${Label}被微信开发者工具拒绝：$([string]$response.message)"
    }
    if ($response.PSObject.Properties["result"] -and
        $response.result -and $response.result.PSObject.Properties["success"] -and
        -not [bool]$response.result.success) {
        throw "${Label}未成功：$([string]$response.result.message)"
    }
    $resultStatus = if ($response.PSObject.Properties["result"] -and $response.result -and $response.result.PSObject.Properties["status"]) {
        [string]$response.result.status
    } else { "" }
    $hasPendingTask = $response.PSObject.Properties["taskId"] -or
        ($response.PSObject.Properties["result"] -and $response.result -and $response.result.PSObject.Properties["taskId"])
    if (($hasPendingTask -or $resultStatus -match '(?i)^(pending|queued|waiting|awaiting[_-]?confirmation)$') -and
        $ToolName -ne "simulator_refresh") {
        throw "${Label}返回待确认任务，未完成：$text"
    }
    return [pscustomobject]@{
        tool = $ToolName
        text = $text
        response = $response
        pending = [bool]$hasPendingTask -or $resultStatus -match '(?i)^(pending|queued|waiting|awaiting[_-]?confirmation)$'
    }
}

function Invoke-ReleaseDevToolsCompileVerification {
    <# simulator_refresh 只表示刷新请求已受理。连续读取模拟器控制台，
       确认没有 WXML/WXSS/JS 编译错误后才把发布回执标成 succeeded。 #>
    param(
        [Parameter(Mandatory = $true)][string]$CliPath,
        [Parameter(Mandatory = $true)][string]$ClientName,
        [Parameter(Mandatory = $true)][string]$ProjectPath,
        [ValidateRange(1, 60)][int]$WaitSeconds = 20,
        [ValidateRange(1, 10)][int]$StablePolls = 3
    )
    $startedAt = [DateTimeOffset]::UtcNow
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $polls = New-Object System.Collections.Generic.List[object]
    $stable = 0
    $lastConsole = ""
    $errorPattern = '(?i)(syntaxerror|compile\s*failed|编译失败|编译错误|wxml[^\r\n]*(error|错误)|wxss[^\r\n]*(error|错误)|module not found|module_not_found|\[error\]|error:\s|exception:)'
    $knownWarningPattern = '(?i)(云端上报失败|cloudbase.*环境|还没有配置\s*cloudbase|cloudbase environment)'
    while ([DateTime]::UtcNow -lt $deadline) {
        $consoleText = ""
        try {
            $consoleStep = Invoke-ReleaseDevToolsCommand `
                -CliPath $CliPath `
                -ClientName $ClientName `
                -ToolName "get_simulator_console" `
                -Arguments @("--project", $ProjectPath, "--command", "grep -i error") `
                -Label "微信开发者工具读取编译控制台"
            $result = $consoleStep.response.result
            if ($result -is [string]) { $consoleText = [string]$result }
            elseif ($null -ne $result) { $consoleText = ($result | ConvertTo-Json -Depth 12 -Compress) }
        }
        catch {
            $polls.Add([pscustomobject]@{ at = [DateTimeOffset]::UtcNow.ToString("o"); status = "read-failed"; message = (ConvertTo-ReleaseSafeMessage $_.Exception.Message) })
            Start-Sleep -Milliseconds 500
            continue
        }
        $lastConsole = $consoleText
        $actualErrors = @(
            ($consoleText -split "`r?`n") |
                Where-Object { $_ -match $errorPattern -and $_ -notmatch $knownWarningPattern }
        )
        $pollStatus = if ($actualErrors.Count) { "failed" } elseif ([string]::IsNullOrWhiteSpace($consoleText)) { "clean" } else { "warning" }
        $polls.Add([pscustomobject]@{
            at = [DateTimeOffset]::UtcNow.ToString("o")
            status = $pollStatus
            lines = @($actualErrors | Select-Object -First 8)
        })
        if ($actualErrors.Count) {
            return [pscustomobject]@{
                status = "failed"
                completedAt = [DateTimeOffset]::UtcNow.ToString("o")
                elapsedMs = [int](([DateTimeOffset]::UtcNow - $startedAt).TotalMilliseconds)
                attempts = $polls.Count
                console = @($actualErrors | Select-Object -First 8)
                polls = @($polls.ToArray())
            }
        }
        # 控制台可能持续保留 CloudBase 未配置等提醒；只要没有实际编译
        # 错误，这些提醒不应阻塞“编译已完成”的确认。
        if ($actualErrors.Count -eq 0) { $stable++ } else { $stable = 0 }
        if ($stable -ge $StablePolls) {
            return [pscustomobject]@{
                status = "succeeded"
                completedAt = [DateTimeOffset]::UtcNow.ToString("o")
                elapsedMs = [int](([DateTimeOffset]::UtcNow - $startedAt).TotalMilliseconds)
                attempts = $polls.Count
                console = @()
                polls = @($polls.ToArray())
            }
        }
        Start-Sleep -Milliseconds 500
    }
    return [pscustomobject]@{
        status = "timeout"
        completedAt = [DateTimeOffset]::UtcNow.ToString("o")
        elapsedMs = [int](([DateTimeOffset]::UtcNow - $startedAt).TotalMilliseconds)
        attempts = $polls.Count
        console = if ([string]::IsNullOrWhiteSpace($lastConsole)) { @() } else { @($lastConsole -split "`r?`n" | Select-Object -First 8) }
        polls = @($polls.ToArray())
    }
}

function Invoke-ReleasePreviewImport {
    <# 导入本次隔离发布工作树，打开模拟器并触发重新编译。这里只操作
       当前 release context 对应的目录，不覆盖开发工作区或旧 clone。 #>
    param(
        [Parameter(Mandatory = $true)][string]$CliPath,
        [Parameter(Mandatory = $true)][string]$ClientName,
        [Parameter(Mandatory = $true)][string]$ProjectPath
    )
    $CliPath = Resolve-ReleaseDevToolsCli -CliPath $CliPath
    if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) { throw "待导入预览项目目录不存在：$ProjectPath" }
    $resolvedProject = [IO.Path]::GetFullPath($ProjectPath)
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedProject "project.config.json") -PathType Leaf)) {
        throw "待导入预览项目缺少 project.config.json：$resolvedProject"
    }
    $importStep = Invoke-ReleaseDevToolsCommand -CliPath $CliPath -ClientName $ClientName -ToolName "project_import" -Arguments @("--project", $resolvedProject) -Label "微信开发者工具导入预览项目"
    $openStep = Invoke-ReleaseDevToolsCommand -CliPath $CliPath -ClientName $ClientName -ToolName "open_project_window" -Arguments @("--project", $resolvedProject, "--window-mode", "liteMode") -Label "微信开发者工具打开项目窗口"
    $refreshStep = Invoke-ReleaseDevToolsCommand -CliPath $CliPath -ClientName $ClientName -ToolName "simulator_refresh" -Arguments @("--project", $resolvedProject) -Label "微信开发者工具重新编译模拟器"
    $compileVerification = Invoke-ReleaseDevToolsCompileVerification -CliPath $CliPath -ClientName $ClientName -ProjectPath $resolvedProject
    if ($compileVerification.status -ne "succeeded") {
        $detail = @($compileVerification.console) -join "；"
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = "开发者工具在限定时间内没有返回稳定的无错误结果。" }
        throw "微信开发者工具重新编译未通过（$($compileVerification.status)）：$detail"
    }
    return [pscustomobject]@{
        status = "imported"
        projectPath = $resolvedProject
        response = $importStep.response
        importedAt = [DateTimeOffset]::UtcNow.ToString("o")
        openStatus = "opened"
        openResponse = $openStep.response
        compileStatus = "succeeded"
        compileTriggeredAt = [DateTimeOffset]::UtcNow.ToString("o")
        compileCompletedAt = $compileVerification.completedAt
        compileElapsedMs = $compileVerification.elapsedMs
        compileAttempts = $compileVerification.attempts
        compileVerification = $compileVerification
        compileResponse = $refreshStep.response
        steps = @("project_import", "open_project_window", "simulator_refresh")
    }
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
        [string]$SourceInputPath = "",
        [string]$SourcePath = "",
        [bool]$SourceDirty = $false,
        [string]$SourceSnapshotSha256 = "",
        [string]$RemoteName = "origin",
        [string]$RemoteUrl = "",
        [string]$AppId = "",
        [string]$ExpectedAppId = "",
        [int]$ExpiresMinutes = 180,
        [string]$BaseHead = "",
        [string]$QueueTicketPath = "",
        [string]$ReleaseWorktree = "",
        [string]$Phase = "prepared",
        [string]$LogPath = "",
        [string]$ReportPath = "",
        [string]$BackupPath = ""
    )
    $context = [ordered]@{
        schemaVersion = 2
        operationId = $OperationId
        canonicalRepo = [IO.Path]::GetFullPath([string]$Policy.canonicalRepo)
        remote = if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { [string]$Policy.remote } else { $RemoteUrl }
        remoteName = $RemoteName
        remoteUrl = if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { [string]$Policy.remote } else { $RemoteUrl }
        branch = [string]$Policy.branch
        sourceInputPath = if ([string]::IsNullOrWhiteSpace($SourceInputPath)) { [string]$SourcePath } else { $SourceInputPath }
        sourcePath = if ([string]::IsNullOrWhiteSpace($SourcePath)) { "" } else { [IO.Path]::GetFullPath($SourcePath) }
        sourceDirty = [bool]$SourceDirty
        sourceSnapshotSha256 = [string]$SourceSnapshotSha256.ToLowerInvariant()
        appId = [string]$AppId
        expectedAppId = if ([string]::IsNullOrWhiteSpace($ExpectedAppId)) { [string]$AppId } else { [string]$ExpectedAppId }
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
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) { $context.logPath = [IO.Path]::GetFullPath($LogPath) }
    if (-not [string]::IsNullOrWhiteSpace($ReportPath)) { $context.reportPath = [IO.Path]::GetFullPath($ReportPath) }
    if (-not [string]::IsNullOrWhiteSpace($BackupPath)) { $context.backupPath = [IO.Path]::GetFullPath($BackupPath) }
    if (-not [string]::IsNullOrWhiteSpace($ReleaseWorktree)) { $context.releaseWorktree = [IO.Path]::GetFullPath($ReleaseWorktree) }
    Write-ReleaseGateJsonAtomic -Path $Path -Value $context
    return [pscustomobject]$context
}

function Assert-ReleaseContextShape {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][object]$Policy
    )
    foreach ($name in @("schemaVersion", "operationId", "canonicalRepo", "sourceInputPath", "sourcePath", "sourceCommit", "sourceSnapshotSha256", "releaseCommit", "treeSha", "sourceSha256", "artifactPath", "appId", "expectedAppId", "expiresAt")) {
        if ($null -eq $Context.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$Context.$name)) {
            throw "release context 缺少字段：$name"
        }
    }
    if ([int]$Context.schemaVersion -notin @(1, 2)) { throw "不支持的 release context schemaVersion：$($Context.schemaVersion)" }
    if (-not [string]::Equals([string]$Context.remoteName, "origin", [StringComparison]::OrdinalIgnoreCase)) { throw "release context remoteName 必须是 origin。" }
    if (-not [string]::Equals([string]$Context.remoteUrl, [string]$Policy.remote, [StringComparison]::OrdinalIgnoreCase)) { throw "release context remoteUrl 不匹配策略。" }
    if ($Context.sourceDirty -isnot [bool]) { throw "release context sourceDirty 必须是布尔值。" }
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
    if ([string]$Context.sourceSnapshotSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "release context sourceSnapshotSha256 无效。" }
    if ([string]$Context.sourceSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "release context 源码 SHA256 无效。" }
    if (-not [string]::Equals([string]$Context.appId, [string]$Context.expectedAppId, [StringComparison]::OrdinalIgnoreCase)) { throw "release context appId 与 expectedAppId 不一致。" }
    if ([string]$Context.releaseCommit -notmatch '^[0-9a-fA-F]{7,64}$') { throw "release context releaseCommit 无效。" }
    if ([string]$Context.treeSha -notmatch '^[0-9a-fA-F]{7,64}$') { throw "release context treeSha 无效。" }
    if ([int]$Context.schemaVersion -ge 2) {
        if ($null -eq $Context.PSObject.Properties["phase"] -or [string]::IsNullOrWhiteSpace([string]$Context.phase)) { throw "release context v2 缺少 phase。" }
        if ($null -eq $Context.PSObject.Properties["baseHead"] -or [string]$Context.baseHead -notmatch '^[0-9a-fA-F]{7,64}$') { throw "release context v2 baseHead 无效。" }
    }
    foreach ($pathField in @("artifactPath", "logPath", "reportPath", "reportMarkdownPath", "backupPath", "queueTicketPath", "releaseWorktree", "previewQrPath", "previewInfoPath", "premergePreviewQrPath", "premergePreviewInfoPath")) {
        $property = $Context.PSObject.Properties[$pathField]
        if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) { continue }
        $value = [IO.Path]::GetFullPath([string]$property.Value)
        $allowedRoot = switch ($pathField) {
            "artifactPath" { [string]$Policy.artifactRoot }
            "logPath" { [string]$Policy.logRoot }
            "reportPath" { [string]$Policy.reportRoot }
            "reportMarkdownPath" { [string]$Policy.reportRoot }
            "backupPath" { [string]$Policy.backupRoot }
            "queueTicketPath" { [string]$Policy.queueRoot }
            "releaseWorktree" { [string]$Policy.worktreeRoot }
            "previewQrPath" { [string]$Policy.artifactRoot }
            "previewInfoPath" { [string]$Policy.artifactRoot }
            "premergePreviewQrPath" { [string]$Policy.artifactRoot }
            "premergePreviewInfoPath" { [string]$Policy.artifactRoot }
        }
        $root = (ConvertTo-ReleaseFullPath -Path $allowedRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if (-not $value.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and
            -not (Test-ReleasePathEqual -Left $value -Right $allowedRoot)) {
            throw "release context $pathField 不在策略允许目录内。"
        }
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

function ConvertTo-ReleaseSafeMessage {
    param([AllowEmptyString()][string]$Message)
    $safe = [string]$Message
    # Logs/alerts are durable and may be copied outside the machine.  Keep the
    # stage and error wording useful while removing common credential shapes.
    $safe = [regex]::Replace($safe, '(?i)(handoffToken|access[_-]?token|refresh[_-]?token|authorization|cookie|appsecret|secret|api[_-]?key|password)\s*[=:：]\s*[^\s,;]+', '$1=[已隐藏]')
    $safe = [regex]::Replace($safe, '(?i)Bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [已隐藏]')
    return $safe
}

function Write-ReleaseOperationLog {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$OperationId = ""
    )
    $parent = Split-Path ([IO.Path]::GetFullPath($Path)) -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $line = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString("o"); operationId = $OperationId; stage = $Stage; message = ConvertTo-ReleaseSafeMessage -Message $Message } |
        ConvertTo-Json -Compress
    $mutex = $null
    $ownsMutex = $false
    try {
        # PowerShell does not use backslash as an escape character.  Keep one
        # separator here; two literal backslashes make the Windows mutex name
        # invalid and abort the release before the first durable log entry.
        $name = "Global\wechat-miniapp-release-log-" + ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Path))) -replace '[^A-Za-z0-9]', '_')
        $mutex = [Threading.Mutex]::new($false, $name)
        try {
            $ownsMutex = $mutex.WaitOne([TimeSpan]::FromSeconds(15))
        }
        catch [Threading.AbandonedMutexException] {
            # The previous writer died while holding the mutex.  The OS has
            # already transferred ownership to us, so the append is safe.
            $ownsMutex = $true
        }
        if (-not $ownsMutex) { throw "等待发布日志写入锁超时：$Path" }
        Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
    }
    finally {
        if ($null -ne $mutex) {
            if ($ownsMutex) { try { $mutex.ReleaseMutex() } catch {} }
            $mutex.Dispose()
        }
    }
}

function Write-ReleaseFailureAlert {
    <# Write one sanitized alert per operation.  Webhook delivery is optional
       and best-effort; a network failure must never hide the original error. #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [string]$Version = "",
        [string]$Stage = "failed",
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$ContextPath = "",
        [string]$LogPath = ""
    )
    $root = if ($Policy.PSObject.Properties["alertRoot"] -and $Policy.alertRoot) { [string]$Policy.alertRoot } else { Join-Path ([string]$Policy.logRoot) "alerts" }
    $path = Join-Path $root "release-$OperationId.json"
    $alert = [ordered]@{
        schemaVersion = 1
        operationId = $OperationId
        version = $Version
        stage = $Stage
        status = "failed"
        message = ConvertTo-ReleaseSafeMessage -Message $Message
        contextPath = $ContextPath
        logPath = $LogPath
        createdAt = [DateTimeOffset]::UtcNow.ToString("o")
    }
    try { Write-ReleaseGateJsonAtomic -Path $path -Value $alert } catch { Write-Host "失败告警写入失败：$($_.Exception.Message)" -ForegroundColor Yellow }
    $webhook = [string]$env:MINIPROGRAM_RELEASE_ALERT_WEBHOOK
    if (-not [string]::IsNullOrWhiteSpace($webhook)) {
        try {
            $payload = @{ text = "微信小程序发布失败 [$OperationId] v$Version 阶段=$Stage：$($alert.message)" } | ConvertTo-Json -Compress
            Invoke-RestMethod -Uri $webhook -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 10 | Out-Null
        }
        catch { Write-Host "失败告警 webhook 发送失败（不影响发布现场）：$($_.Exception.Message)" -ForegroundColor Yellow }
    }
    return $path
}

function Get-ReleaseLatestManifest {
    param([Parameter(Mandatory = $true)][object]$Policy)
    $path = [string]$Policy.latestReleasePath
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "latest-release 清单无法解析：$path" }
}

function Write-ReleaseBackupManifest {
    <# 在新版本真正写入最终状态前登记上一版。旧产物不复制、不删除，
       只保存它们的不可变路径和 SHA，回滚时可验证后复用。 #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$Version
    )
    $previous = Get-ReleaseLatestManifest -Policy $Policy
    $root = [string]$Policy.backupRoot
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $path = Join-Path $root "backup-$OperationId.json"
    $manifest = [ordered]@{
        schemaVersion = 1
        operationId = $OperationId
        version = $Version
        createdAt = [DateTimeOffset]::UtcNow.ToString("o")
        status = "registered"
        previous = $null
    }
    if ($null -ne $previous) {
        $copy = [ordered]@{}
        foreach ($property in $previous.PSObject.Properties) { $copy[$property.Name] = $property.Value }
        $manifest.previous = $copy
    }
    Write-ReleaseImmutableJson -Path $path -Value $manifest | Out-Null
    return [pscustomobject]@{ Path = $path; Manifest = [pscustomobject]$manifest }
}

function Invoke-ReleaseLatestCriticalSection {
    <# latest-release.json 是跨入口共享的可移动指针。所有读-校验-写
       必须在同一个进程间互斥体内完成，避免旧报告在 TOCTOU 窗口覆盖新版本。 #>
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [ValidateRange(1, 300)][int]$TimeoutSeconds = 60
    )
        $mutex = [Threading.Mutex]::new($false, 'Local\wechat-miniapp-release-latest')
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds)) }
        catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw "latest-release 指针互斥锁等待超时，拒绝并发写入。" }
        return & $Action
    }
    finally {
        if ($owned) { try { $mutex.ReleaseMutex() } catch { } }
        $mutex.Dispose()
    }
}

function Write-ReleaseLatestManifestCore {
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][string]$ReportPath,
        [Parameter(Mandatory = $true)][object]$Report
    )
    $status = if ($Report.PSObject.Properties["status"]) { [string]$Report.status } else { "" }
    if ($status -ne "succeeded") { throw "只有验收报告 succeeded 才能更新 latest-release 清单。" }
    # latest 是一个可移动指针，但版本不能倒退。相同版本只能由同一个
    # operation/commit 幂等复用，避免旧恢复任务把新版本指针改回去。
    $existing = Get-ReleaseLatestManifest -Policy $Policy
    if ($null -ne $existing) {
        $existingVersion = [string](Get-ReleaseReceiptField $existing "version")
        $newVersion = [string]$Context.version
        try {
            $oldSemver = [version]$existingVersion
            $newSemver = [version]$newVersion
            if ($oldSemver -gt $newSemver) { throw "latest-release 已是更高版本 $existingVersion，拒绝回退到 $newVersion。" }
            if ($oldSemver -eq $newSemver) {
                $sameIdentity = [string]::Equals([string](Get-ReleaseReceiptField $existing "operationId"), [string]$Context.operationId, [StringComparison]::OrdinalIgnoreCase) -and
                    [string]::Equals([string](Get-ReleaseReceiptField $existing "releaseCommit"), [string]$Context.releaseCommit, [StringComparison]::OrdinalIgnoreCase) -and
                    [string]::Equals([string](Get-ReleaseReceiptField $existing "treeSha"), [string]$Context.treeSha, [StringComparison]::OrdinalIgnoreCase)
                if (-not $sameIdentity) { throw "latest-release 同版本 $newVersion 已绑定其他操作，拒绝覆盖。" }
            }
        }
        catch [System.Management.Automation.RuntimeException] { throw }
        catch { throw "latest-release 版本字段无效，拒绝更新：$existingVersion" }
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        operationId = [string]$Context.operationId
        version = [string]$Context.version
        releaseCommit = [string]$Context.releaseCommit
        mainCommit = if ($Context.PSObject.Properties["mainCommit"]) { [string]$Context.mainCommit } elseif ($Report.PSObject.Properties["mainCommit"]) { [string]$Report.mainCommit } else { "" }
        treeSha = [string]$Context.treeSha
        sourceSha256 = [string]$Context.sourceSha256
        packageSha256 = if ($Context.PSObject.Properties["packageSha256"]) { [string]$Context.packageSha256 } else { "" }
        artifactPath = [string]$Context.artifactPath
        reportPath = [IO.Path]::GetFullPath($ReportPath)
        createdAt = [DateTimeOffset]::UtcNow.ToString("o")
        status = "succeeded"
    }
    Write-ReleaseGateJsonAtomic -Path ([string]$Policy.latestReleasePath) -Value $manifest
    return [pscustomobject]$manifest
}

function Write-ReleaseLatestManifest {
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][string]$ReportPath,
        [Parameter(Mandatory = $true)][object]$Report
    )
    return Invoke-ReleaseLatestCriticalSection -Action {
        Write-ReleaseLatestManifestCore -Policy $Policy -Context $Context -ReportPath $ReportPath -Report $Report
    }
}

function Invoke-ReleaseReservationMaintenanceInline {
    <# 轻量内置维护，供 release.ps1 在已持有同一把锁时调用。它不删除
       原 reservation，只把失败/取消/过期副本放进 archive，历史版本仍被
       Get-ReleaseUsedVersions 计入，避免旧号再次被分配。 #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [ValidateRange(0, 8760)][int]$OlderThanHours = 24
    )
    $root = [IO.Path]::GetFullPath([string]$Policy.reservationRoot)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return 0 }
    $archiveRoot = Join-Path $root "archive"
    New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
    $archived = New-Object System.Collections.Generic.List[object]
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter 'reservation-*.json' -File -ErrorAction SilentlyContinue)) {
        try { $value = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
        $status = [string]$value.status
        if ($status -notin @('failed','cancelled','expired','recoverable')) { continue }
        $stampText = if ($value.PSObject.Properties['updatedAt']) { [string]$value.updatedAt } else { [string]$value.createdAt }
        $ageHours = 0.0
        try { $ageHours = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($stampText)).TotalHours } catch { $ageHours = $OlderThanHours }
        if ($ageHours -lt $OlderThanHours) { continue }
        $target = Join-Path $archiveRoot $file.Name
        $bytes = [IO.File]::ReadAllBytes($file.FullName)
        $newSha = ([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))) -replace '-','').ToLowerInvariant()
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            $oldSha = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($oldSha -ne $newSha) { throw "reservation 归档同名内容不同，拒绝覆盖：$target" }
        }
        else {
            $temp = "$target.$PID.$([guid]::NewGuid().ToString('N')).tmp"
            try { [IO.File]::WriteAllBytes($temp, $bytes); [IO.File]::Move($temp, $target) } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
        }
        [void]$archived.Add([ordered]@{ operationId = [string]$value.operationId; version = [string]$value.targetVersion; status = $status; sourcePath = $file.FullName; archivePath = $target; sourceSha256 = $newSha; archivedAt = [DateTimeOffset]::UtcNow.ToString('o') })
    }
    $indexPath = Join-Path $archiveRoot 'reservation-archive-index.json'
    $entries = New-Object System.Collections.Generic.List[object]
    if (Test-Path -LiteralPath $indexPath -PathType Leaf) {
        try { $old = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json; foreach($e in @($old.entries)){[void]$entries.Add($e)} } catch { throw "reservation 归档索引无法解析：$indexPath" }
    }
    $seen = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    # Do not wrap a generic List in @(...).  PowerShell 7's enumerable
    # binder can throw "Argument types do not match" for a non-empty
    # List[object]; materialize its array explicitly instead.
    foreach($e in $entries.ToArray()){[void]$seen.Add("$($e.operationId)|$($e.sourceSha256)")}
    foreach($e in $archived.ToArray()){if($seen.Add("$($e.operationId)|$($e.sourceSha256)")){[void]$entries.Add($e)}}
    Write-ReleaseGateJsonAtomic -Path $indexPath -Value ([ordered]@{schemaVersion=1;generatedAt=[DateTimeOffset]::UtcNow.ToString('o');versionReuseAllowed=$false;entries=[object[]]$entries.ToArray()})
    return $archived.Count
}

function Get-ReleaseReceiptField {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return "" }
    if ($Object -is [System.Collections.IDictionary]) {
        if (-not $Object.Contains($Name) -or $null -eq $Object[$Name]) { return "" }
        return [string]$Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return "" }
    return [string]$property.Value
}

function Write-ReleaseAcceptanceReport {
    <# 统一核对 GitHub/main、ZIP、二维码、CloudBase 四端。报告本身也是
       不可变证据：同名不同内容拒绝覆盖，失败不会更新 latest 指针。 #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][object]$Context,
        [string]$ContextPath = "",
        [switch]$RequireCloud,
        [switch]$RequirePreview
    )
    $operationId = [string]$Context.operationId
    $reportRoot = [string]$Policy.reportRoot
    New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
    # Reports are immutable evidence.  A failed first attempt may already have
    # occupied the canonical name; a later recovery must never overwrite that
    # evidence.  The write path is selected after the new report is assembled:
    # the canonical name is used for the first write, and a deterministic
    # `-repair-<sha>` sibling is used when the old file contains different
    # (usually failed) evidence.
    $canonicalJsonPath = Join-Path $reportRoot "release-$operationId.json"
    $jsonPath = $canonicalJsonPath
    $checks = [ordered]@{}

    $mainPass = $false
    $mainReason = "未记录 mainCommit"
    $mainCommit = Get-ReleaseReceiptField $Context "mainCommit"
    if (-not [string]::IsNullOrWhiteSpace($mainCommit)) {
        try { $null = Assert-ReleaseMainContainsCommit -RepositoryRoot ([string]$Policy.canonicalRepo) -ReleaseCommit ([string]$Context.releaseCommit) -MergeCommit $mainCommit; $mainPass = $true; $mainReason = "main 已包含 releaseCommit" } catch { $mainReason = $_.Exception.Message }
    }
    $checks.main = [ordered]@{ status = if ($mainPass) { "pass" } else { "fail" }; version = [string]$Context.version; releaseCommit = [string]$Context.releaseCommit; mainCommit = $mainCommit; reason = $mainReason }

    $artifactPath = [string]$Context.artifactPath
    $zipPass = $false; $zipReason = "产物不存在"
    $artifactSha = ""; $artifactSize = 0
    if (Test-Path -LiteralPath $artifactPath -PathType Leaf) {
        try {
            $artifact = Get-Item -LiteralPath $artifactPath
            $artifactSize = [int64]$artifact.Length
            $artifactSha = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $expectedSha = Get-ReleaseReceiptField $Context "packageSha256"
            $expectedSize = Get-ReleaseReceiptField $Context "packageSizeBytes"
            $expectedName = "wechat-miniapp-release-v$($Context.version)-$($Context.releaseCommit).zip"
            $zipPass = $artifactSize -gt 0 -and
                [IO.Path]::GetFileName($artifactPath) -eq $expectedName -and
                $expectedSha -match '^[0-9a-fA-F]{64}$' -and
                $artifactSha -eq $expectedSha.ToLowerInvariant() -and
                $expectedSize -match '^\d+$' -and
                [int64]$expectedSize -eq $artifactSize
            $packageScript = Join-Path $PSScriptRoot "package-release.py"
            if ($zipPass -and (Test-Path -LiteralPath $packageScript -PathType Leaf) -and -not [string]::IsNullOrWhiteSpace($ContextPath) -and (Test-Path -LiteralPath $ContextPath -PathType Leaf)) {
                $packageProbe = & python $packageScript --check-only --release-context $ContextPath 2>&1
                if ($LASTEXITCODE -ne 0) { $zipPass = $false; $zipReason = "package-release.py 校验失败：$($packageProbe -join ' ')" }
            }
            if ($zipPass) { $zipReason = "ZIP 存在且 SHA/大小一致" }
            elseif ([string]::IsNullOrWhiteSpace($zipReason) -or $zipReason -eq "产物不存在") { $zipReason = "ZIP SHA 或大小与 context 不一致" }
        } catch { $zipReason = $_.Exception.Message }
    }
    $checks.zip = [ordered]@{ status = if ($zipPass) { "pass" } else { "fail" }; path = $artifactPath; sha256 = $artifactSha; sizeBytes = $artifactSize; reason = $zipReason }

    $previewRequested = [bool]$RequirePreview -or (
        -not [string]::IsNullOrWhiteSpace((Get-ReleaseReceiptField $Context "previewQrPath")) -or
        -not [string]::IsNullOrWhiteSpace((Get-ReleaseReceiptField $Context "previewInfoPath"))
    )
    $qrPass = $false; $qrPayload = ""; $qrReason = "未要求二维码"; $qrPath = Get-ReleaseReceiptField $Context "previewQrPath"; $infoPath = Get-ReleaseReceiptField $Context "previewInfoPath"
    if ($previewRequested) {
        $qrReason = "二维码证据缺失"
        if (-not [string]::IsNullOrWhiteSpace($qrPath) -and -not [string]::IsNullOrWhiteSpace($infoPath) -and (Test-Path -LiteralPath $qrPath -PathType Leaf) -and (Test-Path -LiteralPath $infoPath -PathType Leaf)) {
            try {
                $artifactRoot = (ConvertTo-ReleaseFullPath -Path ([string]$Policy.artifactRoot)).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
                $resolvedQr = ConvertTo-ReleaseFullPath -Path $qrPath
                $resolvedInfo = ConvertTo-ReleaseFullPath -Path $infoPath
                if (-not $resolvedQr.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase) -or -not $resolvedInfo.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "二维码路径不在策略产物目录内。"
                }
                $expectedQrName = "wechat-miniapp-preview-v$($Context.version)-$($Context.releaseCommit)-qr.png"
                $expectedInfoName = "wechat-miniapp-preview-v$($Context.version)-$($Context.releaseCommit)-info.json"
                if ([IO.Path]::GetFileName($resolvedQr) -ne $expectedQrName -or [IO.Path]::GetFileName($resolvedInfo) -ne $expectedInfoName) {
                    throw "二维码文件名不是当前版本/commit 的不可变名称。"
                }
                $qrItem = Get-Item -LiteralPath $resolvedQr
                if ($qrItem.Length -le 0) { throw "二维码文件为空。" }
                $info = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $qrSha = (Get-FileHash -LiteralPath $resolvedQr -Algorithm SHA256).Hash.ToLowerInvariant()
                $qrDecodeScript = Join-Path $PSScriptRoot "qr-decode.js"
                if (-not (Test-Path -LiteralPath $qrDecodeScript -PathType Leaf)) {
                    throw "二维码解码脚本缺失：$qrDecodeScript"
                }
                $qrDecodeOutput = @(& node $qrDecodeScript --image $resolvedQr --json 2>&1)
                if ($LASTEXITCODE -ne 0) {
                    throw "二维码真实解码失败：$($qrDecodeOutput -join ' ')"
                }
                try {
                    $qrDecode = ($qrDecodeOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
                }
                catch {
                    throw "二维码解码回执不是有效 JSON：$($qrDecodeOutput -join ' ')"
                }
                $qrPayload = Get-ReleaseReceiptField $qrDecode "payload"
                $qrOk = (Get-ReleaseReceiptField $qrDecode "ok").ToLowerInvariant() -eq "true"
                if (-not $qrOk -or [string]::IsNullOrWhiteSpace($qrPayload)) {
                    throw "二维码解码回执缺少非空 payload。"
                }
                $infoMain = Get-ReleaseReceiptField $info "mainCommit"
                $expectedMain = Get-ReleaseReceiptField $Context "mainCommit"
                $qrPass = [int](Get-ReleaseReceiptField $info "schemaVersion") -eq 1 -and
                    -not [string]::IsNullOrWhiteSpace((Get-ReleaseReceiptField $info "qrSha256")) -and
                    (Get-ReleaseReceiptField $info "qrSha256").ToLowerInvariant() -eq $qrSha -and
                    (Get-ReleaseReceiptField $info "operationId") -eq $operationId -and
                    (Get-ReleaseReceiptField $info "appVersion") -eq [string]$Context.version -and
                    (Get-ReleaseReceiptField $info "gitCommit") -eq [string]$Context.releaseCommit -and
                    (Get-ReleaseReceiptField $info "treeSha") -eq [string]$Context.treeSha -and
                    (Get-ReleaseReceiptField $info "sourceSha256") -eq [string]$Context.sourceSha256 -and
                    (Get-ReleaseReceiptField $info "artifactPath") -eq [string]$Context.artifactPath -and
                    -not [string]::IsNullOrWhiteSpace($expectedMain) -and
                    [string]::Equals($infoMain, $expectedMain, [StringComparison]::OrdinalIgnoreCase)
                $qrReason = if ($qrPass) { "二维码已真实解码，且 info/SHA 与 context 一致" } else { "二维码 SHA 或绑定字段不一致" }
            } catch { $qrReason = $_.Exception.Message }
        }
    }
    $checks.qr = [ordered]@{ status = if (-not $previewRequested) { "skipped" } elseif ($qrPass) { "pass" } else { "fail" }; qrPath = $qrPath; infoPath = $infoPath; payload = if ($null -ne $qrPayload) { $qrPayload } else { "" }; reason = $qrReason }

    # When preview was requested, the DevTools project import is a separate
    # auditable step.  A QR file alone does not prove that the newly packaged
    # source was actually loaded into the preview tool.
    $importReceipt = if ($Context.PSObject.Properties["previewImport"]) { $Context.previewImport } else { $null }
    $importRequested = [bool]$RequirePreview -or $null -ne $importReceipt
    $importPass = $false; $importReason = "未要求导入预览项目"
    if ($importRequested) {
        $importReason = "缺少预览项目导入回执"
        if ($null -ne $importReceipt) {
            $importPath = Get-ReleaseReceiptField $importReceipt "projectPath"
                $worktreeRoot = (ConvertTo-ReleaseFullPath -Path ([string]$Policy.worktreeRoot)).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
            $compileStatus = Get-ReleaseReceiptField $importReceipt "compileStatus"
            $importPass = (Get-ReleaseReceiptField $importReceipt "status") -eq "imported" -and
                (Get-ReleaseReceiptField $importReceipt "openStatus") -eq "opened" -and
                $compileStatus -eq "succeeded" -and
                (Get-ReleaseReceiptField $importReceipt "operationId") -eq $operationId -and
                (Get-ReleaseReceiptField $importReceipt "version") -eq [string]$Context.version -and
                [string]::Equals((Get-ReleaseReceiptField $importReceipt "releaseCommit"), [string]$Context.releaseCommit, [StringComparison]::OrdinalIgnoreCase) -and
                [string]::Equals((Get-ReleaseReceiptField $importReceipt "treeSha"), [string]$Context.treeSha, [StringComparison]::OrdinalIgnoreCase) -and
                [string]::Equals((Get-ReleaseReceiptField $importReceipt "sourceSha256"), [string]$Context.sourceSha256, [StringComparison]::OrdinalIgnoreCase) -and
                -not [string]::IsNullOrWhiteSpace($importPath) -and
                $importPath.StartsWith($worktreeRoot, [StringComparison]::OrdinalIgnoreCase)
            $importReason = if ($importPass) { "微信开发者工具已导入、打开并确认编译完成" } else { "预览导入/打开/编译回执与 context 不一致" }
        }
    }
    $checks.previewImport = [ordered]@{ status = if (-not $importRequested) { "skipped" } elseif ($importPass) { "pass" } else { "fail" }; reason = $importReason; receipt = $importReceipt }

    $cloudReceipt = if ($Context.PSObject.Properties["cloudReceipt"]) { $Context.cloudReceipt } else { $null }
    $cloudRequested = [bool]$RequireCloud -or $null -ne $cloudReceipt
    $cloudPass = $false; $cloudReason = "未要求 CloudBase"
    if ($cloudRequested) {
        $cloudReason = "CloudBase receipt 缺失"
        if ($null -ne $cloudReceipt) {
            $expectedPackage = Get-ReleaseReceiptField $Context "packageSha256"
            $expectedMain = Get-ReleaseReceiptField $Context "mainCommit"
            $receiptMarker = Get-ReleaseReceiptField $cloudReceipt "onlineBuildMarker"
            $expectedMarker = Get-ReleaseReceiptField $Context "apiBuildMarker"
            $cloudPass = [int](Get-ReleaseReceiptField $cloudReceipt "schemaVersion") -eq 1 -and
                (Get-ReleaseReceiptField $cloudReceipt "status") -eq "verified" -and
                -not [string]::IsNullOrWhiteSpace((Get-ReleaseReceiptField $cloudReceipt "verifiedAt")) -and
                -not [string]::IsNullOrWhiteSpace((Get-ReleaseReceiptField $cloudReceipt "idempotencyKey")) -and
                (Get-ReleaseReceiptField $cloudReceipt "operationId") -eq $operationId -and
                (Get-ReleaseReceiptField $cloudReceipt "version") -eq [string]$Context.version -and
                (Get-ReleaseReceiptField $cloudReceipt "releaseCommit") -eq [string]$Context.releaseCommit -and
                (Get-ReleaseReceiptField $cloudReceipt "treeSha") -eq [string]$Context.treeSha -and
                (Get-ReleaseReceiptField $cloudReceipt "sourceSha256") -eq [string]$Context.sourceSha256 -and
                -not [string]::IsNullOrWhiteSpace($expectedPackage) -and
                (Get-ReleaseReceiptField $cloudReceipt "packageSha256") -eq $expectedPackage -and
                -not [string]::IsNullOrWhiteSpace($expectedMain) -and
                [string]::Equals((Get-ReleaseReceiptField $cloudReceipt "mainCommit"), $expectedMain, [StringComparison]::OrdinalIgnoreCase) -and
                (Get-ReleaseReceiptField $cloudReceipt "idempotencyKey") -eq "cloud:$operationId`:$([string]$Context.releaseCommit):$([string]$Context.treeSha)" -and
                (Get-ReleaseReceiptField $cloudReceipt "onlineBuildVersion") -eq [string]$Context.version -and
                -not [string]::IsNullOrWhiteSpace($receiptMarker) -and
                ([string]::IsNullOrWhiteSpace($expectedMarker) -or $receiptMarker -eq $expectedMarker)
            $cloudReason = if ($cloudPass) { "CloudBase receipt 已验证" } else { "CloudBase receipt 绑定字段不一致" }
        }
    }
    $checks.cloud = [ordered]@{ status = if (-not $cloudRequested) { "skipped" } elseif ($cloudPass) { "pass" } else { "fail" }; reason = $cloudReason; receipt = $cloudReceipt }

    $paymentReceipt = if ($Context.PSObject.Properties["paymentDeployment"]) { $Context.paymentDeployment } else { $null }
    $paymentRequested = [bool]$RequireCloud -or $null -ne $paymentReceipt
    $paymentPass = $false; $paymentReason = "未要求支付生产部署"
    if ($paymentRequested) {
        $paymentReason = "支付生产部署回执缺失"
        if ($null -ne $paymentReceipt) {
            $expectedPackage = Get-ReleaseReceiptField $Context "packageSha256"
            $expectedMain = Get-ReleaseReceiptField $Context "mainCommit"
            $environment = Get-ReleaseReceiptField $paymentReceipt "environment"
            $expectedEnvironment = ""
            if ($Context.PSObject.Properties["cloudbaseEnvironment"] -and $null -ne $Context.cloudbaseEnvironment) {
                $expectedEnvironment = Get-ReleaseReceiptField $Context.cloudbaseEnvironment "environmentId"
            }
            $credentialsProperty = $paymentReceipt.PSObject.Properties["credentialsConfigured"]
            $missingKeysProperty = $paymentReceipt.PSObject.Properties["missingCredentialKeys"]
            $credentialsValid = $null -ne $credentialsProperty -and $credentialsProperty.Value -is [bool]
            $missingKeys = if ($null -ne $missingKeysProperty) { @($missingKeysProperty.Value) } else { @() }
            $providerState = Get-ReleaseReceiptField $paymentReceipt "providerState"
            $providerStateValid = $credentialsValid -and (
                ($credentialsProperty.Value -and $providerState -eq "configured" -and $missingKeys.Count -eq 0) -or
                (-not $credentialsProperty.Value -and $providerState -eq "fail-closed" -and $missingKeys.Count -gt 0)
            )
            $paymentPass = [int](Get-ReleaseReceiptField $paymentReceipt "schemaVersion") -eq 1 -and
                (Get-ReleaseReceiptField $paymentReceipt "state") -eq "verified" -and
                (Get-ReleaseReceiptField $paymentReceipt "status") -eq "verified" -and
                -not [string]::IsNullOrWhiteSpace((Get-ReleaseReceiptField $paymentReceipt "verifiedAt")) -and
                (Get-ReleaseReceiptField $paymentReceipt "operationId") -eq $operationId -and
                (Get-ReleaseReceiptField $paymentReceipt "version") -eq [string]$Context.version -and
                (Get-ReleaseReceiptField $paymentReceipt "releaseCommit") -eq [string]$Context.releaseCommit -and
                (Get-ReleaseReceiptField $paymentReceipt "treeSha") -eq [string]$Context.treeSha -and
                (Get-ReleaseReceiptField $paymentReceipt "sourceSha256") -eq [string]$Context.sourceSha256 -and
                -not [string]::IsNullOrWhiteSpace($expectedPackage) -and
                (Get-ReleaseReceiptField $paymentReceipt "packageSha256") -eq $expectedPackage -and
                -not [string]::IsNullOrWhiteSpace($expectedMain) -and
                [string]::Equals((Get-ReleaseReceiptField $paymentReceipt "mainCommit"), $expectedMain, [StringComparison]::OrdinalIgnoreCase) -and
                -not [string]::IsNullOrWhiteSpace($environment) -and
                ([string]::IsNullOrWhiteSpace($expectedEnvironment) -or [string]::Equals($environment, $expectedEnvironment, [StringComparison]::OrdinalIgnoreCase)) -and
                (Get-ReleaseReceiptField $paymentReceipt "idempotencyKey") -eq "payment:$operationId`:$([string]$Context.releaseCommit):$([string]$Context.treeSha):$environment" -and
                $providerStateValid -and
                $null -ne $paymentReceipt.PSObject.Properties["functions"] -and
                $null -ne $paymentReceipt.PSObject.Properties["route"] -and
                $null -ne $paymentReceipt.PSObject.Properties["timer"] -and
                $null -ne $paymentReceipt.PSObject.Properties["rechargeConfig"]
            $paymentReason = if ($paymentPass) { "支付生产回执、环境和发布身份已验证" } else { "支付生产回执绑定字段不一致" }
        }
    }
    $checks.payment = [ordered]@{ status = if (-not $paymentRequested) { "skipped" } elseif ($paymentPass) { "pass" } else { "fail" }; reason = $paymentReason; receipt = $paymentReceipt }

    $failed = @($checks.Values | Where-Object { $_.status -eq "fail" }).Count
    $pending = @($checks.Values | Where-Object { $_.status -eq "pending" }).Count
    $overall = if ($failed -gt 0 -or $pending -gt 0) { "failed" } else { "succeeded" }
    $report = [ordered]@{
        schemaVersion = 1; operationId = $operationId; version = [string]$Context.version; releaseCommit = [string]$Context.releaseCommit; treeSha = [string]$Context.treeSha; sourceSha256 = [string]$Context.sourceSha256; packageSha256 = $artifactSha; artifactPath = $artifactPath; status = $overall; checks = $checks; createdAt = if ($Context.PSObject.Properties["createdAt"] -and -not [string]::IsNullOrWhiteSpace([string]$Context.createdAt)) { [string]$Context.createdAt } else { [DateTimeOffset]::UtcNow.ToString("o") }
    }
    # Pick an immutable repair filename if the canonical report already exists
    # with different bytes.  This preserves the original failure report while
    # allowing the same operation/context to finish after a bug or transient
    # side-effect is repaired.  The hash is based on the exact JSON bytes, so
    # retries are idempotent and do not create an unbounded stream of files.
    $reportJsonBytes = [Text.UTF8Encoding]::new($false).GetBytes((($report | ConvertTo-Json -Depth 30) + [Environment]::NewLine))
    if (Test-Path -LiteralPath $canonicalJsonPath -PathType Leaf) {
        $existingReportSha = (Get-FileHash -LiteralPath $canonicalJsonPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $reportSha = [Security.Cryptography.SHA256]::Create()
        try { $newReportSha = ([BitConverter]::ToString($reportSha.ComputeHash($reportJsonBytes)) -replace '-', '').ToLowerInvariant() }
        finally { $reportSha.Dispose() }
        if ($existingReportSha -ne $newReportSha) {
            $repairId = $newReportSha.Substring(0, 16)
            $jsonPath = Join-Path $reportRoot "release-$operationId-repair-$repairId.json"
        }
    }
    # Suppress the helper's created/reused marker.  The acceptance function's
    # public result must be one object; leaking that marker makes PowerShell
    # unwrap the assignment into an array and hides `.Report` from callers.
    Write-ReleaseImmutableJson -Path $jsonPath -Value $report | Out-Null
    $markdownPath = [IO.Path]::ChangeExtension($jsonPath, ".md")
    $lines = @("# 发布验收报告", "", "- 操作号：$operationId", "- 版本：$($Context.version)", "- releaseCommit：$($Context.releaseCommit)", "- 总状态：$overall", "", "| 项目 | 状态 | 说明 |", "|---|---|---|")
    foreach ($entry in $checks.GetEnumerator()) { $lines += "| $($entry.Key) | $($entry.Value.status) | $($entry.Value.reason -replace '\|','/') |" }
    $markdown = ($lines -join "`n") + "`n"
    $tempMd = "$markdownPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($tempMd, $markdown, [Text.UTF8Encoding]::new($false))
    try {
        if (Test-Path -LiteralPath $markdownPath -PathType Leaf) {
            $oldMd = (Get-FileHash -LiteralPath $markdownPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $newMd = (Get-FileHash -LiteralPath $tempMd -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($oldMd -ne $newMd) { throw "验收报告同名但内容不同，拒绝覆盖：$markdownPath" }
        }
        else { [IO.File]::Move($tempMd, $markdownPath) }
    }
    finally { Remove-Item -LiteralPath $tempMd -Force -ErrorAction SilentlyContinue }
    return [pscustomobject]@{ Path = $jsonPath; MarkdownPath = $markdownPath; Report = [pscustomobject]$report }
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
    $push = Invoke-ReleaseGit -WorkingDirectory $RepositoryRoot -Arguments @("push", "origin", "$CommitSha`:refs/heads/$Branch")
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
