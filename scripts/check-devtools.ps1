param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot)
)

# Keep this script ASCII-only so Windows PowerShell 5.1 does not misread UTF-8
# when the file has no BOM.
$ErrorActionPreference = "Continue"

$project = [IO.Path]::GetFullPath($ProjectPath)
Write-Host "Project: $project"
if (-not (Test-Path -LiteralPath (Join-Path $project "app.json"))) {
  Write-Host "ERROR: app.json was not found. Open the wechat-miniapp directory." -ForegroundColor Red
  exit 1
}
Write-Host "OK: app.json found" -ForegroundColor Green

$searchRoots = @("D:\", "C:\Program Files", "C:\Program Files (x86)")
$cliCandidates = foreach ($root in $searchRoots) {
  if (-not (Test-Path -LiteralPath $root)) {
    continue
  }
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
      $candidate = Join-Path $_.FullName "cli.bat"
      if (Test-Path -LiteralPath $candidate) {
        $candidate
      }
    }
}
$cli = $cliCandidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -First 1
$exe = $null
if ($cli) {
  $exe = Get-ChildItem -LiteralPath (Split-Path -Parent ([string]$cli)) -Filter "*.exe" -File |
    Where-Object { $_.Length -gt 50MB } |
    Sort-Object Length -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

if ($exe) {
  Write-Host "OK: DevTools executable found: $exe" -ForegroundColor Green
} else {
  Write-Host "WARN: DevTools executable was not found" -ForegroundColor Yellow
}
if (-not $cli) {
  Write-Host "WARN: cli.bat was not found; CLI check skipped" -ForegroundColor Yellow
  exit 0
}

Write-Host "CLI: $cli"
$result = (& $cli islogin 2>&1 | Out-String)
if ($result -match "service port disabled") {
  Write-Host "WARN: IDE service port is disabled. Enable it in IDE Settings > Security Settings." -ForegroundColor Yellow
} elseif ($result -match "login|success") {
  Write-Host "OK: CLI can access DevTools" -ForegroundColor Green
} else {
  Write-Host $result.Trim()
}
