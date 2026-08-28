Set-StrictMode -Version Latest

function ConvertTo-ReleaseUtcDateTime {
    param([Parameter(Mandatory = $true)][object]$Value)

    if ($Value -is [DateTimeOffset]) {
        return $Value.UtcDateTime
    }
    if ($Value -is [DateTime]) {
        if ($Value.Kind -eq [DateTimeKind]::Utc) {
            return $Value
        }
        if ($Value.Kind -eq [DateTimeKind]::Local) {
            return $Value.ToUniversalTime()
        }
        return [DateTime]::SpecifyKind($Value, [DateTimeKind]::Utc)
    }

    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "时间值为空。"
    }
    try {
        return ([DateTimeOffset]::Parse(
            $text,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )).UtcDateTime
    }
    catch {
        throw "时间值无效：$text。$($_.Exception.Message)"
    }
}

function Get-ReleaseLockPaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectPath,
        [string]$LockPath = ""
    )

    $project = [IO.Path]::GetFullPath($ProjectPath)
    if (-not (Test-Path -LiteralPath $project -PathType Container)) {
        throw "发布锁项目目录不存在：$project"
    }
    if ([string]::IsNullOrWhiteSpace($LockPath)) {
        # 开发仓库和发布 clone 共用父目录，因此默认锁不能按项目目录命名。
        $parent = Split-Path $project -Parent
        $LockPath = Join-Path $parent "wechat-miniapp-release.lock"
    }
    $resolvedLockPath = [IO.Path]::GetFullPath($LockPath)
    return [pscustomobject]@{
        LockPath = $resolvedLockPath
        OwnerPath = "$resolvedLockPath.owner.json"
        PendingPath = "$resolvedLockPath.pending.json"
    }
}

function Read-ReleaseLockOwner {
    param([Parameter(Mandatory = $true)][string]$OwnerPath)

    if (-not (Test-Path -LiteralPath $OwnerPath -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $OwnerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Read-ReleasePending {
    param([Parameter(Mandatory = $true)][string]$PendingPath)

    if (-not (Test-Path -LiteralPath $PendingPath -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $PendingPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "发布 pending 记录无效：$PendingPath"
    }
}

function Write-ReleasePending {
    param(
        [Parameter(Mandatory = $true)][string]$PendingPath,
        [Parameter(Mandatory = $true)][object]$Record
    )

    $parent = Split-Path ([IO.Path]::GetFullPath($PendingPath)) -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $json = $Record | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($PendingPath, $json, [Text.UTF8Encoding]::new($false))
}

function Remove-ReleasePending {
    param([Parameter(Mandatory = $true)][string]$PendingPath)

    Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
}

function Enter-ReleaseLock {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectPath,
        [Parameter(Mandatory = $true)][string]$TargetVersion,
        [Parameter(Mandatory = $true)][string]$TargetType,
        # Release gate callers queue for up to 30 minutes by default.  Keep a
        # generous upper bound so a long-running package/deploy can share the
        # same lock without silently falling back to a bypass.
        [ValidateRange(1, 7200)][int]$WaitSeconds = 60,
        [string]$LockPath = "",
        [string]$ProjectId = ""
    )

    $paths = Get-ReleaseLockPaths -ProjectPath $ProjectPath -LockPath $LockPath
    $lockDirectory = Split-Path $paths.LockPath -Parent
    if (-not (Test-Path -LiteralPath $lockDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $lockDirectory -Force | Out-Null
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
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
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($head)) {
                $head = "<unavailable>"
            }
            $owner = [ordered]@{
                pid = $PID
                startedAt = [DateTime]::UtcNow.ToString("o")
                gitHead = $head
                targetVersion = $TargetVersion
                targetType = $TargetType
                projectId = if ([string]::IsNullOrWhiteSpace($ProjectId)) {
                    Split-Path ([IO.Path]::GetFullPath($ProjectPath)) -Leaf
                } else {
                    $ProjectId
                }
            }
            $ownerJson = $owner | ConvertTo-Json -Depth 5
            $ownerBytes = [Text.UTF8Encoding]::new($false).GetBytes($ownerJson)
            $stream.SetLength(0)
            $stream.Write($ownerBytes, 0, $ownerBytes.Length)
            $stream.Flush()
            [IO.File]::WriteAllText($paths.OwnerPath, $ownerJson, [Text.UTF8Encoding]::new($false))
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
            $owner = Read-ReleaseLockOwner -OwnerPath $paths.OwnerPath
            if ([DateTime]::UtcNow -ge $deadline) {
                $summary = if ($null -ne $owner) {
                    "PID=$($owner.pid)，开始=$($owner.startedAt)，类型=$($owner.targetType)，版本=$($owner.targetVersion)"
                } else {
                    "占用者信息不可用"
                }
                throw "Cloud deployment lock timed out / 发布锁等待超时（${WaitSeconds}秒）。当前占用者：$summary"
            }
            Start-Sleep -Milliseconds 250
        }
        catch {
            if ($null -ne $stream) {
                $stream.Dispose()
            }
            throw
        }
    }
}

function Update-ReleaseLockOwner {
    param(
        [Parameter(Mandatory = $true)][object]$LockHandle,
        [Parameter(Mandatory = $true)][string]$TargetVersion
    )

    $owner = [ordered]@{}
    foreach ($property in $LockHandle.Owner.PSObject.Properties) {
        $owner[$property.Name] = $property.Value
    }
    $owner.targetVersion = $TargetVersion
    $json = $owner | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($LockHandle.OwnerPath, $json, [Text.UTF8Encoding]::new($false))
    $LockHandle.Owner = [pscustomobject]$owner
}

function Exit-ReleaseLock {
    param([object]$LockHandle)

    if ($null -eq $LockHandle) {
        return
    }
    try {
        $owner = Read-ReleaseLockOwner -OwnerPath $LockHandle.OwnerPath
        if ($null -eq $owner -or [int]$owner.pid -eq $PID) {
            Remove-Item -LiteralPath $LockHandle.OwnerPath -Force -ErrorAction SilentlyContinue
        }
    }
    finally {
        if ($null -ne $LockHandle.Stream) {
            $LockHandle.Stream.Dispose()
        }
    }
}
