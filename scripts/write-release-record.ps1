param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[0-9a-f]{7,64}$")]
    [string]$CommitSha,

    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[0-9a-f]{7,64}$")]
    [string]$TreeSha,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourceSha256,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PackagePath,

    [string]$Remote = "origin/main",

    [string]$OutputRoot = "",

    [string[]]$ChangedFile = @(),

    [string]$BaseHead = "",

    [int]$Attempt = 1,

    [int]$RetryCount = 0,

    [string[]]$GeneratedVersionPath = @(),

    [string]$ReleaseWorktree = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$package = Get-Item -LiteralPath $PackagePath -ErrorAction Stop
if (-not $package.PSIsContainer -and $package.Length -gt 0) {
    $packageSha256 = (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
else {
    throw "发布包不存在或为空：$PackagePath"
}

if ($SourceSha256 -notmatch "^[0-9a-fA-F]{64}$") {
    throw "源码 SHA256 格式不正确：$SourceSha256"
}

$recordRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    Join-Path (Split-Path $repoRoot -Parent) "wechat-miniapp-release-records"
}
else {
    [IO.Path]::GetFullPath($OutputRoot)
}
New-Item -ItemType Directory -Path $recordRoot -Force | Out-Null

$safeVersion = ($Version -replace "[^0-9A-Za-z._-]", "_")
$recordName = "release-v{0}-{1}.json" -f $safeVersion, $CommitSha.Substring(0, [Math]::Min(12, $CommitSha.Length))
$recordPath = Join-Path $recordRoot $recordName
$record = [ordered]@{
    schemaVersion = 1
    project = "圈像创作微信小程序"
    status = "已推送"
    version = $Version
    commitSha = $CommitSha.ToLowerInvariant()
    treeSha = $TreeSha.ToLowerInvariant()
    sourceSha256 = $SourceSha256.ToLowerInvariant()
    packageSha256 = $packageSha256
    packageSizeBytes = [int64]$package.Length
    packagePath = $package.FullName
    remote = $Remote
    generatedAt = (Get-Date).ToString("o")
    changedFiles = @($ChangedFile)
    baseHead = $BaseHead
    attempt = $Attempt
    retryCount = $RetryCount
    generatedVersionPaths = @($GeneratedVersionPath)
    releaseWorktree = $ReleaseWorktree
}
$json = $record | ConvertTo-Json -Depth 5
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($recordPath, $json + [Environment]::NewLine, $utf8NoBom)

Write-Host "发布记录已生成：$recordPath"
Write-Host "包 SHA256：$packageSha256"
