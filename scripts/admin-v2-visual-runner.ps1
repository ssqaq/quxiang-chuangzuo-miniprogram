param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$CliPath = "",
  [string]$AutomatorPath = "",
  [string]$OutputPath = "",
  [int]$ConnectPort = 0,
  [string]$State = "",
  [switch]$AllStates,
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "admin-v2-visual-runner.js"
$runnerArgs = @("$runner", "--project", "$ProjectPath")
if ($CliPath) { $runnerArgs += @("--cli", "$CliPath") }
if ($AutomatorPath) { $runnerArgs += @("--automator", "$AutomatorPath") }
if ($OutputPath) { $runnerArgs += @("--output", "$OutputPath") }
if ($ConnectPort -gt 0) { $runnerArgs += @("--connect-port", "$ConnectPort") }
if ($State) { $runnerArgs += @("--state", "$State") }
if ($AllStates) { $runnerArgs += "--all-states" }
if ($CheckOnly) { $runnerArgs += "--check-only" }
& node @runnerArgs
exit $LASTEXITCODE
