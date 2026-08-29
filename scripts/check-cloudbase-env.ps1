[CmdletBinding()]
param(
    [string]$ProjectPath = "",
    [switch]$Strict
)

$ErrorActionPreference = "Stop"
$root = if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
    (Resolve-Path $ProjectPath).Path
}
$configPath = Join-Path $root "config.js"
$projectConfigPath = Join-Path $root "project.config.json"
$envId = [string]$env:CLOUDBASE_ENV_ID
$source = "environment"
if ([string]::IsNullOrWhiteSpace($envId) -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $text = [IO.File]::ReadAllText($configPath, [Text.UTF8Encoding]::new($false))
    $match = [regex]::Match($text, 'cloudEnvId\s*:\s*["'']([^"'']+)["'']')
    if ($match.Success) {
        $envId = $match.Groups[1].Value.Trim()
        $source = "config.js"
    }
}
$appId = ""
if (Test-Path -LiteralPath $projectConfigPath -PathType Leaf) {
    try {
        $project = [IO.File]::ReadAllText($projectConfigPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        $appId = [string]$project.appid
    } catch { }
}
$configured = -not [string]::IsNullOrWhiteSpace($envId)
$result = [ordered]@{
    status = if ($configured) { "configured" } else { "missing" }
    configured = $configured
    source = if ($configured) { $source } else { "" }
    environmentId = if ($configured) { $envId } else { "" }
    appId = $appId
    projectPath = $root
    checkedAt = [DateTimeOffset]::UtcNow.ToString("o")
    message = if ($configured) { "CloudBase 环境 ID 已配置。" } else { "未找到 CloudBase 环境 ID，请在 config.js 或开发者工具环境中配置。" }
}
$result | ConvertTo-Json -Depth 5
if ($Strict -and -not $configured) { exit 2 }
