param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$CliPath = "",
  [ValidateRange(1, 65535)]
  [int]$AutoPort = 9437,
  [ValidateRange(1, 120)]
  [int]$WaitSeconds = 30
)

# Keep this launcher ASCII-only for Windows PowerShell 5.1.
$ErrorActionPreference = "Stop"
$project = [IO.Path]::GetFullPath($ProjectPath)
$cli = ""
if (-not [string]::IsNullOrWhiteSpace($CliPath)) {
  $cli = [IO.Path]::GetFullPath($CliPath)
}
else {
  $cliCommand = Get-Command "wechatidecli.cmd" -ErrorAction SilentlyContinue
  if ($cliCommand -and $cliCommand.Source) {
    $cli = [IO.Path]::GetFullPath([string]$cliCommand.Source)
  }
  else {
    foreach ($searchRoot in @("D:\", "C:\Program Files", "C:\Program Files (x86)")) {
      if (-not (Test-Path -LiteralPath $searchRoot)) { continue }
      $found = Get-ChildItem -LiteralPath $searchRoot -Filter "wechatidecli.cmd" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) { $cli = $found.FullName; break }
    }
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $project "project.config.json") -PathType Leaf)) {
  throw "project.config.json was not found: $project"
}
if ([string]::IsNullOrWhiteSpace($cli) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "wechatidecli.cmd was not found: $cli"
}

function Get-Listener {
  @(Get-NetTCPConnection -LocalPort $AutoPort -State Listen -ErrorAction SilentlyContinue)
}

$existing = @(Get-Listener)
if ($existing.Count -gt 0) {
  [pscustomobject]@{
    ok = $true
    status = "already-listening"
    port = $AutoPort
    owningProcess = @($existing | Select-Object -ExpandProperty OwningProcess -Unique)
    project = $project
    cli = $cli
  } | ConvertTo-Json -Depth 5
  exit 0
}

$arguments = @(
  "auto",
  "--project", $project,
  "--auto-port", [string]$AutoPort,
  "--trust-project",
  "--debug"
)
$process = Start-Process -FilePath $cli -ArgumentList $arguments -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
  Start-Sleep -Milliseconds 500
  $listeners = @(Get-Listener)
} while ($listeners.Count -eq 0 -and (Get-Date) -lt $deadline)

if ($listeners.Count -eq 0) {
  throw "DevTools automation WebSocket did not start on port $AutoPort (launcher PID $($process.Id))."
}

[pscustomobject]@{
  ok = $true
  status = "started"
  port = $AutoPort
  owningProcess = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  launcherProcess = $process.Id
  project = $project
  cli = $cli
} | ConvertTo-Json -Depth 5
