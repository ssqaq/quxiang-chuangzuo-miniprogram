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

function Get-ReleaseLockOwnerMutexName {
    <#
      The OS lock protects the release critical section, but the owner sidecar
      is written by both the foreground phase updater and the timer callback.
      Use a deterministic named mutex for that small metadata file so a
      heartbeat cannot write an older snapshot over a newer stage/version.
    #>
    param([Parameter(Mandatory = $true)][string]$OwnerPath)
    $full = [IO.Path]::GetFullPath($OwnerPath)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($full)
        return "Global\wechat-miniapp-release-owner-" + (([BitConverter]::ToString($hash.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant())
    }
    finally { $hash.Dispose() }
}

function Enter-ReleaseLockOwnerGuard {
    param(
        [Parameter(Mandatory = $true)][string]$OwnerPath,
        [ValidateRange(1, 120)][int]$WaitSeconds = 15
    )
    $mutex = $null
    $owns = $false
    try {
        $mutex = [Threading.Mutex]::new($false, (Get-ReleaseLockOwnerMutexName -OwnerPath $OwnerPath))
        try {
            $owns = $mutex.WaitOne([TimeSpan]::FromSeconds($WaitSeconds))
        }
        catch [Threading.AbandonedMutexException] {
            # The owner writer died while holding the metadata mutex.  The OS
            # transferred ownership to this process, so it is safe to continue.
            $owns = $true
        }
        if (-not $owns) { throw "等待发布锁 owner 元数据写入锁超时：$OwnerPath" }
        return [pscustomobject]@{ Mutex = $mutex; Owns = $true }
    }
    catch {
        if ($null -ne $mutex) {
            try { if ($owns) { $mutex.ReleaseMutex() } } catch {}
            try { $mutex.Dispose() } catch {}
        }
        throw
    }
}

function Exit-ReleaseLockOwnerGuard {
    param([AllowNull()][object]$Guard)
    if ($null -eq $Guard) { return }
    try {
        if ($Guard.Owns -and $null -ne $Guard.Mutex) { $Guard.Mutex.ReleaseMutex() }
    }
    catch { }
    finally {
        try { if ($null -ne $Guard.Mutex) { $Guard.Mutex.Dispose() } } catch { }
    }
}

function Write-ReleaseLockOwnerAtomicInternal {
    <# Caller must hold Enter-ReleaseLockOwnerGuard. #>
    param(
        [Parameter(Mandatory = $true)][string]$OwnerPath,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $full = [IO.Path]::GetFullPath($OwnerPath)
    $parent = Split-Path $full -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $temp = "$full.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $backup = "$full.$PID.$([guid]::NewGuid().ToString('N')).replace.bak"
    try {
        $json = $Value | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            try {
                # Replace is atomic on the NTFS volume used by the release
                # workspace and never exposes a truncated owner JSON.
                [IO.File]::Replace($temp, $full, $backup, $true)
            }
            catch [PlatformNotSupportedException] {
                # PowerShell 7/.NET Core has the overwrite Move overload.  It
                # is still performed while the named mutex is held.
                [IO.File]::Move($temp, $full, $true)
            }
            catch [NotSupportedException] {
                [IO.File]::Move($temp, $full, $true)
            }
        }
        else {
            [IO.File]::Move($temp, $full)
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

function Write-ReleaseLockOwnerAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$OwnerPath,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $guard = Enter-ReleaseLockOwnerGuard -OwnerPath $OwnerPath
    try { Write-ReleaseLockOwnerAtomicInternal -OwnerPath $OwnerPath -Value $Value }
    finally { Exit-ReleaseLockOwnerGuard -Guard $guard }
}

function Update-ReleaseLockHeartbeat {
    param(
        [Parameter(Mandatory = $true)][string]$OwnerPath,
        [Parameter(Mandatory = $true)][int]$OwnerPid
    )
    $guard = $null
    try {
        $guard = Enter-ReleaseLockOwnerGuard -OwnerPath $OwnerPath
        # Read only after taking the guard.  Otherwise a heartbeat can capture
        # an old stage and write it after Update-ReleaseLockOwner advances it.
        $owner = Read-ReleaseLockOwner -OwnerPath $OwnerPath
        if ($null -eq $owner -or [int]$owner.pid -ne $OwnerPid) { return }
        $hash = [ordered]@{}
        foreach ($property in $owner.PSObject.Properties) { $hash[$property.Name] = $property.Value }
        $hash.lastHeartbeat = [DateTimeOffset]::UtcNow.ToString("o")
        Write-ReleaseLockOwnerAtomicInternal -OwnerPath $OwnerPath -Value $hash
    }
    finally { Exit-ReleaseLockOwnerGuard -Guard $guard }
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
    # Register-ObjectEvent actions execute in an event-job scope.  `$using:`
    # variables are not supported there (they are for remoting/jobs), so pass
    # the two immutable values explicitly through MessageData.
    $heartbeatMessage = [pscustomobject]@{ OwnerPath = $ownerPath; OwnerPid = $ownerPid }
    $subscription = Register-ObjectEvent -InputObject $timer -EventName Elapsed -MessageData $heartbeatMessage -Action {
        try {
            # Register-ObjectEvent actions run in an event-job scope and cannot
            # reliably resolve functions from the dot-sourced caller scope.
            # Keep the small read/modify/atomic-write routine self-contained
            # here, while using the exact same owner mutex as foreground writes.
            $message = $event.MessageData
            $path = [IO.Path]::GetFullPath([string]$message.OwnerPath)
            $nameHash = [Security.Cryptography.SHA256]::Create()
            try {
                $nameBytes = [Text.UTF8Encoding]::new($false).GetBytes($path)
                $mutexName = "Global\wechat-miniapp-release-owner-" + (([BitConverter]::ToString($nameHash.ComputeHash($nameBytes)) -replace '-', '').ToLowerInvariant())
            }
            finally { $nameHash.Dispose() }
            $mutex = [Threading.Mutex]::new($false, $mutexName)
            $owns = $false
            try {
                try { $owns = $mutex.WaitOne([TimeSpan]::FromSeconds(15)) }
                catch [Threading.AbandonedMutexException] { $owns = $true }
                if (-not $owns) { return }
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
                $owner = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
                if ([int]$owner.pid -ne [int]$message.OwnerPid) { return }
                $hash = [ordered]@{}
                foreach ($property in $owner.PSObject.Properties) { $hash[$property.Name] = $property.Value }
                $hash.lastHeartbeat = [DateTimeOffset]::UtcNow.ToString("o")
                $temp = "$path.$([int]$message.OwnerPid).$([guid]::NewGuid().ToString('N')).heartbeat.tmp"
                $backup = "$path.$([int]$message.OwnerPid).$([guid]::NewGuid().ToString('N')).heartbeat.replace.bak"
                try {
                    [IO.File]::WriteAllText($temp, ($hash | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
                    if (Test-Path -LiteralPath $path -PathType Leaf) {
                        try { [IO.File]::Replace($temp, $path, $backup, $true) }
                        catch [PlatformNotSupportedException] { [IO.File]::Move($temp, $path, $true) }
                        catch [NotSupportedException] { [IO.File]::Move($temp, $path, $true) }
                    }
                    else { [IO.File]::Move($temp, $path) }
                }
                finally {
                    if (Test-Path -LiteralPath $temp -PathType Leaf) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
                    if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
                }
            }
            finally {
                if ($owns) { try { $mutex.ReleaseMutex() } catch {} }
                $mutex.Dispose()
            }
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
    $expectedToken = if ($LockHandle.Owner.PSObject.Properties["handoffToken"]) { [string]$LockHandle.Owner.handoffToken } else { "" }
    $actualToken = if ($owner.PSObject.Properties["handoffToken"]) { [string]$owner.handoffToken } else { "" }
    if ([string]::IsNullOrWhiteSpace($expectedToken) -or
        -not [string]::Equals($expectedToken, $actualToken, [StringComparison]::Ordinal)) {
        $suffix = if ([string]::IsNullOrWhiteSpace($Stage)) { "" } else { "（阶段：$Stage）" }
        throw "发布锁交接身份已变化$suffix，已停止后续写入。"
    }
    # Keep the deserialized DateTime/DateTimeOffset object intact.  Casting an
    # ISO timestamp to [string] in a Beijing PowerShell session formats it as
    # local wall time and then a second parse treats it as UTC, producing an
    # eight-hour false PID-reuse alarm.
    $recordedStart = if ($owner.PSObject.Properties["processStartUtc"]) { $owner.processStartUtc } else { "" }
    if (-not [string]::IsNullOrWhiteSpace($recordedStart)) {
        $actualStart = Get-ReleaseProcessStartUtc -ProcessId $PID
        if (-not [string]::IsNullOrWhiteSpace($actualStart)) {
            try {
                $delta = (ConvertTo-ReleaseUtcDateTime -Value $actualStart) - (ConvertTo-ReleaseUtcDateTime -Value $recordedStart)
                if ([Math]::Abs($delta.TotalSeconds) -ge 2) {
                    throw "发布锁进程启动时间已变化，已停止后续写入。"
                }
            }
            catch {
                if ($_.Exception.Message -like "发布锁进程启动时间已变化*") { throw }
                throw "发布锁 owner 启动时间无效，已停止后续写入。"
            }
        }
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
            # Owner metadata is separate from the held OS lock.  Publish it
            # through the same guarded atomic writer used by heartbeat/stage
            # updates, so readers never see a truncated JSON document.
            Write-ReleaseLockOwnerAtomic -OwnerPath $paths.OwnerPath -Value $owner
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
    $guard = $null
    try {
        $guard = Enter-ReleaseLockOwnerGuard -OwnerPath ([string]$LockHandle.OwnerPath)
        # Re-read after acquiring the metadata guard.  This closes the race in
        # which a timer callback captured an older owner object before this
        # phase update started.
        $current = Read-ReleaseLockOwner -OwnerPath ([string]$LockHandle.OwnerPath)
        $expectedToken = if ($LockHandle.Owner.PSObject.Properties["handoffToken"]) { [string]$LockHandle.Owner.handoffToken } else { "" }
        $currentToken = if ($null -ne $current -and $current.PSObject.Properties["handoffToken"]) { [string]$current.handoffToken } else { "" }
        if ($null -eq $current -or [int]$current.pid -ne $PID -or
            $currentToken -ne $expectedToken) {
            throw "发布锁所有权在元数据写入前丢失。"
        }
        $owner = [ordered]@{}
        foreach ($property in $current.PSObject.Properties) {
            $owner[$property.Name] = $property.Value
        }
        $owner.targetVersion = $TargetVersion
        if (-not [string]::IsNullOrWhiteSpace($Stage)) { $owner.stage = $Stage }
        $owner.lastHeartbeat = [DateTimeOffset]::UtcNow.ToString("o")
        Write-ReleaseLockOwnerAtomicInternal -OwnerPath ([string]$LockHandle.OwnerPath) -Value $owner
        $LockHandle.Owner = [pscustomobject]$owner
    }
    finally { Exit-ReleaseLockOwnerGuard -Guard $guard }
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

    # A stale owner sidecar can survive a crashed parent after the OS releases
    # its FileStream.  Prove that the recorded process is still the same
    # process, then prove the lock is still held: if this probe can open the
    # file with FileShare.None, no outer owner currently holds it and the child
    # must not perform a deployment without the critical section.
    $ownerPid = 0
    try { $ownerPid = [int]$owner.pid } catch { $ownerPid = 0 }
    if ($ownerPid -le 0) { throw "发布锁 owner PID 无效，拒绝复用外层锁。" }
    $process = $null
    try { $process = Get-Process -Id $ownerPid -ErrorAction Stop }
    catch { throw "发布锁 owner 进程已退出，拒绝复用外层锁。" }
    $recordedStart = if ($owner.PSObject.Properties["processStartUtc"]) { $owner.processStartUtc } else { "" }
    if ([string]::IsNullOrWhiteSpace($recordedStart)) {
        throw "发布锁 owner 缺少 processStartUtc，拒绝复用外层锁。"
    }
    $actualStart = Get-ReleaseProcessStartUtc -ProcessId $ownerPid
    if ([string]::IsNullOrWhiteSpace($actualStart)) { throw "无法读取发布锁 owner 进程启动时间，拒绝复用外层锁。" }
    try {
        $delta = (ConvertTo-ReleaseUtcDateTime -Value $actualStart) - (ConvertTo-ReleaseUtcDateTime -Value $recordedStart)
        if ([Math]::Abs($delta.TotalSeconds) -ge 2) { throw "发布锁 owner PID 已被复用，拒绝复用外层锁。" }
    }
    catch {
        if ($_.Exception.Message -like "发布锁 owner PID 已被复用*") { throw }
        throw "发布锁 owner 启动时间无效，拒绝复用外层锁。"
    }
    $probe = $null
    try {
        $probe = [IO.File]::Open($paths.LockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        # Opening succeeded: the parent no longer owns the lock.  Do not keep
        # this probe open; it is evidence of a stale handoff only.
        throw "发布锁当前未被 owner 独占持有，拒绝复用外层锁。"
    }
    catch [IO.IOException] {
        # Windows sharing violation is the expected result while the parent
        # FileStream is alive.  The process/start-time checks above rule out a
        # stale sidecar in the normal crash/restart case.
    }
    catch [UnauthorizedAccessException] {
        throw "无法验证发布锁独占状态（访问被拒绝），拒绝复用外层锁。"
    }
    finally {
        if ($null -ne $probe) { $probe.Dispose() }
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
