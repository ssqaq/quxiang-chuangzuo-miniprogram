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
        # An offset-less timestamp produced by older releases is a UTC clock
        # value (DateTime.UtcNow.ToString("o")), not local wall time.  Assume
        # UTC for that legacy shape so stale-lock checks do not shift by the
        # machine timezone.
        $styles = [Globalization.DateTimeStyles]::RoundtripKind
        if ($text -notmatch '(?:Z|[+-]\d{2}:?\d{2})$') {
            $styles = $styles -bor [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        }
        return ([DateTimeOffset]::Parse(
            $text,
            [Globalization.CultureInfo]::InvariantCulture,
            $styles
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

function Get-ReleaseProcessStartUtc {
    param([int]$ProcessId)

    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        return ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToString("o")
    }
    catch {
        return ""
    }
}

function Test-ReleaseLockOwnerStale {
    param(
        [Parameter(Mandatory = $true)][object]$Owner,
        [ValidateRange(5, 86400)][int]$StaleAfterSeconds = 600
    )

    $heartbeatValue = if ($Owner.PSObject.Properties["lastHeartbeat"]) {
        $Owner.lastHeartbeat
    }
    else {
        $Owner.startedAt
    }
    try {
        $heartbeat = ConvertTo-ReleaseUtcDateTime -Value $heartbeatValue
    }
    catch {
        return $true
    }
    if (([DateTime]::UtcNow - $heartbeat).TotalSeconds -le $StaleAfterSeconds) {
        return $false
    }

    # A stale sidecar is not enough to take over a live process.  If the PID is
    # still alive and its start time matches the recorded process, leave it
    # alone; the OS file handle remains the final arbiter for ownership.
    $pidValue = 0
    try { $pidValue = [int]$Owner.pid } catch { return $true }
    if ($pidValue -le 0) { return $true }
    $actualStart = Get-ReleaseProcessStartUtc -ProcessId $pidValue
    $recordedStart = if ($Owner.PSObject.Properties["processStartUtc"]) { $Owner.processStartUtc } else { "" }
    if (-not [string]::IsNullOrWhiteSpace($actualStart) -and
        -not [string]::IsNullOrWhiteSpace($recordedStart)) {
        try {
            $delta = (ConvertTo-ReleaseUtcDateTime -Value $actualStart) - (ConvertTo-ReleaseUtcDateTime -Value $recordedStart)
            $delta = $delta.TotalSeconds
            if ([Math]::Abs($delta) -lt 2) { return $false }
        }
        catch { }
    }
    return [string]::IsNullOrWhiteSpace($actualStart)
}

function Start-ReleaseLockHeartbeat {
    param(
        [Parameter(Mandatory = $true)][object]$LockHandle,
        [ValidateRange(5, 900)][int]$IntervalSeconds = 30
    )

    if ($null -ne $LockHandle.HeartbeatTimer) { return $LockHandle }
    $ownerPath = [string]$LockHandle.OwnerPath
    $ownerPid = $PID
    $timer = New-Object System.Timers.Timer
    $timer.Interval = $IntervalSeconds * 1000
    $timer.AutoReset = $true
    $subscription = Register-ObjectEvent -InputObject $timer -EventName Elapsed -Action {
        try {
            if (-not (Test-Path -LiteralPath $using:ownerPath -PathType Leaf)) { return }
            $owner = Get-Content -LiteralPath $using:ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([int]$owner.pid -ne $using:ownerPid) { return }
            $hash = [ordered]@{}
            foreach ($property in $owner.PSObject.Properties) { $hash[$property.Name] = $property.Value }
            $hash.lastHeartbeat = [DateTimeOffset]::UtcNow.ToString("o")
            $temp = "$using:ownerPath.$using:ownerPid.heartbeat.tmp"
            [IO.File]::WriteAllText($temp, ($hash | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temp -Destination $using:ownerPath -Force
        }
        catch {
            # Heartbeat is best effort; the exclusive OS handle still protects
            # the critical section and the next invocation can recover context.
        }
    }
    $LockHandle.HeartbeatTimer = $timer
    $LockHandle.HeartbeatSubscription = $subscription
    $timer.Start()
    return $LockHandle
}

function Stop-ReleaseLockHeartbeat {
    param([object]$LockHandle)

    if ($null -eq $LockHandle) { return }
    try {
        if ($null -ne $LockHandle.HeartbeatSubscription) {
            Unregister-Event -SubscriptionId $LockHandle.HeartbeatSubscription.Id -ErrorAction SilentlyContinue
            # Register-ObjectEvent exposes the subscription's action as a
            # scriptblock, not a job id.  Unregistering the subscription is
            # sufficient; remove only the actual event job when PowerShell
            # provides one.
            $eventJob = Get-Job -Name $LockHandle.HeartbeatSubscription.Name -ErrorAction SilentlyContinue
            if ($null -ne $eventJob) { Remove-Job -Job $eventJob -Force -ErrorAction SilentlyContinue }
        }
    }
    catch { }
    try {
        if ($null -ne $LockHandle.HeartbeatTimer) {
            $LockHandle.HeartbeatTimer.Stop()
            $LockHandle.HeartbeatTimer.Dispose()
        }
    }
    catch { }
    $LockHandle.HeartbeatTimer = $null
    $LockHandle.HeartbeatSubscription = $null
}

function Assert-ReleaseLockOwned {
    param(
        [Parameter(Mandatory = $true)][object]$LockHandle,
        [string]$Stage = ""
    )

    if ($null -eq $LockHandle.Stream) { throw "发布锁句柄已失效。" }
    $owner = Read-ReleaseLockOwner -OwnerPath ([string]$LockHandle.OwnerPath)
    if ($null -eq $owner -or [int]$owner.pid -ne $PID) {
        $suffix = if ([string]::IsNullOrWhiteSpace($Stage)) { "" } else { "（阶段：$Stage）" }
        throw "发布锁所有权丢失$suffix，已停止后续写入。"
    }
    return $true
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
        [string]$ProjectId = "",
        [ValidateRange(5, 86400)][int]$LeaseSeconds = 180,
        [string]$Stage = "queue"
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
                handoffToken = [guid]::NewGuid().ToString("N")
                startedAt = [DateTimeOffset]::UtcNow.ToString("o")
                processStartUtc = Get-ReleaseProcessStartUtc -ProcessId $PID
                host = [Environment]::MachineName
                gitHead = $head
                targetVersion = $TargetVersion
                targetType = $TargetType
                operationId = $ProjectId
                stage = $Stage
                leaseSeconds = $LeaseSeconds
                lastHeartbeat = [DateTimeOffset]::UtcNow.ToString("o")
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
            $handle = [pscustomobject]@{
                Stream = $stream
                LockPath = $paths.LockPath
                OwnerPath = $paths.OwnerPath
                PendingPath = $paths.PendingPath
                Owner = [pscustomobject]$owner
                LeaseSeconds = $LeaseSeconds
                HeartbeatTimer = $null
                HeartbeatSubscription = $null
            }
            Start-ReleaseLockHeartbeat -LockHandle $handle -IntervalSeconds ([Math]::Max(5, [Math]::Min(60, [int]($LeaseSeconds / 3)))) | Out-Null
            return $handle
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
        [Parameter(Mandatory = $true)][string]$TargetVersion,
        [string]$Stage = ""
    )

    Assert-ReleaseLockOwned -LockHandle $LockHandle -Stage $Stage | Out-Null
    $owner = [ordered]@{}
    foreach ($property in $LockHandle.Owner.PSObject.Properties) {
        $owner[$property.Name] = $property.Value
    }
    $owner.targetVersion = $TargetVersion
    if (-not [string]::IsNullOrWhiteSpace($Stage)) { $owner.stage = $Stage }
    $owner.lastHeartbeat = [DateTimeOffset]::UtcNow.ToString("o")
    $json = $owner | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($LockHandle.OwnerPath, $json, [Text.UTF8Encoding]::new($false))
    $LockHandle.Owner = [pscustomobject]$owner
}

function Assert-ReleaseLockHandoff {
    <#
      A child process may use the parent's already-held OS lock only when the
      parent explicitly hands it the one-time token stored in the owner sidecar.
      The old boolean switch was trust-only and allowed an unrelated process to
      claim that the outer lock existed.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$LockPath,
        [Parameter(Mandatory = $true)][string]$HandoffToken,
        [string]$OperationId = ""
    )
    if ([string]::IsNullOrWhiteSpace($HandoffToken)) {
        throw "缺少发布锁交接 token，拒绝复用外层锁。"
    }
    $paths = Get-ReleaseLockPaths -ProjectPath (Split-Path ([IO.Path]::GetFullPath($LockPath)) -Parent) -LockPath $LockPath
    $owner = Read-ReleaseLockOwner -OwnerPath $paths.OwnerPath
    if ($null -eq $owner) { throw "找不到发布锁 owner，拒绝复用外层锁。" }
    $ownerToken = if ($owner.PSObject.Properties["handoffToken"]) { [string]$owner.handoffToken } else { "" }
    if ([string]::IsNullOrWhiteSpace($ownerToken) -or
        -not [string]::Equals($ownerToken, $HandoffToken, [StringComparison]::Ordinal)) {
        throw "发布锁交接 token 不匹配，拒绝复用外层锁。"
    }
    if (-not [string]::IsNullOrWhiteSpace($OperationId) -and
        [string]$owner.operationId -ne $OperationId) {
        throw "发布锁 owner operationId 与 release context 不一致，拒绝复用外层锁。"
    }
    if (-not (Test-Path -LiteralPath $paths.LockPath -PathType Leaf)) {
        throw "发布锁文件不存在，拒绝复用外层锁。"
    }
    return $owner
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
        Stop-ReleaseLockHeartbeat -LockHandle $LockHandle
        if ($null -ne $LockHandle.Stream) {
            $LockHandle.Stream.Dispose()
        }
    }
}
