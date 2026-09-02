param(
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [string]$CliPath = "",
    [ValidateRange(1, 65535)][int]$AutoPort = 9437,
    [ValidateRange(1, 3600)][int]$IntervalSeconds = 3,
    [ValidateRange(0, 100000)][int]$MaxChecks = 0,
    [switch]$Once
)

$ErrorActionPreference = "Stop"
$ensure = Join-Path $PSScriptRoot "ensure-devtools-9437.ps1"
if (-not (Test-Path -LiteralPath $ensure -PathType Leaf)) { throw "缺少 9437 启动脚本：$ensure" }
$check = 0
do {
    $check++
    try {
        $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ensure, "-ProjectPath", $ProjectPath, "-AutoPort", $AutoPort)
        if (-not [string]::IsNullOrWhiteSpace($CliPath)) { $args += @("-CliPath", $CliPath) }
        $raw = & powershell.exe @args 2>&1 | Out-String
        $result = $raw.Trim() | ConvertFrom-Json
        [ordered]@{ ok = [bool]$result.ok; check = $check; port = $AutoPort; status = [string]$result.status; owningProcess = $result.owningProcess; checkedAt = [DateTimeOffset]::UtcNow.ToString("o") } | ConvertTo-Json -Compress
    }
    catch {
        [ordered]@{ ok = $false; check = $check; port = $AutoPort; status = "failed"; error = $_.Exception.Message; checkedAt = [DateTimeOffset]::UtcNow.ToString("o") } | ConvertTo-Json -Compress
    }
    if ($Once -or ($MaxChecks -gt 0 -and $check -ge $MaxChecks)) { break }
    Start-Sleep -Seconds $IntervalSeconds
} while ($true)
