/* eslint-disable no-console */

// This smoke intentionally has no YAML dependency.  It checks the small,
// security-sensitive contract in the workflow as text so it can run before
// npm dependencies are installed on a fresh GitHub runner.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "release-gate.yml");
const entryPath = path.join(root, "scripts", "release.ps1");
const gatePath = path.join(root, "scripts", "release-gate.ps1");
const lockPath = path.join(root, "scripts", "release-lock.ps1");
const protectionPath = path.join(root, "scripts", "configure-github-protection.ps1");
const queuePath = path.join(root, "scripts", "release-queue.ps1");
const resumePath = path.join(root, "scripts", "resume-release.ps1");
const statusPath = path.join(root, "scripts", "release-status.ps1");

function readText(file) {
  assert.ok(fs.existsSync(file), `文件不存在：${file}`);
  const text = fs.readFileSync(file, "utf8");
  // A BOM is valid at the beginning of a PowerShell/YAML file, but an
  // interior BOM is almost always an accidental copy/paste corruption.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  assert.strictEqual(body.includes("\ufeff"), false, `${path.basename(file)} 含有函数体内 BOM`);
  return body.replace(/\r\n/g, "\n");
}

function mustContain(text, fragment, label) {
  assert.ok(text.includes(fragment), `${label}缺少：${fragment}`);
}

function mustMatch(text, expression, label) {
  assert.ok(expression.test(text), `${label}不符合预期：${expression}`);
}

function assertOrdered(text, before, after, label) {
  const left = text.indexOf(before);
  const right = text.indexOf(after);
  assert.ok(left >= 0, `${label}找不到前置标记：${before}`);
  assert.ok(right >= 0, `${label}找不到后置标记：${after}`);
  assert.ok(left < right, `${label}顺序错误：${before} 应在 ${after} 之前`);
}

function testWorkflowContract(workflow) {
  // Workflow-level concurrency is deliberately not cancelable.  Job-level
  // groups would still allow two release workflows to race on the queue.
  mustMatch(workflow, /^concurrency:\s*$/m, "workflow 并发配置");
  mustMatch(
    workflow,
    /^  group:\s*release-gate-\$\{\{\s*github\.repository\s*\}\}-\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\|\|\s*github\.ref_name\s*\}\}\s*$/m,
    "workflow 并发分组"
  );
  mustMatch(workflow, /^  cancel-in-progress:\s*false\s*$/m, "workflow 排队策略");

  mustContain(workflow, "  pull_request:\n    branches:\n      - main", "PR 触发范围");
  mustMatch(workflow, /^  workflow_dispatch:\s*$/m, "手动触发契约");
  assert.strictEqual(/^  push\s*:/m.test(workflow), false, "发布检查不能由 push 直接触发");
  mustContain(workflow, "permissions:\n  contents: read", "最小 GitHub 权限");
  assert.strictEqual(/continue-on-error:\s*true/.test(workflow), false, "发布检查不能吞掉失败");

  // The first executable step after checkout/setup must reject an unsafe
  // event before caches, dependency installs, or any future publish action.
  const preflight = workflow.indexOf("node scripts/release-workflow-smoke.js --runtime");
  const cache = workflow.indexOf("- name: Cache cloud-function npm download cache");
  assert.ok(preflight >= 0, "缺少发布保护预检 smoke");
  assert.ok(cache < 0 || preflight < cache, "保护预检必须先于依赖缓存/安装");
  for (const envName of [
    "RELEASE_WORKFLOW_EVENT_NAME",
    "RELEASE_WORKFLOW_REF",
    "RELEASE_WORKFLOW_REF_NAME",
    "RELEASE_WORKFLOW_BASE_REF",
    "RELEASE_WORKFLOW_HEAD_REF",
  ]) {
    mustContain(workflow, `${envName}:`, "保护预检环境变量");
  }

  // Keep the policy emitted by CI aligned with the local release gate.
  for (const marker of [
    "mainProtection = [ordered]@{ mode = \"pr-only\"",
    "requiredWorkflow = \"release-gate.yml\"",
    "applyToAdmins = $true",
    "enforceOnPublish = $true",
    "queueRoot = Join-Path $parent \"wechat-miniapp-release-queue\"",
    "queue = [ordered]@{ waitSeconds = 1800; pollMilliseconds = 500; leaseSeconds = 180; staleAfterSeconds = 600; maxAttempts = 3",
    "immutableArtifacts = $true",
  ]) {
    mustContain(workflow, marker, "发布保护策略");
  }

  for (const step of [
    "Release safety smoke",
    "Release lock smoke",
    "Release queue smoke",
    "Version concurrency smoke",
    "Release gate smoke",
    "Release failure-stage contract smoke",
    "Resume release recovery smoke",
    "Cloud deploy safety smoke",
    "Cloud deploy entry smoke",
    "Payment UI smoke",
    "Payment package and deployment safety smoke",
    "Payment dependency manifest check",
    "Payment core tests",
    "Package smoke",
    "Package read-only check",
  ]) {
    mustContain(workflow, `- name: ${step}`, "必需检查步骤");
  }
  assert.strictEqual(/release\.ps1[^\n]*-Publish/.test(workflow), false, "CI 检查不能绕过闸门直接发布");
}

function testStageFailureContracts(entry, gate, lock, protection) {
  // Every externally visible stage must leave an operation-log breadcrumb.
  // This makes a failed run resumable/auditable instead of an unexplained
  // version reservation.
  const stages = [
    "queue",
    "archive",
    "source",
    "fetch",
    "version",
    "worktree",
    "stage",
    "check",
    "commit",
    "context",
    "package",
    "preview",
    "cloud",
    "done",
  ];
  for (const stage of stages) {
    mustContain(entry, `Write-GateHost \"${stage}\"`, `阶段 ${stage} 日志`);
  }

  // Failure handling is intentionally checked as one matrix.  If a future
  // edit removes any one invariant, this smoke fails before a PR can merge.
  const failureMatrix = [
    ["锁释放", ["finally {", "Exit-ReleaseLock -LockHandle $lockHandle"]],
    ["失败日志", ["Write-ReleaseOperationLog -Path $logPath -Stage \"failed\""]],
    ["版本占用失败/可恢复标记", ["Set-ReleaseReservationStatus", "-Status \"recoverable\"", "failedStatus = if ($failureAfterCommit)"]],
    ["提交后现场保留", ["$failureAfterCommit = $true", "保留原 release context", "不重新占用版本"]],
    ["隔离工作树清理条件", ["Remove-ReleaseGateWorktree", "-not $failureAfterCommit"]],
    ["云部署共享上下文", ["-ReleaseContext $contextPath", "-DeployLockPath ([string]$policy.lockPath)"]],
    ["两阶段最终化", ["status = \"finalizing\"", "finalization = [ordered]@{ state = \"pending\"", "Set-GateQueueStage -Stage \"succeeded\" -Status \"succeeded\"", "sole terminal queue transition"]],
    ["预览阶段隔离", ["premergePreviewQrPath", "premerge-info.json", "$hasFinalPreview"]],
    ["失败 context 可恢复", ["$contextHash.status = \"recoverable\"", "lastFailureStage = $message", "Remove(\"terminalStatus\")"]],
  ];
  for (const [name, markers] of failureMatrix) {
    for (const marker of markers) mustContain(entry, marker, `${name}契约`);
  }
  assert.ok(
    /catch\s*\{[\s\S]*Set-ReleaseReservationStatus[\s\S]*-Status\s+\"recoverable\"/.test(entry),
    "提交后失败必须把 reservation 标成 recoverable"
  );
  mustContain(entry, 'failedStatus = if ($failureAfterCommit) { "recoverable" } else { "failed" }', "提交前/提交后失败状态分流");
  assertOrdered(entry, "try {", "catch {", "统一失败捕获");
  assertOrdered(entry, "catch {", "finally {", "失败处理与锁释放");

  // Version allocation and package/deploy/PR side effects must be ordered.
  assertOrdered(entry, "刷新 origin/", "已原子写入 reservation", "fetch → reservation");
  assertOrdered(entry, "已原子写入 reservation", "隔离发布工作树", "reservation → worktree");
  assertOrdered(entry, "发布前只读校验通过", "隔离提交完成", "check → commit");
  assertOrdered(entry, "release context 已生成", "不可变发布包已生成", "context → package");
  // Production deployment is a second phase: the PR/main merge must be
  // confirmed before CloudBase can receive the same immutable context.
  assertOrdered(entry, "不可变发布包已生成", "Invoke-ReleasePullRequest", "package → PR");
  assertOrdered(entry, "Invoke-ReleasePullRequest", "PR 已合并，使用同一 release context 部署 CloudBase", "PR → cloud");
  assertOrdered(entry, "status = \"finalizing\"", "Set-GateQueueStage -Stage \"succeeded\"", "finalizing → queue terminal");

  // PR checks may be reported late; the gate must wait and fail closed, never
  // treat "no checks reported" as success.
  for (const marker of [
    "checkDeadline",
    "no checks reported",
    "Start-Sleep -Seconds 5",
    "pr checks $prUrl --watch --fail-fast",
    "headRefOid",
    "Assert-ReleasePullRequestHead",
    "Assert-ReleaseMainContainsCommit",
    "refs/heads/main:refs/remotes/origin/main",
    "merge-base --is-ancestor",
    "status = \"merged\"",
    "mainCommit",
  ]) {
    mustContain(gate, marker, "PR 检查失败恢复");
  }
  for (const marker of [
    "function Test-ReleaseGitHubProtection",
    "required_status_checks",
    "AllowUnavailable",
    "RELEASE_PROTECTION_UNAVAILABLE",
    "RELEASE_PROTECTION_INVALID",
  ]) {
    mustContain(gate, marker, "主分支保护预检");
  }
  for (const marker of ["allow_force_pushes", "allow_deletions", "enforce_admins", "release-gate"]) {
    mustContain(protection, marker, "主分支保护配置");
  }
  assert.strictEqual(/HEAD:main/.test(gate), false, "发布器不能直接推送 main");
  mustContain(gate, "refs/heads/$Branch", "发布分支必须显式 refspec");

  // The lock primitive must use an exclusive OS handle and a bounded wait;
  // a stale sidecar is diagnostic data, not a bypass switch.
  for (const marker of [
    "[IO.FileShare]::None",
    "WaitSeconds",
    "发布锁等待超时",
    "Read-ReleaseLockOwner",
  ]) {
    mustContain(lock, marker, "发布锁失败场景");
  }
}

function testDurableQueueIntegration(entry, gate, queue, resume, status) {
  // The orchestration entry points and the queue state machine must share one
  // status vocabulary.  A typo here otherwise leaves a reservation stuck
  // after a perfectly valid stage transition.
  mustContain(entry, '"scripts/release-queue.ps1"', "发布工具清单");
  mustContain(entry, '"scripts/resume-release.ps1"', "发布工具清单");
  mustContain(entry, '"scripts/release-status.ps1"', "发布工具清单");
  for (const marker of [
    "New-ReleaseQueueTicket",
    "Claim-ReleaseQueueTicket",
    "Renew-ReleaseQueueLease",
    "Recover-ReleaseQueueTickets",
    "Set-ReleaseQueueTicketStatus",
    "Start-ReleaseQueueLeaseHeartbeat",
    "Stop-ReleaseQueueLeaseHeartbeat",
    "Assert-ReleaseQueueTurn",
    "Write-ReleaseQueueStateAtomic",
    "Write-ReleaseQueueEvent",
    "IdempotencyKey",
    "parentStartUtc",
    "hbOwnerStartUtc",
    "Test-HeartbeatOwnerAlive",
    "StartTime.ToUniversalTime",
  ]) {
    mustContain(queue, marker, "持久发布队列能力");
  }
  for (const marker of [
    "function Set-ReleaseQueuePhase",
    "Update-ReleaseQueueTicket",
    "Complete-ReleaseQueueTicket",
    "Renew-ReleaseQueueLease",
    "recoveryStatus",
  ]) {
    mustContain(gate, marker, "发布阶段状态桥接");
  }
  for (const marker of [
    "[string]$OperationId",
    "Assert-ReleaseContextShape",
    "release context operationId 与恢复请求不一致",
    "队列票据版本与 release context 不一致",
    "reservation operationId 与恢复请求不一致",
    "原发布操作",
    "保留原 context",
    "Stop-ReleaseQueueLeaseHeartbeat",
    "必须显式带 -Publish",
    "AllowPrepared",
  ]) {
    mustContain(resume, marker, "失败恢复入口");
  }
  assertOrdered(resume, "必须显式带 -Publish", "Claim-ReleaseQueueTicket", "resume 预检必须先于领取租约");
  mustContain(status, "Get-ReleaseQueueTickets", "发布状态入口");

  const declared = new Set();
  const declaration = queue.match(/ReleaseQueueStatuses\s*=\s*@\(([^)]*)\)/s);
  assert.ok(declaration, "队列必须声明统一状态集合");
  for (const match of declaration[1].matchAll(/"([^"]+)"/g)) declared.add(match[1]);
  const aliases = new Set();
  const aliasDeclaration = queue.match(/phaseAliases\s*=\s*@\(([^)]*)\)/s);
  if (aliasDeclaration) {
    for (const match of aliasDeclaration[1].matchAll(/"([^"]+)"/g)) aliases.add(match[1]);
  }
  const used = new Set();
  for (const source of [entry, resume]) {
    for (const match of source.matchAll(/-Status\s+"([^"]+)"/g)) used.add(match[1]);
  }
  const missing = [...used].filter((value) => !declared.has(value) && !aliases.has(value));
  assert.deepStrictEqual(missing, [], `发布入口使用了队列未声明的状态/阶段：${missing.join(", ")}`);
  if (aliases.size > 0) {
    mustContain(queue, "Normalize-ReleaseQueueStatusInput", "队列阶段别名规范化");
    const setStart = queue.indexOf("function Set-ReleaseQueueTicketStatus");
    const setEnd = queue.indexOf("\nfunction ", setStart + 1);
    const setBody = queue.slice(setStart, setEnd >= 0 ? setEnd : queue.length);
    mustContain(setBody, "Normalize-ReleaseQueueStatusInput", "队列阶段别名调用");
  }
}

function testRuntimeProtectionContract() {
  if (!process.argv.includes("--runtime")) return;

  const event = String(process.env.RELEASE_WORKFLOW_EVENT_NAME || "").trim();
  const ref = String(process.env.RELEASE_WORKFLOW_REF || "").trim();
  const refName = String(process.env.RELEASE_WORKFLOW_REF_NAME || "").trim();
  const base = String(process.env.RELEASE_WORKFLOW_BASE_REF || "").trim();
  const head = String(process.env.RELEASE_WORKFLOW_HEAD_REF || "").trim();

  assert.ok(event, "运行时保护预检缺少 event_name");
  assert.ok(["pull_request", "workflow_dispatch"].includes(event), `禁止的 workflow 事件：${event}`);
  if (event === "pull_request") {
    assert.strictEqual(base, "main", `PR 目标分支必须是 main，实际是 ${base || "<空>"}`);
    assert.ok(/^refs\/pull\/\d+\/(merge|head)$/.test(ref), `PR ref 非隔离引用：${ref}`);
    assert.notStrictEqual(head, "main", "PR head 不能伪装成 main 分支");
  } else {
    // Manual diagnostics are allowed only from main.  This prevents a user
    // selecting an old clone branch and mistaking its checks for release OK.
    assert.strictEqual(refName, "main", `workflow_dispatch 必须从 main 运行，实际是 ${refName || "<空>"}`);
    assert.strictEqual(ref, "refs/heads/main", `workflow_dispatch ref 不一致：${ref}`);
  }
}

function main() {
  const workflow = readText(workflowPath);
  const entry = readText(entryPath);
  const gate = readText(gatePath);
  const lock = readText(lockPath);
  const protection = readText(protectionPath);
  const queue = readText(queuePath);
  const resume = readText(resumePath);
  const status = readText(statusPath);
  testWorkflowContract(workflow);
  testStageFailureContracts(entry, gate, lock, protection);
  testDurableQueueIntegration(entry, gate, queue, resume, status);
  testRuntimeProtectionContract();
  console.log("release workflow smoke: OK");
}

main();
