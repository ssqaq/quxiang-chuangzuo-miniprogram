<#
.SYNOPSIS
    Read-only inspection and maintenance helpers for the miniapp release state.

.DESCRIPTION
    This file deliberately does not alter a reservation's original JSON and it
    never removes the release lock file.  Reservation "cleanup" means writing
    an immutable archival copy and an index; old version numbers remain used.
    Lock metadata cleanup is opt-in and requires an exclusive OS lock plus an
    explicitly terminal operation.  The command line wrapper acquires the
    shared release lock before archival writes.
#>

param(
    [ValidateSet("status", "archive-reservations", "inspect-lock", "cleanup-lock")]
    [string]$Action = "status",
    [string]$PolicyPath = "",
    [ValidateRange(0, 8760)][int]$OlderThanHours = 24,
    [switch]$IncludeRecent,
    [switch]$ConfirmCleanup,
    [switch]$Json,
    [ValidateRange(1, 7200)][int]$LockWaitSeconds = 1800
)

Set-StrictMode -Version Latest

$script:ReleaseMaintenanceRoot = $PSScriptRoot
$script:ReleaseMaintenanceDotSourced = ($MyInvocation.InvocationName -eq ".")

if (-not (Get-Command Get-ReleaseGatePolicy -ErrorAction SilentlyContinue)) {
    $gateScript = Join-Path $PSScriptRoot "release-gate.ps1"
    if (-not (Test-Path -LiteralPath $gateScript -PathType Leaf)) { throw "Missing release-gate.ps1: $gateScript" }
    . $gateScript
}
if (-not (Get-Command Enter-ReleaseLock -ErrorAction SilentlyContinue)) {
    $lockScript = Join-Path $PSScriptRoot "release-lock.ps1"
    if (-not (Test-Path -LiteralPath $lockScript -PathType Leaf)) { throw "Missing release-lock.ps1: $lockScript" }
    . $lockScript
}

function Get-ReleaseMaintenancePolicy {
    param([string]$PolicyPath = "")

    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $policy = Get-ReleaseGatePolicy -PolicyPath $PolicyPath -RepositoryRoot $repoRoot
    Assert-ReleaseCanonicalPolicy -Policy $policy -RepositoryRoot $repoRoot | Out-Null
    return $policy
}

function ConvertTo-ReleaseMaintenanceFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Test-ReleaseMaintenancePathUnder {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $pathFull = (ConvertTo-ReleaseMaintenanceFullPath $Path).TrimEnd('\', '/')
    $rootFull = (ConvertTo-ReleaseMaintenanceFullPath $Root).TrimEnd('\', '/')
    if ([string]::Equals($pathFull, $rootFull, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $pathFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        $pathFull.StartsWith($rootFull + '/', [StringComparison]::OrdinalIgnoreCase) -or
        $pathFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-ReleaseMaintenanceProperty {
    param(
        [object]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [object]$Default = $null
    )
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function ConvertTo-ReleaseMaintenanceDate {
    param([object]$Value)
    try { return ([DateTimeOffset]$Value).ToUniversalTime() }
    catch { return $null }
}

function Get-ReleaseMaintenanceQueueMap {
    param([Parameter(Mandatory = $true)][object]$Policy)
    $map = @{}
    $queuePath = Join-Path ([string]$Policy.queueRoot) "queue.json"
    if (-not (Test-Path -LiteralPath $queuePath -PathType Leaf)) { return $map }
    try {
        $queue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($ticket in @($queue.tickets)) {
            $id = [string](Get-ReleaseMaintenanceProperty $ticket "operationId" "")
            if (-not [string]::IsNullOrWhiteSpace($id)) { $map[$id] = $ticket }
        }
    }
    catch { throw "Unable to parse release queue: $queuePath. $($_.Exception.Message)" }
    return $map
}

function Get-ReleaseMaintenanceReservationInventory {
    <# Return reservation facts without changing any file. #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [string]$OperationId = ""
    )

    $root = ConvertTo-ReleaseMaintenanceFullPath ([string]$Policy.reservationRoot)
    $queue = Get-ReleaseMaintenanceQueueMap -Policy $Policy
    $items = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return [object[]]$items.ToArray() }

    foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter 'reservation-*.json' -File -ErrorAction SilentlyContinue)) {
        try { $value = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { throw "Unable to parse reservation: $($file.FullName). $($_.Exception.Message)" }
        $id = [string](Get-ReleaseMaintenanceProperty $value "operationId" "")
        if (-not [string]::IsNullOrWhiteSpace($OperationId) -and $id -ne $OperationId) { continue }
        $status = [string](Get-ReleaseMaintenanceProperty $value "status" "unknown")
        $version = [string](Get-ReleaseMaintenanceProperty $value "targetVersion" (Get-ReleaseMaintenanceProperty $value "version" ""))
        $createdText = [string](Get-ReleaseMaintenanceProperty $value "createdAt" "")
        if ([string]::IsNullOrWhiteSpace($createdText)) { $createdText = [string](Get-ReleaseMaintenanceProperty $value "updatedAt" "") }
        $created = ConvertTo-ReleaseMaintenanceDate $createdText
        $ticket = if ($queue.ContainsKey($id)) { $queue[$id] } else { $null }
        $queueStatus = [string](Get-ReleaseMaintenanceProperty $ticket "status" "")
        $queuePhase = [string](Get-ReleaseMaintenanceProperty $ticket "phase" "")
        $archiveable = $status -in @("failed", "cancelled", "expired", "recoverable")
        $items.Add([pscustomobject][ordered]@{
            path = $file.FullName
            fileName = $file.Name
            operationId = $id
            version = $version
            status = $status
            queueStatus = $queueStatus
            queuePhase = $queuePhase
            createdAt = $createdText
            updatedAt = [string](Get-ReleaseMaintenanceProperty $value "updatedAt" "")
            lastWriteTimeUtc = $file.LastWriteTimeUtc.ToString("o")
            ageHours = if ($null -eq $created) { $null } else { [Math]::Max(0, ([DateTimeOffset]::UtcNow - $created).TotalHours) }
            archiveable = [bool]$archiveable
            originalSha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        })
    }
    return [object[]]$items.ToArray()
}

function Write-ReleaseMaintenanceImmutableFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )
    $parent = Split-Path ([IO.Path]::GetFullPath($Path)) -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temp = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllBytes($temp, $Bytes)
    try {
        try {
            [IO.File]::Move($temp, $Path)
            return "created"
        }
        catch [IO.IOException] {
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw }
            $oldSha = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
            $newSha = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($oldSha -eq $newSha) { return "reused" }
            throw "Refusing to overwrite immutable file with a different SHA: $Path"
        }
    }
    finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}

function Write-ReleaseMaintenanceJsonImmutable {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $json = ($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine
    return Write-ReleaseMaintenanceImmutableFile -Path $Path -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Get-ReleaseMaintenanceBytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Invoke-ReleaseReservationArchive {
    <#
      Archive terminal reservation metadata without freeing its version.  The
      caller should hold the shared release lock.  -AllowUnlocked is an
      internal test hook only; the CLI never exposes it.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [ValidateRange(0, 8760)][int]$OlderThanHours = 24,
        [switch]$IncludeRecent,
        [switch]$AllowUnlocked
    )

    $inventory = @(Get-ReleaseMaintenanceReservationInventory -Policy $Policy)
    $candidates = @($inventory | Where-Object {
        $_.archiveable -and ($IncludeRecent -or $null -eq $_.ageHours -or [double]$_.ageHours -ge $OlderThanHours)
    })
    $archiveRoot = Join-Path ([string]$Policy.reservationRoot) "archive"
    New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
    $archived = New-Object System.Collections.Generic.List[object]
    foreach ($item in $candidates) {
        $raw = [IO.File]::ReadAllBytes([string]$item.path)
        $archivePath = Join-Path $archiveRoot ([string]$item.fileName)
        $disposition = Write-ReleaseMaintenanceImmutableFile -Path $archivePath -Bytes $raw
        $archived.Add([pscustomobject][ordered]@{
            sourcePath = [string]$item.path
            archivePath = $archivePath
            operationId = [string]$item.operationId
            version = [string]$item.version
            status = [string]$item.status
            sourceSha256 = [string]$item.originalSha256
            disposition = $disposition
            archivedAt = [DateTimeOffset]::UtcNow.ToString("o")
        })
    }

    $indexPath = Join-Path $archiveRoot "reservation-archive-index.json"
    $indexEntries = New-Object System.Collections.Generic.List[object]
    if (Test-Path -LiteralPath $indexPath -PathType Leaf) {
        try {
            $oldIndex = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($entry in @($oldIndex.entries)) { [void]$indexEntries.Add($entry) }
        }
        catch { throw "Unable to parse reservation archive index: $indexPath. $($_.Exception.Message)" }
    }
    $seen = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $indexEntries.ToArray()) { [void]$seen.Add("$($entry.operationId)|$($entry.sourceSha256)") }
    foreach ($entry in $archived.ToArray()) {
        $key = "$($entry.operationId)|$($entry.sourceSha256)"
        if ($seen.Add($key)) { [void]$indexEntries.Add($entry) }
    }
    $index = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        policyCanonicalRepo = [string]$Policy.canonicalRepo
        versionReuseAllowed = $false
        entries = [object[]]$indexEntries.ToArray()
    }
    # The index is a mutable summary, but it is written atomically while the
    # caller's release lock is held.  Individual archived copies are immutable.
    $indexTemp = "$indexPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($indexTemp, (($index | ConvertTo-Json -Depth 30) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $indexTemp -Destination $indexPath -Force
    return [pscustomobject][ordered]@{
        action = "archive-reservations"
        candidates = [object[]]$candidates
        archived = [object[]]$archived.ToArray()
        archivedCount = $archived.Count
        indexPath = $indexPath
        versionReuseAllowed = $false
        lockRequired = -not $AllowUnlocked
    }
}

function Get-ReleaseMaintenanceOperationState {
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [string]$OperationId = ""
    )
    if ([string]::IsNullOrWhiteSpace($OperationId)) { return $null }
    $queue = Get-ReleaseMaintenanceQueueMap -Policy $Policy
    if ($queue.ContainsKey($OperationId)) {
        $ticket = $queue[$OperationId]
        return [pscustomobject][ordered]@{
            operationId = $OperationId
            status = [string](Get-ReleaseMaintenanceProperty $ticket "status" "")
            phase = [string](Get-ReleaseMaintenanceProperty $ticket "phase" "")
            terminal = [string](Get-ReleaseMaintenanceProperty $ticket "status" "") -in @("succeeded", "failed", "cancelled", "expired", "recoverable")
        }
    }
    foreach ($rootName in @("contextRoot", "recordRoot")) {
        $root = [string](Get-ReleaseMaintenanceProperty $Policy $rootName "")
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
            try { $value = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
            if ([string](Get-ReleaseMaintenanceProperty $value "operationId" "") -ne $OperationId) { continue }
            $status = [string](Get-ReleaseMaintenanceProperty $value "terminalStatus" (Get-ReleaseMaintenanceProperty $value "status" ""))
            return [pscustomobject][ordered]@{ operationId = $OperationId; status = $status; phase = [string](Get-ReleaseMaintenanceProperty $value "phase" ""); terminal = $status -in @("succeeded", "failed", "cancelled", "expired", "recoverable", "已推送") }
        }
    }
    return [pscustomobject][ordered]@{ operationId = $OperationId; status = "unknown"; phase = ""; terminal = $false }
}

function Get-ReleaseLockEmbeddedOwner {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return $text | ConvertFrom-Json
    }
    catch { return $null }
}

function Test-ReleaseMaintenanceProcessIdentity {
    param([object]$Owner)
    $pidValue = 0
    try { $pidValue = [int](Get-ReleaseMaintenanceProperty $Owner "pid" 0) } catch { return [pscustomobject]@{ alive = $false; startMatches = $false; pid = 0 } }
    if ($pidValue -le 0) { return [pscustomobject]@{ alive = $false; startMatches = $false; pid = $pidValue } }
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($null -eq $process) { return [pscustomobject]@{ alive = $false; startMatches = $false; pid = $pidValue } }
    $actual = ""
    try { $actual = ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToString("o") } catch { }
    $recorded = [string](Get-ReleaseMaintenanceProperty $Owner "processStartUtc" "")
    $matches = $false
    if (-not [string]::IsNullOrWhiteSpace($actual) -and -not [string]::IsNullOrWhiteSpace($recorded)) {
        try { $matches = [Math]::Abs(((ConvertTo-ReleaseMaintenanceDate $actual) - (ConvertTo-ReleaseMaintenanceDate $recorded)).TotalSeconds) -lt 2 } catch { $matches = $false }
    }
    return [pscustomobject]@{ alive = $true; startMatches = $matches; pid = $pidValue; actualStartUtc = $actual; recordedStartUtc = $recorded }
}

function Test-ReleaseMaintenanceOsLockAvailable {
    param([Parameter(Mandatory = $true)][string]$LockPath)
    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return [pscustomobject]@{ exists = $false; available = $true; error = "" }
    }
    $stream = $null
    try {
        $stream = [IO.File]::Open($LockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        return [pscustomobject]@{ exists = $true; available = $true; error = "" }
    }
    catch [IO.IOException] {
        return [pscustomobject]@{ exists = $true; available = $false; error = $_.Exception.Message }
    }
    catch {
        return [pscustomobject]@{ exists = $true; available = $false; error = $_.Exception.Message }
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Get-ReleaseLockInspection {
    <# Read-only lock/owner/queue inspection.  It never creates the lock file. #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [ValidateRange(5, 86400)][int]$StaleAfterSeconds = 600
    )
    $lockPath = ConvertTo-ReleaseMaintenanceFullPath ([string]$Policy.lockPath)
    $ownerPath = "$lockPath.owner.json"
    $pendingPath = "$lockPath.pending.json"
    $os = Test-ReleaseMaintenanceOsLockAvailable -LockPath $lockPath
    $embedded = Get-ReleaseLockEmbeddedOwner -Path $lockPath
    $sidecar = if (Test-Path -LiteralPath $ownerPath -PathType Leaf) { try { Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } } else { $null }
    $owner = if ($null -ne $sidecar) { $sidecar } else { $embedded }
    $identity = Test-ReleaseMaintenanceProcessIdentity -Owner $owner
    $operationId = [string](Get-ReleaseMaintenanceProperty $owner "operationId" "")
    $state = Get-ReleaseMaintenanceOperationState -Policy $Policy -OperationId $operationId
    $heartbeat = ConvertTo-ReleaseMaintenanceDate (Get-ReleaseMaintenanceProperty $owner "lastHeartbeat" (Get-ReleaseMaintenanceProperty $owner "startedAt" ""))
    $heartbeatAge = if ($null -eq $heartbeat) { $null } else { [Math]::Max(0, ([DateTimeOffset]::UtcNow - $heartbeat).TotalSeconds) }
    $stale = if ($null -eq $owner) { $false } elseif ($null -eq $heartbeat) { $true } else { [double]$heartbeatAge -gt $StaleAfterSeconds }
    $orphan = $null -ne $owner -and ((-not [bool]$identity.alive) -or (-not [bool]$identity.startMatches))
    # A PID that no longer exists is conclusive enough when the OS lock is
    # available; requiring an old heartbeat in that case would leave harmless
    # crash residue for up to ten minutes.  A live/mismatched PID still needs
    # the stale-heartbeat guard to avoid racing a recycled process.
    $orphanSafe = $orphan -and ((-not [bool]$identity.alive) -or [bool]$stale)
    $safe = [bool]$os.available -and [bool]$orphanSafe -and ($null -eq $state -or [bool]$state.terminal)
    return [pscustomobject][ordered]@{
        lockPath = $lockPath
        ownerPath = $ownerPath
        pendingPath = $pendingPath
        exists = [bool]$os.exists
        osLockAvailable = [bool]$os.available
        osLockHeld = -not [bool]$os.available
        osError = [string]$os.error
        ownerSidecarExists = Test-Path -LiteralPath $ownerPath -PathType Leaf
        pendingSidecarExists = Test-Path -LiteralPath $pendingPath -PathType Leaf
        owner = $owner
        operationId = $operationId
        process = $identity
        heartbeatAgeSeconds = $heartbeatAge
        stale = [bool]$stale
        orphan = [bool]$orphan
        orphanSafe = [bool]$orphanSafe
        operation = $state
        safeToCleanup = [bool]$safe
        checkedAt = [DateTimeOffset]::UtcNow.ToString("o")
    }
}

function Invoke-ReleaseOrphanLockMetadataCleanup {
    <#
      Clear only ephemeral lock metadata.  The lock file itself is never
      removed.  A backup is written first, and an explicit confirmation is
      mandatory.  The exclusive stream is held while all checks and clearing
      happen, closing the check/use race.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [switch]$ConfirmCleanup,
        [ValidateRange(5, 86400)][int]$StaleAfterSeconds = 600
    )
    if (-not $ConfirmCleanup) { throw "Explicit -ConfirmCleanup is required; no lock metadata was changed." }
    $lockPath = ConvertTo-ReleaseMaintenanceFullPath ([string]$Policy.lockPath)
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        return [pscustomobject][ordered]@{ action = "cleanup-lock"; changed = $false; reason = "lock-file-missing"; safeToCleanup = $false }
    }
    $stream = $null
    try {
        try { $stream = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw "Cannot obtain exclusive OS lock for metadata cleanup; another publisher may be active. $($_.Exception.Message)" }
        $rawBytes = New-Object byte[] ([int]$stream.Length)
        if ($rawBytes.Length -gt 0) { [void]$stream.Read($rawBytes, 0, $rawBytes.Length) }
        $owner = $null
        try { if ($rawBytes.Length -gt 0) { $owner = ([Text.Encoding]::UTF8.GetString($rawBytes) | ConvertFrom-Json) } } catch { $owner = $null }
        $ownerPath = "$lockPath.owner.json"
        $pendingPath = "$lockPath.pending.json"
        $sidecar = if (Test-Path -LiteralPath $ownerPath -PathType Leaf) { try { Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } } else { $null }
        if ($null -ne $sidecar) { $owner = $sidecar }
        $identity = Test-ReleaseMaintenanceProcessIdentity -Owner $owner
        $heartbeat = ConvertTo-ReleaseMaintenanceDate (Get-ReleaseMaintenanceProperty $owner "lastHeartbeat" (Get-ReleaseMaintenanceProperty $owner "startedAt" ""))
        $stale = $null -ne $owner -and ($null -eq $heartbeat -or ([DateTimeOffset]::UtcNow - $heartbeat).TotalSeconds -gt $StaleAfterSeconds)
        $orphan = $null -ne $owner -and ((-not [bool]$identity.alive) -or (-not [bool]$identity.startMatches))
        $orphanSafe = $orphan -and ((-not [bool]$identity.alive) -or [bool]$stale)
        $operationId = [string](Get-ReleaseMaintenanceProperty $owner "operationId" "")
        $state = Get-ReleaseMaintenanceOperationState -Policy $Policy -OperationId $operationId
        $terminal = $null -eq $state -or [bool]$state.terminal
        if (-not $orphanSafe -or -not $terminal) {
            throw "Lock metadata is not safely orphaned (stale=$stale orphan=$orphan terminal=$terminal operationId=$operationId)."
        }

        $archiveRoot = Join-Path ([string]$Policy.reservationRoot) "archive"
        New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
        $stamp = [DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
        $digest = if ($rawBytes.Length -eq 0) { "empty" } else { (Get-ReleaseMaintenanceBytesSha256 -Bytes $rawBytes).Substring(0, 16) }
        $backupPath = Join-Path $archiveRoot "orphan-lock-$stamp-$digest.json"
        $backup = [ordered]@{
            schemaVersion = 1
            kind = "orphan-lock-metadata-backup"
            lockPath = $lockPath
            operationId = $operationId
            owner = $owner
            embeddedBytesBase64 = [Convert]::ToBase64String($rawBytes)
            ownerSidecar = if ($null -eq $sidecar) { $null } else { $sidecar }
            pendingSidecarPath = $pendingPath
            capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
            reason = "exclusive lock available; stale orphan metadata; operation terminal"
        }
        [void](Write-ReleaseMaintenanceJsonImmutable -Path $backupPath -Value $backup)
        $stream.SetLength(0)
        $stream.Flush()
        if (Test-Path -LiteralPath $ownerPath -PathType Leaf) { Remove-Item -LiteralPath $ownerPath -Force }
        if (Test-Path -LiteralPath $pendingPath -PathType Leaf) { Remove-Item -LiteralPath $pendingPath -Force }
        return [pscustomobject][ordered]@{
            action = "cleanup-lock"
            changed = $true
            lockPath = $lockPath
            operationId = $operationId
            backupPath = $backupPath
            ownerRemoved = $true
            pendingRemoved = $true
            safeToCleanup = $true
        }
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Invoke-ReleaseMaintenanceCli {
    param(
        [ValidateSet("status", "archive-reservations", "inspect-lock", "cleanup-lock")][string]$Action = "status",
        [string]$PolicyPath = "",
        [ValidateRange(0, 8760)][int]$OlderThanHours = 24,
        [switch]$IncludeRecent,
        [switch]$ConfirmCleanup,
        [switch]$Json,
        [ValidateRange(1, 7200)][int]$LockWaitSeconds = 1800
    )
    $policy = Get-ReleaseMaintenancePolicy -PolicyPath $PolicyPath
    $queueWait = if ($policy.queue.PSObject.Properties["waitSeconds"]) { [int]$policy.queue.waitSeconds } else { $LockWaitSeconds }
    $queuePoll = if ($policy.queue.PSObject.Properties["pollMilliseconds"]) { [int]$policy.queue.pollMilliseconds } else { 500 }
    $staleAfter = if ($policy.queue.PSObject.Properties["staleAfterSeconds"]) { [int]$policy.queue.staleAfterSeconds } else { 600 }
    switch ($Action) {
        "status" {
            $result = [pscustomobject][ordered]@{
                action = "status"
                reservations = @(Get-ReleaseMaintenanceReservationInventory -Policy $policy)
                lock = Get-ReleaseLockInspection -Policy $policy -StaleAfterSeconds $staleAfter
                checkedAt = [DateTimeOffset]::UtcNow.ToString("o")
            }
        }
        "inspect-lock" { $result = Get-ReleaseLockInspection -Policy $policy -StaleAfterSeconds $staleAfter }
        "archive-reservations" {
            $lock = $null
            try {
                $lock = Enter-ReleaseLock -ProjectPath ([string]$policy.canonicalRepo) -TargetVersion "maintenance" -TargetType "release-maintenance" -WaitSeconds ([Math]::Max($LockWaitSeconds, $queueWait)) -LockPath ([string]$policy.lockPath) -ProjectId "maintenance" -LeaseSeconds 180 -Stage "maintenance"
                $result = Invoke-ReleaseReservationArchive -Policy $policy -OlderThanHours $OlderThanHours -IncludeRecent:$IncludeRecent
            }
            finally { if ($null -ne $lock) { Exit-ReleaseLock -LockHandle $lock } }
        }
        "cleanup-lock" {
            $result = Invoke-ReleaseOrphanLockMetadataCleanup -Policy $policy -ConfirmCleanup:$ConfirmCleanup -StaleAfterSeconds $staleAfter
        }
    }
    if ($Json) {
        $result | ConvertTo-Json -Depth 30
        return
    }
    else {
        Write-Host ("Action: {0}" -f $result.action)
        if ($result.PSObject.Properties["archivedCount"]) { Write-Host ("Archived reservations: {0}" -f $result.archivedCount) }
        if ($result.PSObject.Properties["safeToCleanup"]) { Write-Host ("Safe to cleanup: {0}" -f $result.safeToCleanup) }
        if ($result.PSObject.Properties["changed"]) { Write-Host ("Changed: {0}" -f $result.changed) }
        $result | ConvertTo-Json -Depth 30
    }
    return $result
}

if (-not $script:ReleaseMaintenanceDotSourced) {
    Invoke-ReleaseMaintenanceCli -Action $Action -PolicyPath $PolicyPath -OlderThanHours $OlderThanHours -IncludeRecent:$IncludeRecent -ConfirmCleanup:$ConfirmCleanup -Json:$Json -LockWaitSeconds $LockWaitSeconds
}
