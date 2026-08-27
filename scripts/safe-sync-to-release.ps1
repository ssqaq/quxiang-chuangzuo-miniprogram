param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TargetPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$IncludePath,

    [switch]$AllowTargetOverwrite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-RelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or [IO.Path]::IsPathRooted($Path)) {
        throw "IncludePath 必须是非空的仓库内相对路径：$Path"
    }
    $normalized = $Path.Replace("\", "/")
    while ($normalized.StartsWith("./", [StringComparison]::Ordinal)) {
        $normalized = $normalized.Substring(2)
    }
    if ([string]::IsNullOrWhiteSpace($normalized) `
        -or $normalized -match '(^|/)\.\.(?:/|$)' `
        -or $normalized -match '^(?:\.git|\.worktrees)(?:/|$)') {
        throw "IncludePath 不是安全路径：$Path"
    }
    return $normalized
}

function Assert-PathInsideRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\", "/") + "\"
    $candidateFull = [IO.Path]::GetFullPath($Candidate)
    if ((-not $candidateFull.StartsWith(
            $rootFull,
            [StringComparison]::OrdinalIgnoreCase
        )) -and $candidateFull -ne $rootFull.TrimEnd("\")) {
        throw "$Label 越出根目录：$Candidate"
    }
    return $candidateFull
}

function Assert-SafeArtifactPath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $path = $RelativePath.Replace("\", "/")
    if ($path -match '(^|/)\.env(?:\.[^/]*)?$' `
        -or $path -match '(?i)(appsecret|api[_-]?key|secret|password|credential|private[_-]?key)' `
        -or $path -match '(?i)(^|/)(?:token|tokens)(?:/|$)' `
        -or $path -match '(?i)(^|/)(?:_tmp|tmp|temp|\.tmp)(?:/|$)' `
        -or $path -match '(?i)(^|/).*\.log$' `
        -or $path -match '(?i)(^|/)release-v\d+\.\d+\.\d+\.zip$') {
        throw "默认禁止同步敏感、临时或发布产物：$RelativePath"
    }
}

function Get-GitRoot {
    param([Parameter(Mandatory = $true)][string]$Root)

    $output = & git -C $Root rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0) {
        return ""
    }
    return ([string]($output | Out-String)).Trim()
}

function Test-TargetPathDirty {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $gitRoot = Get-GitRoot -Root $TargetRoot
    if ([string]::IsNullOrWhiteSpace($gitRoot)) {
        return $false
    }
    & git -C $TargetRoot ls-files --error-unmatch -- $RelativePath 2>$null | Out-Null
    $tracked = $LASTEXITCODE -eq 0
    if (-not $tracked) {
        return $true
    }
    & git -C $TargetRoot diff --quiet HEAD -- $RelativePath 2>$null
    return $LASTEXITCODE -ne 0
}

function Get-SourceFiles {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string[]]$Paths
    )

    $files = @()
    foreach ($relativePath in $Paths) {
        Assert-SafeArtifactPath -RelativePath $relativePath
        $sourcePath = Assert-PathInsideRoot `
            -Root $SourceRoot `
            -Candidate (Join-Path $SourceRoot $relativePath) `
            -Label "源路径"
        if (-not (Test-Path -LiteralPath $sourcePath)) {
            throw "源路径不存在：$relativePath"
        }
        $item = Get-Item -LiteralPath $sourcePath -Force
        if ($item.PSIsContainer) {
            $children = Get-ChildItem -LiteralPath $sourcePath -Recurse -File -Force
            foreach ($child in $children) {
                $childRelative = $child.FullName.Substring($SourceRoot.Length).TrimStart("\", "/")
                $childRelative = $childRelative.Replace("\", "/")
                Assert-SafeArtifactPath -RelativePath $childRelative
                $files += $childRelative
            }
        }
        else {
            $files += $relativePath
        }
    }
    return @($files | Select-Object -Unique | Sort-Object)
}

function Get-FileDigest {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) {
        throw "同步对象不能是目录：$Path"
    }
    if ($item.PSObject.Properties["LinkType"] -and $item.LinkType) {
        throw "不允许同步符号链接：$Path"
    }
    return [pscustomobject]@{
        Exists = $true
        Length = [int64]$item.Length
        Sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    }
}

$sourceRoot = [IO.Path]::GetFullPath($SourcePath).TrimEnd("\", "/")
$targetRoot = [IO.Path]::GetFullPath($TargetPath).TrimEnd("\", "/")
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "源目录不存在：$sourceRoot"
}
if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
    throw "目标目录不存在：$targetRoot"
}
if ($sourceRoot -eq $targetRoot) {
    throw "源目录和目标目录不能相同。"
}

$paths = @(
    $IncludePath |
        ForEach-Object { Normalize-RelativePath -Path $_ } |
        Select-Object -Unique
)
if ($paths.Count -eq 0) {
    throw "必须显式指定至少一个 IncludePath，禁止全量同步。"
}
$files = @(Get-SourceFiles -SourceRoot $sourceRoot -Paths $paths)
if ($files.Count -eq 0) {
    Write-Host "安全同步完成：清单内没有文件需要复制。"
    exit 0
}

$copied = 0
$skipped = 0
foreach ($relativePath in $files) {
    $sourceFile = Assert-PathInsideRoot `
        -Root $sourceRoot `
        -Candidate (Join-Path $sourceRoot $relativePath) `
        -Label "源文件"
    $targetFile = Assert-PathInsideRoot `
        -Root $targetRoot `
        -Candidate (Join-Path $targetRoot $relativePath) `
        -Label "目标文件"
    $sourceDigest = Get-FileDigest -Path $sourceFile
    $targetExists = Test-Path -LiteralPath $targetFile -PathType Leaf
    if ($targetExists) {
        $targetDigest = Get-FileDigest -Path $targetFile
        if ($targetDigest.Sha256 -eq $sourceDigest.Sha256) {
            $skipped += 1
            Write-Host "跳过（内容相同）：$relativePath"
            continue
        }
        if (-not $AllowTargetOverwrite) {
            throw "目标文件内容不同，默认拒绝覆盖：$relativePath。确认目标未被用户修改后，再显式使用 -AllowTargetOverwrite。"
        }
        if (Test-TargetPathDirty -TargetRoot $targetRoot -RelativePath $relativePath) {
            throw "检测到目标用户改动，拒绝覆盖：$relativePath"
        }
    }

    $parent = Split-Path $targetFile -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = "$targetFile.codex-sync-$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::Copy($sourceFile, $temporary, $true)
        $temporaryDigest = Get-FileDigest -Path $temporary
        if ($temporaryDigest.Sha256 -ne $sourceDigest.Sha256) {
            throw "临时复制哈希不一致：$relativePath"
        }
        [IO.File]::Copy($temporary, $targetFile, $true)
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
    $targetDigest = Get-FileDigest -Path $targetFile
    if ($targetDigest.Sha256 -ne $sourceDigest.Sha256 `
        -or $targetDigest.Length -ne $sourceDigest.Length) {
        throw "复制后校验不一致：$relativePath"
    }
    $copied += 1
    Write-Host "已复制并校验：$relativePath"
}

Write-Host "安全同步完成：复制 $copied 个，跳过 $skipped 个；未触碰清单外文件、Git index、分支和提交。"
