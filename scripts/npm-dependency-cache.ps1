# Local npm cache helpers for reproducible cloud-function checks.

function Test-NpmDependencyPathInside {
  param(
    [Parameter(Mandatory = $true)][string]$ParentPath,
    [Parameter(Mandatory = $true)][string]$CandidatePath
  )

  $parent = [IO.Path]::GetFullPath($ParentPath).TrimEnd('\', '/')
  $candidate = [IO.Path]::GetFullPath($CandidatePath).TrimEnd('\', '/')
  if ([string]::Equals($parent, $candidate, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  $prefix = $parent + [IO.Path]::DirectorySeparatorChar
  return $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-NpmDependencyCacheInfo {
  param(
    [Parameter(Mandatory = $true)][string]$ApiPath,
    [string]$CacheRoot = ""
  )

  $api = [IO.Path]::GetFullPath($ApiPath)
  $packageJson = Join-Path $api "package.json"
  $packageLock = Join-Path $api "package-lock.json"
  if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf) -or
      -not (Test-Path -LiteralPath $packageLock -PathType Leaf)) {
    throw "云函数缺少 package.json 或 package-lock.json，不能执行可复现依赖安装。"
  }

  $cloudFunctions = Split-Path -Parent $api
  $project = [IO.Path]::GetFullPath((Split-Path -Parent $cloudFunctions))
  $configuredCacheRoot = if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
    [string]$env:WECHAT_MINIPROGRAM_NPM_CACHE_PATH
  } else {
    $CacheRoot
  }
  $rootInput = if ([string]::IsNullOrWhiteSpace($configuredCacheRoot)) {
    Join-Path (Split-Path -Parent $project) ".wechat-miniapp-npm-cache"
  } elseif ([IO.Path]::IsPathRooted($configuredCacheRoot)) {
    $configuredCacheRoot
  } else {
    Join-Path (Split-Path -Parent $project) $configuredCacheRoot
  }
  $root = [IO.Path]::GetFullPath($rootInput)
  if (Test-NpmDependencyPathInside -ParentPath $project -CandidatePath $root) {
    throw "npm 缓存目录必须位于项目目录之外：$root"
  }

  $lockSha256 = (Get-FileHash -LiteralPath $packageLock -Algorithm SHA256).Hash.ToLowerInvariant()
  $dependencyFingerprint = $lockSha256
  try {
    $package = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "云函数 package.json 不是有效 JSON：$packageJson"
  }
  $localDependencyParts = New-Object System.Collections.Generic.List[string]
  if ($package.dependencies) {
    foreach ($property in @($package.dependencies.PSObject.Properties | Sort-Object Name)) {
      $value = [string]$property.Value
      if (-not $value.StartsWith("file:", [StringComparison]::OrdinalIgnoreCase)) { continue }
      $relativeTarget = $value.Substring(5).Trim()
      $target = [IO.Path]::GetFullPath((Join-Path $api $relativeTarget))
      if (-not (Test-NpmDependencyPathInside -ParentPath $api -CandidatePath $target)) {
        throw "本地 npm 依赖越出云函数目录：$($property.Name)=$value"
      }
      if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "本地 npm 依赖目录不存在：$($property.Name)=$value"
      }
      foreach ($file in @(Get-ChildItem -LiteralPath $target -Recurse -File -Force |
          Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
          Sort-Object FullName)) {
        $relativeFile = $file.FullName.Substring($target.TrimEnd('\', '/').Length).TrimStart('\', '/').Replace('\', '/')
        $fileSha = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        [void]$localDependencyParts.Add("$($property.Name)`0$relativeFile`0$fileSha")
      }
    }
  }
  if ($localDependencyParts.Count -gt 0) {
    $fingerprintMaterial = $lockSha256 + "`n" + ($localDependencyParts -join "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $fingerprintBytes = [Text.Encoding]::UTF8.GetBytes($fingerprintMaterial)
      $dependencyFingerprint = ([BitConverter]::ToString($sha.ComputeHash($fingerprintBytes)) -replace '-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
  }
  $functionName = (Split-Path -Leaf $api).ToLowerInvariant() -replace '[^a-z0-9._-]', '-'
  if ([string]::IsNullOrWhiteSpace($functionName)) { $functionName = "cloudfunction" }
  $key = "$functionName-$dependencyFingerprint"
  $cachePath = Join-Path $root $key
  New-Item -ItemType Directory -Path $cachePath -Force | Out-Null
  return [pscustomobject]@{
    ApiPath = $api
    FunctionName = $functionName
    ProjectPath = $project
    Root = $root
    Path = $cachePath
    LockPath = Join-Path $root "$key.lock"
    Key = $key
    LockSha256 = $lockSha256
    DependencyFingerprintSha256 = $dependencyFingerprint
  }
}

function Enter-NpmDependencyCacheLock {
  param(
    [Parameter(Mandatory = $true)][string]$LockPath,
    [ValidateRange(1, 900)][int]$WaitSeconds = 300
  )

  $parent = Split-Path -Parent $LockPath
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  while ($true) {
    try {
      # OpenOrCreate + FileShare.None makes the lock self-healing after a
      # crashed process: a stale file is reusable once its handle is gone.
      return [IO.File]::Open(
        $LockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
    }
    catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "等待 npm 缓存锁超时：$LockPath"
      }
      Start-Sleep -Milliseconds 200
    }
  }
}

function Exit-NpmDependencyCacheLock {
  param([Parameter(Mandatory = $true)][object]$LockHandle)
  if ($null -ne $LockHandle) {
    $LockHandle.Dispose()
  }
}

function Test-NpmDependencyTree {
  param(
    [Parameter(Mandatory = $true)][string]$ApiPath,
    [string]$DependencyCheckScript = "",
    [string]$LockSha256 = ""
  )

  $nodeModules = Join-Path $ApiPath "node_modules"
  if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
    return $false
  }
  if (-not [string]::IsNullOrWhiteSpace($LockSha256)) {
    $stampPath = Join-Path $nodeModules ".npm-cache-lock-sha256"
    if (-not (Test-Path -LiteralPath $stampPath -PathType Leaf)) {
      return $false
    }
    $stamp = (Get-Content -LiteralPath $stampPath -Raw -ErrorAction SilentlyContinue).Trim()
    if ($stamp -ne $LockSha256) {
      return $false
    }
  }
  if ([string]::IsNullOrWhiteSpace($DependencyCheckScript)) {
    return $true
  }
  if (-not (Test-Path -LiteralPath $DependencyCheckScript -PathType Leaf)) {
    return $false
  }
  $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if (-not $node) {
    $node = Get-Command "node" -ErrorAction SilentlyContinue
  }
  if (-not $node) {
    return $false
  }

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $node.Source $DependencyCheckScript "--api-root" $ApiPath *> $null
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return $exitCode -eq 0
}

function Invoke-NpmCiCached {
  param(
    [Parameter(Mandatory = $true)][object]$Npm,
    [Parameter(Mandatory = $true)][string]$ApiPath,
    [Parameter(Mandatory = $true)][string]$CachePath,
    [switch]$PreferOnline
  )

  $arguments = @("ci", "--ignore-scripts")
  if ($PreferOnline) {
    $arguments += "--prefer-online"
  } else {
    $arguments += "--prefer-offline"
  }
  $arguments += @("--cache", $CachePath, "--no-audit", "--no-fund")

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $locationPushed = $false
  try {
    Push-Location -LiteralPath $ApiPath
    $locationPushed = $true
    # npm writes normal progress lines to PowerShell's success stream.  If we
    # let those lines escape, the caller receives an array of strings plus the
    # exit code instead of one scalar integer and may report a false failure.
    # Capture/print the output explicitly, then return only the numeric code.
    $npmOutput = @(& $Npm.Source @arguments 2>&1)
    $exitCode = [int]$LASTEXITCODE
    foreach ($line in $npmOutput) {
      Write-Host ([string]$line)
    }
    return $exitCode
  }
  finally {
    if ($locationPushed) {
      Pop-Location
    }
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Ensure-LocalCloudFunctionDependencies {
  param(
    [Parameter(Mandatory = $true)][string]$ApiPath,
    [string]$CacheRoot = "",
    [string]$DependencyCheckScript = "",
    [string]$NpmPath = ""
  )

  $cache = Get-NpmDependencyCacheInfo -ApiPath $ApiPath -CacheRoot $CacheRoot
  $lockHandle = $null
  try {
    $lockHandle = Enter-NpmDependencyCacheLock -LockPath $cache.LockPath
    if (Test-NpmDependencyTree `
      -ApiPath $cache.ApiPath `
      -DependencyCheckScript $DependencyCheckScript `
      -LockSha256 $cache.DependencyFingerprintSha256) {
      Write-Host "复用本地云函数依赖：缓存键 $($cache.Key)"
      return $cache
    }

    $npm = $null
    if (-not [string]::IsNullOrWhiteSpace($NpmPath)) {
      if (-not (Test-Path -LiteralPath $NpmPath -PathType Leaf)) {
        throw "指定的 npm 命令不存在：$NpmPath"
      }
      $npm = [pscustomobject]@{ Source = [IO.Path]::GetFullPath($NpmPath) }
    } else {
      $npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
      if (-not $npm) {
        $npm = Get-Command "npm" -ErrorAction SilentlyContinue
      }
    }
    if (-not $npm) {
      throw "找不到 npm，无法为隔离发布工作树安装云函数依赖。"
    }

    Write-Host "隔离发布工作树缺少可用 node_modules，按 lockfile 使用 npm 缓存键 $($cache.Key) 安装。"
    $preferredExitCode = Invoke-NpmCiCached `
      -Npm $npm `
      -ApiPath $cache.ApiPath `
      -CachePath $cache.Path
    if ($preferredExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $cache.ApiPath "node_modules") -PathType Container)) {
      Write-Warning "npm 缓存优先安装失败（exit code $preferredExitCode），回退到在线刷新。"
      $fallbackExitCode = Invoke-NpmCiCached `
        -Npm $npm `
        -ApiPath $cache.ApiPath `
        -CachePath $cache.Path `
        -PreferOnline
      if ($fallbackExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $cache.ApiPath "node_modules") -PathType Container)) {
        throw "隔离发布工作树 npm ci 失败（prefer-offline=$preferredExitCode，prefer-online=$fallbackExitCode），未生成 node_modules。"
      }
    }

    if (-not (Test-NpmDependencyTree `
      -ApiPath $cache.ApiPath `
      -DependencyCheckScript $DependencyCheckScript)) {
      throw "npm ci 完成但云函数依赖检查未通过。"
    }
    $stampPath = Join-Path $cache.ApiPath "node_modules\.npm-cache-lock-sha256"
    [IO.File]::WriteAllText($stampPath, "$($cache.DependencyFingerprintSha256)`n", [Text.UTF8Encoding]::new($false))
    if (-not (Test-NpmDependencyTree `
      -ApiPath $cache.ApiPath `
      -DependencyCheckScript $DependencyCheckScript `
      -LockSha256 $cache.DependencyFingerprintSha256)) {
      throw "云函数依赖安装完成但 lockfile 指纹校验失败。"
    }
    return $cache
  }
  finally {
    if ($null -ne $lockHandle) {
      Exit-NpmDependencyCacheLock -LockHandle $lockHandle
    }
  }
}

function Ensure-ManifestCloudFunctionDependencies {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [string]$CacheRoot = "",
    [Parameter(Mandatory = $true)][string]$DependencyCheckScript,
    [string]$NpmPath = ""
  )

  $project = [IO.Path]::GetFullPath($ProjectRoot)
  $manifestFullPath = [IO.Path]::GetFullPath($ManifestPath)
  if (-not (Test-Path -LiteralPath $manifestFullPath -PathType Leaf)) {
    throw "支付云函数清单不存在：$manifestFullPath"
  }
  try {
    $manifest = Get-Content -LiteralPath $manifestFullPath -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "支付云函数清单不是有效 JSON：$manifestFullPath"
  }
  if ([int]$manifest.schemaVersion -ne 1 -or @($manifest.functions).Count -ne 3) {
    throw "支付云函数清单版本或函数数量无效：$manifestFullPath"
  }

  $results = New-Object System.Collections.Generic.List[object]
  foreach ($paymentFunction in @($manifest.functions)) {
    $relativeRoot = [string]$paymentFunction.root
    $functionRoot = [IO.Path]::GetFullPath((Join-Path $project $relativeRoot))
    if (-not (Test-NpmDependencyPathInside -ParentPath $project -CandidatePath $functionRoot)) {
      throw "支付云函数目录越出项目：$relativeRoot"
    }
    $result = Ensure-LocalCloudFunctionDependencies `
      -ApiPath $functionRoot `
      -CacheRoot $CacheRoot `
      -NpmPath $NpmPath
    [void]$results.Add($result)
  }

  $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if (-not $node) { $node = Get-Command "node" -ErrorAction SilentlyContinue }
  if (-not $node) { throw "找不到 node，无法执行支付云函数依赖清单检查。" }
  $checkOutput = @(& $node.Source $DependencyCheckScript "--manifest" $manifestFullPath 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "支付云函数依赖清单检查失败：$($checkOutput -join [Environment]::NewLine)"
  }
  foreach ($line in $checkOutput) { Write-Host ([string]$line) }
  return $results.ToArray()
}
