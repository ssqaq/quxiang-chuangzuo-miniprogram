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

    $paymentManifestRelative = "scripts/payment-cloudfunctions.json"
    $paymentManifestPath = Join-Path $SourceRoot $paymentManifestRelative
    if (Test-Path -LiteralPath $paymentManifestPath -PathType Leaf) {
        try {
            $paymentManifest = Get-Content -LiteralPath $paymentManifestPath -Raw -Encoding UTF8 |
                ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw "支付云函数清单不是有效 JSON：$paymentManifestPath"
        }
        if ([int]$paymentManifest.schemaVersion -ne 1 -or @($paymentManifest.functions).Count -ne 3) {
            throw "支付云函数清单版本或函数数量无效：$paymentManifestPath"
        }
        $paths += $paymentManifestRelative
        $paths += [string]$paymentManifest.sharedCore.packageJson
        foreach ($paymentFunction in @($paymentManifest.functions)) {
            $paths += [string]$paymentFunction.packageJson
            $paths += [string]$paymentFunction.packageLock
            $paths += [string]$paymentFunction.config
            $paths += ([string]$paymentFunction.vendoredCoreRoot).TrimEnd('/', '\') + "/package.json"
        }
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
        { $_ -match '^cloudfunctions/payment-(?:api|notify|reconcile)/package-lock\.json$' } {
            return Replace-VersionOccurrences -Text $Text -Count 2 -TargetVersion $TargetVersion
        }
        { $_ -match '^cloudfunctions/payment-(?:api|notify|reconcile)/config\.json$' } {
            try {
                $config = $Text | ConvertFrom-Json -ErrorAction Stop
            }
            catch {
                throw "支付云函数 config.json 不是有效 JSON：$RelativePath"
            }
            $expectedTimeout = switch ($RelativePath) {
                "cloudfunctions/payment-api/config.json" { 15 }
                "cloudfunctions/payment-notify/config.json" { 15 }
                "cloudfunctions/payment-reconcile/config.json" { 120 }
            }
            if ([int]$config.timeout -ne $expectedTimeout) {
                throw "支付云函数 timeout 不符合发布契约：$RelativePath"
            }
            if ($config.PSObject.Properties["triggers"] -and @($config.triggers).Count -gt 0) {
                throw "支付云函数 config.json 禁止自动启用 HTTP 路由或 Timer：$RelativePath"
            }
            return $Text
        }
        "scripts/payment-cloudfunctions.json" {
            try {
                $manifest = $Text | ConvertFrom-Json -ErrorAction Stop
            }
            catch {
                throw "支付云函数清单不是有效 JSON。"
            }
            if ([int]$manifest.schemaVersion -ne 1 -or
                [bool]$manifest.productionDeployment.enabled -or
                [bool]$manifest.productionDeployment.automaticDeployment) {
                throw "支付云函数清单必须保持生产部署默认关闭。"
            }
            foreach ($paymentFunction in @($manifest.functions)) {
                if ([bool]$paymentFunction.deploymentEnabled -or
                    [bool]$paymentFunction.httpRoute.enabled -or
                    [bool]$paymentFunction.timer.enabled) {
                    throw "支付云函数部署、HTTP 路由和 Timer 必须默认关闭：$($paymentFunction.name)"
                }
                foreach ($property in @($paymentFunction.runtimeSwitches.PSObject.Properties)) {
                    if ([bool]$property.Value) {
                        throw "支付业务开关必须默认关闭：$($paymentFunction.name).$($property.Name)"
                    }
                }
            }
            return $Text
        }
        default {
            if ($RelativePath -eq "cloudfunctions/api/package.json" -or
                $RelativePath -eq "media-worker/package.json" -or
                $RelativePath -eq "cloudfunctions/watermark-gateway/package.json" -or
                $RelativePath -eq "cloudfunctions/payment-core/package.json" -or
                $RelativePath -match '^cloudfunctions/payment-(?:api|notify|reconcile)/vendor/payment-core/package\.json$' -or
                $RelativePath -match '^cloudfunctions/payment-(?:api|notify|reconcile)/package\.json$') {
                return Replace-VersionOccurrences -Text $Text -Count 1 -TargetVersion $TargetVersion
            }
            throw "未知版本组文件：$RelativePath"
        }
    }
}
