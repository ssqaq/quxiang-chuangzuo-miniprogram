$ErrorActionPreference = "Stop"

$detailPath = Join-Path $env:TEMP "codex-api-detail.json.txt"
$raw = Get-Content -LiteralPath $detailPath -Raw
$detail = ($raw.Substring($raw.IndexOf("{"))) | ConvertFrom-Json
$variables = [ordered]@{}

foreach ($item in @($detail.data.Environment.Variables)) {
    if ($item.Key) {
        $variables[[string]$item.Key] = [string]$item.Value
    }
}

$tokenPath = Join-Path $env:TEMP "codex-apple-live-photo-worker-token.txt"
$variables["APPLE_LIVE_PHOTO_WORKER_URL"] = "https://equations-projection-imaging-upload.trycloudflare.com"
$variables["APPLE_LIVE_PHOTO_WORKER_TOKEN"] = (Get-Content -LiteralPath $tokenPath -Raw).Trim()

$config = [ordered]@{
    envId = "cloud1-d4g05zdxc94d17112"
    functionRoot = "cloudfunctions"
    functions = @(
        [ordered]@{
            name = "api"
            envVariables = $variables
        }
    )
}

$configPath = Join-Path (Get-Location) "cloudbaserc.json"
$config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8
Write-Host "CONFIG_READY"
