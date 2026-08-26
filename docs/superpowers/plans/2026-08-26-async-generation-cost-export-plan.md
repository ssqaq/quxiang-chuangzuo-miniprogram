# 异步生图与成本明细功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把普通凌云生图改成可恢复的异步任务，同时补上孤儿结果清理、管理员成本输入校验、逐次成本明细导出，并减少素材处理的串行等待。

**Architecture:** 继续使用现有 `api` 云函数和 `generation_operations` 集合。`generate` 只负责校验、预留积分和入队；定时 worker 抢占 `queued` 任务并执行现有凌云调用；小程序通过 `getGenerationStatus` 轮询。成本和价格继续由云端统一配置，管理员页面只展示和编辑云端配置。

**Tech Stack:** 微信小程序 JavaScript/WXML/WXSS、CloudBase 云函数、Node.js、`wx-server-sdk`、`xlsx`、现有 smoke/validate 脚本。

---

## 文件结构和职责

本次只改与功能直接相关的文件，不拆出新的云函数，避免部署配置和密钥环境再复制一份。

### 修改文件

- `cloudfunctions/api/index.js`
  - 增加异步任务状态、入队、worker、状态查询和回收逻辑；
  - 抽取普通生图执行核心；
  - 并行化编辑素材下载和素材归属校验；
  - 生成结果先保存 `resultFileID`，再写正式记录；
  - 扩展成本明细导出。
- `cloudfunctions/api/config.json`
  - 增加 `generation-queue-worker` 和任务回收定时触发器；
  - 保留现有照片转视频、水印和腾讯中间文件清理触发器。
- `services/cloud.js`
  - 增加提交和查询普通生图任务的客户端封装；
  - 状态轮询请求禁止调用生图重试。
- `pages/index/index.js`
  - 把 `startGenerate` 改为“准备素材后入队”；
  - 增加轮询、页面重新进入恢复、成功落库和失败提示。
- `pages/index/index.wxml`
  - 补充排队中、恢复中和状态查询中的展示文本；
  - 保留现有生成阶段清单和结果区结构。
- `pages/index/index.wxss`
  - 只在现有生成状态样式不足时补充排队/恢复状态样式，不改变页面整体布局。
- `pages/admin/admin.js`
  - 增加成本字段即时校验状态；
  - 保持价格输入与图片/视频清晰度下拉框同步；
  - 增加成本明细导出按钮调用。
- `pages/admin/admin.wxml`
  - 在成本输入框旁显示校验错误；
  - 在模型用量区域增加“成本调用明细”导出入口。
- `scripts/validate.js`
  - 把新增 smoke 脚本加入 JavaScript、WXML 和必需文件校验。

### 新增测试文件

- `scripts/generation-async-smoke.js`
  - 测试入队、状态查询、重复提交、抢占和完成结果。
- `scripts/generation-orphan-cleanup-smoke.js`
  - 测试无记录结果、卡住任务、退款幂等和删除失败重试。
- `scripts/admin-cost-validation-smoke.js`
  - 测试成本输入合法性及价格标签同步。
- `scripts/model-usage-export-detail-smoke.js`
  - 测试“成本调用明细”工作表字段和脱敏规则。

### 不修改的文件

- `C:\Users\Administrator\Desktop\熊猫image2.txt`
- 任何 `.env`、密钥配置或包含 API Key 的文件；
- `repairImage` 的用户流程；
- 图片模型、输出画质、清晰度价格和积分扣除规则。

---

## Task 1: 先建立异步状态机测试

**Files:**
- Create: `scripts/generation-async-smoke.js`
- Modify: `cloudfunctions/api/index.js:13612-13850`（仅为测试暴露内部函数）
- Modify: `scripts/validate.js:60-125`（最后一个实现任务再加入，先不让总校验因测试文件缺失失败）

- [ ] **Step 1: 写状态归一化和重复提交测试**

在 `scripts/generation-async-smoke.js` 中先写以下断言，约定后续实现必须提供这些测试接口：

```js
const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.PROMO_START_DATE = "2000-01-01";
process.env.PROMO_END_DATE = "2000-01-01";
process.env.DAILY_FREE_LIMIT = "0";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露测试接口");
assert.strictEqual(test.normalizeGenerationStatus("queued"), "queued");
assert.strictEqual(test.normalizeGenerationStatus("processing"), "processing");
assert.strictEqual(test.normalizeGenerationStatus("unknown"), "failed");

const queued = test.buildGenerationStatusResult({
  requestId: "async-smoke-request",
  kind: "image",
  status: "queued",
  pipelineStage: "queued",
  attemptCount: 0
});
assert.strictEqual(queued.taskId, "async-smoke-request");
assert.strictEqual(queued.status, "queued");
assert.strictEqual(queued.stage, "queued");
assert.strictEqual(queued.progress, 0);
assert.strictEqual(queued.result, null);
```

- [ ] **Step 2: 运行测试确认接口尚未存在**

运行：

```powershell
node scripts/generation-async-smoke.js
```

预期：失败，报错应明确指出 `normalizeGenerationStatus` 或 `buildGenerationStatusResult` 尚未导出。此失败证明测试确实锁定了新行为。

- [ ] **Step 3: 约定内部接口签名**

后续 `cloudfunctions/api/index.js` 必须实现并在 `WECHAT_MINIAPP_TEST=1` 下导出。下面列出的每个名称都是本次要新增或改造的真实函数，不允许只在 smoke 中假造接口：

```js
sanitizeGenerationPayload(payload);
normalizeGenerationStatus(value);
statusMessageForGenerationOperation(status, stage);
serializeGenerationDate(value);
buildGenerationStatusResult(operation);
enqueueGenerationOperation(openid, requestId, payload, billing, metadata);
claimNextQueuedGenerationOperation();
touchGenerationOperation(openid, requestId, stage, progress);
buildImageRequestFromOperation(operation, imageConfig);
buildImageRequestMeta(operation, imageConfig, costs);
buildGenerationRecordData(openid, operation, result, billing);
persistGenerationResult(openid, operation, result, billing);
executeImageGeneration(operation, context);
processQueuedGenerationOperation(operation);
processGenerationQueue();
reconcileGenerationOperation(operation);
reconcileGenerationOperationForTest(operation, options);
getGenerationStatus(event, context);
reconcileGenerationOperations(now);
```

返回对象不能包含 `openid`、API Key、Authorization 或完整上游响应。

- [ ] **Step 4: 提交测试基线**

在实现代码前不要提交失败测试；完成 Task 2 后再次运行并提交测试与状态机实现，提交信息使用：

```text
feat: add async generation state machine
```

---

## Task 2: 实现服务端任务状态和状态查询

**Files:**
- Modify: `cloudfunctions/api/index.js:1242-1245`
- Modify: `cloudfunctions/api/index.js:10458-10598`
- Modify: `cloudfunctions/api/index.js:13436-13568`
- Modify: `cloudfunctions/api/index.js:13612-13850`

- [ ] **Step 1: 增加任务阈值和状态常量**

在现有 `GENERATION_OPERATION_STALE_MS` 附近增加固定阈值：

```js
const GENERATION_QUEUE_BATCH_SIZE = 1;
const GENERATION_QUEUE_STALE_MS = 5 * 60 * 1000;
const GENERATION_PROCESSING_STALE_MS = 10 * 60 * 1000;
const GENERATION_MAX_RECOVERY_ATTEMPTS = 2;
const GENERATION_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const GENERATION_OPERATION_STATUSES = [
  "reserved",
  "queued",
  "processing",
  "succeeded",
  "failed",
  "refunding",
  "refunded"
];
```

不要删除已有视频状态使用的字段；新字段只扩展普通图片任务。

- [ ] **Step 2: 增加安全的任务 payload 归一化**

实现 `sanitizeGenerationPayload(payload)`，只保存生图执行需要的字段，并限制长度：

```js
function sanitizeGenerationPayload(payload = {}) {
  const list = (value, limit) => (
    Array.isArray(value)
      ? value.filter(Boolean).slice(0, limit).map((item) => String(item).slice(0, 256))
      : []
  );
  return {
    generationType: "normal",
    mode: String(payload.mode || "").trim().slice(0, 16),
    projectName: String(payload.projectName || "未命名项目").slice(0, 80),
    prompt: String(payload.prompt || "").slice(0, 8000),
    negativePrompt: String(payload.negativePrompt || "").slice(0, 4000),
    mainFileID: String(payload.mainFileID || "").trim().slice(0, 512),
    maskFileID: String(payload.maskFileID || "").trim().slice(0, 512),
    maskGeometry: payload.maskGeometry && typeof payload.maskGeometry === "object"
      ? payload.maskGeometry
      : {},
    assetRegistrationVersion: Number(payload.assetRegistrationVersion) || 0,
    faceFileIDs: list(payload.faceFileIDs, 6),
    wardrobeFileIDs: list(payload.wardrobeFileIDs, 12),
    backgroundFileIDs: list(payload.backgroundFileIDs, 3),
    size: String(payload.size || "").trim().slice(0, 32)
  };
}
```

函数中不得读取或接受 `apiKey`、`authorization`、`headers` 等字段。

- [ ] **Step 3: 增加任务状态返回结构**

先实现状态和日期辅助函数：

```js
function normalizeGenerationStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return GENERATION_OPERATION_STATUSES.includes(status) ? status : "failed";
}

function statusMessageForGenerationOperation(status, stage) {
  if (status === "queued") return "生图任务已提交，正在排队。";
  if (status === "processing") {
    if (stage === "validate") return "正在检查生图素材。";
    if (stage === "download") return "正在接收生成结果。";
    if (stage === "upload") return "正在保存生成图片。";
    if (stage === "record") return "正在保存制作记录。";
    return "AI 正在生成图片。";
  }
  if (status === "succeeded") return "图片生成完成。";
  if (status === "refunding") return "生成失败，正在退回使用额度。";
  if (status === "refunded") return "生成失败，使用额度已退回。";
  if (status === "failed") return "图片生成失败。";
  return "任务状态未知。";
}

function serializeGenerationDate(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
```

实现 `buildGenerationStatusResult(operation)`，把内部字段转换为前端需要的固定结构：

```js
function buildGenerationStatusResult(operation = {}) {
  const status = normalizeGenerationStatus(operation.status);
  const stage = String(operation.pipelineStage || status).trim() || status;
  const progress = status === "queued"
    ? 0
    : status === "processing"
      ? Math.max(5, Math.min(95, Number(operation.progress) || 10))
      : status === "succeeded"
        ? 100
        : 0;
  return {
    taskId: String(operation.requestId || ""),
    requestId: String(operation.requestId || ""),
    status,
    stage,
    progress,
    message: statusMessageForGenerationOperation(status, stage),
    result: status === "succeeded" ? (operation.result || null) : null,
    error: status === "failed" ? (operation.lastError || null) : null,
    queuedAt: serializeGenerationDate(operation.queuedAt),
    processingAt: serializeGenerationDate(operation.processingAt),
    updatedAt: serializeGenerationDate(operation.updatedAt)
  };
}
```

结果中不能返回 `payload`、`openid` 或 `ledgerId`。

- [ ] **Step 4: 把预留操作转成 queued**

增加 `enqueueGenerationOperation`，在现有 `reserveUsage` 返回后调用。相同请求编号按以下规则处理：

```js
async function enqueueGenerationOperation(openid, requestId, payload, billing, metadata = {}) {
  const existing = await findGenerationOperation(openid, requestId);
  if (existing && ["queued", "processing", "succeeded"].includes(existing.status)) {
    return existing;
  }
  return saveGenerationOperation(openid, requestId, {
    kind: "image",
    status: "queued",
    payload: sanitizeGenerationPayload(payload),
    pipelineStage: "queued",
    progress: 0,
    queuedAt: existing && existing.queuedAt ? existing.queuedAt : new Date(),
    lastHeartbeatAt: new Date(),
    billing: billing || (existing && existing.billing) || {},
    model: String(metadata.model || "").slice(0, 160),
    resolution: String(metadata.resolution || "").slice(0, 16),
    expiresAt: new Date(Date.now() + GENERATION_RESULT_TTL_MS)
  });
}
```

不要在这里再次扣积分；积分预留仍只由 `reserveUsage` 完成。

- [ ] **Step 5: 实现用户状态查询**

实现 `getGenerationStatus(event, context)`：

```js
async function getGenerationStatus(event, context) {
  const openid = getOpenId(context);
  const requestId = String(
    event.requestId || event.taskId || (event.payload && event.payload.requestId) || ""
  ).trim();
  if (!requestId) return fail("缺少任务编号。", "missing-generation-task");
  const operation = await findGenerationOperation(openid, requestId);
  if (!operation) return fail("没有找到这个生图任务。", "generation-task-not-found");
  return jsonResponse(true, Object.assign(
    buildGenerationStatusResult(operation),
    { billing: operation.billing || null }
  ));
}
```

查询只读当前用户的 operation，不调用凌云、不扣费、不执行前端重试。

- [ ] **Step 6: 接入 main 和测试导出**

在 `exports.main` 的 action 分支中增加：

```js
else if (action === "getGenerationStatus") {
  result = await getGenerationStatus(requestEvent, context);
}
```

在 `exports.__test` 中导出 Task 1 约定的函数，然后运行：

```powershell
node scripts/generation-async-smoke.js
```

预期：状态归一化和固定返回结构测试通过。

- [ ] **Step 7: 提交服务端状态机**

确认 `git diff --check` 通过后提交：

```powershell
git add -- cloudfunctions/api/index.js scripts/generation-async-smoke.js
git commit -m "feat: add async generation state machine"
```

---

## Task 3: 抽取普通生图 worker，并优化素材处理速度

**Files:**
- Modify: `cloudfunctions/api/index.js:8491-8546`
- Modify: `cloudfunctions/api/index.js:11779-12005`
- Modify: `cloudfunctions/api/index.js:4212-4289`
- Modify: `cloudfunctions/api/index.js:10458-10598`

- [ ] **Step 1: 并行下载编辑素材**

把 `requestImageEdits` 当前主图、mask 顺序下载改成一次 `Promise.all`：

```js
const [mainBuffer, rawMaskBuffer, referenceBuffers] = await Promise.all([
  downloadCloudFile(payload.mainFileID, {
    requestId,
    action: "generate",
    fileType: "main"
  }),
  downloadCloudFile(payload.maskFileID, {
    requestId,
    action: "generate",
    fileType: "mask"
  }),
  Promise.all(references.map(async (reference) => ({
    reference,
    buffer: await downloadCloudFile(reference.fileID, {
      requestId,
      action: "generate",
      fileType: reference.role
    })
  })))
]);
const maskBuffer = invertMask(rawMaskBuffer, requestId);
```

保持每类素材原有数量上限和错误码。

- [ ] **Step 2: 并行校验所有素材归属**

将 `validateGenerationAssets` 改为先拼出所有校验任务，再统一等待：

```js
const checks = [];
if (mainFileID) checks.push(findUserAsset(openid, mainFileID, "main"));
if (maskFileID) checks.push(findUserAsset(openid, maskFileID, "mask"));
checks.push(...faceFileIDs.map((fileID) => findUserAsset(openid, fileID, "face")));
checks.push(...wardrobeFileIDs.map((fileID) => findUserAsset(openid, fileID, "wardrobe")));
checks.push(...backgroundFileIDs.map((fileID) => findUserAsset(openid, fileID, "background")));
await Promise.all(checks);
```

空数组不创建无效 Promise，原有 `assetRegistrationVersion < 1` 快速返回保持不变。

- [ ] **Step 3: 抽取 `executeImageGeneration`**

把 `generate` 中从 claim 后到写记录前的上游处理抽成内部函数，签名固定为：

```js
async function executeImageGeneration(operation, context = {}) {
  const payload = operation.payload || {};
  const requestId = operation.requestId;
  const imageConfig = context.imageConfig || resolveImageConfig();
  const costs = context.costs || resolveCostConfig();
  const apiKey = imageConfig.apiKey;
  const mode = resolveGenerationMode(payload, imageConfig);
  if (!apiKey) {
    const error = new Error("云函数还没有配置图片服务密钥。");
    error.code = "missing-api-key";
    throw error;
  }
  await touchGenerationOperation(
    operation.openid,
    requestId,
    "validate",
    5
  );
  const imageRequest = buildImageRequestFromOperation(operation, imageConfig);
  const upstream = mode === "edits"
    ? await requestImageEdits(
        Object.assign({}, payload, { __action: "generate" }),
        apiKey,
        requestId,
        imageConfig,
        costs,
        usageUserHash(operation.openid)
      )
    : await requestJson(
        imageConfig.endpoint || endpoint(imageConfig.baseUrl, "images/generations"),
        imageRequest,
        apiKey,
        { "Idempotency-Key": requestId },
        buildImageRequestMeta(operation, imageConfig, costs)
      );
  await touchGenerationOperation(operation.openid, requestId, "download", 70);
  const image = extractImageItem(upstream);
  if (!image) {
    const error = new Error("图片接口没有返回图片。");
    error.code = "empty-image-result";
    throw error;
  }
  const buffer = image.buffer || await downloadUrl(image.url, {
    requestId,
    action: "generate-result"
  });
  await touchGenerationOperation(operation.openid, requestId, "upload", 85);
  const uploaded = await cloud.uploadFile({
    cloudPath: `results/${operation.openid}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${imageExtension(image.mime)}`,
    fileContent: buffer
  });
  if (!uploaded || !uploaded.fileID) {
    const error = new Error("生成图片上传失败。");
    error.code = "result-upload-failed";
    throw error;
  }
  await updateGenerationOperation(operation.openid, requestId, {
    pipelineStage: "upload",
    progress: 90,
    resultFileID: uploaded.fileID,
    lastHeartbeatAt: new Date()
  }, { allowedStatuses: ["processing"] });
  const tempResult = await cloud.getTempFileURL({ fileList: [uploaded.fileID] });
  const tempFileURL = tempResult.fileList
    && tempResult.fileList[0]
    && tempResult.fileList[0].tempFileURL
    || "";
  return {
    fileID: uploaded.fileID,
    tempFileURL,
    createdAt: new Date().toISOString(),
    model: imageConfig.model,
    size: imageRequest.size,
    resolution: imageConfig.resolution || normalizeImageResolution(imageRequest.size, "1K"),
    upstream
  };
}
```

先新增 `buildImageRequestFromOperation`、`buildImageRequestMeta`、`buildGenerationRecordData` 三个明确的适配函数：它们分别复用现有 `buildImageGenerationPayload`、`resolveGenerationMode`、旧记录字段和成本元数据，不重新定义请求格式。`touchGenerationOperation` 只更新任务心跳和阶段。所有函数只能从服务端配置取得 API Key；调用 `requestJson`、`requestImageEdits` 时继续传入原 `requestId` 作为幂等键。`executeImageGeneration` 的内部结果可以带上游响应供后续取字段，但不得把完整 `upstream` 写入 operation、记录、导出或返回前端。

- [ ] **Step 4: 先保存结果文件编号**

上传成功后立即调用：

```js
await updateGenerationOperation(openid, requestId, {
  pipelineStage: "upload",
  progress: 90,
  resultFileID: uploaded.fileID,
  lastHeartbeatAt: new Date()
}, { allowedStatuses: ["processing"] });
```

后续获取临时地址或写 `generation_records` 失败时，回收逻辑可以根据 `resultFileID` 补救，不得直接丢弃该文件。

- [ ] **Step 5: 抽取统一记录函数**

实现 `persistGenerationResult(openid, operation, result, billing)`，先查 `generation_records` 是否已有相同 `requestId`，没有才写入：

```js
async function persistGenerationResult(openid, operation, result, billing) {
  const existing = await findGenerationRecord(openid, operation.requestId);
  if (existing) return existing;
  const recordData = buildGenerationRecordData(
    openid,
    operation,
    result,
    billing
  );
  const saved = await db.collection("generation_records").add({
    data: recordData
  });
  return Object.assign({}, result, {
    recordId: saved._id,
    record: Object.assign({}, recordData, { id: saved._id })
  });
}
```

实际实现中先构造一次 `recordData`，不要调用构造函数两次产生不同时间；`prompt`、`fileID` 和 repairContext 沿用旧字段。

- [ ] **Step 6: 实现 worker 处理单个任务**

实现 `processQueuedGenerationOperation(operation)`：

```js
async function processQueuedGenerationOperation(operation) {
  const openid = operation.openid;
  const requestId = operation.requestId;
  let resultFileID = "";
  try {
    await updateGenerationOperation(openid, requestId, {
      status: "processing",
      pipelineStage: "validate",
      progress: 5,
      processingAt: new Date(),
      lastHeartbeatAt: new Date(),
      attemptCount: (Number(operation.attemptCount) || 0) + 1
    }, { allowedStatuses: ["queued", "processing"] });
    const configs = await resolveEffectiveConfigs();
    const result = await executeImageGeneration(operation, {
      imageConfig: configs.image,
      costs: configs.costs
    });
    resultFileID = result.fileID || "";
    const saved = await persistGenerationResult(
      openid,
      operation,
      result,
      operation.billing || {}
    );
    await completeGenerationOperation(openid, requestId, Object.assign(
      {},
      result,
      saved,
      { status: "succeeded" }
    ));
    return { ok: true, requestId, recordId: saved.recordId, fileID: saved.fileID };
  } catch (error) {
    await failGenerationOperation(openid, requestId, error);
    await refundUsage(openid, requestId, "生图失败，已退回本次使用额度");
    return { ok: false, requestId, error: error && error.message };
  }
}
```

正式代码不能使用对象展开覆盖掉 `recordId`/`fileID`；按现有 Node 运行时语法和字段优先级写成显式 `Object.assign`，并确保 `failGenerationOperation` 或退款失败时把 `cleanupPending` 保存下来。

- [ ] **Step 7: 把 `generate` 改成入队入口**

保留现有提示词、模式、素材校验、API Key 配置检查和 `findGenerationRecord` 幂等判断；将同步上游部分替换为：

```js
const billing = await reserveUsage(openid, requestId, "image");
const operation = await enqueueGenerationOperation(
  openid,
  requestId,
  payload,
  billing,
  { model, resolution }
);
return jsonResponse(true, Object.assign(
  buildGenerationStatusResult(operation),
  {
    ok: true,
    taskId: requestId,
    message: "生图任务已提交",
    billing
  }
));
```

如果 operation 已经 `succeeded` 且有结果，继续直接返回原结果；如果是 `queued`/`processing`，直接返回状态，不再次调用 `claimGenerationOperation`。

- [ ] **Step 8: 运行现有和新增测试**

运行：

```powershell
node scripts/generation-concurrency-smoke.js
node scripts/generation-experience-smoke.js
node scripts/generation-async-smoke.js
node scripts/model-cost-stats-smoke.js
```

预期：并发预留/退款、成本统计和异步状态测试全部通过；`generation-experience-smoke.js` 若仍假设同步返回，需要在 Task 5 一起更新。

- [ ] **Step 9: 提交 worker 核心**

```powershell
git add -- cloudfunctions/api/index.js scripts/generation-async-smoke.js
git commit -m "feat: process image generation asynchronously"
```

---

## Task 4: 增加定时 worker 和孤儿任务回收

**Files:**
- Modify: `cloudfunctions/api/config.json`
- Modify: `cloudfunctions/api/index.js:3321-3338`
- Modify: `cloudfunctions/api/index.js:13436-13568`
- Create: `scripts/generation-orphan-cleanup-smoke.js`

- [ ] **Step 1: 精确区分定时触发器**

把 `isPhotoToVideoCleanupTrigger` 从“所有 `Timer` 都算旧清理”改成只识别已有名称和旧兼容 action：

```js
function isPhotoToVideoCleanupTrigger(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  return (
    source.triggerName === "photo-to-video-temp-cleanup"
    || source.triggerName === "photo-to-video-idle-cleanup"
    || source.action === "cleanupPhotoToVideoTempAssets"
  );
}
```

新增：

```js
function isGenerationQueueWorkerTrigger(event = {}) {
  return event && (
    event.triggerName === "generation-queue-worker"
    || event.action === "processGenerationQueue"
  );
}

function isGenerationReconcileTrigger(event = {}) {
  return event && (
    event.triggerName === "generation-operation-reconcile"
    || event.action === "reconcileGenerationOperations"
  );
}
```

保留手工 action 入口，方便 smoke 和线上排查。

- [ ] **Step 2: 增加 worker 触发配置**

在 `cloudfunctions/api/config.json` 的 `triggers` 中增加：

```json
{
  "name": "generation-queue-worker",
  "type": "timer",
  "config": "0 */1 * * * * *"
},
{
  "name": "generation-operation-reconcile",
  "type": "timer",
  "config": "30 */5 * * * * *"
}
```

worker 每次只处理一个任务，避免 59 秒上游调用叠加超过云函数时限；回收任务每 5 分钟运行一次。

- [ ] **Step 3: 实现原子领取 queued 任务**

实现 `claimNextQueuedGenerationOperation()`：先按 `queuedAt` 升序读取有限任务，再用事务确认状态仍为 `queued`，成功后写 `processing`、`processingAt`、`lastHeartbeatAt` 和尝试次数；抢不到则返回 `null`。测试导出名称也固定为 `claimNextQueuedGenerationOperation`，不再使用另一个近似名称。

测试接口固定为：

```js
const claimed = await test.claimNextQueuedGenerationOperation();
assert.ok(claimed === null || claimed.status === "processing");
```

不能用“先查询后无条件更新”，否则两个 timer 并发时会重复调用凌云。

- [ ] **Step 4: 实现队列处理 action**

实现：

```js
async function processGenerationQueue() {
  const operation = await claimNextQueuedGenerationOperation();
  if (!operation) return jsonResponse(true, { processed: 0, message: "暂无排队任务。" });
  const result = await processQueuedGenerationOperation(operation);
  return jsonResponse(true, { processed: 1, result });
}
```

在 `exports.main` 中把 worker 分支放在通用清理分支之前：

```js
if (isGenerationQueueWorkerTrigger(requestEvent)) {
  result = await processGenerationQueue();
} else if (isGenerationReconcileTrigger(requestEvent)) {
  result = await reconcileGenerationOperations(new Date());
} else if (isPhotoToVideoCleanupTrigger(requestEvent)) {
  // 原有清理逻辑
}
```

- [ ] **Step 5: 实现孤儿结果补记录**

实现 `reconcileGenerationOperation(operation)`，顺序必须是：

```js
if (operation.resultFileID && !operation.recordId) {
  const result = await rebuildResultFromOperation(operation);
  const saved = await persistGenerationResult(
    operation.openid,
    operation,
    result,
    operation.billing || {}
  );
  await completeGenerationOperation(
    operation.openid,
    operation.requestId,
    Object.assign({}, result, {
      recordId: saved.recordId,
      pipelineStage: "succeeded"
    })
  );
  return { repaired: true, recordId: saved.recordId };
}
```

若临时地址失效，先用 `cloud.getTempFileURL` 重新获取；若文件不存在，按失败任务处理并退款。

- [ ] **Step 6: 实现卡住任务和清理重试**

规则固定为：

- `queued` 超过 `GENERATION_QUEUE_STALE_MS`：失败并退款；
- `processing` 超过 `GENERATION_PROCESSING_STALE_MS` 且没有近期心跳：优先恢复；超过 `GENERATION_MAX_RECOVERY_ATTEMPTS`：失败并退款；
- 有 `resultFileID` 的任务先补记录，不直接退款；
- 删除文件失败：保存 `cleanupPending: true`、`cleanupLastError` 和下次重试时间；
- 退款调用继续使用现有 `refundUsage`，不新增第二套积分流水。

实现 `reconcileGenerationOperations(now)` 返回：

```js
{
  ok: true,
  scanned: 0,
  repaired: 0,
  failed: 0,
  refunded: 0,
  cleanupPending: 0
}
```

- [ ] **Step 7: 写孤儿清理 smoke**

`scripts/generation-orphan-cleanup-smoke.js` 至少覆盖：

```js
(async () => {
  const orphan = {
    requestId: "orphan-result",
    openid: "orphan-user",
    kind: "image",
    status: "processing",
    resultFileID: "cloud://result/orphan.png",
    recordId: "",
    billing: { source: "points", pointsCharged: 10 }
  };
  const repaired = await test.reconcileGenerationOperationForTest(orphan, {
    simulateRecordWrite: true
  });
  assert.ok(repaired && repaired.repaired);

  const stale = test.buildGenerationStatusResult({
    requestId: "stale-task",
    status: "failed",
    pipelineStage: "failed",
    lastError: { code: "generation-stale", message: "任务超时" }
  });
  assert.strictEqual(stale.status, "failed");
  assert.strictEqual(stale.error.code, "generation-stale");

  const cleanupRetry = await test.reconcileGenerationOperationForTest(
    Object.assign({}, orphan, { requestId: "cleanup-retry", recordId: "record-missing" }),
    { simulateCleanupFailure: true }
  );
  assert.strictEqual(cleanupRetry.cleanupPending, true);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

测试环境必须用显式测试参数模拟记录写入和云文件删除失败，并确认返回 `cleanupPending`；不能真的删除用户文件，也不能调用真实上游服务。

- [ ] **Step 8: 运行测试并提交**

```powershell
node scripts/generation-orphan-cleanup-smoke.js
node scripts/generation-concurrency-smoke.js
node scripts/photo-to-video-cleanup-smoke.js
```

预期：新旧定时分流均通过，旧照片转视频清理行为不变。

```powershell
git add -- cloudfunctions/api/index.js cloudfunctions/api/config.json scripts/generation-orphan-cleanup-smoke.js
git commit -m "feat: reconcile orphan generation results"
```

---

## Task 5: 接入小程序提交、轮询和页面恢复

**Files:**
- Modify: `services/cloud.js:1-180, 350-520`
- Modify: `pages/index/index.js:52-60, 590-601, 765-840, 2527-2730`
- Modify: `pages/index/index.wxml` 生成等待区
- Modify: `pages/index/index.wxss` 生成等待状态区
- Modify: `scripts/generation-experience-smoke.js`

- [ ] **Step 1: 增加客户端 API 封装**

在 `services/cloud.js` 的导出对象中增加：

```js
submitGeneration(payload, options = {}) {
  return callApi({
    action: "generate",
    payload,
    requestId: options.requestId || "",
    retryLimit: 0
  });
},
getGenerationStatus(requestId, options = {}) {
  return callApi({
    action: "getGenerationStatus",
    requestId: String(requestId || ""),
    retryLimit: 0,
    silent: Boolean(options.silent)
  });
},
```

将 `generateImage` 保留为兼容别名，但内部调用 `submitGeneration`；普通提交不得默认使用原来针对长请求的两次重试。

- [ ] **Step 2: 增加页面任务字段和轮询常量**

在 `pages/index/index.js` 增加：

```js
const GENERATION_POLL_INITIAL_MS = 2000;
const GENERATION_POLL_MAX_MS = 6000;
const GENERATION_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const GENERATION_PENDING_STORAGE_KEY = "pendingGenerationTask";
```

页面 data 增加：

```js
generationTaskId: "",
generationTaskStatus: "idle",
generationTaskStage: "",
generationTaskProgress: 0,
generationTaskMessage: "",
generationSubmitting: false,
```

计时器和轮询 timer 分开管理；`onUnload` 同时清理二者，但不删除本地未完成任务。

- [ ] **Step 3: 保存和恢复最小任务信息**

实现：

```js
savePendingGenerationTask(task) {
  const value = task && task.requestId
    ? {
        requestId: String(task.requestId),
        taskId: String(task.taskId || task.requestId),
        submittedAt: Number(task.submittedAt) || Date.now()
      }
    : null;
  if (value) wx.setStorageSync(GENERATION_PENDING_STORAGE_KEY, value);
  else wx.removeStorageSync(GENERATION_PENDING_STORAGE_KEY);
},
```

页面 `onShow` 或初始化完成后读取该字段，只恢复同一个 `requestId` 的状态，不重新准备素材、不重新提交新任务。

- [ ] **Step 4: 把 startGenerate 拆成准备和提交**

保留现有 `validateStep`、`refreshPromptDraft`、`prepareCloudAssets` 和素材硬闸门。将调用部分替换成：

```js
const result = await cloud.submitGeneration(
  {
    generationType: "normal",
    mode: generationMode,
    projectName: project.projectName,
    prompt: submittedPrompt,
    negativePrompt: project.negativePrompt,
    mainFileID,
    maskFileID,
    maskGeometry: project.maskCircle || {},
    assetRegistrationVersion: 1,
    faceFileIDs: project.faceRefs.map((item) => item.fileID).filter(Boolean),
    wardrobeFileIDs: project.wardrobeRefs.map((item) => item.fileID).filter(Boolean),
    backgroundFileIDs: project.backgroundRefs.map((item) => item.fileID).filter(Boolean),
    size: "1024x1024"
  },
  { requestId }
);
this.savePendingGenerationTask({
  requestId,
  taskId: result.taskId || requestId,
  submittedAt: Date.now()
});
this.setGenerationTaskState(result);
this.startGenerationPolling(requestId);
wx.showToast({ title: "任务已提交", icon: "success" });
```

提交成功后不等待图片、不执行 `finally` 清空任务状态；只有成功或最终失败才清理本地任务。

- [ ] **Step 5: 实现轮询和状态映射**

实现 `startGenerationPolling(requestId)`，规则：

- 首次立即查询一次；
- 后续 2 秒、4 秒、6 秒间隔循环；
- 页面隐藏时暂停，回到页面时立即查询；
- 查询失败只记录日志并继续，不能重新调用 `submitGeneration`；
- 超过 15 分钟显示“任务仍在后台处理”，保留任务编号。

状态映射：

```js
const stageMap = {
  queued: ["generate", "已提交，正在排队..."],
  validate: ["upload", "正在检查素材..."],
  upstream: ["generate", "AI 正在生成图片..."],
  download: ["generate", "正在接收生成结果..."],
  upload: ["save", "正在保存图片..."],
  record: ["save", "正在保存制作记录..."],
  succeeded: ["save", "生成完成"],
  failed: ["timeout", "生成失败"]
};
```

- [ ] **Step 6: 成功后复用现有记录展示逻辑**

把现在 `startGenerate` 中从 `result.record` 开始的逻辑抽成 `applyGenerationResult(result, project)`：

```js
applyGenerationResult(result, project) {
  const record = decorateRecordForRepair(
    Object.assign({}, result.record || {}, {
      id: result.recordId || `local-${Date.now()}`,
      fileID: result.fileID || "",
      tempFileURL: result.tempFileURL || "",
      generationType: "normal"
    }),
    this.data.cloudReady
  );
  const records = [record].concat(this.data.records || []).slice(0, 50);
  const nextProject = Object.assign({}, project, {
    results: [record].concat(project.results || []).slice(0, 20)
  });
  this.setData({
    project: nextProject,
    records,
    generatedResults: nextProject.results,
    step: 4
  });
  storage.saveProject(nextProject);
  storage.saveRecords(records);
}
```

成功状态只执行一次；轮询再次看到 `succeeded` 时直接停止。

- [ ] **Step 7: 更新 WXML/WXSS 和体验 smoke**

在现有生成等待区增加任务编号和排队文字，不能删除现有 `generation-checklist`、`generationElapsedSeconds` 和结果区：

```xml
<view wx:if="{{generationTaskId}}" class="generation-task-meta">
  <text>{{generationTaskMessage}}</text>
  <text wx:if="{{generationTaskStatus === 'queued'}}">任务已提交，后台会自动生成</text>
</view>
```

更新 `scripts/generation-experience-smoke.js`：

```js
assert.ok(cloudFunction.includes('action === "getGenerationStatus"'));
assert.ok(indexJs.includes("startGenerationPolling"));
assert.ok(indexJs.includes("savePendingGenerationTask"));
assert.ok(indexJs.includes("任务已提交"));
assert.ok(indexWxml.includes("generationTaskMessage"));
```

- [ ] **Step 8: 运行客户端测试并提交**

```powershell
node scripts/generation-experience-smoke.js
node scripts/image-smoke.js
node scripts/image-edit-routing-smoke.js
node scripts/workbench-interaction-smoke.js
```

```powershell
git add -- services/cloud.js pages/index/index.js pages/index/index.wxml pages/index/index.wxss scripts/generation-experience-smoke.js
git commit -m "feat: poll async image generation tasks"
```

---

## Task 6: 管理员成本输入校验和成本明细导出

**Files:**
- Modify: `cloudfunctions/api/index.js:5970-6122, 7349-7587`
- Modify: `pages/admin/admin.js:46-134, 2680-2720, 3804-3878`
- Modify: `pages/admin/admin.wxml:727-748, 1055-1065`
- Create: `scripts/admin-cost-validation-smoke.js`
- Create: `scripts/model-usage-export-detail-smoke.js`

- [ ] **Step 1: 增加服务端成本输入校验**

新增统一函数：

```js
function validateCostNumber(value, field) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return `${field} 不能为空`;
  }
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text)) {
    return `${field} 必须是非负数字，最多 4 位小数`;
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 100000) {
    return `${field} 必须在 0～100000 之间`;
  }
  return "";
}
```

在 `validateRuntimePatch` 中对以下字段逐个调用：

```js
[
  ["costs.image.perImage.1K", imageCosts.perImage && imageCosts.perImage["1K"]],
  ["costs.image.perImage.2K", imageCosts.perImage && imageCosts.perImage["2K"]],
  ["costs.image.perImage.4K", imageCosts.perImage && imageCosts.perImage["4K"]],
  ["costs.video.perSecond.480p", videoCosts.perSecond && videoCosts.perSecond["480p"]],
  ["costs.video.perSecond.720p", videoCosts.perSecond && videoCosts.perSecond["720p"]],
  ["costs.video.perSecond.1080p", videoCosts.perSecond && videoCosts.perSecond["1080p"]]
].forEach(([field, value]) => {
  const error = validateCostNumber(value, field);
  if (error) errors.push(error);
});
```

保留现有最大值、币种和清晰度范围校验，不增加“必须递增”限制。

- [ ] **Step 2: 增加前端即时校验状态**

在 `pages/admin/admin.js` 增加：

```js
function validateAdminCostInput(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return "不能为空";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text)) return "最多 4 位小数";
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 100000) {
    return "请输入 0～100000";
  }
  return "";
}
```

在 `data` 增加 `costFieldErrors: {}`；`onInput` 处理成本字段时同时更新：

```js
const error = validateAdminCostInput(event.detail.value);
patch[`costFieldErrors.${key}`] = error;
Object.assign(patch, buildQualityPickerState(nextForm, {
  image: profiles.image && profiles.image[currentImageModel] || {},
  video: profiles.video && profiles.video[currentVideoModel] || {}
}));
```

价格标签仍由 `buildAdminImageQualityOptions` 和 `buildAdminVideoQualityOptions` 生成，不能复制第二套价格表。

- [ ] **Step 3: 在 WXML 显示输入错误**

每个成本输入框下方使用统一数据键显示：

```xml
<view wx:if="{{costFieldErrors.image1K}}" class="admin-field-error">
  {{costFieldErrors.image1K}}
</view>
```

图片和视频六个清晰度价格字段都要显示，默认没有错误时不占明显空间。

- [ ] **Step 4: 构造逐次成本明细行**

在云函数中实现 `buildModelUsageDetailRows(events)`，固定列顺序：

```js
const header = [
  "日期", "时间", "脱敏用户编号", "请求编号", "功能",
  "Provider", "模型", "图片清晰度", "视频清晰度",
  "单价", "数量/时长", "成本", "成本来源",
  "HTTP状态", "是否成功", "耗时毫秒", "成本配置版本"
];
```

每个事件只读取已有标准化字段；用户编号经过 `safeExportText`，请求编号截断到 80 字符；不读取 `prompt`、`headers` 或原始响应。

- [ ] **Step 5: 给现有工作簿加“成本调用明细”**

在 `buildModelUsageExportWorkbook(stats)` 中追加：

```js
const detailRows = buildModelUsageDetailRows(
  Array.isArray(stats.details) ? stats.details : []
);
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.aoa_to_sheet(detailRows),
  "成本调用明细"
);
```

如果 `getModelUsageStats` 当前只返回聚合结果，则同时让它在管理员请求的统计范围内保留标准化事件数组 `details`；响应中不返回 OpenID 或原始内容。

- [ ] **Step 6: 增加导出 smoke**

`scripts/admin-cost-validation-smoke.js`：

```js
assert.strictEqual(test.validateCostNumber("0.0600", "x"), "");
assert.ok(test.validateCostNumber("", "x"));
assert.ok(test.validateCostNumber("-0.1", "x"));
assert.ok(test.validateCostNumber("0.12345", "x"));
assert.ok(test.validateCostNumber("abc", "x"));
```

`scripts/model-usage-export-detail-smoke.js`：

```js
const rows = test.buildModelUsageDetailRows([{
  dateKey: "2026-08-26",
  createdAt: "2026-08-26T12:00:00.000Z",
  userHash: "user-hash",
  requestId: "detail-request",
  usageType: "image",
  provider: "lingyun",
  model: "gpt-image-2",
  imageResolution: "1K",
  unitPrice: 0.06,
  estimatedCost: 0.06,
  billingSource: "estimated",
  status: 200,
  success: true,
  durationMs: 59000,
  costConfigVersion: "2026-08-26-v2"
}]);
assert.strictEqual(rows[0][0], "日期");
assert.ok(rows[0].includes("请求编号"));
assert.ok(rows[1].includes("gpt-image-2"));
assert.ok(!JSON.stringify(rows).includes("apiKey"));
assert.ok(!JSON.stringify(rows).includes("authorization"));
```

- [ ] **Step 7: 接入管理员导出入口**

保留现有 `exportModelUsage` 按钮和下载流程，只把按钮文案改成“导出成本明细 Excel”，不新增第二个上传接口。导出结果仍由管理员权限保护、下载后用 `wx.openDocument` 打开。

- [ ] **Step 8: 运行管理员测试并提交**

```powershell
node scripts/admin-cost-validation-smoke.js
node scripts/model-usage-export-detail-smoke.js
node scripts/admin-config-smoke.js
node scripts/admin-usage-entry-smoke.js
node scripts/model-cost-stats-smoke.js
```

```powershell
git add -- cloudfunctions/api/index.js pages/admin/admin.js pages/admin/admin.wxml scripts/admin-cost-validation-smoke.js scripts/model-usage-export-detail-smoke.js
git commit -m "feat: validate and export model costs"
```

---

## Task 7: 把新增 smoke 纳入总校验并做完整本地验证

**Files:**
- Modify: `scripts/validate.js:60-125,230-305`
- Modify: `docs/superpowers/specs/2026-08-26-async-generation-cost-export-design.md`（只在实现结果与设计有必要偏差时补记录）

- [ ] **Step 1: 加入必需文件和脚本列表**

把以下文件加入 `validate.js` 对应列表：

```js
"scripts/generation-async-smoke.js",
"scripts/generation-orphan-cleanup-smoke.js",
"scripts/admin-cost-validation-smoke.js",
"scripts/model-usage-export-detail-smoke.js",
```

同时增加静态条件，确认：

```js
cloudFunction.includes('action === "getGenerationStatus"');
cloudFunction.includes("processGenerationQueue");
cloudFunction.includes("reconcileGenerationOperations");
clientCloudJs.includes('action: "getGenerationStatus"');
indexJs.includes("startGenerationPolling");
adminJs.includes("validateAdminCostInput");
```

- [ ] **Step 2: 运行全部专项 smoke**

```powershell
node scripts/generation-async-smoke.js
node scripts/generation-orphan-cleanup-smoke.js
node scripts/admin-cost-validation-smoke.js
node scripts/model-usage-export-detail-smoke.js
node scripts/generation-concurrency-smoke.js
node scripts/generation-experience-smoke.js
node scripts/model-cost-stats-smoke.js
node scripts/admin-config-smoke.js
```

预期：全部输出 `OK`，没有未处理 Promise 或敏感字段断言失败。

- [ ] **Step 3: 运行完整校验**

```powershell
node scripts/validate.js
```

预期：退出码为 0；如果旧静态断言与异步文案冲突，优先更新断言以匹配本计划明确的固定接口，不删掉原有功能检查。

- [ ] **Step 4: 检查密钥和未授权文件**

只检查文件名和代码中是否出现不应出现的密钥字段，不读取用户密钥文件内容：

```powershell
git diff --check
git status --short
git diff --name-only
```

预期：修改文件只在本计划文件清单内；`熊猫image2.txt` 不在 diff 中。

- [ ] **Step 5: 提交校验脚本**

```powershell
git add -- scripts/validate.js
git commit -m "test: cover async generation and cost export"
```

---

## Task 8: 版本升级、正式打包、同步和线上验证

**Files:**
- Version group handled by `scripts/sync-to-github.ps1`:
  - `config.js`
  - `cloudfunctions/api/index.js`
  - `cloudfunctions/api/package.json`
  - `cloudfunctions/api/package-lock.json`
  - `media-worker/package.json`
  - `media-worker/package-lock.json`
- Deploy: `cloudfunctions/api`

- [ ] **Step 1: 确认实现完成且工作区只有本任务修改**

运行：

```powershell
git status --short --branch
git diff --name-only origin/main...HEAD
```

发现其他并行修改时停止发布，不覆盖、不重置，先记录文件名。

- [ ] **Step 2: 运行发布前检查**

```powershell
node scripts/validate.js
node scripts/release-safety-smoke.js
node scripts/deployment-script-smoke.js
```

预期：全部通过，且 `main` 没有暂存文件。

- [ ] **Step 3: 使用受控同步脚本升级到 0.42.8 并正式打包**

回到项目主分支后，只显式同步本次文件：

```powershell
& .\scripts\sync-to-github.ps1 -IncludePath @(
  "cloudfunctions/api/index.js",
  "cloudfunctions/api/config.json",
  "services/cloud.js",
  "pages/index/index.js",
  "pages/index/index.wxml",
  "pages/index/index.wxss",
  "pages/admin/admin.js",
  "pages/admin/admin.wxml",
  "scripts/validate.js",
  "scripts/generation-async-smoke.js",
  "scripts/generation-orphan-cleanup-smoke.js",
  "scripts/admin-cost-validation-smoke.js",
  "scripts/model-usage-export-detail-smoke.js",
  "docs/superpowers/specs/2026-08-26-async-generation-cost-export-design.md",
  "docs/superpowers/plans/2026-08-26-async-generation-cost-export-plan.md"
)
```

脚本会按项目规则把版本从 `0.42.7` 升到 `0.42.8`，生成：

```text
D:\aips小程序\wechat-miniapp-release-v0.42.8.zip
```

预期：包存在、大小大于 0、清单中的 commit/tree/source SHA 与最终提交一致，`HEAD` 与 `origin/main` 一致。

- [ ] **Step 4: 部署 api 云函数**

使用项目现有部署脚本和已配置环境，不在命令行参数中写入 API Key：

```powershell
& .\scripts\deploy-and-verify-api.ps1
```

预期：部署版本标记为 `0.42.8`，云函数能返回 `checkDeployment` 成功，触发器列表包含两个生图任务触发器。

- [ ] **Step 5: 做线上异步生图验证**

使用测试账号和现有真实配置提交一张 1K 图片，记录以下结果：

1. `generate` 在短时间内返回 `status=queued`；
2. `getGenerationStatus` 依次看到 `queued`/`processing`；
3. worker 只产生一条正式生图调用和一条成本事件；
4. 最终状态为 `succeeded`，有 `fileID`、临时地址和 `recordId`；
5. 小程序重新进入后能恢复任务；
6. 管理员导出的 Excel 包含“成本调用明细”；
7. 任务失败时积分只退款一次。

不要把真实 API Key、Authorization、原始 OpenID 或完整提示词写进日志、提交信息或报告。

- [ ] **Step 6: 核对发布状态并暂停 heartbeat**

最终检查：

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

任务成功后暂停当前 `panda` heartbeat；如果部署失败，保留精确错误和未完成步骤，不声称已完成。

---

## 实施顺序和提交点

按以下顺序执行，不能跳过失败测试或发布前检查：

1. Task 1：状态机测试；
2. Task 2：服务端状态和查询；
3. Task 3：worker 核心和速度优化；
4. Task 4：定时触发器和孤儿回收；
5. Task 5：小程序轮询和恢复；
6. Task 6：管理员价格校验和成本导出；
7. Task 7：总校验；
8. Task 8：版本、打包、同步、部署和线上验证。

每个 Task 完成后先运行对应 smoke，再提交；任何失败都先修复，不带着红灯进入下一 Task。

## 计划自检

- **设计覆盖：** 异步提交、轮询恢复、幂等扣费、孤儿补记录、卡住退款、并行素材处理、价格校验、成本明细导出、测试、版本和部署均有对应任务。
- **占位符检查：** 未保留待实现标记；每个代码步骤都给出了固定接口、字段或命令。
- **接口一致性：** 所有任务统一使用 `requestId` 作为前端任务编号，状态查询 action 为 `getGenerationStatus`，worker action 为 `processGenerationQueue`，回收 action 为 `reconcileGenerationOperations`。
- **范围检查：** 不新增云函数、不迁移模型、不改价格；普通 `generate` 与管理员成本链路在一次发布中完成，`repairImage` 明确不纳入本期异步迁移。
