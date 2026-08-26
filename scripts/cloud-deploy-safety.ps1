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
