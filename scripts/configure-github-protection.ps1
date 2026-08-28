param(
  [string]$PolicyPath = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$policyFile = if ([string]::IsNullOrWhiteSpace($PolicyPath)) {
  Join-Path (Split-Path $repoRoot -Parent) "wechat-miniapp-release-policy.json"
} else {
  [IO.Path]::GetFullPath($PolicyPath)
}
if (-not (Test-Path -LiteralPath $policyFile -PathType Leaf)) {
  throw "缺少发布策略文件：$policyFile"
}
$policy = Get-Content -LiteralPath $policyFile -Raw -Encoding UTF8 | ConvertFrom-Json
$canonical = [IO.Path]::GetFullPath([string]$policy.canonicalRepo)
if (-not [string]::Equals($canonical.TrimEnd('\', '/'), $repoRoot.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
  throw "只能从 canonical 仓库配置主分支保护：$canonical"
}
if ([string]$policy.branch -ne "main") { throw "主分支保护目标必须是 main。" }
$remote = [string]$policy.remote
$slugMatch = [regex]::Match($remote, 'github\.com[/:]([^/]+/[^/]+?)(?:\.git)?$')
if (-not $slugMatch.Success) { throw "无法从远端 URL 解析 GitHub 仓库：$remote" }
$slug = $slugMatch.Groups[1].Value
if ($DryRun) {
  Write-Host "Dry run：将为 $slug/main 设置 PR-only 和 release-gate 必需检查。"
  exit 0
}
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($null -eq $gh) { throw "配置主分支保护需要 GitHub CLI gh。" }
& $gh.Source auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI 未认证，请先执行 gh auth login。" }

$protection = [ordered]@{
  required_status_checks = [ordered]@{
    strict = $true
    contexts = @("release-gate")
  }
  enforce_admins = $true
  required_pull_request_reviews = [ordered]@{
    dismiss_stale_reviews = $true
    require_code_owner_reviews = $false
    required_approving_review_count = 1
  }
  restrictions = $null
  required_linear_history = $false
  allow_force_pushes = $false
  allow_deletions = $false
  block_creations = $false
  required_conversation_resolution = $true
  lock_branch = $false
  allow_fork_syncing = $false
}
$jsonPath = Join-Path ([IO.Path]::GetTempPath()) "wechat-miniapp-main-protection-$PID-$([guid]::NewGuid().ToString('N')).json"
try {
  [IO.File]::WriteAllText($jsonPath, ($protection | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  $response = @(& $gh.Source api --method PUT "repos/$slug/branches/main/protection" --input $jsonPath 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $details = ($response -join "`n").Trim()
    if ($details -match "Upgrade to GitHub Pro|make this repository public") {
      throw "GitHub 主分支保护配置失败：当前仓库是私有仓库，当前 GitHub 套餐不提供分支保护；需要升级 GitHub Pro/团队套餐，或由管理员把仓库改为公开后重试。原始错误：$details"
    }
    throw "GitHub 主分支保护配置失败：$details"
  }
  Write-Host "GitHub 主分支保护已配置：$slug/main（release-gate 必需检查，管理员也生效）。"
}
finally {
  Remove-Item -LiteralPath $jsonPath -Force -ErrorAction SilentlyContinue
}
