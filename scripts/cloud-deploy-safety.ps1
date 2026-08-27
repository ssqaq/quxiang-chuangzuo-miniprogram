Set-StrictMode -Version Latest

function Get-CloudDeployLockPaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectPath,
        [string]$LockPath = ""
    )

    $project = [IO.Path]::GetFullPath($ProjectPath)
    if ([string]::IsNullOrWhiteSpace($LockPath)) {
        $parent = Split-Path $project -Parent
        $name = Split-Path $project -Leaf
        $LockPath = Join-Path $parent "$name-cloud-deploy.lock"
    }
    $resolvedLockPath = [IO.Path]::GetFullPath($LockPath)
    return [pscustomobject]@{
        LockPath = $resolvedLockPath
        OwnerPath = "$resolvedLockPath.owner.json"
        PendingPath = "$resolvedLockPath.pending.json"
    }
}

function Read-CloudDeployOwner {
    param([Parameter(Mandatory = $true)][string]$OwnerPath)

    if (-not (Test-Path -LiteralPath $OwnerPath -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $OwnerPath -Raw -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Read-CloudDeployPending {
    param([Parameter(Mandatory = $true)][string]$PendingPath)

    if (-not (Test-Path -LiteralPath $PendingPath -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $PendingPath -Raw -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        throw "Cloud deployment pending record is invalid: $PendingPath"
    }
}

function Write-CloudDeployPending {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PendingPath,
        [Parameter(Mandatory = $true)]
        [object]$Record
    )

    $json = $Record | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText(
        $PendingPath,
        $json,
        [Text.UTF8Encoding]::new($false)
    )
}

function Remove-CloudDeployPending {
    param([Parameter(Mandatory = $true)][string]$PendingPath)

    Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
}

function Enter-CloudDeployLock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectPath,
        [Parameter(Mandatory = $true)]
        [string]$TargetVersion,
        [Parameter(Mandatory = $true)]
        [string]$FunctionName,
        [ValidateRange(1, 300)]
        [int]$WaitSeconds = 60,
        [string]$LockPath = ""
    )

    $paths = Get-CloudDeployLockPaths `
        -ProjectPath $ProjectPath `
        -LockPath $LockPath
    $lockDirectory = Split-Path $paths.LockPath -Parent
    if (-not (Test-Path -LiteralPath $lockDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $lockDirectory -Force | Out-Null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $lastOwner = $null
    while ($true) {
        $stream = $null
        try {
            $stream = [IO.File]::Open(
                $paths.LockPath,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None
            )
            $head = (& git -C $ProjectPath rev-parse HEAD 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                $head = "<unavailable>"
            }
            $owner = [ordered]@{
                pid = $PID
                startedAt = [DateTime]::UtcNow.ToString("o")
                gitHead = $head
                targetVersion = $TargetVersion
                functionName = $FunctionName
                projectPath = [IO.Path]::GetFullPath($ProjectPath)
            }
            $ownerJson = $owner | ConvertTo-Json -Depth 4
            $ownerBytes = [Text.UTF8Encoding]::new($false).GetBytes($ownerJson)
            $stream.SetLength(0)
            $stream.Write($ownerBytes, 0, $ownerBytes.Length)
            $stream.Flush()
            [IO.File]::WriteAllText(
                $paths.OwnerPath,
                $ownerJson,
                [Text.UTF8Encoding]::new($false)
            )
            return [pscustomobject]@{
                Stream = $stream
                LockPath = $paths.LockPath
                OwnerPath = $paths.OwnerPath
                PendingPath = $paths.PendingPath
                Owner = [pscustomobject]$owner
            }
        }
        catch [IO.IOException] {
            if ($null -ne $stream) {
                $stream.Dispose()
            }
            $lastOwner = Read-CloudDeployOwner -OwnerPath $paths.OwnerPath
            if ([DateTime]::UtcNow -ge $deadline) {
                $summary = if ($null -ne $lastOwner) {
                    "PID=$($lastOwner.pid), startedAt=$($lastOwner.startedAt), version=$($lastOwner.targetVersion)"
                }
                else {
                    "owner details unavailable"
                }
                throw "Cloud deployment lock timed out after $WaitSeconds seconds. Current owner: $summary"
            }
            Start-Sleep -Seconds 1
        }
        catch {
            if ($null -ne $stream) {
                $stream.Dispose()
            }
            throw
        }
    }
}

function Exit-CloudDeployLock {
    param([object]$LockHandle)

    if ($null -eq $LockHandle) {
        return
    }
    try {
        $owner = Read-CloudDeployOwner -OwnerPath $LockHandle.OwnerPath
        if ($null -eq $owner -or [int]$owner.pid -eq $PID) {
            Remove-Item -LiteralPath $LockHandle.OwnerPath -Force -ErrorAction SilentlyContinue
        }
    }
    finally {
        if ($null -ne $LockHandle.Stream) {
            $LockHandle.Stream.Dispose()
        }
        Remove-Item -LiteralPath $LockHandle.LockPath -Force -ErrorAction SilentlyContinue
    }
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
        $entries += [pscustomobject]@{
            Path = $relative.Replace("\", "/")
            Length = [int64]$file.Length
            Sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
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
        if ([string]::IsNullOrWhiteSpace($WechatIdePath)) {
            throw "线上核验需要微信开发者工具 CLI。"
        }
        return "wechat"
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
