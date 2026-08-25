Set-StrictMode -Version Latest

function Replace-VersionOccurrences {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [int]$Count,
        [Parameter(Mandatory = $true)]
        [string]$TargetVersion
    )

    $pattern = '("version"\s*:\s*")[^"]+(")'
    $matches = [regex]::Matches($Text, $pattern)
    if ($matches.Count -lt $Count) {
        throw "版本字段数量不足，至少需要 $Count 个，实际只有 $($matches.Count) 个。"
    }

    $builder = New-Object System.Text.StringBuilder
    $cursor = 0
    for ($index = 0; $index -lt $Count; $index += 1) {
        $match = $matches[$index]
        [void]$builder.Append($Text.Substring($cursor, $match.Index - $cursor))
        [void]$builder.Append($match.Groups[1].Value)
        [void]$builder.Append($TargetVersion)
        [void]$builder.Append($match.Groups[2].Value)
        $cursor = $match.Index + $match.Length
    }
    [void]$builder.Append($Text.Substring($cursor))
    return $builder.ToString()
}

function Get-NextPatchVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseVersion
    )

    $match = [regex]::Match($BaseVersion.Trim(), '^(\d+)\.(\d+)\.(\d+)$')
    if (-not $match.Success) {
        throw "版本号不是三段式语义版本：$BaseVersion"
    }

    $major = [int64]$match.Groups[1].Value
    $minor = [int64]$match.Groups[2].Value
    $patch = [int64]$match.Groups[3].Value
    if ($patch -ge [int64]::MaxValue) {
        throw "补丁版本已达到最大值：$BaseVersion"
    }
    return "$major.$minor.$($patch + 1)"
}

function Get-VersionGroupPaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot
    )

    $paths = @(
        "config.js",
        "cloudfunctions/api/index.js",
        "cloudfunctions/api/package.json",
        "cloudfunctions/api/package-lock.json",
        "media-worker/package.json",
        "media-worker/package-lock.json"
    )
    $gatewayPackage = Join-Path $SourceRoot "cloudfunctions/watermark-gateway/package.json"
    if (Test-Path -LiteralPath $gatewayPackage -PathType Leaf) {
        $paths += "cloudfunctions/watermark-gateway/package.json"
    }
    return @($paths)
}

function Set-VersionText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath,
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$TargetVersion
    )

    switch ($RelativePath) {
        "config.js" {
            $match = [regex]::Match($Text, 'appVersion:\s*"[^"]+"')
            if (-not $match.Success) {
                throw "config.js 没有找到 appVersion。"
            }
            return [regex]::Replace(
                $Text,
                'appVersion:\s*"[^"]+"',
                "appVersion: `"$TargetVersion`"",
                1
            )
        }
        "cloudfunctions/api/index.js" {
            $versionMatch = [regex]::Match(
                $Text,
                'const API_BUILD_VERSION = "[^"]+";'
            )
            if (-not $versionMatch.Success) {
                throw "云函数 index.js 没有找到 API_BUILD_VERSION。"
            }
            $updated = [regex]::Replace(
                $Text,
                'const API_BUILD_VERSION = "[^"]+";',
                "const API_BUILD_VERSION = `"$TargetVersion`";",
                1
            )
            $marker = "API_BUILD_TAG_AUTO_VERSION_V$($TargetVersion.Replace('.', ''))"
            $markerMatch = [regex]::Match(
                $updated,
                'const API_BUILD_MARKER = "[^"]+";'
            )
            if (-not $markerMatch.Success) {
                throw "云函数 index.js 没有找到 API_BUILD_MARKER。"
            }
            $updated = [regex]::Replace(
                $updated,
                'const API_BUILD_MARKER = "[^"]+";',
                "const API_BUILD_MARKER = `"$marker`";",
                1
            )
            return $updated
        }
        "cloudfunctions/api/package-lock.json" {
            return Replace-VersionOccurrences -Text $Text -Count 2 -TargetVersion $TargetVersion
        }
        "media-worker/package-lock.json" {
            return Replace-VersionOccurrences -Text $Text -Count 2 -TargetVersion $TargetVersion
        }
        default {
            if ($RelativePath -eq "cloudfunctions/api/package.json" -or
                $RelativePath -eq "media-worker/package.json" -or
                $RelativePath -eq "cloudfunctions/watermark-gateway/package.json") {
                return Replace-VersionOccurrences -Text $Text -Count 1 -TargetVersion $TargetVersion
            }
            throw "未知版本组文件：$RelativePath"
        }
    }
}
