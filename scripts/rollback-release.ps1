<#
.SYNOPSIS
    Select a previously verified miniapp package as the local release pointer.

.DESCRIPTION
    This is the deliberately small, local half of rollback.  It validates the
    immutable ZIP, its manifest, the release record and context, then (only
    with -ConfirmRollback) records a backup and atomically updates
    the policy's latestReleasePath.  It never pushes Git, calls CloudBase,
    changes a historical record, or deletes an artifact.  CloudBase rollback is
    intentionally not implied by this command.
#>

param(
    [string]$TargetVersion = "",
    [string]$OperationId = "",
    [string]$PolicyPath = "",
    [string]$RollbackId = "",
    [switch]$ConfirmRollback,
    [switch]$Json,
    [ValidateRange(1, 7200)][int]$LockWaitSeconds = 1800
)

Set-StrictMode -Version Latest

$script:RollbackDotSourced = ($MyInvocation.InvocationName -eq ".")

$gateScript = Join-Path $PSScriptRoot "release-gate.ps1"
if (-not (Get-Command Get-ReleaseGatePolicy -ErrorAction SilentlyContinue)) {
    if (-not (Test-Path -LiteralPath $gateScript -PathType Leaf)) { throw "Missing release-gate.ps1: $gateScript" }
    . $gateScript
}
$lockScript = Join-Path $PSScriptRoot "release-lock.ps1"
if (-not (Get-Command Enter-ReleaseLock -ErrorAction SilentlyContinue)) {
    if (-not (Test-Path -LiteralPath $lockScript -PathType Leaf)) { throw "Missing release-lock.ps1: $lockScript" }
    . $lockScript
}
# Do not dot-source release-maintenance.ps1 here: its CLI parameter block would
# overwrite this script's $PolicyPath/$Json variables in the caller scope.
# Rollback has small local immutable-write fallbacks below, so it remains a
# standalone entry point.

function Get-RollbackProperty {
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

function ConvertTo-RollbackFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Test-RollbackPathUnder {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $p = (ConvertTo-RollbackFullPath $Path).TrimEnd('\', '/')
    $r = (ConvertTo-RollbackFullPath $Root).TrimEnd('\', '/')
    if ([string]::Equals($p, $r, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $p.StartsWith($r + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $p.StartsWith($r + '/', [StringComparison]::OrdinalIgnoreCase)
}

function Get-RollbackPolicy {
    param([string]$Path = "")
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $policy = Get-ReleaseGatePolicy -PolicyPath $Path -RepositoryRoot $repoRoot
    Assert-ReleaseCanonicalPolicy -Policy $policy -RepositoryRoot $repoRoot | Out-Null
    return $policy
}

function Get-RollbackRecords {
    param([Parameter(Mandatory = $true)][object]$Policy)
    $root = ConvertTo-RollbackFullPath ([string]$Policy.recordRoot)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return @() }
    $result = New-Object System.Collections.Generic.List[object]
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter 'release-v*.json' -File -ErrorAction SilentlyContinue)) {
        try {
            $value = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            [void]$result.Add([pscustomobject]@{ Path = $file.FullName; Value = $value; LastWriteTimeUtc = $file.LastWriteTimeUtc })
        }
        catch { throw "Unable to parse release record: $($file.FullName). $($_.Exception.Message)" }
    }
    return @($result.ToArray())
}

function Resolve-RollbackRecord {
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [string]$TargetVersion = "",
        [string]$OperationId = ""
    )
    $hasVersion = -not [string]::IsNullOrWhiteSpace($TargetVersion)
    $hasOperation = -not [string]::IsNullOrWhiteSpace($OperationId)
    if ($hasVersion -eq $hasOperation) { throw "Specify exactly one of TargetVersion or OperationId." }
    if ($hasVersion -and $TargetVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid target version: $TargetVersion" }
    if ($hasOperation -and $OperationId -notmatch '^op-[A-Za-z0-9][A-Za-z0-9._-]{5,120}$') { throw "Invalid operation id: $OperationId" }

    $matches = @(Get-RollbackRecords -Policy $Policy | Where-Object {
        $value = $_.Value
        $v = [string](Get-RollbackProperty $value "version" "")
        $op = [string](Get-RollbackProperty $value "operationId" "")
        if ($hasVersion) { $v -eq $TargetVersion } else { $op -eq $OperationId }
    })
    if ($matches.Count -eq 0) { throw "No release record matched the rollback target." }
    $terminal = @($matches | Where-Object {
        $status = [string](Get-RollbackProperty $_.Value "terminalStatus" (Get-RollbackProperty $_.Value "status" ""))
        $status -in @("succeeded", "已推送") -or [string](Get-RollbackProperty $_.Value "status" "") -eq "succeeded"
    })
    if ($terminal.Count -eq 0) { throw "Rollback target has no succeeded release record." }
    $commits = @($terminal | ForEach-Object { [string](Get-RollbackProperty $_.Value "releaseCommit" (Get-RollbackProperty $_.Value "commitSha" "")) } | Sort-Object -Unique)
    if ($commits.Count -gt 1) { throw "Target version maps to multiple release commits; refusing ambiguous rollback." }
    return ($terminal | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)
}

function Get-RollbackManifestValues {
    param([Parameter(Mandatory = $true)][string]$ArtifactPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $archive = $null
    try {
        $archive = [IO.Compression.ZipFile]::OpenRead($ArtifactPath)
        if ($null -eq $archive) { throw "ZIP could not be opened" }
        $entry = $archive.GetEntry("RELEASE-MANIFEST.txt")
        if ($null -eq $entry) { throw "ZIP has no RELEASE-MANIFEST.txt" }
        $reader = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8, $true)
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    catch { throw "Unable to read release manifest: $ArtifactPath. $($_.Exception.Message)" }
    finally { if ($null -ne $archive) { $archive.Dispose() } }
    $map = [ordered]@{}
    $separator = [string][char]0xFF1A
    foreach ($line in ($text -split "`r?`n")) {
        $index = $line.IndexOf($separator, [StringComparison]::Ordinal)
        if ($index -gt 0) {
            $key = $line.Substring(0, $index).Trim()
            $value = $line.Substring($index + 1).Trim()
            if (-not $map.Contains($key)) { $map[$key] = $value }
        }
    }
    return [pscustomobject]$map
}

function Assert-RollbackArtifact {
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [Parameter(Mandatory = $true)][object]$Record
    )
    $value = $Record.Value
    $version = [string](Get-RollbackProperty $value "version" "")
    $operationId = [string](Get-RollbackProperty $value "operationId" "")
    $releaseCommit = [string](Get-RollbackProperty $value "releaseCommit" (Get-RollbackProperty $value "commitSha" ""))
    $treeSha = [string](Get-RollbackProperty $value "treeSha" "")
    $sourceSha = [string](Get-RollbackProperty $value "sourceSha256" "")
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Release record version is invalid." }
    if ($operationId -notmatch '^op-[A-Za-z0-9][A-Za-z0-9._-]{5,120}$') { throw "Release record operationId is invalid." }
    if ($releaseCommit -notmatch '^[0-9a-fA-F]{7,64}$') { throw "Release record releaseCommit is invalid." }
    if ($treeSha -notmatch '^[0-9a-fA-F]{7,64}$') { throw "Release record treeSha is invalid." }
    if ($sourceSha -notmatch '^[0-9a-fA-F]{64}$') { throw "Release record sourceSha256 is invalid." }

    $packageValue = [string](Get-RollbackProperty $value "packagePath" (Get-RollbackProperty $value "artifactPath" ""))
    if ([string]::IsNullOrWhiteSpace($packageValue) -or -not [IO.Path]::IsPathRooted($packageValue)) { throw "Release record packagePath must be absolute." }
    $packagePath = ConvertTo-RollbackFullPath $packageValue
    $artifactRoot = ConvertTo-RollbackFullPath ([string]$Policy.artifactRoot)
    if (-not (Test-RollbackPathUnder -Path $packagePath -Root $artifactRoot)) { throw "Package path is outside artifactRoot." }
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw "Rollback package does not exist: $packagePath" }
    $expectedName = "wechat-miniapp-release-v{0}-{1}.zip" -f $version, $releaseCommit
    if (-not [string]::Equals(([IO.Path]::GetFileName($packagePath)), $expectedName, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Rollback package filename does not bind to version/commit: $packagePath"
    }
    $packageSha = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $recordSha = [string](Get-RollbackProperty $value "packageSha256" "")
    if (-not [string]::IsNullOrWhiteSpace($recordSha) -and $recordSha.ToLowerInvariant() -ne $packageSha) { throw "Package SHA does not match release record." }

    $manifest = Get-RollbackManifestValues -ArtifactPath $packagePath
    $checks = [ordered]@{
        "操作 ID" = $operationId
        "版本" = $version
        "源提交 SHA" = [string](Get-RollbackProperty $value "sourceCommit" "")
        "提交 SHA" = $releaseCommit
        "Git tree SHA" = $treeSha
        "源码内容 SHA256" = $sourceSha
        "产物文件名" = [IO.Path]::GetFileName($packagePath)
    }
    foreach ($key in $checks.Keys) {
        $actual = [string](Get-RollbackProperty $manifest $key "")
        if ($key -eq "源提交 SHA" -and [string]::IsNullOrWhiteSpace([string]$checks[$key])) { continue }
        if ($actual -ne [string]$checks[$key]) { throw "ZIP manifest mismatch for $key." }
    }

    $contextPathValue = [string](Get-RollbackProperty $value "contextPath" "")
    if ([string]::IsNullOrWhiteSpace($contextPathValue)) { $contextPathValue = Join-Path ([string]$Policy.contextRoot) "release-$operationId.json" }
    if (-not [IO.Path]::IsPathRooted($contextPathValue)) { throw "Context path must be absolute." }
    $contextPath = ConvertTo-RollbackFullPath $contextPathValue
    if (-not (Test-RollbackPathUnder -Path $contextPath -Root ([string]$Policy.contextRoot))) { throw "Context path is outside contextRoot." }
    if (-not (Test-Path -LiteralPath $contextPath -PathType Leaf)) { throw "Rollback context is missing: $contextPath" }
    try { $context = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw "Unable to parse rollback context: $contextPath" }
    foreach ($key in @("operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "artifactPath")) {
        if ([string](Get-RollbackProperty $context $key "") -eq "") { throw "Rollback context missing $key." }
    }
    if ([string]$context.operationId -ne $operationId -or [string]$context.version -ne $version -or
        [string]$context.releaseCommit -ne $releaseCommit -or [string]$context.treeSha -ne $treeSha -or
        [string]$context.sourceSha256 -ne $sourceSha) { throw "Context identity does not match release record." }
    if (-not [string]::Equals((ConvertTo-RollbackFullPath ([string]$context.artifactPath)), $packagePath, [StringComparison]::OrdinalIgnoreCase)) { throw "Context artifactPath does not match package." }
    $contextSha = [string](Get-RollbackProperty $context "packageSha256" "")
    if (-not [string]::IsNullOrWhiteSpace($contextSha) -and $contextSha.ToLowerInvariant() -ne $packageSha) { throw "Context package SHA does not match package." }

    return [pscustomobject][ordered]@{
        recordPath = [string]$Record.Path
        contextPath = $contextPath
        version = $version
        operationId = $operationId
        sourceCommit = [string](Get-RollbackProperty $value "sourceCommit" "")
        releaseCommit = $releaseCommit
        treeSha = $treeSha
        sourceSha256 = $sourceSha.ToLowerInvariant()
        packagePath = $packagePath
        packageSha256 = $packageSha
        packageSizeBytes = (Get-Item -LiteralPath $packagePath).Length
        phase = [string](Get-RollbackProperty $value "phase" "")
    }
}

function Get-RollbackCurrentPointer {
    param([Parameter(Mandatory = $true)][object]$Policy)
    $path = [string](Get-RollbackProperty $Policy "latestReleasePath" "")
    if ([string]::IsNullOrWhiteSpace($path)) { $path = Join-Path ([string]$Policy.artifactRoot) "wechat-miniapp-latest-release.json" }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject][ordered]@{ path = $path; exists = $false; value = $null; rawBytes = [byte[]]@(); sha256 = "" }
    }
    $bytes = [IO.File]::ReadAllBytes($path)
    $value = $null
    try { $value = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { }
    $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    return [pscustomobject][ordered]@{ path = $path; exists = $true; value = $value; rawBytes = $bytes; sha256 = $sha }
}

function Write-RollbackJsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $parent = Split-Path ([IO.Path]::GetFullPath($Path)) -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temp = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temp, (($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    try { Move-Item -LiteralPath $temp -Destination $Path -Force }
    finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}

function Write-RollbackImmutableBytes {
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
            throw "Refusing to overwrite immutable rollback file: $Path"
        }
    }
    finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}

function Write-RollbackJsonImmutable {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $json = (($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine)
    return Write-RollbackImmutableBytes -Path $Path -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Write-RollbackLog {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Message
    )
    New-Item -ItemType Directory -Path (Split-Path ([IO.Path]::GetFullPath($Path)) -Parent) -Force | Out-Null
    $line = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString("o"); operationId = $OperationId; stage = $Stage; message = $Message } | ConvertTo-Json -Compress
    Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
}

function New-RollbackIdentifier {
    return "rb-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
}

function Invoke-ReleaseRollback {
    <# Validate first; with -Apply, lock and write only local pointer/records. #>
    param(
        [Parameter(Mandatory = $true)][object]$Policy,
        [string]$TargetVersion = "",
        [string]$OperationId = "",
        [switch]$Apply,
        [string]$RollbackId = "",
        [ValidateRange(1, 7200)][int]$LockWaitSeconds = 1800
    )
    $record = Resolve-RollbackRecord -Policy $Policy -TargetVersion $TargetVersion -OperationId $OperationId
    $target = Assert-RollbackArtifact -Policy $Policy -Record $record
    if (-not $Apply) {
        return [pscustomobject][ordered]@{
            action = "rollback"
            mode = "preview"
            validated = $true
            wouldChange = $true
            cloudBaseChanged = $false
            cloudBaseAction = "not-run"
            target = $target
            pointerPath = [string](Get-RollbackCurrentPointer -Policy $Policy).path
        }
    }

    $lock = $null
    $rollbackIdValue = if ([string]::IsNullOrWhiteSpace($RollbackId)) { New-RollbackIdentifier } else { $RollbackId.Trim() }
    if ($rollbackIdValue -notmatch '^rb-[A-Za-z0-9][A-Za-z0-9._-]{5,120}$') { throw "Invalid rollback id: $rollbackIdValue" }
    $logPath = Join-Path ([string]$Policy.logRoot) "rollback-$rollbackIdValue.log"
    try {
        $lock = Enter-ReleaseLock -ProjectPath ([string]$Policy.canonicalRepo) -TargetVersion $target.version -TargetType "local-rollback" -WaitSeconds $LockWaitSeconds -LockPath ([string]$Policy.lockPath) -ProjectId $rollbackIdValue -LeaseSeconds 180 -Stage "rollback"
        Write-RollbackLog -Path $logPath -OperationId $target.operationId -Stage "validated" -Message "validated immutable target $($target.version) $($target.releaseCommit)"
        # Re-read under the lock to close the record/package check-to-use window.
        $record = Resolve-RollbackRecord -Policy $Policy -TargetVersion $TargetVersion -OperationId $OperationId
        $target = Assert-RollbackArtifact -Policy $Policy -Record $record
        $current = Get-RollbackCurrentPointer -Policy $Policy
        $backupRoot = [string](Get-RollbackProperty $Policy "backupRoot" "")
        if ([string]::IsNullOrWhiteSpace($backupRoot)) { $backupRoot = Join-Path ([string]$Policy.artifactRoot) "wechat-miniapp-release-backups" }
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $previousPointerBackup = ""
        if ($current.exists) {
            $previousPointerBackup = Join-Path $backupRoot "rollback-$rollbackIdValue-previous-pointer.json"
            [void](Write-RollbackImmutableBytes -Path $previousPointerBackup -Bytes $current.rawBytes)
        }
        $backupPath = Join-Path $backupRoot "rollback-$rollbackIdValue.json"
        $backup = [ordered]@{
            schemaVersion = 1
            kind = "local-release-rollback-backup"
            rollbackId = $rollbackIdValue
            operationId = $target.operationId
            targetVersion = $target.version
            targetReleaseCommit = $target.releaseCommit
            targetTreeSha = $target.treeSha
            targetSourceSha256 = $target.sourceSha256
            targetPackagePath = $target.packagePath
            targetPackageSha256 = $target.packageSha256
            previousPointerPath = if ($current.exists) { $current.path } else { "" }
            previousPointerSha256 = $current.sha256
            previousPointerBackupPath = $previousPointerBackup
            capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
            cloudBaseChanged = $false
            cloudBaseAction = "not-run"
        }
        [void](Write-RollbackJsonImmutable -Path $backupPath -Value $backup)

        $pointerPath = $current.path
        $pointer = [ordered]@{
            schemaVersion = 1
            kind = "local-release-pointer"
            status = "selected"
            rollbackId = $rollbackIdValue
            operationId = $target.operationId
            version = $target.version
            sourceCommit = $target.sourceCommit
            releaseCommit = $target.releaseCommit
            treeSha = $target.treeSha
            sourceSha256 = $target.sourceSha256
            artifactPath = $target.packagePath
            packageSha256 = $target.packageSha256
            packageSizeBytes = $target.packageSizeBytes
            contextPath = $target.contextPath
            recordPath = $target.recordPath
            selectedAt = [DateTimeOffset]::UtcNow.ToString("o")
            cloudBaseChanged = $false
            cloudBaseAction = "not-run"
        }
        $recordPath = Join-Path ([string]$Policy.recordRoot) "rollback-$rollbackIdValue.json"
        $rollbackRecord = [ordered]@{
            schemaVersion = 1
            kind = "local-rollback"
            rollbackId = $rollbackIdValue
            status = "prepared"
            operationId = $target.operationId
            version = $target.version
            sourceCommit = $target.sourceCommit
            releaseCommit = $target.releaseCommit
            treeSha = $target.treeSha
            sourceSha256 = $target.sourceSha256
            packagePath = $target.packagePath
            packageSha256 = $target.packageSha256
            contextPath = $target.contextPath
            targetRecordPath = $target.recordPath
            pointerPath = $pointerPath
            backupPath = $backupPath
            previousPointerPath = if ($current.exists) { $current.path } else { "" }
            previousPointerSha256 = $current.sha256
            previousPointerBackupPath = $previousPointerBackup
            cloudBaseChanged = $false
            cloudBaseAction = "not-run"
            createdAt = [DateTimeOffset]::UtcNow.ToString("o")
        }
        Write-RollbackJsonAtomic -Path $recordPath -Value $rollbackRecord
        Write-RollbackLog -Path $logPath -OperationId $target.operationId -Stage "backup" -Message "backup written: $backupPath"
        Write-RollbackJsonAtomic -Path $pointerPath -Value $pointer
        $pointerSha = (Get-FileHash -LiteralPath $pointerPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $rollbackRecord.status = "applied"
        $rollbackRecord.pointerSha256 = $pointerSha
        $rollbackRecord.appliedAt = [DateTimeOffset]::UtcNow.ToString("o")
        Write-RollbackJsonAtomic -Path $recordPath -Value $rollbackRecord
        Write-RollbackLog -Path $logPath -OperationId $target.operationId -Stage "applied" -Message "local pointer selected; CloudBase untouched"
        return [pscustomobject][ordered]@{
            action = "rollback"
            mode = "applied"
            status = "applied"
            rollbackId = $rollbackIdValue
            operationId = $target.operationId
            version = $target.version
            releaseCommit = $target.releaseCommit
            treeSha = $target.treeSha
            sourceSha256 = $target.sourceSha256
            packagePath = $target.packagePath
            packageSha256 = $target.packageSha256
            pointerPath = $pointerPath
            pointerSha256 = $pointerSha
            backupPath = $backupPath
            rollbackRecordPath = $recordPath
            logPath = $logPath
            cloudBaseChanged = $false
            cloudBaseAction = "not-run"
        }
    }
    finally { if ($null -ne $lock) { Exit-ReleaseLock -LockHandle $lock } }
}

if (-not $script:RollbackDotSourced) {
    $policy = Get-RollbackPolicy -Path $PolicyPath
    $result = Invoke-ReleaseRollback -Policy $policy -TargetVersion $TargetVersion -OperationId $OperationId -Apply:$ConfirmRollback -RollbackId $RollbackId -LockWaitSeconds $LockWaitSeconds
    if ($Json) {
        $result | ConvertTo-Json -Depth 40
    }
    else {
        Write-Host ("Rollback mode: {0}" -f $result.mode)
        $displayVersion = if ($result.PSObject.Properties["version"]) { $result.version } else { $result.target.version }
        $displayCommit = if ($result.PSObject.Properties["releaseCommit"]) { $result.releaseCommit } else { $result.target.releaseCommit }
        Write-Host ("Target: v{0} {1}" -f $displayVersion, $displayCommit)
        Write-Host ("CloudBase changed: {0}" -f $result.cloudBaseChanged)
        $result | ConvertTo-Json -Depth 40
    }
}
