param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [object[]]$IncludePath,

    [string]$TargetVersion = "",

    [string]$PolicyPath = "",

    [ValidateRange(1, 1800)]
    [int]$LockWaitSeconds = 1800,

    # Preparation is the default.  Only an explicit -Publish may push a branch
    # and create/auto-merge a PR into main.
    [switch]$Publish,

    [switch]$Preview,

    [string]$PreviewCliPath = "",

    [string]$PreviewClientName = "default",

    [switch]$DeployCloud,

    [switch]$KeepWorktree
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot
. (Join-Path $scriptRoot "release-gate.ps1")
. (Join-Path $scriptRoot "release-lock.ps1")
. (Join-Path $scriptRoot "release-version.ps1")

$canonicalGuess = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$policy = Get-ReleaseGatePolicy -PolicyPath $PolicyPath -RepositoryRoot $canonicalGuess
if (-not (Test-ReleasePathEqual -Left $canonicalGuess -Right ([string]$policy.canonicalRepo))) {
    throw "旧 clone/worktree 不允许直接调用发布入口，请从 canonical 仓库执行：$([string]$policy.canonicalRepo)"
}
$canonicalRepo = ConvertTo-ReleaseFullPath -Path ([string]$policy.canonicalRepo)
$includePaths = @(Normalize-ReleaseIncludePaths -InputPath $IncludePath)
if ($Preview) {
    if ([string]::IsNullOrWhiteSpace($PreviewCliPath)) { $PreviewCliPath = $env:WECHAT_DEVTOOLS_CLI }
    if ([string]::IsNullOrWhiteSpace($PreviewCliPath) -or -not (Test-Path -LiteralPath $PreviewCliPath -PathType Leaf)) {
        throw "已要求生成预览码，但找不到微信开发者工具 CLI；闸门尚未分配版本。"
    }
}
$operationId = "op-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
$logPath = New-ReleaseOperationLogPath -LogRoot ([string]$policy.logRoot) -OperationId $operationId
$lockHandle = $null
$reservation = $null
$releaseWorktree = ""
$contextPath = ""
$finalCommit = ""
$failureAfterCommit = $false
$completed = $false
$releaseToolPaths = @(
    "scripts/release-gate.ps1",
    "scripts/release.ps1",
    "scripts/package-release.py",
    "scripts/package-release-smoke.py",
    "scripts/release-lock.ps1",
    "scripts/release-version.ps1",
    "scripts/release-safety-smoke.js",
    "scripts/release-gate-smoke.js",
    "scripts/deploy-and-verify-api.ps1",
    "scripts/cloud-deploy-safety.ps1",
    "scripts/deploy-api-cloudbase-cli.ps1",
    "scripts/refresh-preview.ps1",
    "scripts/configure-github-protection.ps1",
    "scripts/sync-to-github.ps1",
    ".github/workflows/release-gate.yml",
    "docs/superpowers/specs/2026-08-28-release-gate-design.md"
)

function Write-GateHost {
    param([string]$Stage, [string]$Message)
    Write-Host "[$Stage] $Message"
    Write-ReleaseOperationLog -Path $logPath -Stage $Stage -Message $Message -OperationId $operationId
}

function Get-GateConfigTextAt {
    param([string]$Repository, [string]$Revision)
    return ((Invoke-ReleaseGit -WorkingDirectory $Repository -Arguments @("show", "$Revision`:config.js")) -join "`n")
}

function Get-GateVersionFromText {
    param([string]$Text, [string]$Source)
    $match = [regex]::Match($Text, 'appVersion:\s*"([^"]+)"')
    if (-not $match.Success) { throw "无法从 $Source 读取 appVersion。" }
    return $match.Groups[1].Value
}

function Get-GatePackageSummary {
    param([string[]]$Output)
    $text = ($Output -join "`n").Trim()
    # The hardened package script emits a JSON summary.  Locate the last JSON
    # object so human-readable diagnostic lines before it remain useful.
    $lines = @($text -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') -and $_.Trim().EndsWith('}') })
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        try { return ($lines[$i] | ConvertFrom-Json) } catch { }
    }
    $shaMatch = [regex]::Match($text, '(?:sourceSha256|源码内容 SHA256)\s*[:：]\s*([0-9a-fA-F]{64})')
    if ($shaMatch.Success) { return [pscustomobject]@{ sourceSha256 = $shaMatch.Groups[1].Value.ToLowerInvariant() } }
    return $null
}

function Invoke-GatePython {
    param([string]$ScriptRoot, [string[]]$Arguments)
    $output = & python (Join-Path $ScriptRoot "scripts/package-release.py") @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "package-release.py 失败：$($output -join "`n")"
    }
    return @($output)
}

function Add-GateUniquePath {
    param([System.Collections.Generic.List[string]]$List, [string]$Path)
    if (-not $List.Contains($Path)) { [void]$List.Add($Path) }
}

try {
    Write-GateHost "queue" "操作号 $operationId，开始进入统一发布队列。"
    $sourceRepo = Assert-ReleaseGitRepository -RepositoryPath $SourcePath -Policy $policy -AllowSourceWorktree
    $canonical = Assert-ReleaseCanonicalRepository -RepositoryPath $canonicalRepo -Policy $policy
    $archiveManifestPath = Update-ReleaseArchiveManifest -Policy $policy
    Write-GateHost "archive" "已更新旧 clone/worktree 封存清单：$archiveManifestPath"
    if (-not (Test-Path -LiteralPath ([string]$policy.contextRoot) -PathType Container)) {
        New-Item -ItemType Directory -Path ([string]$policy.contextRoot) -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath ([string]$policy.artifactRoot) -PathType Container)) {
        New-Item -ItemType Directory -Path ([string]$policy.artifactRoot) -Force | Out-Null
    }

    $lockTargetVersion = if ([string]::IsNullOrWhiteSpace($TargetVersion)) { "auto" } else { $TargetVersion }
    $lockHandle = Enter-ReleaseLock `
        -ProjectPath $canonicalRepo `
        -TargetVersion $lockTargetVersion `
        -TargetType "release-gate" `
        -WaitSeconds $LockWaitSeconds `
        -LockPath ([string]$policy.lockPath) `
        -ProjectId $operationId
    Write-GateHost "queue" "已取得发布锁：$($lockHandle.LockPath)"

    # The lock covers fetch, reservation, package, preview, cloud handoff and
    # GitHub operations.  No other entry point may safely interleave here.
    $sourceSnapshot = Get-ReleaseFileSnapshot -SourceRoot $sourceRepo.Root -RelativePath $includePaths
    foreach ($entry in $sourceSnapshot.GetEnumerator()) {
        if (-not [bool]$entry.Value.exists) {
            throw "发布源文件不存在：$($entry.Key)"
        }
    }
    # 发布器本身来自 canonical 仓库，避免旧 source clone 携带旧的打包器/闸门。
    $toolSnapshot = Get-ReleaseFileSnapshot -SourceRoot $canonicalRepo -RelativePath $releaseToolPaths
    foreach ($entry in $toolSnapshot.GetEnumerator()) {
        if (-not [bool]$entry.Value.exists) {
            throw "canonical 发布工具文件不存在：$($entry.Key)"
        }
    }
    $sourceCommit = $sourceRepo.Commit
    Write-GateHost "source" "来源 $($sourceRepo.Root)，提交 $sourceCommit，文件 $($includePaths.Count) 个。"

    Write-GateHost "fetch" "刷新 origin/$($policy.branch)。"
    Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("fetch", "origin", "refs/heads/$($policy.branch):refs/remotes/origin/$($policy.branch)") | ForEach-Object { Write-Host $_ }
    $baseHead = Get-ReleaseGitValue -WorkingDirectory $canonicalRepo -Arguments @("rev-parse", "origin/$($policy.branch)")
    $baseVersion = Get-GateVersionFromText -Text (Get-GateConfigTextAt -Repository $canonicalRepo -Revision "origin/$($policy.branch)") -Source "origin/$($policy.branch):config.js"
    $usedVersions = Get-ReleaseUsedVersions `
        -ReservationRoot ([string]$policy.reservationRoot) `
        -RecordRoot ([string]$policy.recordRoot) `
        -RepositoryRoot $canonicalRepo
    $target = Resolve-ReleaseVersion -BaseVersion $baseVersion -RequestedVersion $TargetVersion -UsedVersions $usedVersions
    Update-ReleaseLockOwner -LockHandle $lockHandle -TargetVersion $target
    Write-GateHost "version" "远端基线 $baseVersion ($baseHead)，分配版本 $target。"

    $reservation = New-ReleaseReservation `
        -ReservationRoot ([string]$policy.reservationRoot) `
        -OperationId $operationId `
        -Version $target `
        -BaseHead $baseHead `
        -IncludePath $includePaths `
        -SourcePath $sourceRepo.Root
    Write-GateHost "version" "已原子写入 reservation：$($reservation.Path)"

    New-Item -ItemType Directory -Path ([string]$policy.worktreeRoot) -Force | Out-Null
    $releaseWorktree = Join-Path ([string]$policy.worktreeRoot) "release-$operationId"
    Invoke-ReleaseGit -WorkingDirectory $canonicalRepo -Arguments @("worktree", "add", "--detach", $releaseWorktree, "origin/$($policy.branch)") | ForEach-Object { Write-Host $_ }
    Write-GateHost "worktree" "隔离发布工作树：$releaseWorktree"
    Copy-ReleaseFileSnapshot -TargetRoot $releaseWorktree -Snapshot $sourceSnapshot
    Copy-ReleaseFileSnapshot -TargetRoot $releaseWorktree -Snapshot $toolSnapshot

    $versionPaths = Get-ReleaseVersionPaths -SourceRoot $releaseWorktree
    foreach ($versionPath in $versionPaths) {
        $versionFile = Join-Path $releaseWorktree ($versionPath.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) { throw "版本组文件不存在：$versionPath" }
        $oldText = Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8
        $newText = Set-VersionText -RelativePath $versionPath -Text $oldText -TargetVersion $target
        [IO.File]::WriteAllText($versionFile, $newText, [Text.UTF8Encoding]::new($false))
    }

    $allowed = New-Object System.Collections.Generic.List[string]
    foreach ($path in $includePaths) { Add-GateUniquePath -List $allowed -Path $path }
    foreach ($path in $releaseToolPaths) { Add-GateUniquePath -List $allowed -Path $path }
    foreach ($path in $versionPaths) { Add-GateUniquePath -List $allowed -Path $path }
    $literal = @($allowed | ForEach-Object { ":(literal)$_" })
    # Source worktrees may inherit a different core.autocrlf setting.  Normalize
    # through Git's index for this command only; never modify shared repo config.
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments (@("-c", "core.autocrlf=true", "add", "--all", "--") + $literal) | ForEach-Object { Write-Host $_ }
    $staged = @((Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--name-only")) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($staged.Count -eq 0) { throw "没有可发布的变化；闸门不会创建空提交。" }
    $outside = @($staged | Where-Object { $_ -notin @($allowed) })
    if ($outside.Count -gt 0) { throw "隔离发布工作树出现未授权文件：$($outside -join '；')" }
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--check") | ForEach-Object { Write-Host $_ }
    Write-GateHost "stage" "已暂存 $($staged.Count) 个授权文件。"

    # Read-only validation happens before commit.  The package script supplied
    # by the package-hardening change must support this explicit interface.
    Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("diff", "--cached", "--check") | Out-Null
    Invoke-GatePython -ScriptRoot $canonicalRepo -Arguments @("--check-only", "--source-tree", $releaseWorktree) | ForEach-Object { Write-Host $_ }
    Write-GateHost "check" "发布前只读校验通过。"
    Assert-ReleaseFileSnapshotStable -SourceRoot $sourceRepo.Root -Snapshot $sourceSnapshot
    Assert-ReleaseFileSnapshotStable -SourceRoot $canonicalRepo -Snapshot $toolSnapshot

    $identity = Resolve-ReleaseIdentity -WorkingDirectory $releaseWorktree -RemoteUrl ([string]$policy.remote)
    $commitMessage = "release: v$target via release gate"
    $oldSkip = $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT
    $oldAllow = $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT
    $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = "1"
    $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT = "1"
    try {
        Invoke-ReleaseGit -WorkingDirectory $releaseWorktree -Arguments @("commit", "-m", $commitMessage, "-m", "operationId=$operationId`nbaseHead=$baseHead`nversion=$target") | ForEach-Object { Write-Host $_ }
    }
    finally {
        if ($null -eq $oldSkip) { Remove-Item Env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT -ErrorAction SilentlyContinue } else { $env:MINIPROGRAM_SYNC_SKIP_POST_COMMIT = $oldSkip }
        if ($null -eq $oldAllow) { Remove-Item Env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT -ErrorAction SilentlyContinue } else { $env:MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT = $oldAllow }
    }
    $finalCommit = Get-ReleaseGitValue -WorkingDirectory $releaseWorktree -Arguments @("rev-parse", "HEAD")
    $finalTree = Get-ReleaseGitValue -WorkingDirectory $releaseWorktree -Arguments @("rev-parse", "$finalCommit^{tree}")
    $failureAfterCommit = $true
    Write-GateHost "commit" "隔离提交完成：$finalCommit，tree=$finalTree，身份=$($identity.Name) <$($identity.Email)>。"

    $finalCheck = Invoke-GatePython -ScriptRoot $canonicalRepo -Arguments @("--check-only", "--source-tree", $finalCommit)
    $finalSummary = Get-GatePackageSummary -Output $finalCheck
    $shaProperty = if ($null -ne $finalSummary) { $finalSummary.PSObject.Properties["sourceSha256"] } else { $null }
    if ($null -eq $shaProperty -or [string]::IsNullOrWhiteSpace([string]$shaProperty.Value)) {
        throw "打包检查没有返回最终提交源码 SHA256，拒绝生成 context。"
    }
    $preSha = [string]$shaProperty.Value
    if ($preSha -notmatch '^[0-9a-fA-F]{64}$') { throw "打包检查返回的源码 SHA256 无效：$preSha" }
    Write-GateHost "check" "最终提交校验通过，源码 SHA256=$preSha。"

    $artifactPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-release-v$target-$finalCommit.zip"
    $contextPath = Join-Path ([string]$policy.contextRoot) "release-$operationId.json"
    $context = New-ReleaseContext `
        -Path $contextPath `
        -OperationId $operationId `
        -Policy $policy `
        -Version $target `
        -SourceCommit $sourceCommit `
        -ReleaseCommit $finalCommit `
        -TreeSha $finalTree `
        -SourceSha256 $preSha `
        -ArtifactPath $artifactPath
    Assert-ReleaseContextShape -Context $context -Policy $policy | Out-Null
    Write-GateHost "context" "release context 已生成：$contextPath"

    $packageOutput = Invoke-GatePython -ScriptRoot $canonicalRepo -Arguments @("--release-context", $contextPath)
    $packageSummary = Get-GatePackageSummary -Output $packageOutput
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw "打包脚本返回成功但产物不存在：$artifactPath" }
    $artifact = Get-Item -LiteralPath $artifactPath
    if ($artifact.Length -le 0) { throw "发布包为空：$artifactPath" }
    $packageSha = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $contextHash = [ordered]@{}
    foreach ($prop in $context.PSObject.Properties) { $contextHash[$prop.Name] = $prop.Value }
    $contextHash.packageSha256 = $packageSha
    $contextHash.packageSizeBytes = [int64]$artifact.Length
    $contextHash.status = "prepared"
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    Write-GateHost "package" "不可变发布包已生成：$artifactPath（$($artifact.Length) bytes，SHA256=$packageSha）。"

    if ($Preview) {
        if ([string]::IsNullOrWhiteSpace($PreviewCliPath)) { $PreviewCliPath = $env:WECHAT_DEVTOOLS_CLI }
        if ([string]::IsNullOrWhiteSpace($PreviewCliPath) -or -not (Test-Path -LiteralPath $PreviewCliPath -PathType Leaf)) {
            throw "已要求生成预览码，但找不到微信开发者工具 CLI。"
        }
        $qrPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-qr.png"
        $infoPath = Join-Path ([string]$policy.artifactRoot) "wechat-miniapp-preview-v$target-$finalCommit-info.json"
        $previewOutput = & $PreviewCliPath -c $PreviewClientName create_preview_qrcode `
            --project $releaseWorktree `
            --qr-format image `
            --qr-output $qrPath 2>&1
        $previewExitCode = $LASTEXITCODE
        $previewText = ($previewOutput | ForEach-Object { [string]$_ }) -join "`n"
        $previewSummary = "WechatIDE create_preview_qrcode 已返回。"
        try {
            $jsonStart = $previewText.IndexOf("{")
            if ($jsonStart -ge 0) {
                $previewResult = $previewText.Substring($jsonStart) | ConvertFrom-Json
                $previewOk = if ($previewResult.PSObject.Properties["ok"]) { [bool]$previewResult.ok } else { $false }
                $previewSummary = "WechatIDE create_preview_qrcode ok=$previewOk。"
            }
        }
        catch {
            $previewSummary = "WechatIDE 已返回，结果 JSON 未解析；继续以退出码和二维码文件校验。"
        }
        Write-Host $previewSummary
        if ($previewExitCode -ne 0 -or -not (Test-Path -LiteralPath $qrPath -PathType Leaf)) {
            throw "预览码生成失败，未发布到远端。"
        }
        $info = [pscustomobject]@{}
        if (Test-Path -LiteralPath $infoPath -PathType Leaf) {
            try { $info = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $info = [pscustomobject]@{} }
        }
        $infoHash = [ordered]@{}
        foreach ($prop in $info.PSObject.Properties) { $infoHash[$prop.Name] = $prop.Value }
        $infoHash.operationId = $operationId; $infoHash.appVersion = $target; $infoHash.gitCommit = $finalCommit; $infoHash.treeSha = $finalTree; $infoHash.sourceSha256 = $preSha; $infoHash.artifactPath = $artifactPath
        Write-ReleaseGateJsonAtomic -Path $infoPath -Value $infoHash
        $contextHash.previewQrPath = $qrPath; $contextHash.previewInfoPath = $infoPath
        Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
        Write-GateHost "preview" "预览二维码已生成：$qrPath"
    }

    if ($DeployCloud) {
        $env:RELEASE_GATE_CONTEXT = $contextPath
        $deployScript = Join-Path $releaseWorktree "scripts/deploy-and-verify-api.ps1"
        if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) {
            throw "缺少统一 CloudBase 部署入口：$deployScript"
        }
        Write-GateHost "cloud" "使用同一 release context 部署 CloudBase：$contextPath"
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $deployScript `
            -ProjectPath $releaseWorktree `
            -ReleaseContext $contextPath `
            -ReleaseGateLockHeld `
            -DeployLockPath ([string]$policy.lockPath) `
            -DeployTransport "auto" `
            -LockWaitSeconds $LockWaitSeconds
        if ($LASTEXITCODE -ne 0) {
            throw "CloudBase 部署或核验失败；保留原 release context，不重新占用版本。"
        }
    }

    $pr = Invoke-ReleasePullRequest -RepositoryRoot $releaseWorktree -Branch "release/$target-$operationId" -Version $target -OperationId $operationId -CommitSha $finalCommit -NoPush:(-not $Publish)
    $contextHash.status = [string]$pr.status
    $contextHash.releaseBranch = $pr.branch
    $contextHash.pullRequest = $pr.pr
    if ($pr.PSObject.Properties["mainCommit"] -and -not [string]::IsNullOrWhiteSpace([string]$pr.mainCommit)) { $contextHash.mainCommit = [string]$pr.mainCommit }
    if ($pr.PSObject.Properties["mergedAt"] -and -not [string]::IsNullOrWhiteSpace([string]$pr.mergedAt)) { $contextHash.mergedAt = [string]$pr.mergedAt }
    Write-ReleaseGateJsonAtomic -Path $contextPath -Value $contextHash
    $reservationExtra = @{ releaseCommit = $finalCommit; treeSha = $finalTree; contextPath = $contextPath; artifactPath = $artifactPath }
    if ($contextHash.Contains("mainCommit")) { $reservationExtra.mainCommit = [string]$contextHash.mainCommit }
    if ($contextHash.Contains("mergedAt")) { $reservationExtra.mergedAt = [string]$contextHash.mergedAt }
    Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status $contextHash.status -Extra $reservationExtra

    $recordPath = Join-Path ([string]$policy.recordRoot) "release-v$target-$finalCommit.json"
    $record = [ordered]@{
        schemaVersion = 1; operationId = $operationId; status = $contextHash.status; version = $target
        baseHead = $baseHead; sourceCommit = $sourceCommit; releaseCommit = $finalCommit; treeSha = $finalTree
        sourceSha256 = $preSha; packageSha256 = $packageSha; packagePath = $artifactPath; contextPath = $contextPath
        changedFiles = @($allowed); generatedAt = [DateTime]::UtcNow.ToString("o"); releaseBranch = $pr.branch; pullRequest = $pr.pr
    }
    if ($contextHash.Contains("mainCommit")) { $record.mainCommit = [string]$contextHash.mainCommit }
    if ($contextHash.Contains("mergedAt")) { $record.mergedAt = [string]$contextHash.mergedAt }
    Write-ReleaseGateJsonAtomic -Path $recordPath -Value $record
    $completed = $true
    $doneMessage = if (-not $Publish) { "准备完成；默认未推送。需要发布时显式加 -Publish。" } elseif ($contextHash.status -eq "merged") { "发布完成，PR 已合并：$($pr.pr)" } else { "发布分支和 PR 已创建，等待 GitHub 必需检查：$($pr.pr)" }
    Write-GateHost "done" $doneMessage
    Write-Host "Context: $contextPath"
    Write-Host "Artifact: $artifactPath"
}
catch {
    $message = $_.Exception.Message
    Write-ReleaseOperationLog -Path $logPath -Stage "failed" -Message $message -OperationId $operationId
    if ($null -ne $reservation) {
        $extra = @{}
        if ($failureAfterCommit) { $extra.releaseCommit = $finalCommit; if ($contextPath) { $extra.contextPath = $contextPath } }
        Set-ReleaseReservationStatus -ReservationPath $reservation.Path -Status "failed" -Extra $extra
    }
    Write-Host "发布闸门失败：$message" -ForegroundColor Red
    throw
}
finally {
    if (-not $KeepWorktree -and -not [string]::IsNullOrWhiteSpace($releaseWorktree) -and ($completed -or -not $failureAfterCommit)) {
        Remove-ReleaseGateWorktree -CanonicalRepo $canonicalRepo -WorktreePath $releaseWorktree
    }
    if ($null -ne $lockHandle) { Exit-ReleaseLock -LockHandle $lockHandle }
}
