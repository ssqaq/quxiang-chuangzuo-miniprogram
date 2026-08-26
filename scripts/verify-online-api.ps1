param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$WechatIde = "",
  [string]$ClientName = "default"
)

# Read-only online verification entry. No source upload and no remote write.
$scriptPath = Join-Path $PSScriptRoot "deploy-and-verify-api.ps1"
& $scriptPath `
  -ProjectPath $ProjectPath `
  -WechatIde $WechatIde `
  -ClientName $ClientName `
  -VerifyOnly
exit $LASTEXITCODE
