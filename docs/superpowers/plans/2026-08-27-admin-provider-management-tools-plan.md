# Admin Provider Management Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员能够在现有后台维护服务商中文名称、按服务商筛选模型配置与探测结果，并在保存时由前后端共同阻止缺少中文名称的自定义服务商配置。

**Architecture:** 在现有管理员运行时配置顶层增加 `providerLabels` 映射，不新增集合；云函数负责清洗、合并和最终校验，管理员页面负责编辑、动态筛选和保存前提示。模型执行仍使用英文服务商标识，中文名称只用于管理员页面展示。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、CloudBase 云函数、Node.js smoke tests、PowerShell 发布脚本。

---

## 文件结构

- Modify: `cloudfunctions/api/index.js` — 服务商名称默认值、清洗、校验、配置合并、返回和保存。
- Modify: `pages/admin/admin.js` — 动态名称映射、编辑行、筛选状态、保存前检查和英文反查。
- Modify: `pages/admin/admin.wxml` — 服务商名称入口、编辑器、筛选控件和筛选后的探测结果。
- Modify: `pages/admin/admin.wxss` — 名称编辑行、错误态、筛选按钮和移动端布局。
- Create: `scripts/admin-provider-management-smoke.js` — 前端三项功能的行为测试。
- Create: `scripts/admin-provider-label-config-smoke.js` — 云函数名称配置的清洗、合并和校验测试。
- Modify: `scripts/validate.js` — 把两个新 smoke test 纳入语法和必需文件检查。
- Modify: `scripts/admin-config-layout-smoke.js` — 固定检查新入口、编辑器和筛选控件存在。
- Modify: `scripts/admin-loading-smoke.js` — 覆盖读取旧配置、中文显示和英文传参兼容。
- Modify: `config.js`、`cloudfunctions/api/index.js`、`cloudfunctions/api/package.json`、`cloudfunctions/api/package-lock.json`、`media-worker/package.json`、`media-worker/package-lock.json`、`cloudfunctions/watermark-gateway/package.json` — 统一升级功能版本。

### Task 1: 云函数服务商名称配置测试

**Files:**
- Create: `scripts/admin-provider-label-config-smoke.js`
- Modify: `cloudfunctions/api/index.js`

- [ ] **Step 1: 编写失败测试**

测试通过 `api.__test` 调用以下接口：

```js
const {
  normalizeAdminProviderLabels,
  mergeAdminProviderLabels,
  validateAdminProviderLabels,
  configuredAdminProviderIds
} = api.__test;

assert.deepStrictEqual(
  normalizeAdminProviderLabels({}, { includeDefaults: true }),
  {
    dashscope: "阿里云百炼",
    lingyun: "凌云",
    xingju: "星炬"
  }
);

assert.deepStrictEqual(
  mergeAdminProviderLabels(
    { lingyun: "凌云" },
    { lingyun: "凌云官方", custom: "自定义服务商" }
  ),
  { lingyun: "凌云官方", custom: "自定义服务商" }
);

assert.ok(
  validateAdminProviderLabels(
    { xingju: "星炬", custom: "custom" },
    { image: { provider: "custom" } }
  ).some((item) => item.includes("custom") && item.includes("中文名称"))
);
```

同时断言危险键名、超过 120 字符的标识、超过 20 字符的名称和非对象输入会被拒绝。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node scripts/admin-provider-label-config-smoke.js`

Expected: FAIL，提示上述测试导出函数不存在。

- [ ] **Step 3: 在云函数增加最小实现**

在 `cloudfunctions/api/index.js` 增加：

```js
const DEFAULT_ADMIN_PROVIDER_LABELS = Object.freeze({
  dashscope: "阿里云百炼",
  lingyun: "凌云",
  xingju: "星炬"
});
const FORBIDDEN_ADMIN_PROVIDER_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor"
]);

function normalizeAdminProviderLabels(input, options = {}) {
  const output = Object.create(null);
  if (options.includeDefaults) {
    Object.keys(DEFAULT_ADMIN_PROVIDER_LABELS).forEach((key) => {
      output[key] = DEFAULT_ADMIN_PROVIDER_LABELS[key];
    });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Object.assign({}, output);
  }
  Object.getOwnPropertyNames(input).forEach((rawKey) => {
    const key = String(rawKey || "").trim().toLowerCase();
    const label = String(input[rawKey] || "").trim();
    if (
      !key
      || key.length > 120
      || FORBIDDEN_ADMIN_PROVIDER_KEYS.has(key)
      || !label
      || label.length > 20
    ) return;
    output[key] = label;
  });
  return Object.assign({}, output);
}

function mergeAdminProviderLabels(current, patch) {
  return Object.assign(
    {},
    normalizeAdminProviderLabels(current),
    normalizeAdminProviderLabels(patch)
  );
}

function configuredAdminProviderIds(config) {
  const source = config && typeof config === "object" ? config : {};
  return Array.from(new Set(
    ["face", "analysis", "image", "imageBackup", "video"]
      .map((section) => String(source[section] && source[section].provider || "")
        .trim()
        .toLowerCase())
      .filter(Boolean)
  )).sort();
}

function validateAdminProviderLabels(labels, config) {
  const errors = [];
  if (labels !== undefined && (
    !labels
    || typeof labels !== "object"
    || Array.isArray(labels)
  )) {
    errors.push("providerLabels 必须是对象");
    return errors;
  }
  const raw = labels && typeof labels === "object" ? labels : {};
  Object.getOwnPropertyNames(raw).forEach((rawKey) => {
    const key = String(rawKey || "").trim().toLowerCase();
    const label = String(raw[rawKey] || "").trim();
    if (!key || key.length > 120 || FORBIDDEN_ADMIN_PROVIDER_KEYS.has(key)) {
      errors.push(`服务商标识 ${rawKey || "未填写"} 不合法`);
    } else if (!label || label.length > 20 || !/[\u3400-\u9fff]/.test(label)) {
      errors.push(`服务商 ${key} 还没有合格的中文名称`);
    }
  });
  const normalized = normalizeAdminProviderLabels(raw, { includeDefaults: true });
  configuredAdminProviderIds(config).forEach((providerId) => {
    const label = normalized[providerId];
    if (!label || !/[\u3400-\u9fff]/.test(label)) {
      errors.push(`服务商 ${providerId} 还没有中文名称，请先填写`);
    }
  });
  return Array.from(new Set(errors));
}
```

把四个函数加入 `exports.__test`。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node scripts/admin-provider-label-config-smoke.js`

Expected: `admin provider label config smoke tests passed`。

- [ ] **Step 5: 提交云函数基础能力**

```powershell
git add -- cloudfunctions/api/index.js scripts/admin-provider-label-config-smoke.js
git commit -m "feat: 增加服务商中文名称配置校验"
```

### Task 2: 接入管理员运行时配置

**Files:**
- Modify: `cloudfunctions/api/index.js`
- Modify: `scripts/admin-runtime-compat-smoke.js`
- Modify: `scripts/admin-config-audit-smoke.js`

- [ ] **Step 1: 扩充失败测试**

覆盖以下行为：

```js
const patch = normalizeRuntimePatch({
  providerLabels: { lingyun: "凌云官方", custom: "自定义服务商" }
});
assert.strictEqual(patch.providerLabels.lingyun, "凌云官方");

const merged = mergeRuntimeConfig(
  { providerLabels: { xingju: "星炬", lingyun: "凌云" } },
  { providerLabels: { lingyun: "凌云官方" } }
);
assert.deepStrictEqual(merged.providerLabels, {
  xingju: "星炬",
  lingyun: "凌云官方"
});
```

审计测试断言 `providerLabels.lingyun` 的变化被记录，但审计 JSON 不包含测试 API Key。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node scripts/admin-runtime-compat-smoke.js && node scripts/admin-config-audit-smoke.js`

Expected: FAIL，提示 `providerLabels` 没有进入配置或审计。

- [ ] **Step 3: 接入配置全链路**

修改：

```js
normalizeRuntimePatch(input)
mergeRuntimeConfig(current, patch)
redactConfig(config, defaults)
resolveEffectiveConfigs(options)
adminConfigView(configs, runtime, metadata)
saveAdminConfig(event, context)
```

`saveAdminConfig` 在合并旧配置后执行最终检查：

```js
const providerLabelErrors = validateAdminProviderLabels(
  next.providerLabels,
  next
);
if (providerLabelErrors.length) {
  return fail(
    providerLabelErrors.join("；"),
    "ADMIN_PROVIDER_LABEL_REQUIRED",
    { fields: providerLabelErrors }
  );
}
```

- [ ] **Step 4: 运行配置与审计测试**

Run: `node scripts/admin-runtime-compat-smoke.js && node scripts/admin-config-audit-smoke.js && node scripts/admin-provider-label-config-smoke.js`

Expected: 全部 PASS。

- [ ] **Step 5: 提交配置集成**

```powershell
git add -- cloudfunctions/api/index.js scripts/admin-runtime-compat-smoke.js scripts/admin-config-audit-smoke.js
git commit -m "feat: 保存管理员服务商中文名称"
```

### Task 3: 管理员页面名称映射和保存前检查

**Files:**
- Create: `scripts/admin-provider-management-smoke.js`
- Modify: `pages/admin/admin.js`
- Modify: `scripts/admin-loading-smoke.js`

- [ ] **Step 1: 编写失败测试**

构造旧配置和自定义服务商配置，断言：

```js
assert.strictEqual(page.data.form.image.provider, "星炬");
assert.strictEqual(page.data.form.video.provider, "凌云");
assert.deepStrictEqual(
  page.data.providerLabelRows.map((item) => item.providerId),
  ["dashscope", "lingyun", "xingju"]
);

page.onInput({
  currentTarget: { dataset: { section: "video", key: "provider" } },
  detail: { value: "custom-provider" }
});
assert.ok(page.data.providerLabelRows.some((item) => (
  item.providerId === "custom-provider" && !item.label
)));

await page.saveConfig();
assert.strictEqual(saveCalls, 0);
assert.strictEqual(page.data.activeConfigSection, "providers");
```

填写“自定义服务商”后再次保存，断言发送到云函数的是：

```js
{
  providerLabels: { "custom-provider": "自定义服务商" },
  video: { provider: "custom-provider" }
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node scripts/admin-provider-management-smoke.js`

Expected: FAIL，提示页面没有名称编辑和保存前检查状态。

- [ ] **Step 3: 增加页面状态与纯函数**

在 `pages/admin/admin.js` 增加：

```js
function mergeAdminProviderLabels(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return Object.assign({}, ADMIN_PROVIDER_LABELS, source);
}

function providerIdFromDisplay(value, labels) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  const map = mergeAdminProviderLabels(labels);
  if (map[lower]) return lower;
  const matched = Object.keys(map).find((key) => map[key] === raw);
  return matched || raw;
}

function adminProviderIdsFromForm(form, labels) {
  const source = form && typeof form === "object" ? form : {};
  return Array.from(new Set(
    ADMIN_PROVIDER_FORM_SECTIONS
      .map((section) => providerIdFromDisplay(
        source[section] && source[section].provider,
        labels
      ))
      .filter(Boolean)
  ));
}

function buildAdminProviderLabelRows(form, labels) {
  const map = mergeAdminProviderLabels(labels);
  const ids = Array.from(new Set(
    Object.keys(map).concat(adminProviderIdsFromForm(form, map))
  )).sort();
  return ids.map((providerId) => ({
    providerId,
    label: String(map[providerId] || ""),
    missing: !String(map[providerId] || "").trim()
  }));
}

function validateAdminProviderLabelRows(rows, form) {
  const source = Array.isArray(rows) ? rows : [];
  const labels = source.reduce((output, row) => Object.assign(output, {
    [row.providerId]: String(row.label || "").trim()
  }), {});
  const errors = {};
  adminProviderIdsFromForm(form, labels).forEach((providerId) => {
    const label = labels[providerId];
    if (!label || label.length > 20 || !/[\u3400-\u9fff]/.test(label)) {
      errors[providerId] = `服务商 ${providerId} 还没有中文名称，请先填写`;
    }
  });
  return errors;
}

function buildAdminProviderFilterState(form, labels, selected = "all") {
  const map = mergeAdminProviderLabels(labels);
  const sectionProviders = {};
  ADMIN_PROVIDER_FORM_SECTIONS.forEach((section) => {
    sectionProviders[section] = providerIdFromDisplay(
      form && form[section] && form[section].provider,
      map
    );
  });
  const ids = Array.from(new Set(Object.values(sectionProviders).filter(Boolean))).sort();
  const value = selected === "all" || ids.includes(selected) ? selected : "all";
  const options = [{ value: "all", label: "全部" }].concat(ids.map((providerId) => ({
    value: providerId,
    label: map[providerId] || providerId
  })));
  const visibility = {};
  Object.keys(sectionProviders).forEach((section) => {
    visibility[section] = value === "all" || sectionProviders[section] === value;
  });
  return { options, value, visibility };
}
```

页面 `data` 增加：

```js
providerLabelRows: [],
providerLabelErrors: {},
providerFilterOptions: [{ value: "all", label: "全部" }],
providerFilterValue: "all",
providerFilterIndex: 0,
providerSectionVisibility: {
  face: true,
  analysis: true,
  image: true,
  video: true
}
```

- [ ] **Step 4: 接入读取、输入和保存**

- `formFromConfig` 读取 `effective.providerLabels`；
- `formToConfig` 返回 `providerLabels`，其余服务商字段反查为英文标识；
- `onInput` 发现新服务商后补充名称编辑行和筛选项；
- 新增 `onProviderLabelInput`；
- `saveConfig` 在调用 `cloud.saveAdminConfig` 前验证并打开 `providers` 编辑区；
- 保存成功后用云函数返回值重建名称行、显示值和筛选状态。

- [ ] **Step 5: 运行页面测试**

Run: `node scripts/admin-provider-management-smoke.js && node scripts/admin-loading-smoke.js && node scripts/admin-config-smoke.js`

Expected: 全部 PASS，英文传参断言保持通过。

- [ ] **Step 6: 提交页面逻辑**

```powershell
git add -- pages/admin/admin.js scripts/admin-provider-management-smoke.js scripts/admin-loading-smoke.js
git commit -m "feat: 增加服务商名称编辑和保存检查"
```

### Task 4: 服务商筛选与中文名称编辑界面

**Files:**
- Modify: `pages/admin/admin.wxml`
- Modify: `pages/admin/admin.wxss`
- Modify: `pages/admin/admin.js`
- Modify: `scripts/admin-config-layout-smoke.js`

- [ ] **Step 1: 编写布局失败测试**

断言 WXML/WXSS 包含：

```js
assert.ok(wxml.includes('data-section="providers"'));
assert.ok(wxml.includes('bindchange="onProviderFilterChange"'));
assert.ok(wxml.includes('wx:for="{{providerLabelRows}}"'));
assert.ok(wxml.includes('modelProbes.filteredResults'));
assert.ok(wxss.includes('.provider-filter-bar'));
assert.ok(wxss.includes('.provider-label-row'));
assert.ok(wxss.includes('.provider-label-error'));
```

- [ ] **Step 2: 运行布局测试并确认失败**

Run: `node scripts/admin-config-layout-smoke.js`

Expected: FAIL，提示新入口或样式不存在。

- [ ] **Step 3: 增加筛选控件和名称编辑器**

- 模型入口上方增加服务商筛选 picker；
- “服务商名称”入口始终显示；
- 五套模型入口使用 `providerSectionVisibility`；
- `providers` 编辑器循环显示只读英文标识、中文名称输入框和错误文字；
- 模型探测循环改用 `modelProbes.filteredResults`；
- 空筛选结果显示“当前服务商没有模型配置”。

- [ ] **Step 4: 实现筛选事件**

新增：

```js
onProviderFilterChange(event) {
  const index = Math.max(0, Number(event.detail.value) || 0);
  const option = this.data.providerFilterOptions[index]
    || this.data.providerFilterOptions[0];
  this.applyProviderFilter(option.value, index);
}
```

如果当前编辑区不匹配新筛选，关闭当前编辑区；筛选只改页面状态，不改 `form`。

- [ ] **Step 5: 运行页面与布局测试**

Run: `node scripts/admin-provider-management-smoke.js && node scripts/admin-config-layout-smoke.js && node scripts/admin-responsive-smoke.js`

Expected: 全部 PASS。

- [ ] **Step 6: 提交界面**

```powershell
git add -- pages/admin/admin.js pages/admin/admin.wxml pages/admin/admin.wxss scripts/admin-config-layout-smoke.js
git commit -m "feat: 增加模型服务商筛选界面"
```

### Task 5: 总验证与验证脚本登记

**Files:**
- Modify: `scripts/validate.js`

- [ ] **Step 1: 把新测试加入验证清单**

在 `jsFiles` 和 `required` 中加入：

```js
"scripts/admin-provider-management-smoke.js",
"scripts/admin-provider-label-config-smoke.js"
```

- [ ] **Step 2: 运行专项测试**

Run:

```powershell
node scripts/admin-provider-label-config-smoke.js
node scripts/admin-provider-management-smoke.js
node scripts/admin-loading-smoke.js
node scripts/admin-config-layout-smoke.js
node scripts/admin-config-smoke.js
node scripts/admin-config-audit-smoke.js
```

Expected: 全部 PASS。

- [ ] **Step 3: 运行总验证**

Run:

```powershell
node scripts/validate.js
git diff --check
```

Expected: 所有 JSON、JavaScript、Python、PowerShell 检查通过，`git diff --check` 无输出。

- [ ] **Step 4: 提交验证登记**

```powershell
git add -- scripts/validate.js
git commit -m "test: 登记服务商管理专项检查"
```

### Task 6: 版本、同步、打包、二维码和部署

**Files:**
- Modify: `config.js`
- Modify: `cloudfunctions/api/index.js`
- Modify: `cloudfunctions/api/package.json`
- Modify: `cloudfunctions/api/package-lock.json`
- Modify: `media-worker/package.json`
- Modify: `media-worker/package-lock.json`
- Modify: `cloudfunctions/watermark-gateway/package.json`

- [ ] **Step 1: 运行受控版本升级与发布同步**

使用项目现有 `scripts/sync-to-github.ps1`，只传入本任务明确修改的文件。功能版本从 `0.48.3` 升级到下一个未被并行任务占用的次版本；脚本负责重新获取远端、合并本任务提交、统一版本号、运行验证、打包和推送。

Expected: 本地发布仓库 `HEAD` 与 `origin/main` 一致，生成非空正式 ZIP 和发布记录。

- [ ] **Step 2: 核对正式发布包**

检查：

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
Get-FileHash D:\aips小程序\wechat-miniapp-release-v<版本>.zip -Algorithm SHA256
```

ZIP 清单必须写入正式提交 SHA 和 tree SHA，不得出现“未提交”。

- [ ] **Step 3: 部署并核对 API 云函数**

Run:

```powershell
.\scripts\deploy-and-verify-api.ps1
```

Expected: 线上 `buildVersion` 和 `buildMarker` 与最终发布提交一致。若本机没有有效腾讯云身份，明确报告未部署及唯一剩余操作，不伪造成功。

- [ ] **Step 4: 生成预览二维码**

使用项目现有预览脚本生成同版本二维码；生成后不得再次覆盖正式 ZIP。核对二维码文件非空并目测可识别。

- [ ] **Step 5: 最终交付核对**

报告：版本变化、最终提交 SHA、tree SHA、正式 ZIP 完整路径和 SHA256、发布记录、二维码路径、API 云函数真实部署状态以及三个功能的测试结果。
