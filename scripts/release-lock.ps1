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

function Get-ReleasePublishLockOperationState {
    <#
      Read the durable state for a lock owner without taking any queue or
      filesystem write lock.  A missing state is deliberately reported as
      unknown; an owner that cannot be proven terminal must block publish.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [string]$OperationId = ""
    )

    if ([string]::IsNullOrWhiteSpace($OperationId)) { return $null }
    $queueRoot = if ($Policy.PSObject.Properties["queueRoot"] -and -not [string]::IsNullOrWhiteSpace([string]$Policy.queueRoot)) {
        [IO.Path]::GetFullPath([string]$Policy.queueRoot)
    }
    else {
        $parent = Split-Path ([IO.Path]::GetFullPath([string]$Policy.lockPath)) -Parent
        Join-Path $parent "wechat-miniapp-release-queue"
    }
    $queuePath = Join-Path $queueRoot "queue.json"
    if (Test-Path -LiteralPath $queuePath -PathType Leaf) {
        try {
            $queue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($ticket in @($queue.tickets)) {
                $ticketId = if ($ticket.PSObject.Properties["operationId"]) { [string]$ticket.operationId } else { "" }
                if ($ticketId -ne $OperationId) { continue }
                $status = if ($ticket.PSObject.Properties["status"]) { [string]$ticket.status } else { "" }
                $phase = if ($ticket.PSObject.Properties["phase"]) { [string]$ticket.phase } else { "" }
                return [pscustomobject][ordered]@{
                    operationId = $OperationId
                    status = $status
                    phase = $phase
                    terminal = $status -in @("succeeded", "failed", "cancelled", "expired", "recoverable")
                    source = "queue"
                }
            }
        }
        catch {
            return [pscustomobject][ordered]@{
                operationId = $OperationId
                status = "invalid"
                phase = ""
                terminal = $false
                source = "queue-invalid"
            }
        }
    }

    # A queue ticket can be absent while a context is still being repaired.
    # Inspect the canonical context/record trees before declaring the owner
    # unknown, but never treat an absent record as proof of completion.
    foreach ($rootName in @("contextRoot", "recordRoot")) {
        if (-not $Policy.PSObject.Properties[$rootName]) { continue }
        $root = [string]$Policy.$rootName
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter "*.json" -File -ErrorAction SilentlyContinue)) {
            try { $value = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
            if (-not $value.PSObject.Properties["operationId"] -or [string]$value.operationId -ne $OperationId) { continue }
            $status = if ($value.PSObject.Properties["terminalStatus"]) { [string]$value.terminalStatus } elseif ($value.PSObject.Properties["status"]) { [string]$value.status } else { "" }
            $phase = if ($value.PSObject.Properties["phase"]) { [string]$value.phase } else { "" }
            return [pscustomobject][ordered]@{
                operationId = $OperationId
                status = $status
                phase = $phase
                terminal = $status -in @("succeeded", "failed", "cancelled", "expired", "recoverable", "已推送")
                source = $rootName
            }
        }
    }
    return [pscustomobject][ordered]@{
        operationId = $OperationId
        status = "unknown"
        phase = ""
        terminal = $false
        source = "missing"
    }
}

function Get-ReleasePublishLockHealth {
    <# Read-only publish preflight.  It never creates, truncates, or cleans a lock. #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [ValidateRange(5, 86400)][int]$StaleAfterSeconds = 600,
        # A resume caller may explicitly identify the prepared operation whose
        # lock metadata it is going to reclaim.  Keep this opt-in; ordinary
        # release must still fail closed on every non-terminal residue.
        [Alias("AllowOperationId")][string]$ExpectedOperationId = ""
    )

    $lockPath = [IO.Path]::GetFullPath([string]$Policy.lockPath)
    $ownerPath = "$lockPath.owner.json"
    $pendingPath = "$lockPath.pending.json"
    $lockExists = Test-Path -LiteralPath $lockPath -PathType Leaf
    $ownerSidecarExists = Test-Path -LiteralPath $ownerPath -PathType Leaf
    $pendingSidecarExists = Test-Path -LiteralPath $pendingPath -PathType Leaf
    $osAvailable = $true
    $osError = ""
    $stream = $null
    if ($lockExists) {
        try {
            $stream = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        }
        catch {
            $osAvailable = $false
            $osError = $_.Exception.Message
        }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }

    $ownerSidecarValid = $true
    $owner = if ($ownerSidecarExists) {
        $value = Read-ReleaseLockOwner -OwnerPath $ownerPath
        if ($null -eq $value) { $ownerSidecarValid = $false }
        $value
    }
    if ($null -eq $owner -and $lockExists) {
        try {
            $raw = [IO.File]::ReadAllText($lockPath, [Text.Encoding]::UTF8)
            if (-not [string]::IsNullOrWhiteSpace($raw)) { $owner = $raw | ConvertFrom-Json }
        }
        catch { $owner = $null }
    }
    $pendingValid = $true
    $pending = if ($pendingSidecarExists) {
        try {
            $value = Get-Content -LiteralPath $pendingPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -eq $value) { $pendingValid = $false }
            $value
        }
        catch {
            $pendingValid = $false
            $null
        }
    }
    $ownerOperationId = if ($null -ne $owner -and $owner.PSObject.Properties["operationId"]) { [string]$owner.operationId } else { "" }
    $pendingOperationId = if ($null -ne $pending -and $pending.PSObject.Properties["operationId"]) { [string]$pending.operationId } else { "" }
    # A pending cloud task can outlive the owner sidecar after a normal lock
    # release.  Use its operation id only when no owner identity remains, and
    # reject contradictory identities instead of choosing one silently.
    $operationId = if (-not [string]::IsNullOrWhiteSpace($ownerOperationId)) { $ownerOperationId } else { $pendingOperationId }
    $identityMismatch =
        (-not $ownerSidecarValid) -or
        (-not $pendingValid) -or
        ($pendingSidecarExists -and [string]::IsNullOrWhiteSpace($pendingOperationId)) -or
        (-not [string]::IsNullOrWhiteSpace($ownerOperationId) -and
            -not [string]::IsNullOrWhiteSpace($pendingOperationId) -and
            -not [string]::Equals($ownerOperationId, $pendingOperationId, [StringComparison]::Ordinal))
    $operation = Get-ReleasePublishLockOperationState -Policy $Policy -OperationId $operationId
    $metadataPresent = $null -ne $owner -or $ownerSidecarExists -or $pendingSidecarExists
    $reason = ""
    $error = ""
    $healthy = $true

    if (-not $metadataPresent) {
        $reason = if ($lockExists) { "empty-lock-file" } else { "lock-file-missing" }
    }
    elseif (-not $osAvailable) {
        $healthy = $false
        $reason = "active-lock"
        $error = "发布前锁健康检查失败：发布锁当前被其他进程持有（$lockPath）。$osError"
    }
    elseif ($identityMismatch) {
        $healthy = $false
        $reason = "metadata-mismatch"
        $detail = if (-not $ownerSidecarValid) {
            "owner sidecar 无法解析"
        }
        elseif (-not $pendingValid) {
            "pending sidecar 无法解析"
        }
        elseif ($pendingSidecarExists -and [string]::IsNullOrWhiteSpace($pendingOperationId)) {
            "pending sidecar 缺少 operationId"
        }
        else {
            "owner operationId=$ownerOperationId，pending operationId=$pendingOperationId"
        }
        $error = "发布前锁健康检查失败：锁元数据身份不一致（$detail）。请先完成或取消该发布操作，再重试。"
    }
    elseif ($null -ne $operation -and [bool]$operation.terminal) {
        $reason = "terminal-metadata"
    }
    elseif (
        -not [string]::IsNullOrWhiteSpace($ExpectedOperationId) -and
        [string]::Equals($operationId, $ExpectedOperationId.Trim(), [StringComparison]::Ordinal) -and
        $null -ne $operation -and
        [string]::Equals([string]$operation.source, "queue", [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$operation.status, "queued", [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$operation.phase, "prepared", [StringComparison]::OrdinalIgnoreCase)
    ) {
        # The OS probe above already proved that no process currently owns the
        # lock.  Only the exact prepared queue ticket may pass this explicit
        # resume exception; a different operation or phase remains blocked.
        $reason = "expected-nonterminal-residue"
    }
    else {
        $healthy = $false
        $reason = "nonterminal-residue"
        $status = if ($null -eq $operation) { "unknown" } else { [string]$operation.status }
        $phase = if ($null -eq $operation) { "" } else { [string]$operation.phase }
        $detail = if ([string]::IsNullOrWhiteSpace($operationId)) { "operationId 缺失" } else { "operationId=$operationId，status=$status，phase=$phase" }
        $error = "发布前锁健康检查失败：发现非终态残留锁（$detail）。请先完成或取消该发布操作，再重试。"
    }

    return [pscustomobject][ordered]@{
        healthy = [bool]$healthy
        reason = $reason
        error = $error
        lockPath = $lockPath
        exists = [bool]$lockExists
        osLockAvailable = [bool]$osAvailable
        osError = $osError
        ownerSidecarExists = [bool]$ownerSidecarExists
        pendingSidecarExists = [bool]$pendingSidecarExists
        metadataPresent = [bool]$metadataPresent
        operationId = $operationId
        ownerOperationId = $ownerOperationId
        pendingOperationId = $pendingOperationId
        operation = $operation
        expectedOperationId = $ExpectedOperationId
        checkedAt = [DateTimeOffset]::UtcNow.ToString("o")
        staleAfterSeconds = $StaleAfterSeconds
    }
}

function Assert-ReleasePublishLockHealth {
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [ValidateRange(5, 86400)][int]$StaleAfterSeconds = 600,
        [Alias("AllowOperationId")][string]$ExpectedOperationId = ""
    )

    $result = Get-ReleasePublishLockHealth `
        -Policy $Policy `
        -StaleAfterSeconds $StaleAfterSeconds `
        -ExpectedOperationId $ExpectedOperationId
    if (-not [bool]$result.healthy) { throw [string]$result.error }
    return $result
}

function Get-ReleaseLockOwnerMutexName {
    <#
      The OS lock protects the release critical section, but the owner sidecar
      is written by both the foreground phase updater and the timer callback.
      Use a deterministic named mutex for that small metadata file so a
      heartbeat cannot write an older snapshot over a newer stage/version.
    #>
    param([Parameter(Mandatory = $true)][string]$OwnerPath)
    # Windows paths are case-insensitive.  Normalize before hashing so two
    # callers spelling the same sidecar with different case/separators cannot
    # accidentally create two independent metadata mutexes.
    $full = [IO.Path]::GetFullPath($OwnerPath).TrimEnd('\', '/').ToLowerInvariant()
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
                $path = $path.TrimEnd('\', '/').ToLowerInvariant()
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
    # Stop the timer before touching the sidecar.  Then take the same owner
    # mutex used by heartbeat/stage writers and compare both PID and the unique
    # handoffToken.  A PID-only delete could remove a newer owner's metadata if
    # a handle is released late or the OS reuses a process id.
    try { Stop-ReleaseLockHeartbeat -LockHandle $LockHandle } catch { }
    $guard = $null
    try {
        $guard = Enter-ReleaseLockOwnerGuard -OwnerPath ([string]$LockHandle.OwnerPath)
        $owner = Read-ReleaseLockOwner -OwnerPath ([string]$LockHandle.OwnerPath)
        $expectedPid = if ($LockHandle.Owner.PSObject.Properties["pid"]) { [int]$LockHandle.Owner.pid } else { [int]$PID }
        $expectedToken = if ($LockHandle.Owner.PSObject.Properties["handoffToken"]) { [string]$LockHandle.Owner.handoffToken } else { "" }
        $ownerToken = if ($null -ne $owner -and $owner.PSObject.Properties["handoffToken"]) { [string]$owner.handoffToken } else { "" }
        $sameOwner = $null -ne $owner -and [int]$owner.pid -eq $expectedPid -and
            -not [string]::IsNullOrWhiteSpace($expectedToken) -and
            [string]::Equals($ownerToken, $expectedToken, [StringComparison]::Ordinal)
        if ($sameOwner) {
            # The lock stream also carries a legacy embedded owner snapshot.
            # Clear it while the OS lock is still held, before removing the
            # sidecar.  Otherwise a normal release leaves a non-terminal
            # operation in the lock body; the read-only health preflight then
            # mistakes that body for a live/stale owner and blocks recovery.
            $embeddedOwnerCleared = $false
            try {
                if ($null -ne $LockHandle.Stream -and $LockHandle.Stream.CanWrite) {
                    $LockHandle.Stream.SetLength(0)
                    $LockHandle.Stream.Flush()
                    $embeddedOwnerCleared = $true
                }
            }
            catch { }
            # Keep the sidecar when body cleanup failed.  A conservative
            # residue is recoverable by the maintenance path; deleting the
            # only identity marker would make the remaining body ambiguous.
            if ($embeddedOwnerCleared) {
                Remove-Item -LiteralPath ([string]$LockHandle.OwnerPath) -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch { }
    finally {
        if ($null -ne $guard) { try { Exit-ReleaseLockOwnerGuard -Guard $guard } catch { } }
        if ($null -ne $LockHandle.Stream) {
            try { $LockHandle.Stream.Dispose() } catch { }
        }
    }
}
