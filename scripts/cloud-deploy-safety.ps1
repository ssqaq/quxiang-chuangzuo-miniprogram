Set-StrictMode -Version Latest

$releaseLockScript = Join-Path $PSScriptRoot "release-lock.ps1"
if (-not (Test-Path -LiteralPath $releaseLockScript -PathType Leaf)) {
    throw "缺少公共发布锁模块：$releaseLockScript"
}
. $releaseLockScript

function Get-CloudDeployLockPaths {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectPath,
        [string]$LockPath = ""
    )
    return Get-ReleaseLockPaths -ProjectPath $ProjectPath -LockPath $LockPath
}

function Read-CloudDeployOwner {
    param([Parameter(Mandatory = $true)][string]$OwnerPath)
    return Read-ReleaseLockOwner -OwnerPath $OwnerPath
}

function Read-CloudDeployPending {
    param([Parameter(Mandatory = $true)][string]$PendingPath)
    return Read-ReleasePending -PendingPath $PendingPath
}

function Write-CloudDeployPending {
    param(
        [Parameter(Mandatory = $true)][string]$PendingPath,
        [Parameter(Mandatory = $true)][object]$Record
    )
    Write-ReleasePending -PendingPath $PendingPath -Record $Record
}

function Remove-CloudDeployPending {
    param([Parameter(Mandatory = $true)][string]$PendingPath)
    Remove-ReleasePending -PendingPath $PendingPath
}

function Enter-CloudDeployLock {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectPath,
        [Parameter(Mandatory = $true)][string]$TargetVersion,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [ValidateRange(1, 7200)][int]$WaitSeconds = 60,
        [string]$LockPath = ""
    )
    return Enter-ReleaseLock `
        -ProjectPath $ProjectPath `
        -TargetVersion $TargetVersion `
        -TargetType "cloud-deploy:$FunctionName" `
        -WaitSeconds $WaitSeconds `
        -LockPath $LockPath `
        -ProjectId (Split-Path ([IO.Path]::GetFullPath($ProjectPath)) -Leaf)
}

function Exit-CloudDeployLock {
    param([object]$LockHandle)
    Exit-ReleaseLock -LockHandle $LockHandle
}

function Assert-CloudDeployReleaseContext {
    param(
        [Parameter(Mandatory = $true)][string]$ContextPath,
        [Parameter(Mandatory = $true)][string]$ProjectPath,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [string]$ExpectedRemoteUrl = "",
        [switch]$AllowPostMergeRecovery
    )
    if (-not (Test-Path -LiteralPath $ContextPath -PathType Leaf)) {
        throw "缺少 release context：$ContextPath"
    }
    try {
        $context = Get-Content -LiteralPath $ContextPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "release context 不是有效 JSON：$ContextPath。$($_.Exception.Message)"
    }
    foreach ($name in @("schemaVersion", "operationId", "canonicalRepo", "remote", "version", "releaseCommit", "treeSha", "sourceSha256", "artifactPath", "expiresAt")) {
        if ($null -eq $context.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$context.$name)) {
            throw "release context 缺少字段：$name"
        }
    }
    if ([int]$context.schemaVersion -notin @(1, 2)) { throw "不支持的 release context schemaVersion：$($context.schemaVersion)" }
    if ([int]$context.schemaVersion -ge 2) {
        foreach ($name in @("baseHead", "phase")) {
            if ($null -eq $context.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$context.$name)) {
                throw "release context v2 缺少字段：$name"
            }
        }
        if ([string]$context.baseHead -notmatch '^[0-9a-fA-F]{7,64}$') {
            throw "release context v2 baseHead 无效。"
        }
        $allowedDeployPhases = @("merged", "deployed", "previewed", "verified")
        if ($AllowPostMergeRecovery) {
            $allowedDeployPhases += "succeeded"
        }
        if ($allowedDeployPhases -notcontains [string]$context.phase) {
            throw "CloudBase 部署只允许消费 PR 已合并后的 context；当前 phase=$($context.phase)。"
        }
        if ($allowedDeployPhases -contains [string]$context.phase -and
            ($null -eq $context.PSObject.Properties["mainCommit"] -or [string]::IsNullOrWhiteSpace([string]$context.mainCommit))) {
            throw "CloudBase 部署 context 缺少已合并的 mainCommit，拒绝绕过 PR。"
        }
    }
    if ([string]$context.version -ne $ExpectedVersion) {
        throw "release context 版本与部署源码不一致：context=$($context.version)，源码=$ExpectedVersion"
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedRemoteUrl) -and
        -not [string]::Equals([string]$context.remote, $ExpectedRemoteUrl, [StringComparison]::OrdinalIgnoreCase)) {
        throw "release context 远端与部署源码策略不一致：context=$($context.remote)，期望=$ExpectedRemoteUrl"
    }
    if ($context.PSObject.Properties["branch"] -and [string]$context.branch -ne "main") {
        throw "release context 目标分支必须是 main：$($context.branch)"
    }
    if ([string]$context.releaseCommit -notmatch '^[0-9a-fA-F]{7,64}$') { throw "release context releaseCommit 无效。" }
    if ([string]$context.treeSha -notmatch '^[0-9a-fA-F]{7,64}$') { throw "release context treeSha 无效。" }
    if ([string]$context.sourceSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "release context sourceSha256 无效。" }
    try { $expires = ConvertTo-ReleaseUtcDateTime -Value $context.expiresAt } catch { throw "release context expiresAt 无效。" }
    if ($expires -le [DateTime]::UtcNow) { throw "release context 已过期：$ContextPath" }

    $project = [IO.Path]::GetFullPath($ProjectPath)
    $canonical = [IO.Path]::GetFullPath([string]$context.canonicalRepo)
    if (-not (Test-Path -LiteralPath $canonical -PathType Container)) {
        throw "release context canonicalRepo 不存在：$canonical"
    }
    $projectRoot = (& git -C $project rev-parse --show-toplevel 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($projectRoot)) {
        throw "无法读取部署源码 Git 根目录。"
    }
    $projectRoot = [IO.Path]::GetFullPath($projectRoot)
    $commonDir = (& git -C $projectRoot rev-parse --git-common-dir 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commonDir)) {
        throw "无法读取部署源码 Git common dir。"
    }
    $commonDirFull = if ([IO.Path]::IsPathRooted($commonDir)) { [IO.Path]::GetFullPath($commonDir) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot $commonDir)) }
    $canonicalGit = [IO.Path]::GetFullPath((Join-Path $canonical ".git"))
    if (-not [string]::Equals($commonDirFull.TrimEnd('\', '/'), $canonicalGit.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "部署源码不是该 release context 的 canonical 隔离工作树，拒绝部署：$projectRoot"
    }
    $head = (& git -C $project rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($head)) { throw "无法读取部署源码 Git HEAD。" }
    $tree = (& git -C $project rev-parse "$head^{tree}" 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tree)) { throw "无法读取部署源码 Git tree。" }
    if (-not [string]::Equals($head, [string]$context.releaseCommit, [StringComparison]::OrdinalIgnoreCase)) {
        throw "部署源码 HEAD 与 release context 不一致：context=$($context.releaseCommit)，源码=$head"
    }
    if (-not [string]::Equals($tree, [string]$context.treeSha, [StringComparison]::OrdinalIgnoreCase)) {
        throw "部署源码 tree 与 release context 不一致：context=$($context.treeSha)，源码=$tree"
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedRemoteUrl)) {
        $remote = (& git -C $project remote get-url origin 2>$null | Out-String).Trim()
        if (-not [string]::Equals($remote, $ExpectedRemoteUrl, [StringComparison]::OrdinalIgnoreCase)) {
            throw "部署源码远端与 release context 不一致：context=$ExpectedRemoteUrl，源码=$remote"
        }
    }
    return $context
}

function Get-CloudDeployContextProperty {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][string]$Name,
        [object]$Default = $null
    )
    if ($null -eq $Context) { return $Default }
    $property = $Context.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Write-CloudDeployContextAtomic {
    <#
      Cloud deployment is a side effect of a release context.  Persisting its
      state beside the context lets a retry distinguish "never submitted" from
      "submitted but the process died before writing the receipt".  The caller
      must already hold the release lock; this helper only provides the atomic
      file replacement primitive.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ContextPath,
        [Parameter(Mandatory = $true)][object]$Context
    )
    $full = [IO.Path]::GetFullPath($ContextPath)
    $parent = Split-Path $full -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temp = "$full.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = $Context | ConvertTo-Json -Depth 20
        [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $full -Force
    }
    finally {
        if (Test-Path -LiteralPath $temp -PathType Leaf) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
    }
}

function New-CloudDeployIdempotencyKey {
    param(
        [Parameter(Mandatory = $true)][object]$Context
    )
    $operationId = [string](Get-CloudDeployContextProperty -Context $Context -Name "operationId" -Default "")
    $releaseCommit = [string](Get-CloudDeployContextProperty -Context $Context -Name "releaseCommit" -Default "")
    $treeSha = [string](Get-CloudDeployContextProperty -Context $Context -Name "treeSha" -Default "")
    if ([string]::IsNullOrWhiteSpace($operationId) -or
        [string]::IsNullOrWhiteSpace($releaseCommit) -or
        [string]::IsNullOrWhiteSpace($treeSha)) {
        throw "无法生成 CloudBase 幂等键：release context 身份字段不完整。"
    }
    return "cloud:${operationId}:${releaseCommit}:${treeSha}"
}

function Test-CloudDeployReceipt {
    param(
        [Parameter(Mandatory = $true)][object]$Receipt,
        [Parameter(Mandatory = $true)][object]$Context,
        [string]$ExpectedMainCommit = "",
        [string]$ExpectedBuildVersion = "",
        [string]$ExpectedBuildMarker = ""
    )
    if ($null -eq $Receipt) { return $false }
    $required = @("operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "packageSha256", "mainCommit", "status", "verifiedAt", "idempotencyKey")
    foreach ($name in $required) {
        $property = $Receipt.PSObject.Properties[$name]
        if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) { return $false }
    }
    if ([string]$Receipt.status -ne "verified") { return $false }
    foreach ($name in @("operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "packageSha256")) {
        $expected = [string](Get-CloudDeployContextProperty -Context $Context -Name $name -Default "")
        if (-not [string]::Equals([string]$Receipt.$name, $expected, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    }
    $main = if ([string]::IsNullOrWhiteSpace($ExpectedMainCommit)) {
        [string](Get-CloudDeployContextProperty -Context $Context -Name "mainCommit" -Default "")
    } else { $ExpectedMainCommit }
    if ([string]::IsNullOrWhiteSpace($main) -or
        -not [string]::Equals([string]$Receipt.mainCommit, $main, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $expectedKey = New-CloudDeployIdempotencyKey -Context $Context
    if (-not [string]::Equals([string]$Receipt.idempotencyKey, $expectedKey, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedBuildVersion) -and
        $Receipt.PSObject.Properties["onlineBuildVersion"] -and
        -not [string]::Equals([string]$Receipt.onlineBuildVersion, $ExpectedBuildVersion, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedBuildMarker) -and
        $Receipt.PSObject.Properties["onlineBuildMarker"] -and
        -not [string]::Equals([string]$Receipt.onlineBuildMarker, $ExpectedBuildMarker, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return $true
}

function Assert-CloudDeployReceipt {
    param(
        [Parameter(Mandatory = $true)][object]$Receipt,
        [Parameter(Mandatory = $true)][object]$Context,
        [string]$ExpectedMainCommit = "",
        [string]$ExpectedBuildVersion = "",
        [string]$ExpectedBuildMarker = ""
    )
    if (-not (Test-CloudDeployReceipt -Receipt $Receipt -Context $Context -ExpectedMainCommit $ExpectedMainCommit -ExpectedBuildVersion $ExpectedBuildVersion -ExpectedBuildMarker $ExpectedBuildMarker)) {
        throw "CloudBase receipt 与 release context/线上身份不一致，拒绝跳过部署。"
    }
    return $Receipt
}

function Get-CloudDeployVersion {
    param([Parameter(Mandatory = $true)][string]$ProjectPath)

    $configPath = Join-Path $ProjectPath "config.js"
    $text = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    $match = [regex]::Match($text, 'appVersion:\s*"([^"]+)"')
    if (-not $match.Success) {
        throw "config.js is missing appVersion."
    }
    return $match.Groups[1].Value
}

function ConvertTo-CloudDeployVersionParts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [string]$SourceName = "version"
    )

    $trimmed = $Version.Trim()
    $match = [regex]::Match($trimmed, '^(\d+)\.(\d+)\.(\d+)$')
    if (-not $match.Success) {
        throw "$SourceName 不是三段式语义版本：$Version"
    }
    return [pscustomobject]@{
        Text = "$([int64]$match.Groups[1].Value).$([int64]$match.Groups[2].Value).$([int64]$match.Groups[3].Value)"
        Major = [int64]$match.Groups[1].Value
        Minor = [int64]$match.Groups[2].Value
        Patch = [int64]$match.Groups[3].Value
    }
}

function Compare-CloudDeployVersions {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LeftVersion,
        [Parameter(Mandatory = $true)]
        [string]$RightVersion
    )

    $left = ConvertTo-CloudDeployVersionParts `
        -Version $LeftVersion `
        -SourceName "左侧版本"
    $right = ConvertTo-CloudDeployVersionParts `
        -Version $RightVersion `
        -SourceName "右侧版本"
    foreach ($part in @("Major", "Minor", "Patch")) {
        if ($left.$part -gt $right.$part) {
            return 1
        }
        if ($left.$part -lt $right.$part) {
            return -1
        }
    }
    return 0
}

function Assert-CloudDeployVersionNotDowngrade {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LocalVersion,
        [string]$OnlineVersion
    )

    if ([string]::IsNullOrWhiteSpace($OnlineVersion)) {
        throw "禁止部署：读取不到线上版本，无法确认这次部署不会降级。"
    }
    $local = ConvertTo-CloudDeployVersionParts `
        -Version $LocalVersion `
        -SourceName "本地版本"
    $online = ConvertTo-CloudDeployVersionParts `
        -Version $OnlineVersion `
        -SourceName "线上版本"
    $comparison = Compare-CloudDeployVersions `
        -LeftVersion $local.Text `
        -RightVersion $online.Text
    if ($comparison -lt 0) {
        throw "禁止版本降级：线上版本 $($online.Text) 高于本地版本 $($local.Text)，本次上传已拦截。"
    }
    return [pscustomobject]@{
        LocalVersion = $local.Text
        OnlineVersion = $online.Text
        Relation = if ($comparison -eq 0) { "same" } else { "local-newer" }
    }
}

function Test-CloudDeployUtf8TextFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    # npm may rewrite line endings in checked-in JavaScript dependencies.  We
    # only normalize files that are unambiguously text and valid UTF-8; image,
    # archive, and other binary payloads remain byte-for-byte protected.
    $textExtensions = @(
        ".js", ".cjs", ".mjs", ".njs", ".json", ".wxml", ".wxss", ".css",
        ".scss", ".less", ".ts", ".tsx", ".jsx", ".html", ".htm", ".xml",
        ".yaml", ".yml", ".md", ".txt", ".map", ".graphql", ".sql", ".sh",
        ".ps1", ".cmd", ".bat", ".ini", ".conf"
    )
    $extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($textExtensions -notcontains $extension) {
        return $false
    }
    for ($index = 0; $index -lt $Bytes.Length; $index++) {
        if ($Bytes[$index] -eq 0) {
            return $false
        }
    }
    try {
        $decoder = [Text.UTF8Encoding]::new($false, $true)
        [void]$decoder.GetString($Bytes)
        return $true
    }
    catch {
        return $false
    }
}

function ConvertTo-CloudDeployCanonicalTextBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    if (-not (Test-CloudDeployUtf8TextFile -Path $Path -Bytes $Bytes)) {
        return ,$Bytes
    }
    $stream = New-Object IO.MemoryStream
    try {
        for ($index = 0; $index -lt $Bytes.Length; $index++) {
            $byte = $Bytes[$index]
            if ($byte -eq 13) {
                # Treat CRLF and lone CR identically to LF.  This is deliberately
                # byte-level so valid UTF-8 content is otherwise untouched.
                [void]$stream.WriteByte(10)
                if ($index + 1 -lt $Bytes.Length -and $Bytes[$index + 1] -eq 10) {
                    $index++
                }
            }
            else {
                [void]$stream.WriteByte($byte)
            }
        }
        return ,$stream.ToArray()
    }
    finally {
        $stream.Dispose()
    }
}

function Get-CloudDeploySha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return (
            $sha.ComputeHash($Bytes) |
                ForEach-Object { $_.ToString("x2") }
        ) -join ""
    }
    finally {
        $sha.Dispose()
    }
}

function Get-CloudDeployFileDigest {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    $rawBytes = [IO.File]::ReadAllBytes($Path)
    $canonicalBytes = ConvertTo-CloudDeployCanonicalTextBytes `
        -Path $Path `
        -Bytes $rawBytes
    return [pscustomobject]@{
        # Length/Sha256 are the stable (LF-normalized for UTF-8 text) values
        # used by ApiFingerprint and source-change checks.
        Length = [int64]$canonicalBytes.Length
        Sha256 = Get-CloudDeploySha256Hex -Bytes $canonicalBytes
        RawLength = [int64]$rawBytes.Length
        RawSha256 = Get-CloudDeploySha256Hex -Bytes $rawBytes
    }
}

function Get-CloudDeploySourceSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectPath,
        [Parameter(Mandatory = $true)]
        [string]$ApiPath
    )

    $project = [IO.Path]::GetFullPath($ProjectPath)
    $api = [IO.Path]::GetFullPath($ApiPath).TrimEnd("\", "/")
    $head = (& git -C $project rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($head)) {
        throw "Unable to read Git HEAD for cloud deployment snapshot."
    }
    $entries = @()
    $files = Get-ChildItem -LiteralPath $api -Recurse -File |
        Where-Object {
            $_.FullName -notmatch '[\\/](?:node_modules|\.git)[\\/]'
        } |
        Sort-Object FullName
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($api.Length).TrimStart("\", "/")
        $digest = Get-CloudDeployFileDigest -Path $file.FullName
        $entries += [pscustomobject]@{
            Path = $relative.Replace("\", "/")
            Length = $digest.Length
            Sha256 = $digest.Sha256
            RawLength = $digest.RawLength
            RawSha256 = $digest.RawSha256
        }
    }
    $manifest = (
        $entries |
            ForEach-Object { "$($_.Path)`0$($_.Length)`0$($_.Sha256)" }
    ) -join "`n"
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($manifest)
        $fingerprint = (
            $sha.ComputeHash($bytes) |
                ForEach-Object { $_.ToString("x2") }
        ) -join ""
    }
    finally {
        $sha.Dispose()
    }
    return [pscustomobject]@{
        GitHead = $head
        Version = Get-CloudDeployVersion -ProjectPath $project
        ApiFingerprint = $fingerprint
        Files = @($entries)
    }
}

function Assert-CloudDeploySourceSnapshotStable {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Snapshot,
        [Parameter(Mandatory = $true)]
        [string]$ProjectPath,
        [Parameter(Mandatory = $true)]
        [string]$ApiPath,
        [string]$Stage = "deployment"
    )

    $current = Get-CloudDeploySourceSnapshot `
        -ProjectPath $ProjectPath `
        -ApiPath $ApiPath
    if ([string]$current.GitHead -ne [string]$Snapshot.GitHead) {
        throw "Cloud deployment source changed during $Stage`: Git HEAD changed."
    }
    if ([string]$current.Version -ne [string]$Snapshot.Version) {
        throw "Cloud deployment source changed during $Stage`: appVersion changed."
    }
    if ([string]$current.ApiFingerprint -eq [string]$Snapshot.ApiFingerprint) {
        return
    }
    $expectedFiles = @{}
    foreach ($file in @($Snapshot.Files)) {
        $expectedFiles[[string]$file.Path] = "$($file.Length):$($file.Sha256)"
    }
    $currentFiles = @{}
    foreach ($file in @($current.Files)) {
        $currentFiles[[string]$file.Path] = "$($file.Length):$($file.Sha256)"
    }
    $changed = @(
        @($expectedFiles.Keys + $currentFiles.Keys) |
            Select-Object -Unique |
            Where-Object {
                -not $expectedFiles.ContainsKey($_) -or
                -not $currentFiles.ContainsKey($_) -or
                $expectedFiles[$_] -ne $currentFiles[$_]
            } |
            Sort-Object
    )
    $summary = if ($changed.Count -gt 0) {
        ($changed | Select-Object -First 8) -join ", "
    }
    else {
        "unknown API source change"
    }
    throw "Cloud deployment source changed during $Stage`: $summary"
}

function Get-CloudBaseCliCommand {
    $command = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $command = Get-Command "npx" -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
        return ""
    }
    return [string]$command.Source
}

function Resolve-CloudDeployTransport {
    param(
        [ValidateSet("auto", "wechat", "cloudbase")]
        [string]$RequestedTransport = "auto",
        [string]$CloudBaseCliPath = "",
        [string]$WechatIdePath = "",
        [switch]$VerifyOnly,
        [switch]$ResumePendingDeploy
    )

    $requested = $RequestedTransport.ToLowerInvariant()
    if ($ResumePendingDeploy) {
        if ($requested -eq "cloudbase") {
            throw "-ResumePendingDeploy 只能恢复微信开发者工具的待确认任务，不能与 cloudbase 方式一起使用。"
        }
        if ([string]::IsNullOrWhiteSpace($WechatIdePath)) {
            throw "恢复微信待确认任务需要微信开发者工具 CLI。"
        }
        return "wechat"
    }
    if ($VerifyOnly) {
        if (-not [string]::IsNullOrWhiteSpace($CloudBaseCliPath)) {
            return "cloudbase"
        }
        if (-not [string]::IsNullOrWhiteSpace($WechatIdePath)) {
            return "wechat"
        }
        throw "线上只读核验需要可用的 CloudBase CLI 或微信开发者工具 CLI。"
    }

    if ($requested -eq "cloudbase") {
        if ([string]::IsNullOrWhiteSpace($CloudBaseCliPath)) {
            throw "已强制使用 CloudBase 直部署，但本机没有可用的 npx/CloudBase CLI。"
        }
        return "cloudbase"
    }
    if ($requested -eq "wechat") {
        if ([string]::IsNullOrWhiteSpace($WechatIdePath)) {
            throw "已强制使用微信开发者工具部署，但本机没有找到 wechatide CLI。"
        }
        return "wechat"
    }

    if (-not [string]::IsNullOrWhiteSpace($CloudBaseCliPath)) {
        return "cloudbase"
    }
    if (-not [string]::IsNullOrWhiteSpace($WechatIdePath)) {
        return "wechat"
    }
    throw "自动部署没有可用的 CloudBase CLI 或微信开发者工具 CLI。"
}

function Invoke-CloudBaseFunctionDeploy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvironmentId,
        [Parameter(Mandatory = $true)]
        [string]$FunctionName,
        [Parameter(Mandatory = $true)]
        [string]$ApiPath,
        [ValidateRange(1, 900)]
        [int]$TimeoutSeconds = 900,
        [string]$NpxPath = ""
    )

    $api = [IO.Path]::GetFullPath($ApiPath)
    if (-not (Test-Path -LiteralPath $api -PathType Container)) {
        throw "CloudBase 直部署目录不存在。"
    }
    $npx = if ([string]::IsNullOrWhiteSpace($NpxPath)) {
        Get-CloudBaseCliCommand
    }
    else {
        [IO.Path]::GetFullPath($NpxPath)
    }
    if ([string]::IsNullOrWhiteSpace($npx) -or -not (Test-Path -LiteralPath $npx -PathType Leaf)) {
        throw "CloudBase CLI 不可用，直部署尚未开始。"
    }

    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\", "/")
    $tempName = "wechat-miniapp-cloudbase-cli-" + [guid]::NewGuid().ToString("N")
    $tempRoot = Join-Path $tempParent $tempName
    if (
        [IO.Path]::GetDirectoryName($tempRoot).TrimEnd("\", "/") -ne $tempParent -or
        [IO.Path]::GetFileName($tempRoot) -notlike "wechat-miniapp-cloudbase-cli-*"
    ) {
        throw "CloudBase 直部署临时目录校验失败。"
    }

    try {
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        $cloudbaseConfig = [ordered]@{
            envId = $EnvironmentId
            functions = @(
                [ordered]@{
                    name = $FunctionName
                    timeout = $TimeoutSeconds
                }
            )
        } | ConvertTo-Json -Depth 5
        [IO.File]::WriteAllText(
            (Join-Path $tempRoot "cloudbaserc.json"),
            $cloudbaseConfig,
            [Text.UTF8Encoding]::new($false)
        )

        Push-Location $tempRoot
        try {
            $output = & $npx `
                -y `
                -p "@cloudbase/cli" `
                tcb `
                fn `
                deploy `
                $FunctionName `
                --dir $api `
                --force `
                --install-dependency true `
                --json 2>&1
            $exitCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        if ($exitCode -ne 0) {
            # CLI 原始输出可能带环境变量或其他敏感信息，绝不回显。
            throw "CloudBase 直部署失败，退出码：$exitCode。未自动切换到另一种部署方式。"
        }
        return [pscustomobject]@{
            Transport = "cloudbase"
            FunctionName = $FunctionName
            TimeoutSeconds = $TimeoutSeconds
        }
    }
    finally {
        if (
            (Test-Path -LiteralPath $tempRoot) -and
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($tempRoot)).TrimEnd("\", "/") -eq $tempParent -and
            [IO.Path]::GetFileName($tempRoot) -like "wechat-miniapp-cloudbase-cli-*"
        ) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-CloudBaseCliJson {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$NpxPath = ""
    )

    $npx = if ([string]::IsNullOrWhiteSpace($NpxPath)) {
        Get-CloudBaseCliCommand
    }
    else {
        [IO.Path]::GetFullPath($NpxPath)
    }
    if ([string]::IsNullOrWhiteSpace($npx) -or -not (Test-Path -LiteralPath $npx -PathType Leaf)) {
        throw "CloudBase CLI 不可用，无法执行只读核验。"
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $npx `
            -y `
            -p "@cloudbase/cli" `
            tcb `
            @Arguments `
            2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "CloudBase CLI 请求失败（原始输出已隐藏，防止环境变量或密钥泄露）。"
    }
    $text = ($output | Out-String).Trim()
    $jsonStart = $text.IndexOf("{")
    if ($jsonStart -lt 0) {
        throw "CloudBase CLI 没有返回可解析的 JSON（原始输出已隐藏）。"
    }
    try {
        return $text.Substring($jsonStart) | ConvertFrom-Json
    }
    catch {
        throw "CloudBase CLI 返回的 JSON 无法解析（原始输出已隐藏）。"
    }
}

function Invoke-CloudBaseFunctionJson {
    param(
        [Parameter(Mandatory = $true)][string]$EnvironmentId,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [Parameter(Mandatory = $true)][object]$Data,
        [string]$NpxPath = ""
    )

    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\", "/")
    $tempRoot = Join-Path $tempParent ("wechat-miniapp-cloudbase-invoke-" + [guid]::NewGuid().ToString("N"))
    if (
        [IO.Path]::GetDirectoryName($tempRoot).TrimEnd("\", "/") -ne $tempParent `
        -or [IO.Path]::GetFileName($tempRoot) -notlike "wechat-miniapp-cloudbase-invoke-*"
    ) {
        throw "CloudBase 运行核验临时目录校验失败。"
    }
    try {
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        $dataPath = Join-Path $tempRoot "request.json"
        $json = $Data | ConvertTo-Json -Depth 12 -Compress
        [IO.File]::WriteAllText($dataPath, $json, [Text.UTF8Encoding]::new($false))
        return Invoke-CloudBaseCliJson `
            -NpxPath $NpxPath `
            -Arguments @(
                "-e",
                $EnvironmentId,
                "fn",
                "invoke",
                $FunctionName,
                "-d",
                "@$dataPath",
                "--json"
            )
    }
    finally {
        if (
            (Test-Path -LiteralPath $tempRoot) `
            -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($tempRoot)).TrimEnd("\", "/") -eq $tempParent `
            -and [IO.Path]::GetFileName($tempRoot) -like "wechat-miniapp-cloudbase-invoke-*"
        ) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-CloudBaseFunctionDetail {
    param(
        [Parameter(Mandatory = $true)][string]$EnvironmentId,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [string]$NpxPath = ""
    )

    $response = Invoke-CloudBaseCliJson `
        -NpxPath $NpxPath `
        -Arguments @(
            "-e",
            $EnvironmentId,
            "fn",
            "detail",
            $FunctionName,
            "--json"
        )
    $dataProperty = $response.PSObject.Properties["data"]
    if ($null -ne $dataProperty -and $null -ne $dataProperty.Value) {
        return $dataProperty.Value
    }
    return $response
}

function Get-CloudBaseFunctionSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$EnvironmentId,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [string]$NpxPath = ""
    )

    $data = Get-CloudBaseFunctionDetail `
        -EnvironmentId $EnvironmentId `
        -FunctionName $FunctionName `
        -NpxPath $NpxPath
    $codeInfoProperty = $data.PSObject.Properties["CodeInfo"]
    if ($null -eq $codeInfoProperty) {
        $codeInfoProperty = $data.PSObject.Properties["codeInfo"]
    }
    $codeInfo = if ($null -ne $codeInfoProperty) {
        [string]$codeInfoProperty.Value
    }
    else {
        ""
    }
    $versionMatch = [regex]::Match(
        $codeInfo,
        'const API_BUILD_VERSION = "([^"]+)"'
    )
    $markerMatch = [regex]::Match(
        $codeInfo,
        'const API_BUILD_MARKER = "([^"]+)"'
    )
    $modeMatch = [regex]::Match(
        $codeInfo,
        'const DEFAULT_IMAGE_MODE = "([^"]+)"'
    )
    $statusProperty = $data.PSObject.Properties["Status"]
    if ($null -eq $statusProperty) {
        $statusProperty = $data.PSObject.Properties["status"]
    }
    $timeoutProperty = $data.PSObject.Properties["Timeout"]
    if ($null -eq $timeoutProperty) {
        $timeoutProperty = $data.PSObject.Properties["timeout"]
    }
    return [pscustomobject]@{
        Status = if ($null -ne $statusProperty) { [string]$statusProperty.Value } else { "" }
        Timeout = if ($null -ne $timeoutProperty) { [int]$timeoutProperty.Value } else { 0 }
        BuildVersion = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { "" }
        BuildMarker = if ($markerMatch.Success) { $markerMatch.Groups[1].Value } else { "" }
        ImageMode = if ($modeMatch.Success) { $modeMatch.Groups[1].Value } else { "" }
    }
}

function Repair-CloudBaseFunctionTimeout {
    param(
        [Parameter(Mandatory = $true)][string]$EnvironmentId,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [ValidateRange(1, 900)][int]$TimeoutSeconds = 900,
        [string]$NpxPath = ""
    )

    $response = Invoke-CloudBaseCliJson `
        -NpxPath $NpxPath `
        -Arguments @(
            "-e",
            $EnvironmentId,
            "config",
            "update",
            "fn",
            $FunctionName,
            "--timeout",
            [string]$TimeoutSeconds,
            "--json"
        )
    if ($null -eq $response) {
        throw "CloudBase 超时修正没有返回结果。[CLOUDBASE_TIMEOUT_REPAIR_FAILED]"
    }
    Write-Host "CloudBase 已请求把云函数超时修正为 $TimeoutSeconds 秒。"
}

function Wait-CloudBaseFunctionReady {
    param(
        [Parameter(Mandatory = $true)][string]$EnvironmentId,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [string]$NpxPath = "",
        [ValidateRange(1, 60)][int]$Attempts = 30,
        [ValidateRange(0, 60)][int]$DelaySeconds = 2
    )

    $lastStatus = ""
    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        $detail = Get-CloudBaseFunctionDetail `
            -EnvironmentId $EnvironmentId `
            -FunctionName $FunctionName `
            -NpxPath $NpxPath
        $statusProperty = $detail.PSObject.Properties["Status"]
        $status = if ($null -ne $statusProperty) {
            [string]$statusProperty.Value
        }
        else {
            ""
        }
        if ($status -ne $lastStatus) {
            Write-Host "CloudBase 云函数状态：$status"
            $lastStatus = $status
        }
        if ($status -eq "Active") {
            return
        }
        if ($status -match "Failed|Error") {
            throw "CloudBase 云函数进入失败状态：$status"
        }
        if ($attempt -lt $Attempts -and $DelaySeconds -gt 0) {
            Start-Sleep -Seconds $DelaySeconds
        }
    }
    throw "CloudBase 云函数未在限定时间内恢复 Active。最后状态：$lastStatus"
}

function Get-CloudBaseFunctionInvokePayload {
    param([Parameter(Mandatory = $true)][object]$Response)

    $current = $Response
    for ($index = 0; $index -lt 8; $index += 1) {
        if ($null -eq $current) {
            return $null
        }
        $retMsgProperty = $current.PSObject.Properties["RetMsg"]
        if ($null -eq $retMsgProperty) {
            $retMsgProperty = $current.PSObject.Properties["retMsg"]
        }
        if (
            $null -ne $retMsgProperty `
            -and $retMsgProperty.Value -is [string]
        ) {
            $retMsg = ([string]$retMsgProperty.Value).Trim()
            if ($retMsg.StartsWith("{") -or $retMsg.StartsWith("[")) {
                try {
                    return $retMsg | ConvertFrom-Json
                }
                catch {
                    # 保留原对象，让上层断言给出统一的结构错误。
                }
            }
        }
        if (
            $null -ne $current.PSObject.Properties["buildVersion"] `
            -or $null -ne $current.PSObject.Properties["active"] `
            -or $null -ne $current.PSObject.Properties["dependencies"]
        ) {
            return $current
        }
        $next = $null
        foreach ($name in @("result", "Result", "data", "Data", "response", "Response")) {
            $property = $current.PSObject.Properties[$name]
            if ($null -ne $property -and $null -ne $property.Value) {
                $next = $property.Value
                break
            }
        }
        if ($null -eq $next) {
            return $current
        }
        $current = $next
    }
    return $current
}

function Get-CloudBaseRuntimeHealth {
    param(
        [Parameter(Mandatory = $true)][string]$EnvironmentId,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [string]$NpxPath = ""
    )

    $response = Invoke-CloudBaseFunctionJson `
        -EnvironmentId $EnvironmentId `
        -FunctionName $FunctionName `
        -Data ([ordered]@{
            action = "checkRuntimeHealth"
            readOnly = $true
            requestId = "cloudbase-runtime-health-" + [guid]::NewGuid().ToString("N")
        }) `
        -NpxPath $NpxPath
    return Get-CloudBaseFunctionInvokePayload -Response $response
}

function Assert-CloudBaseRuntimeHealth {
    param(
        [Parameter(Mandatory = $true)][object]$Health,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [string]$ExpectedMarker = ""
    )

    if ($null -eq $Health) {
        throw "CloudBase 运行健康返回结构为空。[CLOUDBASE_RUNTIME_RESPONSE_INVALID]"
    }
    if ([bool]$Health.ok -eq $false) {
        $errorCode = [string]$Health.errorCode
        if ([string]::IsNullOrWhiteSpace($errorCode)) {
            $errorCode = "CLOUDBASE_RUNTIME_REPORTED_FAILURE"
        }
        throw "CloudBase 运行健康失败：$errorCode"
    }
    if (-not [bool]$Health.active) {
        throw "CloudBase 运行健康失败：实例未确认 Active。[CLOUDBASE_RUNTIME_INACTIVE]"
    }
    if (-not [bool]$Health.readOnly) {
        throw "CloudBase 运行健康失败：返回结果未标记为只读。[CLOUDBASE_RUNTIME_NOT_READONLY]"
    }
    if ([string]$Health.buildVersion -ne $ExpectedVersion) {
        throw "CloudBase 运行健康版本不一致。[CLOUDBASE_RUNTIME_VERSION_MISMATCH]"
    }
    if (
        $ExpectedMarker `
        -and [string]$Health.buildMarker -ne $ExpectedMarker
    ) {
        throw "CloudBase 运行健康构建标记不一致。[CLOUDBASE_RUNTIME_MARKER_MISMATCH]"
    }
    $dependencies = $Health.PSObject.Properties["dependencies"]
    if ($null -eq $dependencies -or $null -eq $dependencies.Value) {
        throw "CloudBase 运行健康缺少依赖结果。[CLOUDBASE_RUNTIME_RESPONSE_INVALID]"
    }
    if (-not [bool]$dependencies.Value.healthy) {
        throw "CloudBase 运行依赖异常。[CLOUDBASE_RUNTIME_DEPENDENCY_UNHEALTHY]"
    }
    if ([string]::IsNullOrWhiteSpace([string]$Health.checkedAt)) {
        throw "CloudBase 运行健康缺少检查时间。[CLOUDBASE_RUNTIME_RESPONSE_INVALID]"
    }
}

function Get-CloudBaseFunctionVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvironmentId,
        [Parameter(Mandatory = $true)]
        [string]$FunctionName,
        [string]$NpxPath = ""
    )

    $npx = if ([string]::IsNullOrWhiteSpace($NpxPath)) {
        Get-CloudBaseCliCommand
    }
    else {
        [IO.Path]::GetFullPath($NpxPath)
    }
    if ([string]::IsNullOrWhiteSpace($npx) -or -not (Test-Path -LiteralPath $npx -PathType Leaf)) {
        throw "CloudBase CLI 不可用，无法读取线上版本。"
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $npx `
            -y `
            -p "@cloudbase/cli" `
            tcb `
            fn `
            detail `
            $FunctionName `
            -e $EnvironmentId `
            --json 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "读取线上云函数版本失败，已阻止部署。"
    }
    $text = ($output | Out-String).Trim()
    $jsonStart = $text.IndexOf("{")
    if ($jsonStart -lt 0) {
        throw "线上云函数没有返回可解析的版本信息，已阻止部署。"
    }
    try {
        $response = $text.Substring($jsonStart) | ConvertFrom-Json
    }
    catch {
        throw "线上云函数版本信息无法解析，已阻止部署。"
    }
    $dataProperty = $response.PSObject.Properties["data"]
    $data = if ($null -ne $dataProperty -and $null -ne $dataProperty.Value) {
        $dataProperty.Value
    }
    else {
        $response
    }
    $codeInfoProperty = $data.PSObject.Properties["CodeInfo"]
    $codeInfo = if ($null -ne $codeInfoProperty) {
        [string]$codeInfoProperty.Value
    }
    else {
        ""
    }
    $versionMatch = [regex]::Match(
        $codeInfo,
        'const API_BUILD_VERSION = "([^"]+)"'
    )
    if (-not $versionMatch.Success) {
        throw "线上云函数源码没有返回合法版本号，已阻止部署。"
    }
    return $versionMatch.Groups[1].Value
}
