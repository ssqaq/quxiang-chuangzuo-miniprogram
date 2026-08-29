/* eslint-disable no-console */

// 只在临时目录验证 release-queue.ps1，不读取或修改 canonical 发布队列。
// 覆盖：并发入队、幂等、FIFO、并发领取、heartbeat、进程失联后的过期接管、
// 状态转换和可恢复状态。失败时保留完整 stdout/stderr，方便定位。

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const queueScript = path.join(root, "scripts", "release-queue.ps1");

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getPowerShellFullPath(value, label) {
  const result = runPowerShell([
    `$value = ${psQuote(value)}`,
    "$full = [IO.Path]::GetFullPath($value)",
    "Write-Output ($full -replace '[\\\\/]+$','')",
  ].join("; "));
  assertPowerShellOk(result, label || "PowerShell 路径规范化");
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(lines.length > 0, `${label || "PowerShell 路径规范化"}没有输出路径`);
  return lines[lines.length - 1];
}

function encodedCommand(command) {
  return Buffer.from(command, "utf16le").toString("base64");
}

function runPowerShell(command, options = {}) {
  const result = childProcess.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(command)],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    }
  );
  return result;
}

function runPowerShellAsync(command) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(command)],
      { cwd: root, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function assertPowerShellOk(result, label) {
  assert.strictEqual(
    result.status,
    0,
    `${label}失败\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
  );
}

function parseLastJsonLine(result, label) {
  assertPowerShellOk(result, label);
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(lines.length > 0, `${label}没有 JSON 输出\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`);
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    throw new Error(`${label} JSON 解析失败：${error.message}\n${result.stdout}\n${result.stderr || ""}`);
  }
}

function parseOptionalJsonLine(result, label) {
  assertPowerShellOk(result, label);
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    throw new Error(`${label} JSON 解析失败：${error.message}\n${result.stdout}\n${result.stderr || ""}`);
  }
}

function psBase() {
  return `. ${psQuote(queueScript)}`;
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function testConcurrentCreate(queueRoot) {
  const workers = 8;
  const sourceSha = "a".repeat(64);
  const commands = Array.from({ length: workers }, (_, index) => [
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(`parallel-${index}`)} -RequestedVersion '0.57.8' -SourceSha256 ${psQuote(sourceSha)} -IncludePath @('pages/p${index}.js') -Phase 'queued' -ContextPath ${psQuote(`ctx-${index}.json`)} -ReservationPath ${psQuote(`res-${index}.json`)} -CreatedBy 'smoke-worker'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; "));
  const results = await Promise.all(commands.map((command) => runPowerShellAsync(command)));
  const tickets = results.map((result, index) => parseLastJsonLine(result, `并发入队 worker ${index}`));
  assert.strictEqual(new Set(tickets.map((ticket) => ticket.ticketId)).size, workers, "并发入队产生重复 ticketId");
  const sequences = tickets.map((ticket) => Number(ticket.sequence)).sort((a, b) => a - b);
  assert.deepStrictEqual(sequences, Array.from({ length: workers }, (_, index) => index + 1), "并发入队 sequence 不连续，可能丢票据");
  assert.ok(tickets.every((ticket) => ticket.status === "queued"), "新票据没有全部处于 queued");
  assert.ok(tickets.every((ticket) => ticket.lease && ticket.lease.id === ""), "新票据 lease 初始值不为空对象");
  return tickets;
}

function testIdempotency(queueRoot, ticket) {
  const sourceSha = "a".repeat(64);
  const reused = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId 'parallel-0' -RequestedVersion '0.57.8' -SourceSha256 ${psQuote(sourceSha)} -IncludePath @('pages/p0.js')`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "幂等复用");
  assert.strictEqual(reused.ticketId, ticket.ticketId, "幂等请求没有复用原 ticket");
  assert.strictEqual(reused.wasReused, true, "幂等复用没有标记 wasReused");

  const conflict = runPowerShell([
    psBase(),
    `New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId 'parallel-0' -RequestedVersion '0.57.9' -SourceSha256 ${psQuote("b".repeat(64))} -IncludePath @('pages/p0.js') | Out-Null`,
  ].join("; "));
  assert.notStrictEqual(conflict.status, 0, "不同请求错误地复用了同一个 operationId");
  assert.ok(`${conflict.stdout}\n${conflict.stderr}`.includes("幂等键冲突"), "幂等冲突错误提示不清楚");
}

function assertFingerprintConflict(command, label) {
  const result = runPowerShell(command);
  assert.notStrictEqual(result.status, 0, `${label}错误地复用了已有 operationId`);
  assert.ok(
    `${result.stdout || ""}\n${result.stderr || ""}`.includes("幂等键冲突"),
    `${label}没有返回幂等键冲突提示\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
  );
}

function testFingerprintBindings(queueRoot) {
  // v2 fingerprint must bind the effective version, canonical source path and
  // release metadata (publish/preview/deploy flags).  Metadata key order and
  // equivalent source spellings are intentionally treated as the same request.
  // Keep the `..` literal here; path.join() would normalize it before the
  // PowerShell helper gets a chance to prove its own canonicalization.
  const sourceWithDotSegments = `${queueRoot}${path.sep}source${path.sep}..${path.sep}publish-source`;
  // Node's os.tmpdir() can be returned with an 8.3 short user path on the
  // GitHub Windows runner (RUNNER~1), while PowerShell expands it to the long
  // spelling (runneradmin). Compare against the same canonicalizer used by
  // release-queue.ps1 instead of relying on either spelling.
  const canonicalSource = getPowerShellFullPath(sourceWithDotSegments, "SourcePath 规范化");
  const operationId = "fingerprint-binding";
  const sourceSha = "c".repeat(64);
  const include = "@('pages/fingerprint.js')";
  const first = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(operationId)} -RequestedVersion '0.57.8' -Version '0.57.8' -SourceSha256 ${psQuote(sourceSha)} -IncludePath ${include} -SourcePath ${psQuote(sourceWithDotSegments)} -Metadata ([ordered]@{ publish = $true; preview = $false; deployCloud = $false })`,
    "$ticket | ConvertTo-Json -Compress -Depth 30",
  ].join("; ")), "v2 指纹首个请求");
  assert.strictEqual(first.requestFingerprintVersion, 2, "新票据没有标记 requestFingerprintVersion=2");
  assert.strictEqual(first.sourcePath, canonicalSource, "SourcePath 没有规范化保存");

  const reordered = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(operationId)} -RequestedVersion '0.57.8' -Version '0.57.8' -SourceSha256 ${psQuote(sourceSha)} -IncludePath ${include} -SourcePath ${psQuote(canonicalSource)} -Metadata ([ordered]@{ deployCloud = $false; preview = $false; publish = $true })`,
    "$ticket | ConvertTo-Json -Compress -Depth 30",
  ].join("; ")), "v2 指纹规范化复用");
  assert.strictEqual(reordered.ticketId, first.ticketId, "等价 SourcePath/Metadata 没有幂等复用");
  assert.strictEqual(reordered.wasReused, true, "等价 v2 请求没有标记 wasReused");

  assertFingerprintConflict([
    psBase(),
    `New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(operationId)} -RequestedVersion '0.57.8' -Version '0.57.8' -SourceSha256 ${psQuote(sourceSha)} -IncludePath ${include} -SourcePath ${psQuote(canonicalSource)} -Metadata ([ordered]@{ publish = $false; preview = $true; deployCloud = $false }) | Out-Null`,
  ].join("; "), "publish/preview 标志冲突");

  assertFingerprintConflict([
    psBase(),
    `New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(operationId)} -RequestedVersion '0.57.8' -Version '0.57.9' -SourceSha256 ${psQuote(sourceSha)} -IncludePath ${include} -SourcePath ${psQuote(canonicalSource)} -Metadata ([ordered]@{ publish = $true; preview = $false; deployCloud = $false }) | Out-Null`,
  ].join("; "), "显式 Version 冲突");

  assertFingerprintConflict([
    psBase(),
    `New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(operationId)} -RequestedVersion '0.57.8' -Version '0.57.8' -SourceSha256 ${psQuote(sourceSha)} -IncludePath ${include} -SourcePath ${psQuote(path.join(queueRoot, "other-source"))} -Metadata ([ordered]@{ publish = $true; preview = $false; deployCloud = $false }) | Out-Null`,
  ].join("; "), "SourcePath 冲突");

  // A pre-v2 ticket carries only the old six-field hash.  It remains reusable
  // when every newly-bound field is absent/equal, but a changed metadata field
  // must not silently reuse it.
  const legacyOperation = "legacy-fingerprint";
  const legacy = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(legacyOperation)}`,
    "$ticket | ConvertTo-Json -Compress -Depth 30",
  ].join("; ")), "legacy 指纹票据创建");
  const legacyHash = parseLastJsonLine(runPowerShell([
    psBase(),
    `$hash = Get-ReleaseQueueFingerprint -Legacy -OperationId ${psQuote(legacyOperation)} -RequestedVersion '' -SourceSha256 '' -IncludePath @() -Priority 0 -MaxAttempts 3`,
    "$hash | ConvertTo-Json -Compress",
  ].join("; ")), "legacy 指纹计算");
  const statePath = path.join(queueRoot, "queue.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const legacyRow = state.tickets.find((row) => row.ticketId === legacy.ticketId);
  assert.ok(legacyRow, "找不到 legacy 测试票据");
  legacyRow.requestFingerprint = legacyHash;
  legacyRow.requestFingerprintVersion = 1;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

  const legacyReuse = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(legacyOperation)}`,
    "$ticket | ConvertTo-Json -Compress -Depth 30",
  ].join("; ")), "legacy 指纹兼容复用");
  assert.strictEqual(legacyReuse.ticketId, legacy.ticketId, "旧票据没有兼容复用");
  assert.strictEqual(legacyReuse.wasReused, true, "旧票据兼容复用没有标记 wasReused");
  assertFingerprintConflict([
    psBase(),
    `New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId ${psQuote(legacyOperation)} -Metadata @{ publish = $true } | Out-Null`,
  ].join("; "), "旧票据新增 Metadata 冲突");
}

function listTickets(queueRoot, includeTerminal = false) {
  const result = runPowerShell([
    psBase(),
    `$items = @(Get-ReleaseQueueTickets -QueueRoot ${psQuote(queueRoot)} -IncludeTerminal:$${includeTerminal ? "true" : "false"})`,
    "$items | ConvertTo-Json -Compress -Depth 20",
  ].join("; "), { maxBuffer: 8 * 1024 * 1024 });
  return parseLastJsonLine(result, "FIFO 查询");
}

function testFifoAndTurn(queueRoot, tickets) {
  const listed = listTickets(queueRoot);
  assert.strictEqual(listed.length, tickets.length, "FIFO 查询返回数量不一致");
  const sorted = [...listed].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  assert.deepStrictEqual(listed.map((ticket) => ticket.ticketId), sorted.map((ticket) => ticket.ticketId), "队列查询不是 sequence FIFO 顺序");
  const next = parseLastJsonLine(runPowerShell([
    psBase(),
    `$next = Get-ReleaseQueueNext -QueueRoot ${psQuote(queueRoot)}`,
    "$next | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "Get-ReleaseQueueNext");
  assert.strictEqual(next.ticketId, listed[0].ticketId, "Get-ReleaseQueueNext 没有返回最前票据");
  const turn = parseLastJsonLine(runPowerShell([
    psBase(),
    `$turn = Assert-ReleaseQueueTurn -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(next.ticketId)}`,
    "$turn | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "Assert-ReleaseQueueTurn");
  assert.strictEqual(turn.ticketId, next.ticketId, "Assert-ReleaseQueueTurn 返回错误票据");
  const outOfTurn = runPowerShell([
    psBase(),
    `$items = @(Get-ReleaseQueueTickets -QueueRoot ${psQuote(queueRoot)} -Status queued)`,
    `$items[1] | Out-Null; Assert-ReleaseQueueTurn -QueueRoot ${psQuote(queueRoot)} -TicketId $items[1].ticketId | Out-Null`,
  ].join("; "));
  assert.notStrictEqual(outOfTurn.status, 0, "非 FIFO 票据错误地通过 turn 检查");
}

async function testConcurrentClaim(queueRoot) {
  const commands = [0, 1].map(() => [
    psBase(),
    `$ticket = Claim-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -LeaseOwner ${psQuote(`claim-${Math.random().toString(16).slice(2)}`)} -LeaseSeconds 5`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; "));
  const results = await Promise.all(commands.map((command) => runPowerShellAsync(command)));
  const claimed = results.map((result, index) => parseLastJsonLine(result, `并发领取 worker ${index}`));
  assert.strictEqual(new Set(claimed.map((ticket) => ticket.ticketId)).size, claimed.length, "并发领取重复领取同一 ticket");
  assert.ok(claimed.every((ticket) => ticket.status === "leased" && ticket.leaseId && ticket.lease.id === ticket.leaseId), "并发领取租约字段不一致");
  return claimed;
}

function testHeartbeatAndCompletion(queueRoot, ticket) {
  const heartbeat = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Update-ReleaseQueueHeartbeat -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(ticket.ticketId)} -LeaseId ${psQuote(ticket.leaseId)} -LeaseOwner ${psQuote(ticket.leaseOwner)} -LeaseSeconds 5`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "heartbeat");
  assert.strictEqual(heartbeat.status, "leased");
  assert.strictEqual(heartbeat.lease.id, heartbeat.leaseId, "heartbeat 没同步嵌套 lease.id");
  assert.ok(heartbeat.lastHeartbeatAt && heartbeat.lease.heartbeatAt, "heartbeat 时间没有落盘");

  const running = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Start-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(ticket.ticketId)} -LeaseId ${psQuote(ticket.leaseId)} -LeaseOwner ${psQuote(ticket.leaseOwner)} -Stage 'packaging' -Version '0.57.8'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "进入 running");
  assert.strictEqual(running.status, "running");
  assert.strictEqual(running.phase, "packaging");
  assert.strictEqual(running.version, "0.57.8");

  const done = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Complete-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(ticket.ticketId)} -LeaseId ${psQuote(ticket.leaseId)} -LeaseOwner ${psQuote(ticket.leaseOwner)} -Status 'succeeded'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "完成票据");
  assert.strictEqual(done.status, "succeeded");
  assert.strictEqual(done.lease.id, "", "终态票据没有清理 lease");

  const invalid = runPowerShell([
    psBase(),
    `Set-ReleaseQueueTicketStatus -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(ticket.ticketId)} -Status 'running' | Out-Null`,
  ].join("; "));
  assert.notStrictEqual(invalid.status, 0, "终态 succeeded 错误地允许回到 running");
}

function testBackgroundHeartbeat(queueRoot) {
  // Exercise the real background job, not only a direct Renew call.  The
  // worker dot-sources release-queue.ps1, so this catches the subtle
  // PowerShell case-insensitive variable collision that can otherwise turn
  // every renewal into a no-op while the job still reports Running.
  const result = runPowerShell([
    psBase(),
    `$created = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId 'background-heartbeat'`,
    `$claimed = Claim-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId $created.ticketId -AllowOutOfOrder -LeaseOwner 'background-owner' -LeaseSeconds 8`,
    `$started = Start-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId $claimed.ticketId -LeaseId $claimed.leaseId -LeaseOwner $claimed.leaseOwner`,
    `$before = [DateTimeOffset]::Parse([string]$started.leaseExpiresAt)`,
    `$heartbeat = $null`,
    `try {`,
    `  $heartbeat = Start-ReleaseQueueLeaseHeartbeat -QueueRoot ${psQuote(queueRoot)} -TicketId $started.ticketId -LeaseId $started.leaseId -LeaseOwner $started.leaseOwner -LeaseSeconds 8 -IntervalSeconds 2`,
    `  Start-Sleep -Milliseconds 6500`,
    `  $afterTicket = Get-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId $started.ticketId`,
    `  [pscustomobject]@{ before = $before.ToUniversalTime().ToString('o'); after = ([DateTimeOffset]::Parse([string]$afterTicket.leaseExpiresAt)).ToUniversalTime().ToString('o'); heartbeat = [string]$afterTicket.lastHeartbeatAt; jobState = [string]$heartbeat.job.State; ownerPid = [int]$heartbeat.ownerPid; ownerStartUtc = [string]$heartbeat.ownerStartUtc; processStartUtc = [string]$heartbeat.processStartUtc } | ConvertTo-Json -Compress`,
    `} finally { if ($null -ne $heartbeat) { Stop-ReleaseQueueLeaseHeartbeat -Heartbeat $heartbeat } }`,
  ].join("; "));
  const summary = parseLastJsonLine(result, "后台 heartbeat");
  assert.ok(summary.heartbeat, "后台 heartbeat 没有写入 lastHeartbeatAt");
  assert.ok(["Running", "Completed", "Stopped"].includes(summary.jobState), "后台 heartbeat job 状态异常");
  assert.ok(Date.parse(summary.after) > Date.parse(summary.before), "后台 heartbeat 没有延长租约");
  assert.ok(Number(summary.ownerPid) > 0, "后台 heartbeat 没记录 owner PID");
  assert.ok(summary.ownerStartUtc && !Number.isNaN(Date.parse(summary.ownerStartUtc)), "后台 heartbeat 没记录 parent process start time");
  assert.strictEqual(summary.processStartUtc, summary.ownerStartUtc, "后台 heartbeat processStartUtc 与 ownerStartUtc 不一致");
}

function testDotSourceIsolation() {
  // A release entry point has its own variables with these names.  Dot-sourcing
  // the queue helper must not reset them merely to install queue functions.
  const result = runPowerShell([
    "$OperationId = 'caller-operation'",
    "$Version = 'caller-version'",
    "$SourcePath = 'caller-source'",
    "$IncludePath = @('caller-file.js')",
    "$Status = 'caller-status'",
    `$before = [ordered]@{ operationId = $OperationId; version = $Version; sourcePath = $SourcePath; includePath = @($IncludePath); status = $Status }`,
    ` . ${psQuote(queueScript)}`,
    `$after = [ordered]@{ operationId = $OperationId; version = $Version; sourcePath = $SourcePath; includePath = @($IncludePath); status = $Status }`,
    `[pscustomobject]@{ before = $before; after = $after } | ConvertTo-Json -Compress -Depth 10`,
  ].join("; "));
  const summary = parseLastJsonLine(result, "dot-source 变量隔离");
  assert.deepStrictEqual(summary.after, summary.before, "dot-source queue helper 覆盖了调用方变量");

  // The real regression was subtler than parameter clobbering: a queue
  // transaction created inside a dot-sourced caller used to lose helper
  // commands once its action entered Where-Object.  Exercise that exact
  // call shape so release.ps1/status cannot silently regress.
  const transactionProbe = runPowerShell([
    psBase(),
    "$probe = @(Get-ReleaseQueueTickets -QueueRoot (Join-Path $env:TEMP ('release-queue-probe-' + [guid]::NewGuid().ToString('N'))))",
    "Write-Output ('transaction-probe-count=' + $probe.Count)",
  ].join("; "));
  assertPowerShellOk(transactionProbe, "dot-source 事务 helper 可见性");
  assert.ok(String(transactionProbe.stdout || "").includes("transaction-probe-count="), "事务可见性探针没有完成");
}

function testLeaseRecovery(queueRoot) {
  const created = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId 'crash-recovery' -MaxAttempts 2 -Phase 'queued'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "恢复票据创建");
  const claimed = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Claim-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(created.ticketId)} -AllowOutOfOrder -LeaseOwner 'crashed-process' -LeaseSeconds 5`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "恢复票据领取");
  assert.strictEqual(claimed.status, "leased");
  // 模拟进程拿到租约后直接退出；OS 锁已释放，但 lease 仍留在 queue.json。
  sleepMs(5800);
  const recovered = parseLastJsonLine(runPowerShell([
    psBase(),
    `$items = @(Recover-StaleReleaseQueueTickets -QueueRoot ${psQuote(queueRoot)})`,
    "$items | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "过期租约接管");
  const recoveredItem = Array.isArray(recovered) ? recovered.find((item) => item.ticketId === created.ticketId) : recovered;
  assert.ok(recoveredItem, "过期租约没有被恢复扫描发现");
  assert.strictEqual(recoveredItem.status, "queued", "第一次过期租约没有重新排队");
  assert.strictEqual(Number(recoveredItem.takeoverCount), 1, "takeoverCount 没有递增");

  const takeover = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Claim-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(created.ticketId)} -AllowOutOfOrder -LeaseOwner 'takeover-process' -LeaseSeconds 5`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "接管后再次领取");
  assert.strictEqual(takeover.status, "leased");
  assert.strictEqual(takeover.leaseOwner, "takeover-process");

  const unrecoverable = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId 'recoverable-case' -MaxAttempts 1`,
    `$ticket = Claim-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId $ticket.ticketId -AllowOutOfOrder -LeaseOwner 'one-shot' -LeaseSeconds 5`,
    "Start-Sleep -Seconds 6",
    `$items = @(Recover-StaleReleaseQueueTickets -QueueRoot ${psQuote(queueRoot)})`,
    "$items | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "达到最大次数后的恢复状态");
  const exhausted = Array.isArray(unrecoverable) ? unrecoverable.find((item) => item.operationId === "recoverable-case") : unrecoverable;
  assert.ok(exhausted, "最大 attempt 票据没有返回恢复结果");
  assert.strictEqual(exhausted.status, "recoverable", "最大 attempt 应进入 recoverable 状态");
}

function testUpdateAndDelete(queueRoot) {
  const created = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId 'crud-case' -Metadata @{ owner = 'smoke'; step = 'queued' }`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "CRUD 创建");
  const updated = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Update-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(created.ticketId)} -Phase 'preflight' -ContextPath 'ctx-crud.json'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "CRUD 更新");
  assert.strictEqual(updated.phase, "preflight");
  assert.strictEqual(updated.contextPath, "ctx-crud.json");
  const fetched = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Get-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -OperationId 'crud-case'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "CRUD 查询");
  assert.strictEqual(fetched.ticketId, created.ticketId);
  const removed = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Remove-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(created.ticketId)}`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "CRUD 删除");
  assert.strictEqual(removed.ticketId, created.ticketId);
  const absent = runPowerShell([
    psBase(),
    `$ticket = Get-ReleaseQueueTicket -QueueRoot ${psQuote(queueRoot)} -TicketId ${psQuote(created.ticketId)}`,
    "if ($null -ne $ticket) { throw 'delete failed' }",
  ].join("; "));
  assertPowerShellOk(absent, "CRUD 删除后查询");
}

function testPreparedClaimIsolation(queueRoot) {
  // Prepared tickets deliberately remain queued to hold their FIFO slot, but
  // must not be consumable by a generic worker.  Only the explicit resume
  // path opts into -AllowPrepared.
  const preparedRoot = path.join(queueRoot, "prepared-head");
  const prepared = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(preparedRoot)} -OperationId 'prepared-head' -Phase 'prepared'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "prepared 票据创建");
  const later = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(preparedRoot)} -OperationId 'later-ticket' -Phase 'queued'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "prepared 后续票据创建");

  const generic = runPowerShell([
    psBase(),
    `$claimed = Claim-ReleaseQueueTicket -QueueRoot ${psQuote(preparedRoot)} -LeaseOwner 'generic-worker'`,
    "if ($null -ne $claimed) { throw 'generic worker incorrectly claimed prepared ticket' }",
  ].join("; "));
  assertPowerShellOk(generic, "generic worker 跳过 prepared 票据");

  const laterAttempt = runPowerShell([
    psBase(),
    `Claim-ReleaseQueueTicket -QueueRoot ${psQuote(preparedRoot)} -TicketId ${psQuote(later.ticketId)} -LeaseOwner 'generic-worker' | Out-Null`,
  ].join("; "));
  assert.notStrictEqual(laterAttempt.status, 0, "普通 worker 错误地越过 prepared FIFO 头票据");

  const noOptIn = runPowerShell([
    psBase(),
    `Claim-ReleaseQueueTicket -QueueRoot ${psQuote(preparedRoot)} -TicketId ${psQuote(prepared.ticketId)} -LeaseOwner 'generic-worker' | Out-Null`,
  ].join("; "));
  assert.notStrictEqual(noOptIn.status, 0, "未显式 AllowPrepared 却领取了 prepared 票据");

  const resumed = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Claim-ReleaseQueueTicket -QueueRoot ${psQuote(preparedRoot)} -TicketId ${psQuote(prepared.ticketId)} -AllowPrepared -LeaseOwner 'resume-worker'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "resume 显式领取 prepared 票据");
  assert.strictEqual(resumed.ticketId, prepared.ticketId, "resume 没有领取 prepared 头票据");
  assert.strictEqual(resumed.status, "leased");
}

function testPreparedContextExpiry(queueRoot) {
  // An abandoned preparation must not hold the FIFO forever.  Recovery closes
  // only a queued non-terminal ticket whose durable context deadline is past;
  // a later ordinary ticket can then proceed without bypassing the head.
  const expiryRoot = path.join(queueRoot, "expiry");
  const contextPath = path.join(expiryRoot, "expired-context.json");
  fs.mkdirSync(expiryRoot, { recursive: true });
  fs.writeFileSync(contextPath, JSON.stringify({
    operationId: "expired-prepared",
    version: "0.57.8",
    expiresAt: "2000-01-01T00:00:00.000Z",
    terminalStatus: "",
  }), "utf8");
  const prepared = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(expiryRoot)} -OperationId 'expired-prepared' -Phase 'prepared' -ContextPath ${psQuote(contextPath)}`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "过期 prepared 票据创建");
  const later = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(expiryRoot)} -OperationId 'after-expired' -Phase 'queued'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "过期票据后的队列创建");
  const recovered = parseLastJsonLine(runPowerShell([
    psBase(),
    `$items = @(Recover-ReleaseQueueTickets -QueueRoot ${psQuote(expiryRoot)})`,
    "$items | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "prepared context 过期恢复");
  const expired = Array.isArray(recovered) ? recovered.find((item) => item.ticketId === prepared.ticketId) : recovered;
  assert.ok(expired, "过期 prepared 票据没有被恢复扫描发现");
  assert.strictEqual(expired.status, "expired", "过期 prepared 票据没有进入 expired");
  const claimedLater = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = Claim-ReleaseQueueTicket -QueueRoot ${psQuote(expiryRoot)} -LeaseOwner 'after-expiry'`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "过期后继续领取队列");
  assert.strictEqual(claimedLater.ticketId, later.ticketId, "过期 prepared 票据仍阻塞后续队列");

  // PowerShell ConvertFrom-Json materializes an ISO `Z` value as DateTime.  A
  // recovery implementation must pass that typed UTC value through its parser
  // instead of stringifying it (which would make a Beijing host subtract eight
  // hours and expire a still-valid context).
  const futureRoot = path.join(queueRoot, "future-context");
  const futureContextPath = path.join(futureRoot, "future-context.json");
  fs.mkdirSync(futureRoot, { recursive: true });
  fs.writeFileSync(futureContextPath, JSON.stringify({
    operationId: "future-prepared",
    version: "0.57.8",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    terminalStatus: "",
  }), "utf8");
  const futureTicket = parseLastJsonLine(runPowerShell([
    psBase(),
    `$ticket = New-ReleaseQueueTicket -QueueRoot ${psQuote(futureRoot)} -OperationId 'future-prepared' -Phase 'prepared' -ContextPath ${psQuote(futureContextPath)}`,
    "$ticket | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "未来 prepared 票据创建");
  const futureRecovered = parseOptionalJsonLine(runPowerShell([
    psBase(),
    `$items = @(Recover-ReleaseQueueTickets -QueueRoot ${psQuote(futureRoot)})`,
    "$items | ConvertTo-Json -Compress -Depth 20",
  ].join("; ")), "未来 context 恢复扫描");
  const unexpectedlyExpired = Array.isArray(futureRecovered)
    ? futureRecovered.find((item) => item.ticketId === futureTicket.ticketId)
    : (futureRecovered && futureRecovered.ticketId === futureTicket.ticketId ? futureRecovered : null);
  assert.ok(!unexpectedlyExpired, "未过期 UTC context 被错误标记 expired");
}

async function main() {
  assert.ok(fs.existsSync(queueScript), "release-queue.ps1 不存在");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-queue-smoke-"));
  try {
    const tickets = await testConcurrentCreate(tempRoot);
    testIdempotency(tempRoot, tickets[0]);
    testFifoAndTurn(tempRoot, tickets);
    testFingerprintBindings(tempRoot);
    const claimed = await testConcurrentClaim(tempRoot);
    testHeartbeatAndCompletion(tempRoot, claimed[0]);
    testBackgroundHeartbeat(tempRoot);
    testDotSourceIsolation();
    testLeaseRecovery(tempRoot);
    testUpdateAndDelete(tempRoot);
    testPreparedClaimIsolation(tempRoot);
    testPreparedContextExpiry(tempRoot);
    const statePath = path.join(tempRoot, "queue.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(Number(state.nextSequence) >= tickets.length, "持久队列 nextSequence 没有保存");
    assert.ok(fs.existsSync(path.join(tempRoot, "events.jsonl")), "队列事件日志没有生成");
    console.log("release queue smoke: OK");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
