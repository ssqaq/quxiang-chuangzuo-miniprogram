[CmdletBinding()]
param(
    # Prefix the implementation variables.  This script is frequently
    # dot-sourced by release.ps1/resume-release.ps1; common public parameter
    # names such as $OperationId and $Version would otherwise overwrite the
    # caller's variables with their default values.  Aliases keep the CLI
    # contract unchanged (pwsh -File release-queue.ps1 -OperationId ...).
    [Alias("Action")][string]$RQAction = "",
    [Alias("QueueRoot")][string]$RQQueueRoot = "",
    [Alias("QueuePath")][string]$RQQueuePath = "",
    [Alias("TicketId")][string]$RQTicketId = "",
    [Alias("OperationId")][string]$RQOperationId = "",
    [Alias("IdempotencyKey")][string]$RQIdempotencyKey = "",
    [Alias("RequestedVersion")][string]$RQRequestedVersion = "",
    [Alias("SourceSha256")][string]$RQSourceSha256 = "",
    [Alias("IncludePath")][string[]]$RQIncludePath = @(),
    [Alias("SourcePath")][string]$RQSourcePath = "",
    [Alias("CreatedBy")][string]$RQCreatedBy = "",
    [Alias("Phase")][string]$RQPhase = "",
    [Alias("Version")][string]$RQVersion = "",
    [Alias("BaseHead")][string]$RQBaseHead = "",
    [Alias("ContextPath")][string]$RQContextPath = "",
    [Alias("ReservationPath")][string]$RQReservationPath = "",
    [Alias("ErrorMessage")][string]$RQErrorMessage = "",
    [Alias("Priority")][int]$RQPriority = 0,
    [Alias("MaxAttempts")][int]$RQMaxAttempts = 3,
    [Alias("LeaseOwner")][string]$RQLeaseOwner = "",
    [Alias("LeaseId")][string]$RQLeaseId = "",
    [Alias("LeaseSeconds")][int]$RQLeaseSeconds = 300,
    [Alias("AllowPrepared")][switch]$RQAllowPrepared,
    [Alias("WaitSeconds")][int]$RQWaitSeconds = 1800,
    [Alias("PollMilliseconds")][int]$RQPollMilliseconds = 250,
    [Alias("Status")][string]$RQStatus = "",
    [Alias("Reason")][string]$RQReason = "",
    [Alias("MetadataJson")][string]$RQMetadataJson = "",
    [Alias("Limit")][int]$RQLimit = 0,
    [Alias("AllowOutOfOrder")][switch]$RQAllowOutOfOrder,
    [Alias("Retry")][switch]$RQRetry,
    [Alias("RecoverExpired")][switch]$RQRecoverExpired,
    [Alias("Force")][switch]$RQForce,
    [Alias("Json")][switch]$RQJson
)

Set-StrictMode -Version Latest

# 持久发布队列。这个文件只负责队列状态，不会直接调用 release-gate.ps1。
# 所有写操作都先拿独立的 OS 文件锁，再用同目录临时文件原子替换 queue.json。

$script:ReleaseQueueSchemaVersion = 1
$script:ReleaseQueueActiveStatuses = @("leased", "running")
$script:ReleaseQueueTerminalStatuses = @("succeeded", "failed", "cancelled", "expired", "recoverable")
$script:ReleaseQueueStatuses = @("queued", "leased", "running", "succeeded", "failed", "cancelled", "expired", "recoverable")
$script:ReleaseQueueTransitions = @{
    queued = @("leased", "cancelled", "failed", "recoverable")
    leased = @("running", "queued", "succeeded", "failed", "cancelled", "expired", "recoverable")
    running = @("succeeded", "failed", "queued", "cancelled", "expired", "recoverable")
    succeeded = @()
    failed = @("queued", "cancelled")
    cancelled = @()
    expired = @("queued", "cancelled")
    recoverable = @("queued", "cancelled")
}

# 不依赖 $script: 变量。脚本既可以直接运行，也会被 release.ps1
# dot-source；在后一种模式下 $script: 可能指向调用方脚本，所以状态常量
# 通过函数返回，避免被调用方同名变量遮蔽。
function Get-ReleaseQueueStatusList {
    return @("queued", "leased", "running", "succeeded", "failed", "cancelled", "expired", "recoverable")
}

function Get-ReleaseQueueActiveStatusList {
    return @("leased", "running")
}

function Get-ReleaseQueueTerminalStatusList {
    return @("succeeded", "failed", "cancelled", "expired", "recoverable")
}

function Get-ReleaseQueueAllowedTransitions {
    param([Parameter(Mandatory = $true)][string]$From)
    switch ($From) {
        "queued" { return @("leased", "cancelled", "failed", "recoverable") }
        "leased" { return @("running", "queued", "succeeded", "failed", "cancelled", "expired", "recoverable") }
        "running" { return @("succeeded", "failed", "queued", "cancelled", "expired", "recoverable") }
        "failed" { return @("queued", "cancelled", "recoverable") }
        "expired" { return @("queued", "cancelled", "recoverable") }
        "recoverable" { return @("queued", "cancelled") }
        default { return @() }
    }
}

function Normalize-ReleaseQueueStatusInput {
    param([Parameter(Mandatory = $true)][string]$Status)
    $value = $Status.Trim().ToLowerInvariant()
    # release.ps1 的阶段名称保留在 phase 字段，主状态统一归到 running，
    # 这样旧调用传 reserved/prepared/pr-opened/merged/deployed/previewed/
    # finalizing 不会被误判成新终态。
    $phaseAliases = @("reserved", "prepared", "pr-opened", "merged", "deployed", "previewed", "finalizing")
    if ($phaseAliases -contains $value) {
        return [pscustomobject]@{ status = "running"; phase = $value }
    }
    if ((Get-ReleaseQueueStatusList) -contains $value) {
        return [pscustomobject]@{ status = $value; phase = "" }
    }
    throw "未知队列状态：$Status"
}

function Sync-ReleaseQueueLeaseObject {
    param([Parameter(Mandatory = $true)][object]$Ticket)
    $Ticket.lease = [pscustomobject][ordered]@{
        id = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "leaseId" -Default "")
        owner = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "leaseOwner" -Default "")
        expiresAt = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "leaseExpiresAt" -Default "")
        heartbeatAt = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "lastHeartbeatAt" -Default "")
    }
    return $Ticket
}

function ConvertTo-ReleaseQueueFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Get-ReleaseQueueDefaultRoot {
    $repoRoot = ConvertTo-ReleaseQueueFullPath -Path (Join-Path $PSScriptRoot "..")
    return Join-Path (Split-Path $repoRoot -Parent) "wechat-miniapp-release-queue"
}

function Get-ReleaseQueuePaths {
    [CmdletBinding()]
    param(
        [string]$QueueRoot = "",
        [string]$QueuePath = ""
    )

    $root = if ([string]::IsNullOrWhiteSpace($QueueRoot)) {
        Get-ReleaseQueueDefaultRoot
    }
    else {
        ConvertTo-ReleaseQueueFullPath -Path $QueueRoot
    }

    $statePath = if ([string]::IsNullOrWhiteSpace($QueuePath)) {
        Join-Path $root "queue.json"
    }
    elseif ([IO.Path]::IsPathRooted($QueuePath)) {
        ConvertTo-ReleaseQueueFullPath -Path $QueuePath
    }
    else {
        ConvertTo-ReleaseQueueFullPath -Path (Join-Path $root $QueuePath)
    }

    $stateParent = Split-Path $statePath -Parent
    return [pscustomobject]@{
        QueueRoot = $root
        QueuePath = $statePath
        LockPath = "$statePath.lock"
        OwnerPath = "$statePath.lock.owner.json"
        EventLogPath = Join-Path $stateParent "events.jsonl"
    }
}

function Get-ReleaseQueueProperty {
    param(
        [object]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [object]$Default = $null
    )
    if ($null -eq $Object) {
        return $Default
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $Default
    }
    return $property.Value
}

function ConvertTo-ReleaseQueueUtcDateTime {
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
        throw "队列时间值为空。"
    }
    try {
        # Historical context files used DateTime.UtcNow.ToString("o"), which
        # contains a UTC clock value but no offset.  Treat an offset-less value
        # as UTC instead of the machine's local timezone; otherwise a Beijing
        # host would move an expiry eight hours into the past on every scan.
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
        throw "队列时间值无效：$text。$($_.Exception.Message)"
    }
}

function Get-ReleaseQueueNowText {
    return [DateTimeOffset]::UtcNow.ToString("o")
}

function Assert-ReleaseQueueOperationId {
    param([Parameter(Mandatory = $true)][string]$Value)
    $trimmed = $Value.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.Length -gt 200 -or $trimmed -match '[\\/\r\n]') {
        throw "operationId 为空、过长或包含路径字符：$Value"
    }
    return $trimmed
}

function Assert-ReleaseQueueSemVer {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }
    $trimmed = $Value.Trim()
    if ($trimmed -notmatch '^\d+\.\d+\.\d+$') {
        throw "requestedVersion 必须是三段式版本号：$Value"
    }
    return $trimmed
}

function Assert-ReleaseQueueSha256 {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }
    $trimmed = $Value.Trim().ToLowerInvariant()
    if ($trimmed -notmatch '^[0-9a-f]{64}$') {
        throw "sourceSha256 必须是 64 位十六进制字符串：$Value"
    }
    return $trimmed
}

function Normalize-ReleaseQueueIncludePaths {
    param([object[]]$InputPath = @())

    $result = New-Object System.Collections.Generic.List[string]
    foreach ($rawItem in @($InputPath)) {
        if ($null -eq $rawItem) {
            throw "IncludePath 不能包含空值。"
        }
        $raw = ([string]$rawItem).Trim()
        if ($raw.Contains(',')) {
            $parts = $raw.Split(',')
        }
        else {
            $parts = @($raw)
        }
        foreach ($part in $parts) {
            $value = ([string]$part).Trim()
            if ([string]::IsNullOrWhiteSpace($value)) {
                throw "IncludePath 不能包含空项。"
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
            if ($normalized -match '(^|/)\.(?:git|worktrees)(?:/|$)' -or $normalized -match '[*?\[\]]') {
                throw "IncludePath 不允许指向 Git 内部目录或使用通配符：$value"
            }
            if ($normalized -match '(^|/)(?:\.env(?:\..*)?|.*(?:secret|apikey|api_key|appsecret|private.key).*)$') {
                throw "IncludePath 疑似包含敏感文件，已拒绝：$value"
            }
            if (-not $result.Contains($normalized)) {
                [void]$result.Add($normalized)
            }
        }
    }
    return [string[]]$result.ToArray()
}

function Assert-ReleaseQueueMetadataSafe {
    param(
        [object]$Value,
        [string]$Path = "metadata"
    )
    if ($null -eq $Value) {
        return
    }
    $sensitive = '(?i)(password|secret|token|apikey|api_key|privatekey|accesskey|authorization|cookie|credential)'
    if ($Value -is [Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            $keyText = [string]$key
            if ($keyText -match $sensitive) {
                throw "队列 metadata 禁止保存敏感字段：$Path.$keyText"
            }
            Assert-ReleaseQueueMetadataSafe -Value $Value[$key] -Path "$Path.$keyText"
        }
        return
    }
    if ($Value -is [PSCustomObject]) {
        foreach ($property in $Value.PSObject.Properties) {
            if ($property.Name -match $sensitive) {
                throw "队列 metadata 禁止保存敏感字段：$Path.$($property.Name)"
            }
            Assert-ReleaseQueueMetadataSafe -Value $property.Value -Path "$Path.$($property.Name)"
        }
        return
    }
    if ($Value -is [Collections.IEnumerable] -and -not ($Value -is [string])) {
        $index = 0
        foreach ($item in $Value) {
            Assert-ReleaseQueueMetadataSafe -Value $item -Path "$Path[$index]"
            $index += 1
        }
    }
}

function ConvertTo-ReleaseQueueCanonicalValue {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [DateTimeOffset]) {
        return $Value.ToUniversalTime().ToString("o")
    }
    if ($Value -is [DateTime]) {
        $utcValue = if ($Value.Kind -eq [DateTimeKind]::Unspecified) {
            [DateTime]::SpecifyKind($Value, [DateTimeKind]::Utc)
        }
        else {
            $Value.ToUniversalTime()
        }
        return $utcValue.ToString("o")
    }
    if ($Value -is [Collections.IDictionary]) {
        $entries = @(
            foreach ($entry in $Value.GetEnumerator()) {
                [pscustomobject]@{ key = [string]$entry.Key; value = $entry.Value }
            }
        )
        $ordered = [ordered]@{}
        foreach ($entry in @($entries | Sort-Object -Property key)) {
            $ordered[[string]$entry.key] = ConvertTo-ReleaseQueueCanonicalValue -Value $entry.value
        }
        return [pscustomobject]$ordered
    }
    if ($Value -is [PSCustomObject]) {
        $entries = @(
            foreach ($property in $Value.PSObject.Properties) {
                [pscustomobject]@{ key = [string]$property.Name; value = $property.Value }
            }
        )
        $ordered = [ordered]@{}
        foreach ($entry in @($entries | Sort-Object -Property key)) {
            $ordered[[string]$entry.key] = ConvertTo-ReleaseQueueCanonicalValue -Value $entry.value
        }
        return [pscustomobject]$ordered
    }
    if ($Value -is [Collections.IEnumerable] -and -not ($Value -is [string])) {
        return @($Value | ForEach-Object { ConvertTo-ReleaseQueueCanonicalValue -Value $_ })
    }
    return $Value
}

function ConvertTo-ReleaseQueueCanonicalJson {
    param([object]$Value)
    $canonical = ConvertTo-ReleaseQueueCanonicalValue -Value $Value
    if ($null -eq $canonical) {
        return "null"
    }
    return ($canonical | ConvertTo-Json -Depth 50 -Compress)
}

function Normalize-ReleaseQueueSourcePath {
    param([string]$Value = "")
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }
    $trimmed = $Value.Trim()
    try {
        $full = [IO.Path]::GetFullPath($trimmed)
        return $full.TrimEnd('\', '/')
    }
    catch {
        return $trimmed.Replace('\', '/')
    }
}

function Test-ReleaseQueueSourcePathEqual {
    param(
        [string]$Left = "",
        [string]$Right = ""
    )
    $leftValue = Normalize-ReleaseQueueSourcePath -Value $Left
    $rightValue = Normalize-ReleaseQueueSourcePath -Value $Right
    $comparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    return [string]::Equals($leftValue, $rightValue, $comparison)
}

function Get-ReleaseQueueFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$OperationId,
        [string]$RequestedVersion = "",
        [string]$SourceSha256 = "",
        [string[]]$IncludePath = @(),
        [int]$Priority = 0,
        [int]$MaxAttempts = 3,
        [string]$Version = "",
        [string]$SourcePath = "",
        [object]$Metadata = $null,
        [switch]$Legacy
    )
    if ($Legacy) {
        $payload = @(
            $OperationId,
            $RequestedVersion,
            $SourceSha256,
            (@($IncludePath) -join [Environment]::NewLine),
            [string]$Priority,
            [string]$MaxAttempts
        ) -join [Environment]::NewLine
    }
    else {
        $sourceKey = Normalize-ReleaseQueueSourcePath -Value $SourcePath
        if ([IO.Path]::DirectorySeparatorChar -eq '\') { $sourceKey = $sourceKey.ToLowerInvariant() }
        $metadataKey = ConvertTo-ReleaseQueueCanonicalJson -Value $Metadata
        $payload = @(
            "release-queue-fingerprint-v2",
            $OperationId,
            $RequestedVersion,
            $SourceSha256,
            (@($IncludePath) -join [Environment]::NewLine),
            [string]$Priority,
            [string]$MaxAttempts,
            $Version,
            $sourceKey,
            $metadataKey
        ) -join [Environment]::NewLine
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($payload)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Test-ReleaseQueueLegacyRequestCompatible {
    param(
        [Parameter(Mandatory = $true)][object]$Existing,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RequestedVersion,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$SourceSha256,
        [AllowEmptyCollection()][string[]]$IncludePath = @(),
        [Parameter(Mandatory = $true)][int]$Priority,
        [Parameter(Mandatory = $true)][int]$MaxAttempts,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Version,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$SourcePath,
        [object]$Metadata = $null
    )
    if ([string](Get-ReleaseQueueProperty -Object $Existing -Name "requestedVersion" -Default "") -ne $RequestedVersion) { return $false }
    if ([string](Get-ReleaseQueueProperty -Object $Existing -Name "sourceSha256" -Default "") -ne $SourceSha256) { return $false }
    if ([int](Get-ReleaseQueueProperty -Object $Existing -Name "priority" -Default 0) -ne $Priority) { return $false }
    if ([int](Get-ReleaseQueueProperty -Object $Existing -Name "maxAttempts" -Default 3) -ne $MaxAttempts) { return $false }
    try {
        $storedIncludePaths = @(Get-ReleaseQueueProperty -Object $Existing -Name "includePaths" -Default @())
        # A short-lived pre-v2 build serialized an empty array as [null].
        # Treat that legacy shape as an empty list while still rejecting any
        # real empty item supplied by a new request.
        if ($storedIncludePaths.Count -eq 1 -and $null -eq $storedIncludePaths[0]) {
            $storedIncludePaths = @()
        }
        $existingPaths = Normalize-ReleaseQueueIncludePaths -InputPath $storedIncludePaths
        if ($null -eq $existingPaths) { $existingPaths = New-Object System.String[] 0 }
    }
    catch {
        return $false
    }
    if ((@($existingPaths) -join [Environment]::NewLine) -ne (@($IncludePath) -join [Environment]::NewLine)) { return $false }

    $existingVersion = [string](Get-ReleaseQueueProperty -Object $Existing -Name "version" -Default "")
    if ([string]::IsNullOrWhiteSpace($existingVersion)) {
        $existingVersion = [string](Get-ReleaseQueueProperty -Object $Existing -Name "requestedVersion" -Default "")
    }
    if ($existingVersion -ne $Version) { return $false }
    if (-not (Test-ReleaseQueueSourcePathEqual -Left ([string](Get-ReleaseQueueProperty -Object $Existing -Name "sourcePath" -Default "")) -Right $SourcePath)) { return $false }
    try {
        $existingMetadata = Get-ReleaseQueueProperty -Object $Existing -Name "metadata" -Default $null
        if ((ConvertTo-ReleaseQueueCanonicalJson -Value $existingMetadata) -ne (ConvertTo-ReleaseQueueCanonicalJson -Value $Metadata)) { return $false }
    }
    catch {
        return $false
    }
    return $true
}

function New-ReleaseQueueState {
    $now = Get-ReleaseQueueNowText
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        queueId = "queue-$([guid]::NewGuid().ToString('N'))"
        createdAt = $now
        updatedAt = $now
        nextSequence = 1
        tickets = @()
    }
}

function Ensure-ReleaseQueueTicketShape {
    param([Parameter(Mandatory = $true)][object]$Ticket)

    $defaults = [ordered]@{
        status = "queued"
        phase = "queued"
        # 1 = legacy fingerprint (pre-v2 tickets); newly-created tickets use 2.
        requestFingerprintVersion = 1
        version = ""
        baseHead = ""
        contextPath = ""
        reservationPath = ""
        priority = 0
        attempt = 0
        maxAttempts = 3
        takeoverCount = 0
        leaseId = ""
        leaseOwner = ""
        leaseExpiresAt = ""
        lastHeartbeatAt = ""
        leaseSeconds = 300
        lastError = ""
        includePaths = @()
        metadata = $null
        lease = [pscustomobject][ordered]@{ id = ""; owner = ""; expiresAt = ""; heartbeatAt = "" }
    }
    foreach ($entry in $defaults.GetEnumerator()) {
        if ($null -eq $Ticket.PSObject.Properties[$entry.Key]) {
            $Ticket | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value
        }
    }
    if ([string]::IsNullOrWhiteSpace([string](Get-ReleaseQueueProperty -Object $Ticket -Name "phase" -Default ""))) {
        $Ticket.phase = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "status" -Default "queued")
    }
    if ([string]::IsNullOrWhiteSpace([string](Get-ReleaseQueueProperty -Object $Ticket -Name "leaseId" -Default ""))) {
        $leaseObject = Get-ReleaseQueueProperty -Object $Ticket -Name "lease" -Default $null
        if ($null -ne $leaseObject) {
            $Ticket.leaseId = [string](Get-ReleaseQueueProperty -Object $leaseObject -Name "id" -Default "")
            $Ticket.leaseOwner = [string](Get-ReleaseQueueProperty -Object $leaseObject -Name "owner" -Default "")
            $Ticket.leaseExpiresAt = [string](Get-ReleaseQueueProperty -Object $leaseObject -Name "expiresAt" -Default "")
            $Ticket.lastHeartbeatAt = [string](Get-ReleaseQueueProperty -Object $leaseObject -Name "heartbeatAt" -Default "")
        }
    }
    [void](Sync-ReleaseQueueLeaseObject -Ticket $Ticket)
    return $Ticket
}

function Read-ReleaseQueueState {
    param([Parameter(Mandatory = $true)][object]$Paths)

    if (-not (Test-Path -LiteralPath $Paths.QueuePath -PathType Leaf)) {
        return New-ReleaseQueueState
    }
    try {
        $raw = Get-Content -LiteralPath $Paths.QueuePath -Raw -Encoding UTF8
        $state = $raw | ConvertFrom-Json
    }
    catch {
        throw "发布队列文件不是有效 JSON：$($Paths.QueuePath)。$($_.Exception.Message)"
    }
    $schema = [int](Get-ReleaseQueueProperty -Object $state -Name "schemaVersion" -Default 0)
    if ($schema -ne 1) {
        throw "发布队列 schemaVersion 不支持：$schema"
    }
    if ($null -eq $state.PSObject.Properties["tickets"]) {
        $state | Add-Member -NotePropertyName tickets -NotePropertyValue @()
    }
    $state.tickets = @($state.tickets | ForEach-Object { Ensure-ReleaseQueueTicketShape -Ticket $_ })
    $maxSequence = 0
    foreach ($ticket in @($state.tickets)) {
        $sequence = [int64](Get-ReleaseQueueProperty -Object $ticket -Name "sequence" -Default 0)
        if ($sequence -gt $maxSequence) {
            $maxSequence = $sequence
        }
    }
    $nextSequence = [int64](Get-ReleaseQueueProperty -Object $state -Name "nextSequence" -Default ($maxSequence + 1))
    if ($nextSequence -le $maxSequence) {
        $nextSequence = $maxSequence + 1
    }
    if ($nextSequence -lt 1) {
        $nextSequence = 1
    }
    if ($null -eq $state.PSObject.Properties["nextSequence"]) {
        $state | Add-Member -NotePropertyName nextSequence -NotePropertyValue $nextSequence
    }
    else {
        $state.nextSequence = $nextSequence
    }
    return $state
}

function Write-ReleaseQueueStateAtomic {
    param(
        [Parameter(Mandatory = $true)][object]$Paths,
        [Parameter(Mandatory = $true)][object]$State
    )

    $parent = Split-Path $Paths.QueuePath -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $State.updatedAt = Get-ReleaseQueueNowText
    $json = $State | ConvertTo-Json -Depth 40
    $temp = Join-Path $parent (".{0}.{1}.{2}.tmp" -f (Split-Path $Paths.QueuePath -Leaf), $PID, [guid]::NewGuid().ToString('N'))
    $backup = Join-Path $parent (".{0}.{1}.{2}.replace.bak" -f (Split-Path $Paths.QueuePath -Leaf), $PID, [guid]::NewGuid().ToString('N'))
    $encoding = [Text.UTF8Encoding]::new($false)
    $stream = $null
    try {
        $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $bytes = $encoding.GetBytes($json + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
    try {
        if (Test-Path -LiteralPath $Paths.QueuePath -PathType Leaf) {
            try {
                [IO.File]::Replace($temp, $Paths.QueuePath, $backup, $true)
            }
            catch [PlatformNotSupportedException] {
                # 某些文件系统不支持 Replace；同卷 Move 仍在队列互斥锁内完成。
                [IO.File]::Move($temp, $Paths.QueuePath, $true)
            }
            catch [NotSupportedException] { [IO.File]::Move($temp, $Paths.QueuePath, $true) }
        }
        else {
            [IO.File]::Move($temp, $Paths.QueuePath)
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

function Write-ReleaseQueueEvent {
    param(
        [Parameter(Mandatory = $true)][object]$Paths,
        [Parameter(Mandatory = $true)][object]$Event
    )
    $parent = Split-Path $Paths.EventLogPath -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $line = $Event | ConvertTo-Json -Depth 20 -Compress
    [IO.File]::AppendAllText($Paths.EventLogPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function New-ReleaseQueueEvent {
    param(
        [string]$Type,
        [object]$Ticket,
        [string]$FromStatus = "",
        [string]$ToStatus = "",
        [string]$Actor = "",
        [string]$Reason = "",
        [hashtable]$Details = @{}
    )
    $event = [ordered]@{
        schemaVersion = 1
        eventId = "event-$([guid]::NewGuid().ToString('N'))"
        at = Get-ReleaseQueueNowText
        type = $Type
        ticketId = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "ticketId" -Default "")
        operationId = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "operationId" -Default "")
        fromStatus = $FromStatus
        toStatus = $ToStatus
        actor = $Actor
        reason = $Reason
    }
    foreach ($entry in $Details.GetEnumerator()) {
        if (-not $event.Contains($entry.Key)) {
            $event[$entry.Key] = $entry.Value
        }
    }
    return [pscustomobject]$event
}

function Enter-ReleaseQueueStoreLock {
    param(
        [Parameter(Mandatory = $true)][object]$Paths,
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250,
        [string]$OperationId = ""
    )

    $parent = Split-Path $Paths.LockPath -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $lockToken = [guid]::NewGuid().ToString('N')
    while ($true) {
        $stream = $null
        try {
            $stream = [IO.File]::Open(
                $Paths.LockPath,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None
            )
            $computer = if ([string]::IsNullOrWhiteSpace([string]$env:COMPUTERNAME)) { "localhost" } else { [string]$env:COMPUTERNAME }
            $owner = [ordered]@{
                pid = $PID
                host = $computer
                lockToken = $lockToken
                operationId = $OperationId
                acquiredAt = Get-ReleaseQueueNowText
            }
            $ownerJson = $owner | ConvertTo-Json -Depth 8
            [IO.File]::WriteAllText($Paths.OwnerPath, $ownerJson, [Text.UTF8Encoding]::new($false))
            return [pscustomobject]@{
                Stream = $stream
                LockToken = $lockToken
                OwnerPath = $Paths.OwnerPath
            }
        }
        catch [IO.IOException] {
            if ($null -ne $stream) {
                $stream.Dispose()
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                $ownerSummary = "占用者信息不可用"
                if (Test-Path -LiteralPath $Paths.OwnerPath -PathType Leaf) {
                    try {
                        $owner = Get-Content -LiteralPath $Paths.OwnerPath -Raw -Encoding UTF8 | ConvertFrom-Json
                        $ownerSummary = "PID=$($owner.pid)，主机=$($owner.host)，操作=$($owner.operationId)，取得=$($owner.acquiredAt)"
                    }
                    catch {
                        $ownerSummary = "占用者信息损坏"
                    }
                }
                throw "release queue lock timed out / 发布队列锁等待超时（${WaitSeconds}秒）。当前占用者：$ownerSummary"
            }
            Start-Sleep -Milliseconds $PollMilliseconds
        }
        catch {
            if ($null -ne $stream) {
                $stream.Dispose()
            }
            throw
        }
    }
}

function Exit-ReleaseQueueStoreLock {
    param([object]$LockHandle)
    if ($null -eq $LockHandle) {
        return
    }
    try {
        if (Test-Path -LiteralPath $LockHandle.OwnerPath -PathType Leaf) {
            try {
                $owner = Get-Content -LiteralPath $LockHandle.OwnerPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ([int]$owner.pid -eq $PID -and [string]$owner.lockToken -eq [string]$LockHandle.LockToken) {
                    Remove-Item -LiteralPath $LockHandle.OwnerPath -Force -ErrorAction SilentlyContinue
                }
            }
            catch {
                # 锁文件本身仍会在 finally 中释放；损坏的 owner sidecar 不阻塞下一次取得锁。
            }
        }
    }
    finally {
        if ($null -ne $LockHandle.Stream) {
            $LockHandle.Stream.Dispose()
        }
    }
}

function New-ReleaseQueueOutcome {
    param(
        [object]$Result,
        [bool]$Changed = $true,
        [object[]]$Events = @()
    )
    return [pscustomobject]@{
        __queueOutcome = $true
        result = $Result
        changed = $Changed
        events = @($Events)
    }
}

function Invoke-ReleaseQueueTransaction {
    param(
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [switch]$ReadOnly,
        [string]$OperationId = "",
        [int]$WaitSeconds = 1800,
        [int]$PollMilliseconds = 250
    )

    $paths = Get-ReleaseQueuePaths -QueueRoot $QueueRoot -QueuePath $QueuePath
    $lock = Enter-ReleaseQueueStoreLock -Paths $paths -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -OperationId $OperationId
    try {
        $state = Read-ReleaseQueueState -Paths $paths
        # 不使用 GetNewClosure：它会创建一个只捕获变量的动态模块，
        # dot-source 调用时该模块看不到本脚本的 helper，嵌套
        # Where-Object/ForEach-Object 就会误报“找不到函数”。这里从事务
        # 调用方快照 action AST 实际引用的变量，再在一个普通子作用域中
        # 执行 action；函数命令沿动态作用域可见，变量也不会串到下一单。
        $captured = @{}
        $variableNodes = @($Action.Ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.VariableExpressionAst]
            }, $true))
        foreach ($node in $variableNodes) {
            $name = [string]$node.VariablePath.UserPath
            if ([string]::IsNullOrWhiteSpace($name) -or $name -in @("_", "this", "input", "args", "PSItem", "null", "true", "false")) {
                continue
            }
            if ($captured.ContainsKey($name)) {
                continue
            }
            $callerVariable = Get-Variable -Name $name -Scope 1 -ErrorAction SilentlyContinue
            if ($null -ne $callerVariable) {
                $readonlyMask = [System.Management.Automation.ScopedItemOptions]::ReadOnly -bor [System.Management.Automation.ScopedItemOptions]::Constant
                if (($callerVariable.Options -band $readonlyMask) -ne [System.Management.Automation.ScopedItemOptions]::None) {
                    continue
                }
                $captured[$name] = $callerVariable.Value
            }
        }
        $invokeAction = {
            param($invokeBlock, $invokeState, $invokePaths, $invokeVariables)
            foreach ($entry in $invokeVariables.GetEnumerator()) {
                Set-Variable -Name ([string]$entry.Key) -Value $entry.Value -Scope 0 -Force
            }
            & $invokeBlock $invokeState $invokePaths
        }
        $raw = @(& $invokeAction $Action $state $paths $captured)
        $outcome = $null
        if ($raw.Count -eq 1 -and $null -ne $raw[0] -and $null -ne $raw[0].PSObject.Properties["__queueOutcome"]) {
            $outcome = $raw[0]
        }
        else {
            $outcome = New-ReleaseQueueOutcome -Result $(if ($raw.Count -eq 0) { $null } elseif ($raw.Count -eq 1) { $raw[0] } else { $raw }) -Changed (-not $ReadOnly)
        }
        $changed = [bool](Get-ReleaseQueueProperty -Object $outcome -Name "changed" -Default (-not $ReadOnly))
        if (-not $ReadOnly -and $changed) {
            Write-ReleaseQueueStateAtomic -Paths $paths -State $state
        }
        $events = @(Get-ReleaseQueueProperty -Object $outcome -Name "events" -Default @())
        foreach ($event in $events) {
            try {
                Write-ReleaseQueueEvent -Paths $paths -Event $event
            }
            catch {
                # 队列主状态已经原子落盘，审计日志失败不能触发重复占号。
            }
        }
        return (Get-ReleaseQueueProperty -Object $outcome -Name "result" -Default $null)
    }
    finally {
        Exit-ReleaseQueueStoreLock -LockHandle $lock
    }
}

function Get-ReleaseQueueTicketIndex {
    param(
        [Parameter(Mandatory = $true)][object]$State,
        [string]$TicketId = "",
        [string]$OperationId = "",
        [string]$IdempotencyKey = ""
    )
    $tickets = @($State.tickets)
    for ($index = 0; $index -lt $tickets.Count; $index += 1) {
        $ticket = $tickets[$index]
        if (-not [string]::IsNullOrWhiteSpace($TicketId) -and [string]$ticket.ticketId -eq $TicketId) {
            return $index
        }
        if (-not [string]::IsNullOrWhiteSpace($OperationId) -and [string]$ticket.operationId -eq $OperationId) {
            return $index
        }
        if (-not [string]::IsNullOrWhiteSpace($IdempotencyKey) -and [string]$ticket.idempotencyKey -eq $IdempotencyKey) {
            return $index
        }
    }
    return -1
}

function Copy-ReleaseQueueTicketResult {
    param(
        [Parameter(Mandatory = $true)][object]$Ticket,
        [bool]$WasReused = $false
    )
    $copy = [ordered]@{}
    foreach ($property in $Ticket.PSObject.Properties) {
        $copy[$property.Name] = $property.Value
    }
    $copy.wasReused = $WasReused
    return [pscustomobject]$copy
}

function Initialize-ReleaseQueueStore {
    [CmdletBinding(SupportsShouldProcess = $false)]
    param(
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [switch]$Force,
        [int]$WaitSeconds = 1800,
        [int]$PollMilliseconds = 250
    )
    $paths = Get-ReleaseQueuePaths -QueueRoot $QueueRoot -QueuePath $QueuePath
    $lock = Enter-ReleaseQueueStoreLock -Paths $paths -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
    try {
        if ((Test-Path -LiteralPath $paths.QueuePath -PathType Leaf) -and -not $Force) {
            return Read-ReleaseQueueState -Paths $paths
        }
        $state = New-ReleaseQueueState
        Write-ReleaseQueueStateAtomic -Paths $paths -State $state
        Write-ReleaseQueueEvent -Paths $paths -Event ([pscustomobject]@{
                schemaVersion = 1
                eventId = "event-$([guid]::NewGuid().ToString('N'))"
                at = Get-ReleaseQueueNowText
                type = "queue-initialized"
                ticketId = ""
                operationId = ""
                fromStatus = ""
                toStatus = ""
                actor = "release-queue"
                reason = if ($Force) { "force-reinitialize" } else { "initialize" }
            })
        return $state
    }
    finally {
        Exit-ReleaseQueueStoreLock -LockHandle $lock
    }
}

function New-ReleaseQueueTicket {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$OperationId,
        [string]$IdempotencyKey = "",
        [string]$RequestedVersion = "",
        [string]$SourceSha256 = "",
        [object[]]$IncludePath = @(),
        [string]$SourcePath = "",
        [string]$CreatedBy = "",
        [string]$Phase = "queued",
        [string]$Version = "",
        [string]$BaseHead = "",
        [string]$ContextPath = "",
        [string]$ReservationPath = "",
        [int]$Priority = 0,
        [ValidateRange(1, 100)][int]$MaxAttempts = 3,
        [object]$Metadata = $null,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )

    $operation = Assert-ReleaseQueueOperationId -Value $OperationId
    # Variable names are case-insensitive in PowerShell; do not call this
    # `$version` because the public `-Version` parameter would be overwritten.
    $requestedVersionValue = Assert-ReleaseQueueSemVer -Value $RequestedVersion
    $sha = Assert-ReleaseQueueSha256 -Value $SourceSha256
    $includePaths = Normalize-ReleaseQueueIncludePaths -InputPath $IncludePath
    # PowerShell unwraps an empty pipeline result to $null.  Keep a typed,
    # genuinely empty array so queue.json never receives includePaths:[null].
    if ($null -eq $includePaths) { $includePaths = New-Object System.String[] 0 }
    Assert-ReleaseQueueMetadataSafe -Value $Metadata
    $idempotency = if ([string]::IsNullOrWhiteSpace($IdempotencyKey)) { $operation } else { Assert-ReleaseQueueOperationId -Value $IdempotencyKey }
    $phaseValue = if ([string]::IsNullOrWhiteSpace($Phase)) { "queued" } else { $Phase.Trim().ToLowerInvariant() }
    if ($phaseValue -match '[\r\n]') { throw "phase 不能包含换行。" }
    $versionValue = if ([string]::IsNullOrWhiteSpace($Version)) { $requestedVersionValue } else { Assert-ReleaseQueueSemVer -Value $Version }
    $sourcePathValue = Normalize-ReleaseQueueSourcePath -Value $SourcePath
    $fingerprint = Get-ReleaseQueueFingerprint -OperationId $operation -RequestedVersion $requestedVersionValue -SourceSha256 $sha -IncludePath $includePaths -Priority $Priority -MaxAttempts $MaxAttempts -Version $versionValue -SourcePath $sourcePathValue -Metadata $Metadata
    $legacyFingerprint = Get-ReleaseQueueFingerprint -Legacy -OperationId $operation -RequestedVersion $requestedVersionValue -SourceSha256 $sha -IncludePath $includePaths -Priority $Priority -MaxAttempts $MaxAttempts

    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -OperationId $operation -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $tickets = @($state.tickets)
        $existingIndex = -1
        for ($index = 0; $index -lt $tickets.Count; $index += 1) {
            $candidate = $tickets[$index]
            if ([string]$candidate.operationId -eq $operation -or [string]$candidate.idempotencyKey -eq $idempotency) {
                $existingIndex = $index
                break
            }
        }
        if ($existingIndex -ge 0) {
            $existing = $tickets[$existingIndex]
            $existingFingerprint = [string](Get-ReleaseQueueProperty -Object $existing -Name "requestFingerprint" -Default "")
            $sameRequest = $existingFingerprint -eq $fingerprint
            # Tickets written by the pre-v2 helper have the legacy hash. Keep
            # them reusable only when every newly-bound field also matches;
            # changing publish flags, source or explicit version must fail.
            if (-not $sameRequest -and $existingFingerprint -eq $legacyFingerprint) {
                $sameRequest = Test-ReleaseQueueLegacyRequestCompatible -Existing $existing -RequestedVersion $requestedVersionValue -SourceSha256 $sha -IncludePath $includePaths -Priority $Priority -MaxAttempts $MaxAttempts -Version $versionValue -SourcePath $sourcePathValue -Metadata $Metadata
            }
            if (-not $sameRequest) {
                throw "队列幂等键冲突：operationId/idempotencyKey 已对应不同请求。"
            }
            return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $existing -WasReused $true) -Changed $false
        }

        $now = Get-ReleaseQueueNowText
        $sequence = [int64](Get-ReleaseQueueProperty -Object $state -Name "nextSequence" -Default 1)
        $ticket = [pscustomobject][ordered]@{
            schemaVersion = 1
            ticketId = "ticket-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
            operationId = $operation
            idempotencyKey = $idempotency
            requestFingerprint = $fingerprint
            requestFingerprintVersion = 2
            sequence = $sequence
            createdAt = $now
            updatedAt = $now
            status = "queued"
            requestedVersion = $requestedVersionValue
            sourceSha256 = $sha
            includePaths = @($includePaths)
            sourcePath = $sourcePathValue
            createdBy = $CreatedBy
            phase = $phaseValue
            version = $versionValue
            baseHead = $BaseHead
            contextPath = $ContextPath
            reservationPath = $ReservationPath
            priority = $Priority
            attempt = 0
            maxAttempts = $MaxAttempts
            takeoverCount = 0
            leaseId = ""
            leaseOwner = ""
            leaseExpiresAt = ""
            lastHeartbeatAt = ""
            leaseSeconds = 300
            lastError = ""
            metadata = $Metadata
            lease = [pscustomobject][ordered]@{ id = ""; owner = ""; expiresAt = ""; heartbeatAt = "" }
        }
        $state.tickets = @($tickets + $ticket)
        $state.nextSequence = $sequence + 1
        $event = New-ReleaseQueueEvent -Type "ticket-created" -Ticket $ticket -ToStatus "queued" -Actor $CreatedBy
        return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $ticket -WasReused $false) -Changed $true -Events @($event)
    })
}

function Get-ReleaseQueueTicket {
    [CmdletBinding()]
    param(
        [string]$TicketId = "",
        [string]$OperationId = "",
        [string]$IdempotencyKey = "",
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    if ([string]::IsNullOrWhiteSpace($TicketId) -and [string]::IsNullOrWhiteSpace($OperationId) -and [string]::IsNullOrWhiteSpace($IdempotencyKey)) {
        throw "必须提供 TicketId、OperationId 或 IdempotencyKey。"
    }
    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -ReadOnly -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $index = Get-ReleaseQueueTicketIndex -State $state -TicketId $TicketId -OperationId $OperationId -IdempotencyKey $IdempotencyKey
        if ($index -lt 0) {
            return New-ReleaseQueueOutcome -Result $null -Changed $false
        }
        return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $state.tickets[$index]) -Changed $false
    })
}

function Get-ReleaseQueueTickets {
    [CmdletBinding()]
    param(
        [string]$Status = "",
        [string]$OperationId = "",
        [switch]$IncludeTerminal,
        [switch]$RecoverExpired,
        [int]$Limit = 0,
        [switch]$NewestFirst,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    $statusFilter = ""
    $phaseFilter = ""
    if (-not [string]::IsNullOrWhiteSpace($Status)) {
        $normalizedFilter = Normalize-ReleaseQueueStatusInput -Status $Status
        $statusFilter = [string]$normalizedFilter.status
        $phaseFilter = [string]$normalizedFilter.phase
    }
    $readOnly = -not $RecoverExpired
    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -ReadOnly:$readOnly -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $events = New-Object System.Collections.Generic.List[object]
        $changed = $false
        if ($RecoverExpired) {
            $recovery = Invoke-ReleaseQueueRecoveryOnState -State $state -Now ([DateTime]::UtcNow) -Actor "queue-list-recovery"
            $changed = [bool]$recovery.Changed
            foreach ($event in @($recovery.Events)) { [void]$events.Add($event) }
        }
        $tickets = @($state.tickets)
        $selected = @($tickets | Where-Object {
                $statusMatches = [string]::IsNullOrWhiteSpace($statusFilter) -or [string]$_.status -eq $statusFilter
                if (-not [string]::IsNullOrWhiteSpace($phaseFilter)) {
                    $statusMatches = $statusMatches -and [string]$_.phase -eq $phaseFilter
                }
                $operationMatches = [string]::IsNullOrWhiteSpace($OperationId) -or [string]$_.operationId -eq $OperationId
                $terminalMatches = $IncludeTerminal -or (Get-ReleaseQueueTerminalStatusList) -notcontains [string]$_.status
                $statusMatches -and $operationMatches -and $terminalMatches
            } | Sort-Object -Property @{ Expression = { [int64](Get-ReleaseQueueProperty -Object $_ -Name "sequence" -Default 0) }; Ascending = (-not $NewestFirst) })
        if ($Limit -gt 0) {
            $selected = @($selected | Select-Object -First $Limit)
        }
        $result = @($selected | ForEach-Object { Copy-ReleaseQueueTicketResult -Ticket $_ })
        return New-ReleaseQueueOutcome -Result $result -Changed $changed -Events ([object[]]$events.ToArray())
    })
}

function Assert-ReleaseQueueStatusTransition {
    param(
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$To
    )
    if ((Get-ReleaseQueueStatusList) -notcontains $From -or (Get-ReleaseQueueStatusList) -notcontains $To) {
        throw "未知队列状态转换：$From -> $To"
    }
    if ($From -eq $To) {
        return
    }
    if ((Get-ReleaseQueueAllowedTransitions -From $From) -notcontains $To) {
        throw "不允许的队列状态转换：$From -> $To"
    }
}

function Assert-ReleaseQueueLeaseOwner {
    param(
        [Parameter(Mandatory = $true)][object]$Ticket,
        [string]$LeaseId = "",
        [string]$LeaseOwner = "",
        [switch]$AllowExpired
    )
    $storedLease = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "leaseId" -Default "")
    $storedOwner = [string](Get-ReleaseQueueProperty -Object $Ticket -Name "leaseOwner" -Default "")
    if ([string]::IsNullOrWhiteSpace($storedLease)) {
        throw "票据当前没有有效租约：$($Ticket.ticketId)"
    }
    if (-not [string]::IsNullOrWhiteSpace($LeaseId) -and $storedLease -ne $LeaseId) {
        throw "租约 leaseId 不匹配，拒绝修改票据：$($Ticket.ticketId)"
    }
    if (-not [string]::IsNullOrWhiteSpace($LeaseOwner) -and $storedOwner -ne $LeaseOwner) {
        throw "租约 owner 不匹配，拒绝修改票据：$($Ticket.ticketId)"
    }
    if (-not $AllowExpired) {
        $expiresValue = Get-ReleaseQueueProperty -Object $Ticket -Name "leaseExpiresAt" -Default ""
        if ($null -eq $expiresValue -or [string]::IsNullOrWhiteSpace([string]$expiresValue) -or (ConvertTo-ReleaseQueueUtcDateTime -Value $expiresValue) -le [DateTime]::UtcNow) {
            throw "票据租约已过期，请先执行 Recover-ReleaseQueueTickets 后再接管：$($Ticket.ticketId)"
        }
    }
}

function Clear-ReleaseQueueRecoveryMetadata {
    param([object]$Metadata)
    if ($null -eq $Metadata) { return }
    foreach ($name in @("lastError", "recoveryStatus")) {
        if ($Metadata -is [System.Collections.IDictionary]) {
            if ($Metadata.Contains($name)) { [void]$Metadata.Remove($name) }
        }
        elseif ($null -ne $Metadata.PSObject.Properties[$name]) {
            $Metadata.PSObject.Properties.Remove($name)
        }
    }
}

function Set-ReleaseQueueTicketStatus {
    [CmdletBinding()]
    param(
        [string]$TicketId = "",
        [string]$Status = "running",
        [string]$OperationId = "",
        [string]$Stage = "",
        [string]$Version = "",
        [string]$BaseHead = "",
        [string]$ContextPath = "",
        [string]$ReservationPath = "",
        [string]$ErrorMessage = "",
        [string]$LeaseId = "",
        [string]$LeaseOwner = "",
        [string]$Reason = "",
        [object]$Metadata = $null,
        [switch]$ClearMetadata,
        [switch]$Retry,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    $normalizedStatus = Normalize-ReleaseQueueStatusInput -Status $Status
    $targetStatus = [string]$normalizedStatus.status
    $aliasPhase = [string]$normalizedStatus.phase
    $hasMetadata = $PSBoundParameters.ContainsKey("Metadata")
    if ($hasMetadata) { Assert-ReleaseQueueMetadataSafe -Value $Metadata }
    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -OperationId $OperationId -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $index = Get-ReleaseQueueTicketIndex -State $state -TicketId $TicketId -OperationId $OperationId
        if ($index -lt 0) { throw "找不到队列票据：$TicketId / $OperationId" }
        $ticket = $state.tickets[$index]
        $from = [string]$ticket.status
        if (-not [string]::IsNullOrWhiteSpace($OperationId) -and [string]$ticket.operationId -ne $OperationId) {
            throw "票据 operationId 不匹配：$TicketId"
        }
        Assert-ReleaseQueueStatusTransition -From $from -To $targetStatus
        if ((Get-ReleaseQueueActiveStatusList) -contains $from) {
            # 即使只是更新 phase/version，也必须证明仍持有当前租约；
            # 防止旧进程在租约续期后写回过时状态。
            Assert-ReleaseQueueLeaseOwner -Ticket $ticket -LeaseId $LeaseId -LeaseOwner $LeaseOwner
        }
        if ($from -eq $targetStatus) {
            # A same-state phase update is still a write.  Active tickets may
            # only be touched by the process holding the current lease.
            if ((Get-ReleaseQueueActiveStatusList) -contains $from) {
                Assert-ReleaseQueueLeaseOwner -Ticket $ticket -LeaseId $LeaseId -LeaseOwner $LeaseOwner
            }
            if (-not [string]::IsNullOrWhiteSpace($Stage)) { $ticket.phase = $Stage.Trim().ToLowerInvariant() }
            elseif (-not [string]::IsNullOrWhiteSpace($aliasPhase)) { $ticket.phase = $aliasPhase }
            if (-not [string]::IsNullOrWhiteSpace($Version)) { $ticket.version = Assert-ReleaseQueueSemVer -Value $Version }
            if (-not [string]::IsNullOrWhiteSpace($BaseHead)) { $ticket.baseHead = $BaseHead }
            if (-not [string]::IsNullOrWhiteSpace($ContextPath)) { $ticket.contextPath = $ContextPath }
            if (-not [string]::IsNullOrWhiteSpace($ReservationPath)) { $ticket.reservationPath = $ReservationPath }
            if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $ticket.lastError = $ErrorMessage }
            elseif ($targetStatus -eq "succeeded") { $ticket.lastError = "" }
            if ($ClearMetadata) { $ticket.metadata = $null }
            elseif ($hasMetadata) { $ticket.metadata = $Metadata }
            if ($targetStatus -eq "succeeded") { Clear-ReleaseQueueRecoveryMetadata -Metadata $ticket.metadata }
            $ticket.updatedAt = Get-ReleaseQueueNowText
            [void](Sync-ReleaseQueueLeaseObject -Ticket $ticket)
            $state.tickets[$index] = $ticket
            return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $ticket) -Changed $true
        }
        if ($targetStatus -eq "queued" -and $from -eq "failed" -and -not $Retry) {
            throw "failed 票据重新排队必须显式指定 -Retry。"
        }
        if ($targetStatus -eq "queued" -and $from -eq "recoverable" -and -not $Retry) {
            throw "recoverable 票据重新排队必须显式指定 -Retry。"
        }
        if ($targetStatus -eq "leased") {
            throw "不能手工把票据设为 leased，请使用 Claim-ReleaseQueueTicket。"
        }
        if ($targetStatus -eq "running" -and $from -ne "leased") {
            throw "只有 leased 票据可以进入 running。"
        }
        $ticket.status = $targetStatus
        $ticket.phase = if (-not [string]::IsNullOrWhiteSpace($Stage)) { $Stage.Trim().ToLowerInvariant() } elseif (-not [string]::IsNullOrWhiteSpace($aliasPhase)) { $aliasPhase } else { $targetStatus }
        if (-not [string]::IsNullOrWhiteSpace($Version)) { $ticket.version = Assert-ReleaseQueueSemVer -Value $Version }
        if (-not [string]::IsNullOrWhiteSpace($BaseHead)) { $ticket.baseHead = $BaseHead }
        if (-not [string]::IsNullOrWhiteSpace($ContextPath)) { $ticket.contextPath = $ContextPath }
        if (-not [string]::IsNullOrWhiteSpace($ReservationPath)) { $ticket.reservationPath = $ReservationPath }
        if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $ticket.lastError = $ErrorMessage }
        elseif ($targetStatus -eq "succeeded") { $ticket.lastError = "" }
        if ($ClearMetadata) { $ticket.metadata = $null }
        elseif ($hasMetadata) { $ticket.metadata = $Metadata }
        if ($targetStatus -eq "succeeded") { Clear-ReleaseQueueRecoveryMetadata -Metadata $ticket.metadata }
        $ticket.updatedAt = Get-ReleaseQueueNowText
        if ($targetStatus -notin @("leased", "running")) {
            $ticket.leaseId = ""
            $ticket.leaseOwner = ""
            $ticket.leaseExpiresAt = ""
            $ticket.lastHeartbeatAt = ""
        }
        [void](Sync-ReleaseQueueLeaseObject -Ticket $ticket)
        $state.tickets[$index] = $ticket
        $event = New-ReleaseQueueEvent -Type "status-changed" -Ticket $ticket -FromStatus $from -ToStatus $targetStatus -Actor $LeaseOwner -Reason $(if ([string]::IsNullOrWhiteSpace($ErrorMessage)) { $Reason } else { $ErrorMessage })
        return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $ticket) -Changed $true -Events @($event)
    })
}

function Update-ReleaseQueueTicket {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TicketId,
        [string]$RequestedVersion = "",
        [string]$SourceSha256 = "",
        [object[]]$IncludePath = @(),
        [string]$SourcePath = "",
        [int]$Priority = 0,
        [int]$MaxAttempts = 0,
        [string]$Phase = "",
        [string]$Version = "",
        [string]$BaseHead = "",
        [string]$ContextPath = "",
        [string]$ReservationPath = "",
        [string]$LeaseId = "",
        [string]$LeaseOwner = "",
        [object]$Metadata = $null,
        [switch]$ClearMetadata,
        [switch]$Force,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    $hasRequestedVersion = $PSBoundParameters.ContainsKey("RequestedVersion")
    $hasSourceSha = $PSBoundParameters.ContainsKey("SourceSha256")
    $hasInclude = $PSBoundParameters.ContainsKey("IncludePath") -and @($IncludePath).Count -gt 0
    $hasSourcePath = $PSBoundParameters.ContainsKey("SourcePath")
    $hasPriority = $PSBoundParameters.ContainsKey("Priority")
    $hasMaxAttempts = $PSBoundParameters.ContainsKey("MaxAttempts") -and $MaxAttempts -gt 0
    $hasPhase = $PSBoundParameters.ContainsKey("Phase")
    $hasVersion = $PSBoundParameters.ContainsKey("Version")
    $hasBaseHead = $PSBoundParameters.ContainsKey("BaseHead")
    $hasContextPath = $PSBoundParameters.ContainsKey("ContextPath")
    $hasReservationPath = $PSBoundParameters.ContainsKey("ReservationPath")
    $hasMetadata = $PSBoundParameters.ContainsKey("Metadata")
    if (-not ($hasRequestedVersion -or $hasSourceSha -or $hasInclude -or $hasSourcePath -or $hasPriority -or $hasMaxAttempts -or $hasPhase -or $hasVersion -or $hasBaseHead -or $hasContextPath -or $hasReservationPath -or $hasMetadata -or $ClearMetadata)) {
        throw "没有指定要更新的队列字段。"
    }
    # Keep this name distinct from the public `-Version` parameter (PowerShell
    # variable names ignore case).
    $requestedVersionValue = if ($hasRequestedVersion) { Assert-ReleaseQueueSemVer -Value $RequestedVersion } else { "" }
    $sha = if ($hasSourceSha) { Assert-ReleaseQueueSha256 -Value $SourceSha256 } else { "" }
    $includePaths = if ($hasInclude) { Normalize-ReleaseQueueIncludePaths -InputPath $IncludePath } else { @() }
    $versionValue = if ($hasVersion) { Assert-ReleaseQueueSemVer -Value $Version } else { "" }
    if ($hasMetadata) { Assert-ReleaseQueueMetadataSafe -Value $Metadata }
    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $index = Get-ReleaseQueueTicketIndex -State $state -TicketId $TicketId
        if ($index -lt 0) { throw "找不到队列票据：$TicketId" }
        $ticket = $state.tickets[$index]
        if ((Get-ReleaseQueueActiveStatusList) -contains [string]$ticket.status) {
            Assert-ReleaseQueueLeaseOwner -Ticket $ticket -LeaseId $LeaseId -LeaseOwner $LeaseOwner
        }
        if ((Get-ReleaseQueueTerminalStatusList) -contains [string]$ticket.status -and -not $Force) {
            throw "终态票据默认不可修改：$TicketId；如需修正请使用 -Force。"
        }
        if ($hasRequestedVersion) { $ticket.requestedVersion = $requestedVersionValue }
        if ($hasSourceSha) { $ticket.sourceSha256 = $sha }
        if ($hasInclude) { $ticket.includePaths = @($includePaths) }
        if ($hasSourcePath) { $ticket.sourcePath = $SourcePath }
        if ($hasPriority) { $ticket.priority = $Priority }
        if ($hasMaxAttempts) {
            if ($MaxAttempts -lt [int]$ticket.attempt) { throw "maxAttempts 不能小于已经发生的 attempt。" }
            $ticket.maxAttempts = $MaxAttempts
        }
        if ($hasPhase) { $ticket.phase = if ([string]::IsNullOrWhiteSpace($Phase)) { [string]$ticket.phase } else { $Phase.Trim().ToLowerInvariant() } }
        if ($hasVersion) { $ticket.version = $versionValue }
        if ($hasBaseHead) { $ticket.baseHead = $BaseHead }
        if ($hasContextPath) { $ticket.contextPath = $ContextPath }
        if ($hasReservationPath) { $ticket.reservationPath = $ReservationPath }
        if ($ClearMetadata) { $ticket.metadata = $null }
        elseif ($hasMetadata) { $ticket.metadata = $Metadata }
        $ticket.updatedAt = Get-ReleaseQueueNowText
        [void](Sync-ReleaseQueueLeaseObject -Ticket $ticket)
        $state.tickets[$index] = $ticket
        $event = New-ReleaseQueueEvent -Type "ticket-updated" -Ticket $ticket -ToStatus ([string]$ticket.status) -Actor "queue-update"
        return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $ticket) -Changed $true -Events @($event)
    })
}

function Invoke-ReleaseQueueRecoveryOnState {
    param(
        [Parameter(Mandatory = $true)][object]$State,
        [DateTime]$Now = ([DateTime]::UtcNow),
        [string]$Actor = "queue-recovery"
    )
    $events = New-Object System.Collections.Generic.List[object]
    $recovered = New-Object System.Collections.Generic.List[object]
    $changed = $false
    $tickets = @($State.tickets)
    for ($index = 0; $index -lt $tickets.Count; $index += 1) {
        $ticket = $tickets[$index]
        $status = [string]$ticket.status
        # A prepared ticket intentionally remains `queued` so it owns the FIFO
        # slot while waiting for an explicit resume.  Without an expiry check,
        # an abandoned/crashed preparation could block every later release
        # forever.  The release context is the durable source of its deadline;
        # only a clearly expired, non-terminal context is auto-closed.
        if ($status -eq "queued") {
            $phase = [string](Get-ReleaseQueueProperty -Object $ticket -Name "phase" -Default "queued")
            if ($phase -ne "queued" -and $phase -notin @("succeeded", "failed", "cancelled", "expired")) {
                $contextPath = [string](Get-ReleaseQueueProperty -Object $ticket -Name "contextPath" -Default "")
                if (-not [string]::IsNullOrWhiteSpace($contextPath) -and (Test-Path -LiteralPath $contextPath -PathType Leaf)) {
                    try {
                        $context = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json
                        $terminalStatus = [string](Get-ReleaseQueueProperty -Object $context -Name "terminalStatus" -Default "")
                        $expiresValue = Get-ReleaseQueueProperty -Object $context -Name "expiresAt" -Default ""
                        $expiresText = if ($expiresValue -is [DateTimeOffset]) {
                            $expiresValue.ToUniversalTime().ToString("o")
                        }
                        elseif ($expiresValue -is [DateTime]) {
                            $expiresValue.ToUniversalTime().ToString("o")
                        }
                        else {
                            [string]$expiresValue
                        }
                        $contextExpired = $false
                        if ($terminalStatus -ne "succeeded" -and -not [string]::IsNullOrWhiteSpace([string]$expiresValue)) {
                            try { $contextExpired = (ConvertTo-ReleaseQueueUtcDateTime -Value $expiresValue) -le $Now }
                            catch { $contextExpired = $false }
                        }
                        if ($contextExpired) {
                            $ticket.status = "expired"
                            $ticket.phase = "expired"
                            $ticket.lastError = "release context expired at $expiresText"
                            $ticket.updatedAt = Get-ReleaseQueueNowText
                            $ticket.leaseId = ""
                            $ticket.leaseOwner = ""
                            $ticket.leaseExpiresAt = ""
                            $ticket.lastHeartbeatAt = ""
                            [void](Sync-ReleaseQueueLeaseObject -Ticket $ticket)
                            $tickets[$index] = $ticket
                            [void]$recovered.Add((Copy-ReleaseQueueTicketResult -Ticket $ticket))
                            [void]$events.Add((New-ReleaseQueueEvent -Type "context-expired" -Ticket $ticket -FromStatus $status -ToStatus "expired" -Actor $Actor -Reason "release context expired" -Details @{ expiresAt = $expiresText; contextPath = $contextPath }))
                            $changed = $true
                            continue
                        }
                    }
                    catch {
                        # A transiently incomplete context must not be deleted
                        # by recovery.  The owning operation will mark it
                        # recoverable once its write sequence is known.
                    }
                }
            }
        }
        if ((Get-ReleaseQueueActiveStatusList) -notcontains $status) {
            continue
        }
        $expiresValue = Get-ReleaseQueueProperty -Object $ticket -Name "leaseExpiresAt" -Default ""
        try { $expiresText = (ConvertTo-ReleaseQueueUtcDateTime -Value $expiresValue).ToString("o") } catch { $expiresText = [string]$expiresValue }
        $expired = $null -eq $expiresValue -or [string]::IsNullOrWhiteSpace($expiresText)
        if (-not $expired) {
            try { $expired = (ConvertTo-ReleaseQueueUtcDateTime -Value $expiresValue) -le $Now }
            catch { $expired = $true }
        }
        if (-not $expired) {
            continue
        }
        $oldLease = [string](Get-ReleaseQueueProperty -Object $ticket -Name "leaseId" -Default "")
        $oldOwner = [string](Get-ReleaseQueueProperty -Object $ticket -Name "leaseOwner" -Default "")
        $attempt = [int](Get-ReleaseQueueProperty -Object $ticket -Name "attempt" -Default 0)
        $maxAttempts = [int](Get-ReleaseQueueProperty -Object $ticket -Name "maxAttempts" -Default 3)
        $takeover = [int](Get-ReleaseQueueProperty -Object $ticket -Name "takeoverCount" -Default 0) + 1
        $target = if ($attempt -lt $maxAttempts) { "queued" } else { "recoverable" }
        $ticket.status = $target
        $ticket.takeoverCount = $takeover
        $ticket.lastError = "lease expired; previous owner=$oldOwner"
        $ticket.updatedAt = Get-ReleaseQueueNowText
        $ticket.leaseId = ""
        $ticket.leaseOwner = ""
        $ticket.leaseExpiresAt = ""
        $ticket.lastHeartbeatAt = ""
        [void](Sync-ReleaseQueueLeaseObject -Ticket $ticket)
        $tickets[$index] = $ticket
        [void]$recovered.Add((Copy-ReleaseQueueTicketResult -Ticket $ticket))
        [void]$events.Add((New-ReleaseQueueEvent -Type "lease-expired" -Ticket $ticket -FromStatus $status -ToStatus $target -Actor $Actor -Reason "lease expired" -Details @{ previousLeaseId = $oldLease; previousOwner = $oldOwner; takeoverCount = $takeover }))
        $changed = $true
    }
    $State.tickets = $tickets
    return [pscustomobject]@{
        Changed = $changed
        Recovered = [object[]]$recovered.ToArray()
        Events = [object[]]$events.ToArray()
    }
}

function Recover-ReleaseQueueTickets {
    [CmdletBinding()]
    param(
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [string]$Actor = "queue-recovery",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $recovery = Invoke-ReleaseQueueRecoveryOnState -State $state -Now ([DateTime]::UtcNow) -Actor $Actor
        return New-ReleaseQueueOutcome -Result $recovery.Recovered -Changed ([bool]$recovery.Changed) -Events $recovery.Events
    })
}

function Claim-ReleaseQueueTicket {
    [CmdletBinding()]
    param(
        [string]$TicketId = "",
        [string]$LeaseOwner = "",
        [ValidateRange(5, 86400)][int]$LeaseSeconds = 300,
        [switch]$AllowOutOfOrder,
        # A prepared ticket is intentionally left in queued status so it keeps
        # its FIFO place while the immutable package waits for an explicit
        # resume.  Only resume-release.ps1 may opt in to claiming that phase;
        # generic workers must never consume it as a fresh request.
        [switch]$AllowPrepared,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    $owner = if ([string]::IsNullOrWhiteSpace($LeaseOwner)) {
        $computer = if ([string]::IsNullOrWhiteSpace([string]$env:COMPUTERNAME)) { "localhost" } else { [string]$env:COMPUTERNAME }
        "$computer/$PID"
    }
    else {
        $LeaseOwner.Trim()
    }
    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $recovery = Invoke-ReleaseQueueRecoveryOnState -State $state -Now ([DateTime]::UtcNow) -Actor "claim-recovery"
        $events = New-Object System.Collections.Generic.List[object]
        foreach ($event in @($recovery.Events)) { [void]$events.Add($event) }
        $tickets = @($state.tickets)
        $queued = @($tickets | Where-Object {
                if ([string]$_.status -ne "queued") { return $false }
                if ($AllowPrepared) { return $true }
                # A queued ticket whose phase is prepared/pr-opened/etc. is a
                # resumable operation, not a new claim.  Keep it at the head
                # of the FIFO so later tickets cannot leapfrog it.
                $phase = [string](Get-ReleaseQueueProperty -Object $_ -Name "phase" -Default "queued")
                return [string]::IsNullOrWhiteSpace($phase) -or $phase -eq "queued"
            } | Sort-Object -Property @{ Expression = { [int64](Get-ReleaseQueueProperty -Object $_ -Name "sequence" -Default 0) }; Ascending = $true })
        $allQueued = @($tickets | Where-Object { [string]$_.status -eq "queued" } | Sort-Object -Property @{ Expression = { [int64](Get-ReleaseQueueProperty -Object $_ -Name "sequence" -Default 0) }; Ascending = $true })
        if (-not $AllowPrepared -and $allQueued.Count -gt 0) {
            $headPhase = [string](Get-ReleaseQueueProperty -Object $allQueued[0] -Name "phase" -Default "queued")
            if (-not [string]::IsNullOrWhiteSpace($headPhase) -and $headPhase -ne "queued") {
                # Do not let an ordinary worker leapfrog a prepared/resumable
                # operation.  The owner must explicitly resume the head ticket.
                if (-not [string]::IsNullOrWhiteSpace($TicketId) -and [string]$allQueued[0].ticketId -eq $TicketId) {
                    throw "票据处于可恢复阶段 $headPhase，必须由 resume-release.ps1 使用 -AllowPrepared 领取：$TicketId"
                }
                if ([string]::IsNullOrWhiteSpace($TicketId)) {
                    return New-ReleaseQueueOutcome -Result $null -Changed ([bool]$recovery.Changed) -Events ([object[]]$events.ToArray())
                }
                $requestedTicket = $allQueued | Where-Object { [string]$_.ticketId -eq $TicketId } | Select-Object -First 1
                if ($null -ne $requestedTicket) {
                    throw "FIFO 被可恢复票据 $($allQueued[0].ticketId)（phase=$headPhase）阻塞，请先使用 -AllowPrepared 恢复它。"
                }
            }
        }
        if ($queued.Count -eq 0) {
        return New-ReleaseQueueOutcome -Result $null -Changed ([bool]$recovery.Changed) -Events ([object[]]$events.ToArray())
        }
        $ticket = $null
        if (-not [string]::IsNullOrWhiteSpace($TicketId)) {
            $ticket = $queued | Where-Object { [string]$_.ticketId -eq $TicketId } | Select-Object -First 1
            if ($null -eq $ticket) {
                $candidateIndex = Get-ReleaseQueueTicketIndex -State $state -TicketId $TicketId
                if ($candidateIndex -lt 0) { throw "找不到队列票据：$TicketId" }
                $candidate = $state.tickets[$candidateIndex]
                $candidatePhase = [string](Get-ReleaseQueueProperty -Object $candidate -Name "phase" -Default "queued")
                if ([string]$candidate.status -eq "queued" -and -not $AllowPrepared -and $candidatePhase -ne "queued" -and -not [string]::IsNullOrWhiteSpace($candidatePhase)) {
                    throw "票据处于可恢复阶段 $candidatePhase，必须由 resume-release.ps1 使用 -AllowPrepared 领取：$TicketId"
                }
                throw "票据当前不可领取，或不在 queued 状态：$TicketId"
            }
            if (-not $AllowOutOfOrder -and [string]$ticket.ticketId -ne [string]$queued[0].ticketId) {
                throw "必须按 FIFO 领取；最前面的票据是 $($queued[0].ticketId)。"
            }
        }
        else {
            $ticket = $queued[0]
        }
        $index = Get-ReleaseQueueTicketIndex -State $state -TicketId ([string]$ticket.ticketId)
        $now = Get-ReleaseQueueNowText
        $leaseId = "lease-$([guid]::NewGuid().ToString('N'))"
        $ticket.status = "leased"
        $ticket.leaseId = $leaseId
        $ticket.leaseOwner = $owner
        $ticket.leaseExpiresAt = [DateTimeOffset]::UtcNow.AddSeconds($LeaseSeconds).ToString("o")
        $ticket.lastHeartbeatAt = $now
        $ticket.leaseSeconds = $LeaseSeconds
        $ticket.attempt = [int](Get-ReleaseQueueProperty -Object $ticket -Name "attempt" -Default 0) + 1
        $ticket.updatedAt = $now
        [void](Sync-ReleaseQueueLeaseObject -Ticket $ticket)
        $state.tickets[$index] = $ticket
        [void]$events.Add((New-ReleaseQueueEvent -Type "ticket-claimed" -Ticket $ticket -FromStatus "queued" -ToStatus "leased" -Actor $owner -Details @{ leaseId = $leaseId; leaseExpiresAt = $ticket.leaseExpiresAt; attempt = $ticket.attempt }))
        return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $ticket) -Changed $true -Events ([object[]]$events.ToArray())
    })
}

function Start-ReleaseQueueTicket {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TicketId,
        [Parameter(Mandatory = $true)][string]$LeaseId,
        [string]$LeaseOwner = "",
        [string]$OperationId = "",
        [string]$Stage = "",
        [string]$Version = "",
        [string]$BaseHead = "",
        [string]$ContextPath = "",
        [string]$ReservationPath = "",
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    return Set-ReleaseQueueTicketStatus -TicketId $TicketId -Status "running" -OperationId $OperationId -Stage $Stage -Version $Version -BaseHead $BaseHead -ContextPath $ContextPath -ReservationPath $ReservationPath -LeaseId $LeaseId -LeaseOwner $LeaseOwner -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
}

function Renew-ReleaseQueueLease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TicketId,
        [Parameter(Mandatory = $true)][string]$LeaseId,
        [string]$LeaseOwner = "",
        [ValidateRange(5, 86400)][int]$LeaseSeconds = 300,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $index = Get-ReleaseQueueTicketIndex -State $state -TicketId $TicketId
        if ($index -lt 0) { throw "找不到队列票据：$TicketId" }
        $ticket = $state.tickets[$index]
        if ((Get-ReleaseQueueActiveStatusList) -notcontains [string]$ticket.status) {
            throw "只有 leased/running 票据可以 heartbeat：$TicketId"
        }
        Assert-ReleaseQueueLeaseOwner -Ticket $ticket -LeaseId $LeaseId -LeaseOwner $LeaseOwner
        $ticket.lastHeartbeatAt = Get-ReleaseQueueNowText
        $ticket.leaseExpiresAt = [DateTimeOffset]::UtcNow.AddSeconds($LeaseSeconds).ToString("o")
        $ticket.updatedAt = $ticket.lastHeartbeatAt
        [void](Sync-ReleaseQueueLeaseObject -Ticket $ticket)
        $state.tickets[$index] = $ticket
        $event = New-ReleaseQueueEvent -Type "lease-heartbeat" -Ticket $ticket -Actor $LeaseOwner -Details @{ leaseId = $LeaseId; leaseExpiresAt = $ticket.leaseExpiresAt }
        return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $ticket) -Changed $true -Events @($event)
    })
}

function Update-ReleaseQueueHeartbeat {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TicketId,
        [Parameter(Mandatory = $true)][string]$LeaseId,
        [string]$LeaseOwner = "",
        [ValidateRange(5, 86400)][int]$LeaseSeconds = 300,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    return Renew-ReleaseQueueLease @PSBoundParameters
}

function Start-ReleaseQueueLeaseHeartbeat {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TicketId,
        [Parameter(Mandatory = $true)][string]$LeaseId,
        [Parameter(Mandatory = $true)][string]$LeaseOwner,
        [Parameter(Mandatory = $true)][string]$QueueRoot,
        [ValidateRange(5, 86400)][int]$LeaseSeconds = 300,
        [ValidateRange(2, 3600)][int]$IntervalSeconds = 30,
        [ValidateRange(1, 7200)][int]$WaitSeconds = 60,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )

    $interval = [Math]::Max(2, [Math]::Min($IntervalSeconds, [Math]::Max(2, [int]($LeaseSeconds / 3))))
    $queueScriptPath = Join-Path $PSScriptRoot "release-queue.ps1"
    $parentPid = $PID
    $parentStartUtc = ""
    try { $parentStartUtc = ([DateTimeOffset]((Get-Process -Id $parentPid -ErrorAction Stop).StartTime.ToUniversalTime())).ToString("o") } catch { }
    # A separate job makes the heartbeat independent from a long-running
    # package/deploy command.  It exits when the owning process disappears, so
    # a crashed publisher cannot keep a lease alive forever.
    $job = Start-Job -Name "release-queue-heartbeat-$TicketId" -ArgumentList @(
        $queueScriptPath, $TicketId, $LeaseId, $LeaseOwner, $QueueRoot,
        $LeaseSeconds, $interval, $WaitSeconds, $PollMilliseconds, $parentPid,
        $parentStartUtc
    ) -ScriptBlock {
        # Do not use the top-level script's public parameter names here.  The
        # worker dot-sources release-queue.ps1, whose $TicketId/$LeaseId/etc.
        # parameters would otherwise overwrite same-named child variables
        # (PowerShell variable names are case-insensitive), silently disabling
        # every heartbeat renewal.
        param($hbScriptPath, $hbTicketId, $hbLeaseId, $hbLeaseOwner, $hbQueueRoot, $hbLeaseSeconds, $hbIntervalSeconds, $hbWaitSeconds, $hbPollMilliseconds, $hbOwnerPid, $hbOwnerStartUtc)
        try { . $hbScriptPath } catch { return }
        function Test-HeartbeatOwnerAlive {
            param([int]$ProcessId, [string]$ExpectedStartUtc)
            $ownerProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
            if ($null -eq $ownerProcess) { return $false }
            if ([string]::IsNullOrWhiteSpace($ExpectedStartUtc)) { return $true }
            try {
                $actual = $ownerProcess.StartTime.ToUniversalTime()
                $expected = [DateTimeOffset]::Parse($ExpectedStartUtc).UtcDateTime
                return [Math]::Abs(($actual - $expected).TotalSeconds) -lt 2
            }
            catch { return $false }
        }
        while ($true) {
            if (-not (Test-HeartbeatOwnerAlive -ProcessId $hbOwnerPid -ExpectedStartUtc $hbOwnerStartUtc)) { break }
            Start-Sleep -Seconds $hbIntervalSeconds
            if (-not (Test-HeartbeatOwnerAlive -ProcessId $hbOwnerPid -ExpectedStartUtc $hbOwnerStartUtc)) { break }
            try {
                Renew-ReleaseQueueLease -TicketId $hbTicketId -LeaseId $hbLeaseId -LeaseOwner $hbLeaseOwner -LeaseSeconds $hbLeaseSeconds -QueueRoot $hbQueueRoot -WaitSeconds $hbWaitSeconds -PollMilliseconds $hbPollMilliseconds | Out-Null
            }
            catch {
                # The foreground operation records the eventual failure.  A
                # transient queue-lock collision is retried on the next tick.
            }
        }
    }
    return [pscustomobject][ordered]@{
        job = $job
        ticketId = $TicketId
        leaseId = $LeaseId
        leaseOwner = $LeaseOwner
        intervalSeconds = $interval
        # Keep the process identity alongside the Job object.  PID alone is
        # not stable on Windows: after the publisher exits, a new process can
        # reuse the same PID.  The worker compares this start instant before
        # every renewal and these fields make the binding auditable/resumable.
        ownerPid = $parentPid
        parentPid = $parentPid
        ownerStartUtc = $parentStartUtc
        parentStartUtc = $parentStartUtc
        parentProcessStartUtc = $parentStartUtc
        processStartUtc = $parentStartUtc
    }
}

function Stop-ReleaseQueueLeaseHeartbeat {
    param([object]$Heartbeat)
    if ($null -eq $Heartbeat) { return }
    try {
        $job = if ($Heartbeat.PSObject.Properties["job"]) { $Heartbeat.job } else { $null }
        if ($null -ne $job) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
    catch { }
}

Set-Alias -Name Start-ReleaseQueueHeartbeat -Value Start-ReleaseQueueLeaseHeartbeat -Scope Local
Set-Alias -Name Stop-ReleaseQueueHeartbeat -Value Stop-ReleaseQueueLeaseHeartbeat -Scope Local

function Complete-ReleaseQueueTicket {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TicketId,
        [Parameter(Mandatory = $true)][string]$LeaseId,
        [string]$Status = "succeeded",
        [string]$LeaseOwner = "",
        [string]$OperationId = "",
        [string]$Stage = "",
        [string]$Version = "",
        [string]$BaseHead = "",
        [string]$ContextPath = "",
        [string]$ReservationPath = "",
        [string]$ErrorMessage = "",
        [string]$Reason = "",
        [switch]$Retry,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    return Set-ReleaseQueueTicketStatus -TicketId $TicketId -Status $Status -OperationId $OperationId -Stage $Stage -Version $Version -BaseHead $BaseHead -ContextPath $ContextPath -ReservationPath $ReservationPath -ErrorMessage $ErrorMessage -LeaseId $LeaseId -LeaseOwner $LeaseOwner -Reason $Reason -Retry:$Retry -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
}

# release-gate.ps1 also has a phase adapter because the normal release entry
# point dot-sources that file first.  Keep a queue-local adapter as well: the
# resume entry point and small integrations may dot-source only this script.
# Do not overwrite a richer adapter that has already been loaded by
# release-gate.ps1; the conditional definition makes the two load orders
# compatible.
if ($null -eq (Get-Command Set-ReleaseQueuePhase -ErrorAction SilentlyContinue)) {
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

        $ticket = Get-ReleaseQueueTicket -QueueRoot $QueueRoot -OperationId $OperationId -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
        if ($null -eq $ticket) {
            return $null
        }
        $ticketId = [string](Get-ReleaseQueueProperty -Object $ticket -Name "ticketId" -Default "")
        if ([string]::IsNullOrWhiteSpace($ticketId)) {
            throw "队列票据缺少 ticketId：$OperationId"
        }

        # Lease can be either the queue ticket returned by Claim/Start
        # (leaseId/leaseOwner) or a compact { id, owner } object.  Accept both
        # forms, but require both values whenever an active ticket is touched.
        $leaseId = ""
        $leaseOwner = ""
        if ($null -ne $Lease) {
            $leaseId = [string](Get-ReleaseQueueProperty -Object $Lease -Name "leaseId" -Default "")
            $leaseOwner = [string](Get-ReleaseQueueProperty -Object $Lease -Name "leaseOwner" -Default "")
            if ([string]::IsNullOrWhiteSpace($leaseId)) {
                $leaseId = [string](Get-ReleaseQueueProperty -Object $Lease -Name "id" -Default "")
            }
            if ([string]::IsNullOrWhiteSpace($leaseOwner)) {
                $leaseOwner = [string](Get-ReleaseQueueProperty -Object $Lease -Name "owner" -Default "")
            }
            $nestedLease = Get-ReleaseQueueProperty -Object $Lease -Name "lease" -Default $null
            if ($null -ne $nestedLease) {
                if ([string]::IsNullOrWhiteSpace($leaseId)) {
                    $leaseId = [string](Get-ReleaseQueueProperty -Object $nestedLease -Name "id" -Default "")
                }
                if ([string]::IsNullOrWhiteSpace($leaseOwner)) {
                    $leaseOwner = [string](Get-ReleaseQueueProperty -Object $nestedLease -Name "owner" -Default "")
                }
            }
        }

        $currentStatus = [string](Get-ReleaseQueueProperty -Object $ticket -Name "status" -Default "queued")
        if ((Get-ReleaseQueueActiveStatusList) -contains $currentStatus) {
            if ([string]::IsNullOrWhiteSpace($leaseId) -or [string]::IsNullOrWhiteSpace($leaseOwner)) {
                throw "活动票据更新必须提供当前 leaseId 和 leaseOwner：$ticketId"
            }
        }

        $normalized = $null
        if (-not [string]::IsNullOrWhiteSpace($Status)) {
            $normalized = Normalize-ReleaseQueueStatusInput -Status $Status
        }
        $targetStatus = if ($null -ne $normalized) {
            [string]$normalized.status
        }
        else {
            $currentStatus
        }
        $aliasPhase = if ($null -ne $normalized) { [string]$normalized.phase } else { "" }
        $stageValue = if (-not [string]::IsNullOrWhiteSpace($phaseValue)) { $phaseValue } elseif (-not [string]::IsNullOrWhiteSpace($aliasPhase)) { $aliasPhase } else { "" }

        $metadata = [ordered]@{}
        $existingMetadata = Get-ReleaseQueueProperty -Object $ticket -Name "metadata" -Default $null
        if ($null -ne $existingMetadata) {
            if ($existingMetadata -is [Collections.IDictionary]) {
                foreach ($entry in $existingMetadata.GetEnumerator()) { $metadata[[string]$entry.Key] = $entry.Value }
            }
            else {
                foreach ($property in $existingMetadata.PSObject.Properties) { $metadata[$property.Name] = $property.Value }
            }
        }
        $metadata.phase = $stageValue
        $metadata.stage = $stageValue
        if (-not [string]::IsNullOrWhiteSpace($Version)) { $metadata.version = $Version }
        elseif (-not $metadata.Contains('version') -and -not [string]::IsNullOrWhiteSpace([string]$ticket.version)) { $metadata.version = [string]$ticket.version }
        if (-not [string]::IsNullOrWhiteSpace($BaseHead)) { $metadata.baseHead = $BaseHead }
        elseif (-not $metadata.Contains('baseHead') -and -not [string]::IsNullOrWhiteSpace([string]$ticket.baseHead)) { $metadata.baseHead = [string]$ticket.baseHead }
        if (-not [string]::IsNullOrWhiteSpace($ContextPath)) { $metadata.contextPath = $ContextPath }
        elseif (-not $metadata.Contains('contextPath') -and -not [string]::IsNullOrWhiteSpace([string]$ticket.contextPath)) { $metadata.contextPath = [string]$ticket.contextPath }
        if (-not [string]::IsNullOrWhiteSpace($ReservationPath)) { $metadata.reservationPath = $ReservationPath }
        elseif (-not $metadata.Contains('reservationPath') -and -not [string]::IsNullOrWhiteSpace([string]$ticket.reservationPath)) { $metadata.reservationPath = [string]$ticket.reservationPath }
        if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $metadata.lastError = $ErrorMessage }
        $metadata.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        if ($targetStatus -in @('failed', 'recoverable')) { $metadata.recoveryStatus = $targetStatus }

        $setArgs = @{
            TicketId = $ticketId
            Status = $targetStatus
            QueueRoot = $QueueRoot
            WaitSeconds = $WaitSeconds
            PollMilliseconds = $PollMilliseconds
            Metadata = $metadata
        }
        if (-not [string]::IsNullOrWhiteSpace($OperationId)) { $setArgs.OperationId = $OperationId }
        if (-not [string]::IsNullOrWhiteSpace($stageValue)) { $setArgs.Stage = $stageValue }
        if (-not [string]::IsNullOrWhiteSpace($Version)) { $setArgs.Version = $Version }
        if (-not [string]::IsNullOrWhiteSpace($BaseHead)) { $setArgs.BaseHead = $BaseHead }
        if (-not [string]::IsNullOrWhiteSpace($ContextPath)) { $setArgs.ContextPath = $ContextPath }
        if (-not [string]::IsNullOrWhiteSpace($ReservationPath)) { $setArgs.ReservationPath = $ReservationPath }
        if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $setArgs.ErrorMessage = $ErrorMessage }
        if (-not [string]::IsNullOrWhiteSpace($leaseId)) { $setArgs.LeaseId = $leaseId }
        if (-not [string]::IsNullOrWhiteSpace($leaseOwner)) { $setArgs.LeaseOwner = $leaseOwner }

        # One state-machine transaction updates phase, version, context and
        # status together.  That prevents a phase write from racing a lease
        # expiry and leaves no half-updated ticket for resume-release.ps1.
        return Set-ReleaseQueueTicketStatus @setArgs
    }
}

function Remove-ReleaseQueueTicket {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TicketId,
        [switch]$Force,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    return Invoke-ReleaseQueueTransaction -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds -Action ({
        param($state, $storePaths)
        $index = Get-ReleaseQueueTicketIndex -State $state -TicketId $TicketId
        if ($index -lt 0) { throw "找不到队列票据：$TicketId" }
        $ticket = $state.tickets[$index]
        $status = [string]$ticket.status
        if (((Get-ReleaseQueueActiveStatusList) -contains $status -or $status -eq "succeeded") -and -not $Force) {
            throw "活动或成功票据默认不可删除，请使用 -Force 并确认审计需求：$TicketId"
        }
        $state.tickets = @($state.tickets | Where-Object { [string]$_.ticketId -ne $TicketId })
        $event = New-ReleaseQueueEvent -Type "ticket-deleted" -Ticket $ticket -FromStatus $status -ToStatus "deleted" -Actor "queue-delete"
        return New-ReleaseQueueOutcome -Result (Copy-ReleaseQueueTicketResult -Ticket $ticket) -Changed $true -Events @($event)
    })
}

function Get-ReleaseQueueSummary {
    [CmdletBinding()]
    param(
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    $tickets = @(Get-ReleaseQueueTickets -IncludeTerminal -RecoverExpired -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds)
    $counts = [ordered]@{}
    foreach ($status in (Get-ReleaseQueueStatusList)) { $counts[$status] = @($tickets | Where-Object { $_.status -eq $status }).Count }
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        total = $tickets.Count
        counts = [pscustomobject]$counts
        next = @($tickets | Where-Object { $_.status -eq "queued" } | Sort-Object sequence | Select-Object -First 1)
        generatedAt = Get-ReleaseQueueNowText
    }
}

function Get-ReleaseQueueRoot {
    [CmdletBinding()]
    param(
        [string]$QueueRoot = "",
        [string]$QueuePath = ""
    )
    return (Get-ReleaseQueuePaths -QueueRoot $QueueRoot -QueuePath $QueuePath).QueueRoot
}

function Get-ReleaseQueueNext {
    [CmdletBinding()]
    param(
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [switch]$NoRecovery,
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    $items = @(Get-ReleaseQueueTickets -Status "queued" -Limit 1 -RecoverExpired:(-not $NoRecovery) -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds)
    if ($items.Count -eq 0) {
        return $null
    }
    return $items[0]
}

function Recover-StaleReleaseQueueTickets {
    [CmdletBinding()]
    param(
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [string]$Actor = "queue-recovery",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    return Recover-ReleaseQueueTickets -QueueRoot $QueueRoot -QueuePath $QueuePath -Actor $Actor -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
}

function Assert-ReleaseQueueTurn {
    [CmdletBinding()]
    param(
        [string]$TicketId = "",
        [string]$OperationId = "",
        [int64]$Sequence = 0,
        [switch]$AllowOutOfOrder,
        [string]$QueueRoot = "",
        [string]$QueuePath = "",
        [ValidateRange(1, 7200)][int]$WaitSeconds = 1800,
        [ValidateRange(25, 5000)][int]$PollMilliseconds = 250
    )
    if ([string]::IsNullOrWhiteSpace($TicketId) -and [string]::IsNullOrWhiteSpace($OperationId) -and $Sequence -le 0) {
        throw "Assert-ReleaseQueueTurn 必须提供 TicketId、OperationId 或 Sequence。"
    }
    if ($AllowOutOfOrder) {
        if (-not [string]::IsNullOrWhiteSpace($TicketId)) {
            return Get-ReleaseQueueTicket -TicketId $TicketId -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
        }
        return Get-ReleaseQueueTicket -OperationId $OperationId -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
    }
    $next = Get-ReleaseQueueNext -QueueRoot $QueueRoot -QueuePath $QueuePath -WaitSeconds $WaitSeconds -PollMilliseconds $PollMilliseconds
    if ($null -eq $next) {
        throw "发布队列当前没有可领取票据。"
    }
    $matches = $false
    if (-not [string]::IsNullOrWhiteSpace($TicketId)) { $matches = [string]$next.ticketId -eq $TicketId }
    elseif (-not [string]::IsNullOrWhiteSpace($OperationId)) { $matches = [string]$next.operationId -eq $OperationId }
    else { $matches = [int64]$next.sequence -eq $Sequence }
    if (-not $matches) {
        throw "尚未轮到该发布票据；当前 FIFO 票据是 $($next.ticketId)（sequence=$($next.sequence)）。"
    }
    return $next
}

# 下面是可选的命令行薄封装；被 dot-source 时 Action 为空，不会产生副作用。
if (-not [string]::IsNullOrWhiteSpace($RQAction) -and $MyInvocation.InvocationName -ne ".") {
    $ErrorActionPreference = "Stop"
    $result = $null
    switch ($RQAction.ToLowerInvariant()) {
        "init" {
            $result = Initialize-ReleaseQueueStore -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -Force:$RQForce -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "new" {
            if ([string]::IsNullOrWhiteSpace($RQOperationId)) { throw "new 操作必须提供 -OperationId。" }
            $metadata = $null
            if (-not [string]::IsNullOrWhiteSpace($RQMetadataJson)) { $metadata = $RQMetadataJson | ConvertFrom-Json }
            $result = New-ReleaseQueueTicket -OperationId $RQOperationId -IdempotencyKey $RQIdempotencyKey -RequestedVersion $RQRequestedVersion -SourceSha256 $RQSourceSha256 -IncludePath $RQIncludePath -SourcePath $RQSourcePath -CreatedBy $RQCreatedBy -Phase $RQPhase -Version $RQVersion -BaseHead $RQBaseHead -ContextPath $RQContextPath -ReservationPath $RQReservationPath -Priority $RQPriority -MaxAttempts $RQMaxAttempts -Metadata $metadata -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "get" {
            $result = Get-ReleaseQueueTicket -TicketId $RQTicketId -OperationId $RQOperationId -IdempotencyKey $RQIdempotencyKey -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "list" {
            $result = Get-ReleaseQueueTickets -Status $RQStatus -OperationId $RQOperationId -IncludeTerminal:$RQForce -RecoverExpired:$RQRecoverExpired -Limit $RQLimit -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "next" {
            $result = Get-ReleaseQueueNext -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -NoRecovery:$(-not $RQRecoverExpired) -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "turn" {
            $result = Assert-ReleaseQueueTurn -TicketId $RQTicketId -OperationId $RQOperationId -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -AllowOutOfOrder:$RQAllowOutOfOrder -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "claim" {
            $result = Claim-ReleaseQueueTicket -TicketId $RQTicketId -LeaseOwner $RQLeaseOwner -LeaseSeconds $RQLeaseSeconds -AllowOutOfOrder:$RQAllowOutOfOrder -AllowPrepared:$RQAllowPrepared -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "heartbeat" {
            $result = Renew-ReleaseQueueLease -TicketId $RQTicketId -LeaseId $RQLeaseId -LeaseOwner $RQLeaseOwner -LeaseSeconds $RQLeaseSeconds -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "recover" {
            $result = Recover-ReleaseQueueTickets -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "status" {
            if ([string]::IsNullOrWhiteSpace($RQTicketId) -or [string]::IsNullOrWhiteSpace($RQStatus)) { throw "status 操作必须提供 -TicketId 和 -Status。" }
            $result = Set-ReleaseQueueTicketStatus -TicketId $RQTicketId -Status $RQStatus -OperationId $RQOperationId -Stage $RQPhase -Version $RQVersion -BaseHead $RQBaseHead -ContextPath $RQContextPath -ReservationPath $RQReservationPath -ErrorMessage $RQErrorMessage -LeaseId $RQLeaseId -LeaseOwner $RQLeaseOwner -Reason $RQReason -Retry:$RQRetry -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "remove" {
            $result = Remove-ReleaseQueueTicket -TicketId $RQTicketId -Force:$RQForce -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        "summary" {
            $result = Get-ReleaseQueueSummary -QueueRoot $RQQueueRoot -QueuePath $RQQueuePath -WaitSeconds $RQWaitSeconds -PollMilliseconds $RQPollMilliseconds
        }
        default { throw "未知 release queue Action：$RQAction（可用 init/new/get/list/claim/heartbeat/recover/status/remove/summary）" }
    }
    if ($RQJson) {
        $result | ConvertTo-Json -Depth 40
    }
    elseif ($null -ne $result) {
        $result
    }
}
