# 云数据库索引检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一套先只读检查、再逐项确认创建、最后自动复查的 CloudBase 数据库索引管理工具。

**Architecture:** 使用 JSON 文件保存11组必需索引；纯 Node.js 核心负责标准化和比较索引；独立的 CloudBase Manager Node SDK 适配器负责读取和修改云端索引；PowerShell 入口负责安装本地依赖、展示报告、逐项确认和复查。管理端密钥只从环境变量读取，云函数和小程序运行时不接触密钥。

**Tech Stack:** Node.js CommonJS、PowerShell 5.1+、`@cloudbase/manager-node@5.8.1`、现有 smoke test 与发布脚本。

---

## 文件结构

新增文件：

- `scripts/database-indexes.json`：11组必需索引的唯一配置来源。
- `scripts/database-index-core.js`：索引标准化、比较、汇总和创建参数生成。
- `scripts/database-index-smoke.js`：纯本地自动测试，不连接真实云环境。
- `scripts/cloud-database-index-manager/package.json`：本地管理工具依赖。
- `scripts/cloud-database-index-manager/package-lock.json`：锁定 Manager SDK 依赖。
- `scripts/cloud-database-index-manager/index.js`：CloudBase Manager SDK 命令行适配器。
- `scripts/check-cloud-database-indexes.ps1`：检查、确认创建和复查入口。

修改文件：

- `scripts/validate.js`：把新增 JSON、JS、PowerShell 和 smoke test 纳入静态检查。
- `scripts/package-release.py`：要求发布包包含索引工具源码，但继续排除 `node_modules` 和临时报告。
- `README.md`：补充凭据、检查、确认创建和复查命令。
- `config.js`：版本从 `0.25.0` 升到 `0.26.0`。
- `cloudfunctions/api/package.json`：版本从 `0.25.0` 升到 `0.26.0`。
- `cloudfunctions/api/package-lock.json`：根版本同步到 `0.26.0`。
- `cloudfunctions/api/index.js`：仅同步 API 构建版本和构建标记，不加入索引管理密钥或管理 SDK。
- 依赖 API 构建标记的 smoke test：同步期望标记。

## Task 1：建立索引清单和第一个失败测试

**Files:**

- Create: `scripts/database-indexes.json`
- Create: `scripts/database-index-smoke.js`

- [ ] **Step 1：先写读取索引清单的失败测试**

创建 `scripts/database-index-smoke.js`：

```js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "scripts", "database-indexes.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

assert.strictEqual(manifest.version, 1);
assert.ok(Array.isArray(manifest.indexes));
assert.strictEqual(manifest.indexes.length, 11);

const identities = new Set();
for (const item of manifest.indexes) {
  assert.ok(item.collection);
  assert.ok(item.name);
  assert.ok(Array.isArray(item.keys) && item.keys.length > 0);
  assert.strictEqual(item.unique, false);
  assert.ok(item.reason);
  const identity = `${item.collection}:${item.name}`;
  assert.ok(!identities.has(identity), `重复索引定义：${identity}`);
  identities.add(identity);
  for (const key of item.keys) {
    assert.ok(key.name);
    assert.ok(key.direction === 1 || key.direction === -1);
  }
}

console.log("database index manifest smoke: OK");
```

- [ ] **Step 2：运行测试，确认清单不存在时失败**

Run:

```powershell
node scripts/database-index-smoke.js
```

Expected: FAIL，错误包含 `ENOENT` 和 `database-indexes.json`。

- [ ] **Step 3：创建完整索引清单**

创建 `scripts/database-indexes.json`：

```json
{
  "version": 1,
  "indexes": [
    {
      "collection": "auto_face_failure_logs",
      "name": "idx_created_at_desc",
      "keys": [{ "name": "createdAt", "direction": -1 }],
      "unique": false,
      "reason": "按创建时间清理过期日志并读取最近失败记录"
    },
    {
      "collection": "photo_to_video_temp_assets",
      "name": "idx_session_id_asc",
      "keys": [{ "name": "sessionId", "direction": 1 }],
      "unique": false,
      "reason": "按照片转视频会话查找临时资源"
    },
    {
      "collection": "photo_to_video_temp_assets",
      "name": "idx_idle_cleanup_after_asc",
      "keys": [{ "name": "idleCleanupAfter", "direction": 1 }],
      "unique": false,
      "reason": "按空闲清理时间查找待清理资源"
    },
    {
      "collection": "photo_to_video_temp_assets",
      "name": "idx_cleanup_after_asc",
      "keys": [{ "name": "cleanupAfter", "direction": 1 }],
      "unique": false,
      "reason": "按兜底清理时间查找待清理资源"
    },
    {
      "collection": "admin_deployment_logs",
      "name": "idx_checked_at_desc",
      "keys": [{ "name": "checkedAt", "direction": -1 }],
      "unique": false,
      "reason": "按检查时间倒序读取最近部署记录"
    },
    {
      "collection": "model_usage_events",
      "name": "idx_date_key_asc",
      "keys": [{ "name": "dateKey", "direction": 1 }],
      "unique": false,
      "reason": "按日期范围读取模型用量事件"
    },
    {
      "collection": "auto_face_probe_logs",
      "name": "idx_created_at_checked_at",
      "keys": [
        { "name": "createdAt", "direction": 1 },
        { "name": "checkedAt", "direction": -1 }
      ],
      "unique": false,
      "reason": "按创建时间过滤并按检查时间倒序读取探针历史"
    },
    {
      "collection": "point_ledger",
      "name": "idx_openid_created_at",
      "keys": [
        { "name": "openid", "direction": 1 },
        { "name": "createdAt", "direction": -1 }
      ],
      "unique": false,
      "reason": "按用户读取最近积分流水"
    },
    {
      "collection": "generation_records",
      "name": "idx_openid_request_id",
      "keys": [
        { "name": "openid", "direction": 1 },
        { "name": "requestId", "direction": 1 }
      ],
      "unique": false,
      "reason": "按用户和请求号查找幂等生成记录"
    },
    {
      "collection": "generation_records",
      "name": "idx_openid_created_at",
      "keys": [
        { "name": "openid", "direction": 1 },
        { "name": "createdAt", "direction": -1 }
      ],
      "unique": false,
      "reason": "按用户读取最近生成记录"
    },
    {
      "collection": "generation_records",
      "name": "idx_openid_parent_record_id",
      "keys": [
        { "name": "openid", "direction": 1 },
        { "name": "parentRecordId", "direction": 1 }
      ],
      "unique": false,
      "reason": "按用户和父记录查找修复子记录"
    }
  ]
}
```

- [ ] **Step 4：重新运行清单测试**

Run:

```powershell
node scripts/database-index-smoke.js
```

Expected: PASS，输出 `database index manifest smoke: OK`。

- [ ] **Step 5：提交索引清单**

```powershell
git add -- scripts/database-indexes.json scripts/database-index-smoke.js
git commit -m "test: 定义云数据库必需索引"
```

## Task 2：实现纯索引比较核心

**Files:**

- Create: `scripts/database-index-core.js`
- Modify: `scripts/database-index-smoke.js`

- [ ] **Step 1：给 smoke test 增加比较场景**

在 `scripts/database-index-smoke.js` 读取清单后加入：

```js
const core = require("./database-index-core");

function index(name, keys, unique = false) {
  return {
    Name: name,
    Keys: keys.map((item) => ({
      Name: item.name,
      Direction: String(item.direction)
    })),
    Unique: unique
  };
}

async function inspectWith(actualByCollection) {
  return core.inspectDatabaseIndexes(manifest.indexes, async (collectionName) => ({
    Indexes: actualByCollection[collectionName] || []
  }));
}

async function runCoreTests() {
  const expected = manifest.indexes[0];
  const existing = await inspectWith({
    [expected.collection]: [index(expected.name, expected.keys)]
  });
  assert.strictEqual(existing.results[0].status, "existing");

  const equivalent = await inspectWith({
    [expected.collection]: [index("legacy_created_at", expected.keys)]
  });
  assert.strictEqual(equivalent.results[0].status, "equivalent");

  const missing = await inspectWith({});
  assert.strictEqual(missing.results[0].status, "missing");

  const mismatched = await inspectWith({
    [expected.collection]: [index(expected.name, [{ name: "createdAt", direction: 1 }])]
  });
  assert.strictEqual(mismatched.results[0].status, "mismatched");

  const options = core.buildCreateOptions(expected);
  assert.deepStrictEqual(options, {
    CreateIndexes: [{
      IndexName: expected.name,
      MgoKeySchema: {
        MgoIndexKeys: [{ Name: "createdAt", Direction: "-1" }],
        MgoIsUnique: "false"
      }
    }]
  });

  const originalSecretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  try {
    process.env.TENCENTCLOUD_SECRET_KEY = "smoke-secret-key";
    const safe = core.safeError({
      code: "AuthFailure",
      message: "bad smoke-secret-key"
    });
    assert.strictEqual(safe.code, "AuthFailure");
    assert.ok(!safe.message.includes("smoke-secret-key"));
  } finally {
    if (originalSecretKey === undefined) {
      delete process.env.TENCENTCLOUD_SECRET_KEY;
    } else {
      process.env.TENCENTCLOUD_SECRET_KEY = originalSecretKey;
    }
  }
}

runCoreTests().then(() => {
  console.log("database index core smoke: OK");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2：运行测试，确认核心模块不存在**

Run:

```powershell
node scripts/database-index-smoke.js
```

Expected: FAIL，错误包含 `Cannot find module './database-index-core'`。

- [ ] **Step 3：实现纯比较核心**

创建 `scripts/database-index-core.js`，导出以下稳定接口：

```js
function direction(value) {
  return String(value) === "-1" ? -1 : 1;
}

function normalizeKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => ({
      name: String(item.Name ?? item.name ?? ""),
      direction: direction(item.Direction ?? item.direction)
    })).filter((item) => item.name);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([name, itemDirection]) => ({
      name,
      direction: direction(itemDirection)
    }));
  }
  return [];
}

function normalizeIndex(value) {
  const item = value || {};
  const uniqueValue = item.Unique ?? item.unique;
  return {
    name: String(item.Name ?? item.name ?? item.IndexName ?? ""),
    keys: normalizeKeys(item.Keys ?? item.keys ?? item.Key ?? item.key),
    unique: uniqueValue === true
      || String(uniqueValue).toLowerCase() === "true"
      || String(uniqueValue) === "1"
  };
}

function definitionKey(value) {
  const normalized = normalizeIndex(value);
  return JSON.stringify({
    keys: normalized.keys,
    unique: normalized.unique
  });
}

function responseIndexes(response) {
  const candidates = [
    response && response.Indexes,
    response && response.indexes,
    response && response.Data && response.Data.Indexes,
    response && response.data && response.data.indexes
  ];
  const found = candidates.find(Array.isArray);
  return (found || []).map(normalizeIndex).filter((item) => item.name);
}

function isSystemIndex(value) {
  const name = String(value && value.name || "");
  return name === "_id_" || name === "_id";
}

function secretValues() {
  return [
    process.env.TENCENTCLOUD_SECRET_ID,
    process.env.TENCENTCLOUD_SECRET_KEY,
    process.env.TENCENTCLOUD_SESSION_TOKEN
  ].filter(Boolean);
}

function safeError(error) {
  let message = String(error && error.message || error || "unknown error");
  for (const secret of secretValues()) {
    message = message.split(secret).join("[REDACTED]");
  }
  return {
    code: String(error && (error.code || error.Code) || "UNKNOWN"),
    message
  };
}

function isCollectionMissing(error) {
  const value = `${error && (error.code || error.Code) || ""} ${error && error.message || ""}`;
  return /collection.*not.*exist|ResourceNotFound|DATABASE_COLLECTION_NOT_EXIST/i.test(value);
}

function buildCreateOptions(spec) {
  return {
    CreateIndexes: [{
      IndexName: spec.name,
      MgoKeySchema: {
        MgoIndexKeys: spec.keys.map((item) => ({
          Name: item.name,
          Direction: String(item.direction)
        })),
        MgoIsUnique: String(Boolean(spec.unique))
      }
    }]
  };
}

async function inspectDatabaseIndexes(specs, describeCollection) {
  const grouped = new Map();
  for (const spec of specs) {
    if (!grouped.has(spec.collection)) grouped.set(spec.collection, []);
    grouped.get(spec.collection).push(spec);
  }

  const results = [];
  const extras = [];
  for (const [collection, collectionSpecs] of grouped) {
    let actual;
    try {
      actual = responseIndexes(await describeCollection(collection));
    } catch (error) {
      const status = isCollectionMissing(error) ? "collection-missing" : "check-failed";
      const safe = safeError(error);
      for (const spec of collectionSpecs) {
        results.push({ ...spec, status, error: safe });
      }
      continue;
    }

    for (const spec of collectionSpecs) {
      const sameName = actual.find((item) => item.name === spec.name);
      const equivalent = actual.find((item) => definitionKey(item) === definitionKey(spec));
      if (sameName && definitionKey(sameName) === definitionKey(spec)) {
        results.push({ ...spec, status: "existing", actual: sameName });
      } else if (sameName) {
        results.push({ ...spec, status: "mismatched", actual: sameName });
      } else if (equivalent) {
        results.push({ ...spec, status: "equivalent", actual: equivalent });
      } else {
        results.push({ ...spec, status: "missing" });
      }
    }

    for (const item of actual.filter((entry) => !isSystemIndex(entry))) {
      const managed = collectionSpecs.some((spec) => (
        item.name === spec.name || definitionKey(item) === definitionKey(spec)
      ));
      if (!managed) extras.push({ collection, ...item, status: "extra" });
    }
  }

  const summary = {
    total: results.length,
    existing: results.filter((item) => item.status === "existing").length,
    equivalent: results.filter((item) => item.status === "equivalent").length,
    missing: results.filter((item) => item.status === "missing").length,
    mismatched: results.filter((item) => item.status === "mismatched").length,
    collectionMissing: results.filter((item) => item.status === "collection-missing").length,
    failed: results.filter((item) => item.status === "check-failed").length,
    extra: extras.length
  };
  return {
    ok: summary.collectionMissing === 0 && summary.failed === 0,
    results,
    extras,
    summary
  };
}

module.exports = {
  normalizeKeys,
  normalizeIndex,
  definitionKey,
  responseIndexes,
  safeError,
  isCollectionMissing,
  buildCreateOptions,
  inspectDatabaseIndexes
};
```

- [ ] **Step 4：运行核心测试**

Run:

```powershell
node scripts/database-index-smoke.js
```

Expected: PASS，输出：

```text
database index manifest smoke: OK
database index core smoke: OK
```

- [ ] **Step 5：提交纯核心**

```powershell
git add -- scripts/database-index-core.js scripts/database-index-smoke.js
git commit -m "feat: 增加数据库索引比较核心"
```

## Task 3：实现 CloudBase Manager SDK 适配器

**Files:**

- Create: `scripts/cloud-database-index-manager/package.json`
- Create: `scripts/cloud-database-index-manager/package-lock.json`
- Create: `scripts/cloud-database-index-manager/index.js`
- Modify: `scripts/database-index-smoke.js`

- [ ] **Step 1：增加 Manager 适配器失败测试**

在 `scripts/database-index-smoke.js` 的 `runCoreTests()` 中增加：

```js
const managerCli = require("./cloud-database-index-manager/index");
const targetSpec = manifest.indexes[0];
const calls = [];
const fakeDatabase = {
  async describeCollection() {
    return { Indexes: [] };
  },
  async updateCollection(collectionName, options) {
    calls.push({ collectionName, options });
    return { RequestId: "manager-smoke" };
  }
};
const applied = await managerCli.applyIndex({
  database: fakeDatabase,
  manifest,
  collection: targetSpec.collection,
  indexName: targetSpec.name,
  allowRebuild: false
});
assert.strictEqual(applied.status, "created");
assert.strictEqual(calls.length, 1);
assert.deepStrictEqual(calls[0], {
  collectionName: targetSpec.collection,
  options: core.buildCreateOptions(targetSpec)
});

calls.length = 0;
fakeDatabase.describeCollection = async () => ({
  Indexes: [index(targetSpec.name, [{ name: "createdAt", direction: 1 }])]
});
await assert.rejects(
  () => managerCli.applyIndex({
    database: fakeDatabase,
    manifest,
    collection: targetSpec.collection,
    indexName: targetSpec.name,
    allowRebuild: false
  }),
  /REBUILD_CONFIRMATION_REQUIRED/
);
assert.strictEqual(calls.length, 0);
```

- [ ] **Step 2：运行测试，确认适配器不存在**

Run:

```powershell
node scripts/database-index-smoke.js
```

Expected: FAIL，错误包含 `cloud-database-index-manager/index`。

- [ ] **Step 3：增加独立依赖清单并锁定版本**

创建 `scripts/cloud-database-index-manager/package.json`：

```json
{
  "name": "cloud-database-index-manager",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "dependencies": {
    "@cloudbase/manager-node": "5.8.1"
  }
}
```

生成锁文件：

```powershell
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefix scripts/cloud-database-index-manager
```

Expected: `scripts/cloud-database-index-manager/package-lock.json` 存在，根包版本为 `1.0.0`，Manager SDK 为 `5.8.1`。

- [ ] **Step 4：实现 Manager SDK 命令行适配器**

创建 `scripts/cloud-database-index-manager/index.js`，稳定接口为：

```js
const fs = require("fs");
const path = require("path");
const core = require("../database-index-core");

function parseArgs(argv) {
  const args = { command: argv[2] || "" };
  for (let index = 3; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    if (name === "allow-rebuild") {
      args.allowRebuild = true;
      continue;
    }
    args[name] = argv[index + 1];
    index += 1;
  }
  return args;
}

function loadManifest(manifestPath) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  if (!parsed || !Array.isArray(parsed.indexes)) {
    throw new Error("INDEX_MANIFEST_INVALID");
  }
  return parsed;
}

function createDatabase(environmentId) {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error("TENCENT_CLOUD_CREDENTIALS_MISSING");
  }
  const CloudBase = require("@cloudbase/manager-node");
  const app = CloudBase.init({
    secretId,
    secretKey,
    token: process.env.TENCENTCLOUD_SESSION_TOKEN || undefined,
    envId: environmentId
  });
  return app.database;
}

async function checkIndexes({ database, manifest }) {
  return core.inspectDatabaseIndexes(
    manifest.indexes,
    (collectionName) => database.describeCollection(collectionName)
  );
}

async function applyIndex({
  database,
  manifest,
  collection,
  indexName,
  allowRebuild
}) {
  const spec = manifest.indexes.find((item) => (
    item.collection === collection && item.name === indexName
  ));
  if (!spec) throw new Error("INDEX_SPEC_NOT_FOUND");

  const inspected = await core.inspectDatabaseIndexes(
    [spec],
    (collectionName) => database.describeCollection(collectionName)
  );
  const current = inspected.results[0];
  if (current.status === "existing" || current.status === "equivalent") {
    return { ok: true, status: current.status, index: current };
  }
  if (current.status === "collection-missing") {
    throw new Error("COLLECTION_MISSING");
  }
  if (current.status === "check-failed") {
    throw new Error(`INDEX_CHECK_FAILED: ${current.error.message}`);
  }
  if (current.status === "mismatched" && !allowRebuild) {
    throw new Error("REBUILD_CONFIRMATION_REQUIRED");
  }

  const response = await database.updateCollection(
    spec.collection,
    core.buildCreateOptions(spec)
  );
  return {
    ok: true,
    status: current.status === "mismatched" ? "rebuilt" : "created",
    collection,
    indexName,
    requestId: String(response && (response.RequestId || response.requestId) || "")
  };
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const manifest = loadManifest(args.manifest);
  const database = createDatabase(args.environment);
  if (args.command === "check") {
    return checkIndexes({ database, manifest });
  }
  if (args.command === "apply") {
    return applyIndex({
      database,
      manifest,
      collection: args.collection,
      indexName: args.index,
      allowRebuild: Boolean(args.allowRebuild)
    });
  }
  throw new Error("INDEX_COMMAND_INVALID");
}

if (require.main === module) {
  main().then((result) => {
    process.stdout.write(JSON.stringify(result));
  }).catch((error) => {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: core.safeError(error)
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  loadManifest,
  checkIndexes,
  applyIndex,
  main
};
```

- [ ] **Step 5：安装依赖并运行适配器测试**

```powershell
npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/cloud-database-index-manager
node scripts/database-index-smoke.js
```

Expected: PASS，且创建测试只调用一次 `updateCollection`，错误索引未确认时调用次数为0。

- [ ] **Step 6：提交 Manager 适配器**

```powershell
git add -- scripts/cloud-database-index-manager/package.json scripts/cloud-database-index-manager/package-lock.json scripts/cloud-database-index-manager/index.js scripts/database-index-smoke.js
git commit -m "feat: 接入CloudBase索引管理接口"
```

## Task 4：实现逐项确认 PowerShell 入口

**Files:**

- Create: `scripts/check-cloud-database-indexes.ps1`
- Modify: `scripts/database-index-smoke.js`

- [ ] **Step 1：给 smoke test 增加入口安全约束**

在 `scripts/database-index-smoke.js` 增加：

```js
const ps1 = fs.readFileSync(
  path.join(root, "scripts", "check-cloud-database-indexes.ps1"),
  "utf8"
);
assert.ok(ps1.includes("[switch]$CheckOnly"));
assert.ok(ps1.includes("TENCENTCLOUD_SECRET_ID"));
assert.ok(ps1.includes("TENCENTCLOUD_SECRET_KEY"));
assert.ok(ps1.includes('Read-Host "Create this index? [Y/N/A/Q]"'));
assert.ok(ps1.includes('Read-Host "Type the full index name to rebuild"'));
assert.ok(ps1.includes("DATABASE_INDEX_CHECK_INCOMPLETE"));
assert.ok(!ps1.includes("DropIndexes = @("));
```

- [ ] **Step 2：运行测试，确认入口不存在**

Run:

```powershell
node scripts/database-index-smoke.js
```

Expected: FAIL，错误包含 `check-cloud-database-indexes.ps1`。

- [ ] **Step 3：创建检查和确认入口**

创建 `scripts/check-cloud-database-indexes.ps1`，实现以下完整流程：

```powershell
param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$EnvironmentId = "",
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

function Invoke-IndexManager {
  param(
    [string]$NodePath,
    [string]$ManagerPath,
    [string[]]$Arguments
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $NodePath $ManagerPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previous
  }
  $text = ($output | Out-String).Trim()
  $jsonStart = $text.IndexOf("{")
  if ($jsonStart -lt 0) {
    throw "Index manager did not return JSON: $text"
  }
  $payload = $text.Substring($jsonStart) | ConvertFrom-Json
  if ($exitCode -ne 0 -or $payload.ok -eq $false) {
    $code = if ($payload.error.code) { $payload.error.code } else { "INDEX_MANAGER_FAILED" }
    $message = if ($payload.error.message) { $payload.error.message } else { $text }
    throw "$code`: $message"
  }
  return $payload
}

function Write-IndexResult {
  param($Item)
  $color = switch ($Item.status) {
    "existing" { "Green" }
    "equivalent" { "Cyan" }
    "missing" { "Yellow" }
    "mismatched" { "Magenta" }
    default { "Red" }
  }
  Write-Host ("{0,-30} {1,-34} {2}" -f $Item.collection, $Item.name, $Item.status) -ForegroundColor $color
}

$project = [IO.Path]::GetFullPath($ProjectPath)
$configPath = Join-Path $project "config.js"
$manifestPath = Join-Path $project "scripts\database-indexes.json"
$toolRoot = Join-Path $project "scripts\cloud-database-index-manager"
$managerPath = Join-Path $toolRoot "index.js"
$packageLock = Join-Path $toolRoot "package-lock.json"

foreach ($requiredPath in @($configPath, $manifestPath, $managerPath, $packageLock)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required file not found: $requiredPath"
  }
}
if (-not $env:TENCENTCLOUD_SECRET_ID -or -not $env:TENCENTCLOUD_SECRET_KEY) {
  throw "Set TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY in the current terminal."
}

if (-not $EnvironmentId) {
  $configText = Get-Content -LiteralPath $configPath -Raw
  $match = [regex]::Match($configText, 'cloudEnvId:\s*"([^"]+)"')
  if (-not $match.Success -or -not $match.Groups[1].Value) {
    throw "cloudEnvId is missing from config.js"
  }
  $EnvironmentId = $match.Groups[1].Value
}

$node = (Get-Command "node" -ErrorAction Stop).Source
$npm = (Get-Command "npm" -ErrorAction Stop).Source
$managerModule = Join-Path $toolRoot "node_modules\@cloudbase\manager-node"
if (-not (Test-Path -LiteralPath $managerModule)) {
  & $npm ci --ignore-scripts --no-audit --no-fund --prefix $toolRoot
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed for cloud database index manager."
  }
}

$checkArguments = @(
  "check",
  "--manifest", $manifestPath,
  "--environment", $EnvironmentId
)
$report = Invoke-IndexManager -NodePath $node -ManagerPath $managerPath -Arguments $checkArguments

Write-Host "Cloud environment: $EnvironmentId"
foreach ($item in @($report.results)) {
  Write-IndexResult -Item $item
}
foreach ($item in @($report.extras)) {
  Write-Host ("{0,-30} {1,-34} extra" -f $item.collection, $item.name) -ForegroundColor DarkGray
}
Write-Host (
  "Summary: total={0}, existing={1}, equivalent={2}, missing={3}, mismatched={4}, collectionMissing={5}, failed={6}, extra={7}" -f
  $report.summary.total,
  $report.summary.existing,
  $report.summary.equivalent,
  $report.summary.missing,
  $report.summary.mismatched,
  $report.summary.collectionMissing,
  $report.summary.failed,
  $report.summary.extra
)

$reportDirectory = Join-Path $project "_tmp_database-index-reports"
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$reportPath = Join-Path $reportDirectory ("database-index-report-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "Report: $reportPath"

$incomplete = (
  [int]$report.summary.missing
  + [int]$report.summary.mismatched
  + [int]$report.summary.collectionMissing
  + [int]$report.summary.failed
)
if ($CheckOnly) {
  if ($incomplete -gt 0) {
    Write-Host "DATABASE_INDEX_CHECK_INCOMPLETE" -ForegroundColor Red
    exit 2
  }
  Write-Host "Cloud database index check passed." -ForegroundColor Green
  exit 0
}

if ([int]$report.summary.collectionMissing -gt 0) {
  throw "Collections are missing. Run scripts\init-cloud-database.ps1 first."
}
if ([int]$report.summary.failed -gt 0) {
  throw "Index inspection failed. No changes were made."
}

$applyAllMissing = $false
$quitRequested = $false
foreach ($item in @($report.results | Where-Object { $_.status -eq "missing" })) {
  $answer = if ($applyAllMissing) { "Y" } else { Read-Host "Create this index? [Y/N/A/Q]" }
  $answer = ([string]$answer).Trim().ToUpperInvariant()
  if ($answer -eq "Q") {
    $quitRequested = $true
    break
  }
  if ($answer -eq "A") {
    $applyAllMissing = $true
    $answer = "Y"
  }
  if ($answer -ne "Y") {
    Write-Host "Skipped: $($item.collection)/$($item.name)" -ForegroundColor Yellow
    continue
  }
  $applied = Invoke-IndexManager -NodePath $node -ManagerPath $managerPath -Arguments @(
    "apply",
    "--manifest", $manifestPath,
    "--environment", $EnvironmentId,
    "--collection", $item.collection,
    "--index", $item.name
  )
  Write-Host "$($applied.status): $($item.collection)/$($item.name)" -ForegroundColor Green
}

if (-not $quitRequested) {
  foreach ($item in @($report.results | Where-Object { $_.status -eq "mismatched" })) {
    Write-Host "Current definition differs from expected definition." -ForegroundColor Magenta
    Write-Host ($item.actual | ConvertTo-Json -Depth 10)
    Write-Host (@{
      name = $item.name
      keys = $item.keys
      unique = $item.unique
    } | ConvertTo-Json -Depth 10)
    $confirmation = Read-Host "Type the full index name to rebuild"
    if ($confirmation -cne $item.name) {
      Write-Host "Skipped rebuild: $($item.collection)/$($item.name)" -ForegroundColor Yellow
      continue
    }
    $applied = Invoke-IndexManager -NodePath $node -ManagerPath $managerPath -Arguments @(
      "apply",
      "--manifest", $manifestPath,
      "--environment", $EnvironmentId,
      "--collection", $item.collection,
      "--index", $item.name,
      "--allow-rebuild"
    )
    Write-Host "$($applied.status): $($item.collection)/$($item.name)" -ForegroundColor Green
  }
}

$verified = Invoke-IndexManager -NodePath $node -ManagerPath $managerPath -Arguments $checkArguments
foreach ($item in @($verified.results)) {
  Write-IndexResult -Item $item
}
$remaining = (
  [int]$verified.summary.missing
  + [int]$verified.summary.mismatched
  + [int]$verified.summary.collectionMissing
  + [int]$verified.summary.failed
)
if ($remaining -gt 0) {
  Write-Host "DATABASE_INDEX_CHECK_INCOMPLETE" -ForegroundColor Red
  exit 2
}
Write-Host "Cloud database indexes are ready." -ForegroundColor Green
```

- [ ] **Step 4：运行 PowerShell 语法检查和本地 smoke test**

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[scriptblock]::Create((Get-Content -LiteralPath '.\scripts\check-cloud-database-indexes.ps1' -Raw)) | Out-Null"
node scripts/database-index-smoke.js
```

Expected: 两条命令都成功，smoke test 输出 `database index core smoke: OK`。

- [ ] **Step 5：提交交互入口**

```powershell
git add -- scripts/check-cloud-database-indexes.ps1 scripts/database-index-smoke.js
git commit -m "feat: 增加数据库索引逐项确认工具"
```

## Task 5：接入项目检查、发布包和说明文档

**Files:**

- Modify: `scripts/validate.js`
- Modify: `scripts/package-release.py`
- Modify: `README.md`

- [ ] **Step 1：先让 validate.js 要求新增文件**

修改 `scripts/validate.js`：

1. 把 `scripts/database-indexes.json` 和 `scripts/cloud-database-index-manager/package.json` 加入 `jsonFiles`。
2. 把 `scripts/database-index-core.js`、`scripts/database-index-smoke.js` 和 `scripts/cloud-database-index-manager/index.js` 加入 `jsFiles`。
3. 把 `scripts/check-cloud-database-indexes.ps1` 加入 `powerShellFiles`。
4. 把全部新增源码和锁文件加入 `required`。
5. 读取索引清单和 PowerShell 内容，增加以下断言：

```js
const databaseIndexes = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/database-indexes.json"), "utf8")
);
const databaseIndexPs1 = fs.readFileSync(
  path.join(root, "scripts/check-cloud-database-indexes.ps1"),
  "utf8"
);
if (
  databaseIndexes.version !== 1
  || !Array.isArray(databaseIndexes.indexes)
  || databaseIndexes.indexes.length !== 11
  || !databaseIndexPs1.includes("TENCENTCLOUD_SECRET_ID")
  || !databaseIndexPs1.includes("TENCENTCLOUD_SECRET_KEY")
  || !databaseIndexPs1.includes("Create this index? [Y/N/A/Q]")
  || !databaseIndexPs1.includes("Type the full index name to rebuild")
  || !databaseIndexPs1.includes("DATABASE_INDEX_CHECK_INCOMPLETE")
) {
  throw new Error("云数据库索引检查和逐项确认工具不完整。");
}
```

- [ ] **Step 2：运行静态检查**

Run:

```powershell
node scripts/validate.js
```

Expected: PASS，末尾输出 `微信小程序工程静态检查通过。`

- [ ] **Step 3：更新发布包清单**

在 `scripts/package-release.py` 的发布说明中加入：

```python
"数据库索引：执行 scripts/check-cloud-database-indexes.ps1，先检查再逐项确认创建 11 组必需索引",
```

在 `required` 集合加入：

```python
"scripts/database-indexes.json",
"scripts/database-index-core.js",
"scripts/database-index-smoke.js",
"scripts/check-cloud-database-indexes.ps1",
"scripts/cloud-database-index-manager/package.json",
"scripts/cloud-database-index-manager/package-lock.json",
"scripts/cloud-database-index-manager/index.js",
```

保留现有规则，确保任意路径含 `node_modules` 或任意目录名以 `_tmp_` 开头时不打包。

- [ ] **Step 4：更新 README**

在 `README.md` 的“创建数据库集合”之后增加“检查数据库索引”，内容必须包含：

```powershell
$env:TENCENTCLOUD_SECRET_ID = "当前终端临时SecretId"
$env:TENCENTCLOUD_SECRET_KEY = "当前终端临时SecretKey"
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cloud-database-indexes.ps1 -CheckOnly
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cloud-database-indexes.ps1
Remove-Item Env:TENCENTCLOUD_SECRET_ID
Remove-Item Env:TENCENTCLOUD_SECRET_KEY
```

并明确：

- `-CheckOnly` 不修改云端；
- 默认回车等于跳过；
- `A` 只应用于后续缺失索引；
- 错误索引必须输入完整索引名；
- 多余索引只报告不删除；
- 报告保存在 `_tmp_database-index-reports`；
- 集合缺失时先运行 `scripts/init-cloud-database.ps1`；
- 密钥不能写进 `config.js`、`.env`、源码或发布包。

- [ ] **Step 5：运行集成检查和打包测试**

```powershell
node scripts/validate.js
python scripts/package-release.py
```

Expected:

- 静态检查通过；
- ZIP 完整性通过；
- ZIP 包含新增工具源码；
- ZIP 不包含 `scripts/cloud-database-index-manager/node_modules`；
- ZIP 不包含 `_tmp_database-index-reports`。

- [ ] **Step 6：提交集成改动**

```powershell
git add -- README.md scripts/validate.js scripts/package-release.py
git commit -m "docs: 接入数据库索引检查发布流程"
```

## Task 6：升级版本并完成全部本地测试

**Files:**

- Modify: `config.js`
- Modify: `cloudfunctions/api/package.json`
- Modify: `cloudfunctions/api/package-lock.json`
- Modify: `cloudfunctions/api/index.js`
- Modify: `scripts/auto-face-failure-stats-smoke.js`
- Modify: `scripts/auto-face-probe-history-smoke.js`
- Modify: `scripts/cloud-face-smoke.js`

- [ ] **Step 1：把功能版本升级到0.26.0**

修改：

```text
config.js appVersion: 0.25.0 -> 0.26.0
cloudfunctions/api/package.json version: 0.25.0 -> 0.26.0
cloudfunctions/api/package-lock.json 根 version: 0.25.0 -> 0.26.0
cloudfunctions/api/package-lock.json packages[""].version: 0.25.0 -> 0.26.0
```

把 `cloudfunctions/api/index.js` 的构建版本和构建标记改为：

```js
const API_BUILD_VERSION = "0.26.0";
const API_BUILD_MARKER = "API_BUILD_TAG_20260824_DATABASE_INDEX_CHECK_V260";
```

所有断言旧构建标记的 smoke test 同步为新标记。

- [ ] **Step 2：运行静态检查**

```powershell
node scripts/validate.js
```

Expected: PASS。

- [ ] **Step 3：运行全部 smoke test**

```powershell
$tests = @(Get-ChildItem -LiteralPath scripts -Filter '*-smoke.js' -File | Sort-Object Name)
$passed = 0
foreach ($test in $tests) {
  & node $test.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "测试失败: $($test.Name)"
  }
  $passed++
}
"ALL_SMOKE_TESTS_OK count=$passed"
```

Expected: 新增后总数为29，输出 `ALL_SMOKE_TESTS_OK count=29`。

- [ ] **Step 4：检查改动边界并提交版本**

```powershell
git diff --check
git status --short
git add -- config.js cloudfunctions/api/index.js cloudfunctions/api/package.json cloudfunctions/api/package-lock.json scripts/auto-face-failure-stats-smoke.js scripts/auto-face-probe-history-smoke.js scripts/cloud-face-smoke.js
git diff --cached --name-only
git commit -m "chore: 发布数据库索引检查0.26.0"
```

Expected: 暂存区只包含版本和构建标记相关文件；提交钩子成功推送 `origin/main`。

## Task 7：真实云环境检查和逐项确认验证

**Files:**

- Runtime output only: `_tmp_database-index-reports/*.json`

- [ ] **Step 1：确认凭据只存在于当前进程环境**

```powershell
"SECRET_ID_SET=$([bool]$env:TENCENTCLOUD_SECRET_ID)"
"SECRET_KEY_SET=$([bool]$env:TENCENTCLOUD_SECRET_KEY)"
"SESSION_TOKEN_SET=$([bool]$env:TENCENTCLOUD_SESSION_TOKEN)"
```

Expected: 前两项为 `True`。命令不能输出真实值。

- [ ] **Step 2：执行真实只读检查**

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cloud-database-indexes.ps1 -CheckOnly
```

Expected:

- 输出11组必需索引状态；
- 写入脱敏 JSON 报告；
- 不发生索引修改；
- 全部就绪时退出码0；
- 存在缺失或错误时退出码2。

- [ ] **Step 3：检查报告不含密钥**

```powershell
$latest = Get-ChildItem -LiteralPath .\_tmp_database-index-reports -Filter '*.json' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$reportText = Get-Content -LiteralPath $latest.FullName -Raw
if ($reportText.Contains($env:TENCENTCLOUD_SECRET_ID)) { throw "报告泄漏SecretId" }
if ($reportText.Contains($env:TENCENTCLOUD_SECRET_KEY)) { throw "报告泄漏SecretKey" }
```

Expected: 无异常。

- [ ] **Step 4：在有缺失索引时执行逐项确认**

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cloud-database-indexes.ps1
```

Expected:

- 先完整显示检查结果；
- 每个缺失索引逐项询问；
- 直接回车不会创建；
- 同名错误索引要求输入完整索引名；
- 创建后自动复查。

如果真实环境已经全部具备索引，该步骤应输出全部 `existing` 或 `equivalent`，不执行修改。

- [ ] **Step 5：清理当前终端凭据**

```powershell
Remove-Item Env:TENCENTCLOUD_SECRET_ID -ErrorAction SilentlyContinue
Remove-Item Env:TENCENTCLOUD_SECRET_KEY -ErrorAction SilentlyContinue
Remove-Item Env:TENCENTCLOUD_SESSION_TOKEN -ErrorAction SilentlyContinue
```

Expected: 三个环境变量在当前终端中均不存在。

## Task 8：使用干净提交正式打包和最终核对

**Files:**

- Output: `D:\aips小程序\wechat-miniapp-release-v0.26.0.zip`

- [ ] **Step 1：确认本地和远端一致**

```powershell
$head = git rev-parse HEAD
$origin = git rev-parse origin/main
if ($head -ne $origin) { throw "HEAD和origin/main不一致" }
git status --short --branch
```

Expected: 工作区干净，HEAD 与 `origin/main` 相同。

- [ ] **Step 2：创建隔离打包 worktree**

```powershell
$releasePath = "D:\aips小程序\_release-wechat-miniapp-v0.26.0"
if (Test-Path -LiteralPath $releasePath) { throw "发布目录已存在：$releasePath" }
git worktree add --detach -- $releasePath HEAD
```

Expected: worktree 指向最终提交。

- [ ] **Step 3：在干净目录安装测试依赖并复测**

```powershell
npm ci --ignore-scripts --no-audit --no-fund --prefix "$releasePath\cloudfunctions\api"
npm ci --ignore-scripts --no-audit --no-fund --prefix "$releasePath\scripts\cloud-database-index-manager"
node "$releasePath\scripts\validate.js"
```

然后在 `$releasePath` 中运行29个 `*-smoke.js`，期望全部通过。

- [ ] **Step 4：生成正式发布包**

```powershell
python "$releasePath\scripts\package-release.py"
```

Expected:

```text
版本：0.26.0
ZIP 完整性：通过
```

- [ ] **Step 5：核对发布包**

```powershell
$zip = "D:\aips小程序\wechat-miniapp-release-v0.26.0.zip"
$item = Get-Item -LiteralPath $zip
$hash = Get-FileHash -LiteralPath $zip -Algorithm SHA256
$item | Select-Object FullName,Length,LastWriteTime
$hash | Select-Object Algorithm,Hash,Path
```

使用 Python `zipfile` 再确认：

- `testzip()` 返回 `None`；
- 包含 `scripts/database-indexes.json`；
- 包含 `scripts/check-cloud-database-indexes.ps1`；
- 包含 Manager 工具的 `package.json`、锁文件和 `index.js`；
- 不包含任意 `node_modules`；
- 不包含 `_tmp_database-index-reports`；
- 不包含 `project.private.config.json`。

- [ ] **Step 6：安全移除临时 worktree**

删除前必须解析并核对绝对路径等于：

```text
D:\aips小程序\_release-wechat-miniapp-v0.26.0
```

确认该路径出现在 `git worktree list --porcelain` 后执行：

```powershell
git worktree remove --force -- "D:\aips小程序\_release-wechat-miniapp-v0.26.0"
```

- [ ] **Step 7：最终交付核对**

```powershell
git rev-parse HEAD
git rev-parse origin/main
git status --short --branch
```

最终交付必须写明：

- 版本 `0.25.0 -> 0.26.0`；
- 11组索引检查结果；
- 逐项确认和二次确认行为；
- 真实云端检查结果；
- 29个 smoke test 结果；
- 静态检查结果；
- ZIP 完整路径、大小和 SHA256；
- 打包是否成功；
- 是否存在未完成阻塞。

## 回滚步骤

如果本地工具需要整体回滚：

```powershell
$messages = @(
  "chore: 发布数据库索引检查0.26.0",
  "docs: 接入数据库索引检查发布流程",
  "feat: 增加数据库索引逐项确认工具",
  "feat: 接入CloudBase索引管理接口",
  "feat: 增加数据库索引比较核心",
  "test: 定义云数据库必需索引"
)
foreach ($message in $messages) {
  $commit = git log -1 --format=%H --fixed-strings --grep=$message
  if (-not $commit) { throw "找不到待回滚提交: $message" }
  git revert --no-edit $commit
  if ($LASTEXITCODE -ne 0) { throw "回滚失败: $message" }
}
node scripts/validate.js
python scripts/package-release.py
```

如果只需要停用索引管理能力，不删除代码：

1. 不再设置 `TENCENTCLOUD_SECRET_ID` 和 `TENCENTCLOUD_SECRET_KEY`；
2. 不运行 `scripts/check-cloud-database-indexes.ps1`；
3. 小程序和 `api` 云函数继续正常运行，因为运行时不依赖 Manager SDK。

已经创建的云端索引不由回滚脚本自动删除。需要删除时，只能由管理员在 CloudBase 控制台逐项核对集合、索引名和字段后手动操作。
