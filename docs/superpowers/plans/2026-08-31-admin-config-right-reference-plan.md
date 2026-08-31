# 功能配置页右图还原 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `pages/admin-config` 的三种折叠状态与 `pages/admin-provider` 完整还原为用户最后四张右侧 `390 x 844` 参考图，同时保留正式 `0.57.82` 的真实配置与保存逻辑。

**Architecture:** 页面继续使用现有 `admin-config.js` 作为唯一数据和保存入口，只重排 WXML 展示边界、折叠状态和页面级 WXSS。静态 smoke 锁定结构与视觉标记，运行时 smoke 锁定真实统计、主备保存和三个默认折叠状态，统一发布闸门负责版本与不可变 ZIP。

**Tech Stack:** 微信小程序 WXML/WXSS/CommonJS、Node.js `assert` smoke tests、PowerShell release gate、微信开发者工具 CLI。

**Spec:** `docs/superpowers/specs/2026-08-31-admin-config-right-reference-design.md`

## Global Constraints

- 右侧 `390 x 844` 参考图是唯一视觉标准。
- 使用 `rpx` 自适应 `320px` 到 `430px` 手机宽度，不得横向裁切或文字重叠。
- 字体优先 `PingFang SC`，禁止全页 `Microsoft YaHei` 和 `font-weight:600` 覆盖。
- `configuredCount`、`totalCount`、`backupCount` 必须继续读取真实配置，禁止硬编码 `4 / 4` 或 `3 个已启用`。
- 供应商、模型、凭据、主备保存、超时、重试、清晰度和宽高比行为保持不变。
- 主模型、备用模型和高级参数首次进入与切换功能后都必须折叠；主模型展开后使用总览下方的独立白色实线卡。
- 两页都使用无返回箭头的自定义导航；供应商页编辑态隐藏不可变供应商 ID，并保留八条可见目录。

## File Map

- `pages/admin-config/admin-config.json`: 自定义导航开关。
- `pages/admin-config/admin-config.wxml`: 三类入口、总览内主模型、故障与高级参数合卡。
- `pages/admin-config/admin-config.js`: 分组待配置摘要和三个折叠状态。
- `pages/admin-config/admin-config.wxss`: 右图视觉、状态栏安全区和窄屏约束。
- `scripts/admin-v2-pages-smoke.js`: WXML/JSON 静态结构契约。
- `scripts/admin-v2-pages-runtime-smoke.js`: 页面数据、折叠状态和保存行为契约。
- `scripts/admin-v2-layout-smoke.js`: 视觉标记与窄屏样式契约。
- `scripts/validate.js`: 完整工程测试入口，登记新增 layout smoke。

---

### Task 1: 自定义导航与右图页面骨架

**Files:**
- Modify: `pages/admin-config/admin-config.json`
- Modify: `pages/admin-config/admin-config.wxml`
- Test: `scripts/admin-v2-pages-smoke.js`

**Interfaces:**
- Consumes: `groups: Group[]`、`selectedGroupIndex: number`、`selectedTabIndex: number`、`selectedTab: Tab`。
- Produces: `.standard-group`、`.tencent-group`、`.shared-group`、`.summary-actions`、`.main-model-card`、`.advanced-section` 结构类名供 WXSS 和静态测试使用。

- [ ] **Step 1: 写入失败的静态结构断言**

```js
const configJson = JSON.parse(read("admin-config", "json"));
assert.strictEqual(configJson.navigationStyle, "custom");
assert.ok(configWxml.includes('class="group-row standard-group"'));
assert.ok(configWxml.includes('class="group-row tencent-group"'));
assert.ok(configWxml.includes('class="group-row shared-group"'));
assert.ok(!configWxml.includes('class="tab-icon"'));
assert.ok(!configWxml.includes('class="tab-status'));
assert.ok(configWxml.indexOf('class="summary-card"') < configWxml.indexOf('class="main-model-card"'));
assert.ok(configWxml.indexOf('class="main-model-card"') < configWxml.indexOf('class="failure-card"'));
assert.ok(configWxml.indexOf('class="advanced-section"') > configWxml.indexOf('class="failure-card"'));
```

- [ ] **Step 2: 运行测试并确认旧版失败**

Run: `node scripts/admin-v2-pages-smoke.js`

Expected: FAIL，提示缺少 `navigationStyle: custom` 或右图结构类名。

- [ ] **Step 3: 实现自定义导航和三类入口**

`admin-config.json` 使用：

```json
{
  "navigationBarTitleText": "功能配置",
  "navigationStyle": "custom",
  "enablePullDownRefresh": true
}
```

WXML 将通用入口循环拆为三个语义区块；普通版和腾讯版标签只输出名称，共享视频使用左右布局：

```xml
<view class="group-row standard-group">
  <view class="group-row-top"><text class="group-title">{{groups[0].label}}</text><text class="group-note">{{groups[0].note}}</text></view>
  <view class="tab-grid"><view wx:for="{{groups[0].tabs}}" wx:key="slot" wx:for-item="tab" wx:for-index="tabIndex" class="tab {{selectedGroupIndex === 0 && selectedTabIndex === tabIndex ? 'active' : ''}}" data-group-index="0" data-tab-index="{{tabIndex}}" bindtap="selectTab"><text class="tab-label">{{tab.label}}</text></view></view>
</view>
<view class="group-row shared-group">
  <view class="shared-row"><view class="shared-copy"><text class="group-title">{{groups[2].label}}</text><text class="group-note">{{groups[2].note}}</text></view><view class="shared-tab" data-group-index="2" data-tab-index="0" bindtap="selectTab">{{groups[2].tabs[0].label}}</view></view>
</view>
```

- [ ] **Step 4: 把主模型与高级参数移动到正确卡片**

总览标题右侧必须同时提供真实状态和展开按钮；展开后的 picker/字段位于总览与故障切换之间的独立白色实线卡：

```xml
<view class="summary-actions"><text class="summary-status {{selectedTab.ready ? '' : 'pending'}}">{{selectedTab.ready ? '主模型正常' : '待配置'}}</text><view class="summary-toggle" bindtap="toggleMain">{{mainExpanded ? '收回' : '展开'}}</view></view>
<view wx:if="{{mainExpanded}}" class="main-model-card">
  <view class="two-fields"><view class="field center"><text class="field-label">供应商</text><picker mode="selector" range="{{selectedTab.providerOptions}}" range-key="name" value="{{selectedTab.providerIndex}}" bindchange="onMainProviderChange"><view class="picker-value">{{selectedTab.provider || '请选择供应商'}} <text>⌄</text></view></picker></view><view class="field center"><text class="field-label">模型</text><picker mode="selector" range="{{selectedTab.modelOptions}}" value="{{selectedTab.modelIndex}}" bindchange="onMainModelChange"><view class="picker-value">{{selectedTab.model || '请选择模型'}} <text>⌄</text></view></picker></view></view>
  <view class="field wrap-field"><text class="field-label">API 端点</text><text class="field-value">{{selectedTab.endpoint}}</text></view>
  <view class="field key-field"><text class="field-label">API Key</text><text class="field-value">{{selectedTab.keyText}}</text></view>
  <view class="model-state">已从供应商模型库选用</view>
</view>
```

`advanced-section` 必须放在 `failure-card` 结束标签之前，继续绑定 `toggleAdvanced` 和原高级参数字段。

- [ ] **Step 5: 运行静态与运行时测试**

Run: `node scripts/admin-v2-pages-smoke.js`

Expected: PASS，输出 `admin-v2-pages-smoke: PASS`。

Run: `node scripts/admin-v2-pages-runtime-smoke.js`

Expected: PASS，原主备保存和真实数据断言不回退。

- [ ] **Step 6: 提交结构修改**

```bash
git add pages/admin-config/admin-config.json pages/admin-config/admin-config.wxml scripts/admin-v2-pages-smoke.js
git commit -m "feat: match admin config reference structure"
```

### Task 2: 真实分组摘要与默认折叠

**Files:**
- Modify: `pages/admin-config/admin-config.js`
- Test: `scripts/admin-v2-pages-runtime-smoke.js`

**Interfaces:**
- Consumes: `makeTab()` 返回的 `{ ready, pendingText, backupEnabled }`。
- Produces: `Group.pendingCount: number`、`Group.pendingText: string`，以及 `mainExpanded`、`backupExpanded`、`advancedExpanded` 三个布尔状态。

- [ ] **Step 1: 写入失败的折叠状态测试**

```js
assert.strictEqual(configPage.data.mainExpanded, false);
assert.strictEqual(configPage.data.backupExpanded, false);
assert.strictEqual(configPage.data.advancedExpanded, false);
configPage.toggleMain();
configPage.toggleBackup();
configPage.toggleAdvanced();
configPage.selectTab({ currentTarget: { dataset: { groupIndex: 2, tabIndex: 0 } } });
assert.strictEqual(configPage.data.mainExpanded, false);
assert.strictEqual(configPage.data.backupExpanded, false);
assert.strictEqual(configPage.data.advancedExpanded, false);
```

- [ ] **Step 2: 运行测试并确认旧版失败**

Run: `node scripts/admin-v2-pages-runtime-smoke.js`

Expected: FAIL，旧版 `mainExpanded` 或 `backupExpanded` 为 `true`。

- [ ] **Step 3: 实现折叠状态和真实待配置摘要**

```js
function pendingSummary(tabs) {
  const pendingTabs = (tabs || []).filter(tab => !tab.ready);
  return {
    pendingCount: pendingTabs.length,
    pendingText: pendingTabs.length === 1
      ? pendingTabs[0].pendingText
      : (pendingTabs.length > 1 ? `${pendingTabs.length} 项待配置` : "")
  };
}
```

`Page.data`、`loadConfig()` 的最终 `setData()` 和 `selectTab()` 都写入：

```js
mainExpanded: false,
backupExpanded: false,
advancedExpanded: false
```

编辑主模型后重新构建当前 `Group.pendingCount` 与 `Group.pendingText`，不要修改 `summaryForGroup()` 的真实计数算法。

- [ ] **Step 4: 运行运行时测试**

Run: `node scripts/admin-v2-pages-runtime-smoke.js`

Expected: PASS，折叠、CAS 主备保存、真实统计和凭据读取全部通过。

- [ ] **Step 5: 提交状态修改**

```bash
git add pages/admin-config/admin-config.js scripts/admin-v2-pages-runtime-smoke.js
git commit -m "fix: default admin model panels to collapsed"
```

### Task 3: 右图视觉与窄屏安全区

**Files:**
- Modify: `pages/admin-config/admin-config.wxss`
- Create: `scripts/admin-v2-layout-smoke.js`
- Modify: `scripts/validate.js`

**Interfaces:**
- Consumes: Task 1 输出的结构类名。
- Produces: 390px 基准视觉，并为 `320px` 到 `430px` 视口提供无横向溢出的布局。

- [ ] **Step 1: 写入失败的视觉标记测试**

```js
requireMarker(config, 'font-family:"PingFang SC"');
requireMarker(config, "padding-top:env(safe-area-inset-top)");
requireMarker(config, ".summary-actions");
requireMarker(config, ".shared-row");
requireMarker(config, "grid-template-columns:repeat(4,minmax(0,1fr))");
requireMarker(config, "height:68rpx");
requireMarker(config, "white-space:nowrap");
requireMarker(config, "overflow-x:hidden");
assert.ok(!config.includes(".tab-icon"));
assert.ok(!config.includes(".tab-status"));
```

- [ ] **Step 2: 运行视觉测试并确认失败**

Run: `node scripts/admin-v2-layout-smoke.js`

Expected: FAIL，旧 WXSS 缺少 PingFang、安全区和右图结构样式。

- [ ] **Step 3: 实现页面和导航基线**

```css
page{background:#f4f8fe;color:#10294b;font-family:"PingFang SC","Helvetica Neue",Arial,sans-serif;overflow-x:hidden;}
.config-page{min-height:100vh;width:100%;overflow-x:hidden;background:#f4f8fe;}
.appbar{height:calc(104rpx + env(safe-area-inset-top));padding:env(safe-area-inset-top) 28rpx 20rpx;display:flex;align-items:flex-end;box-sizing:border-box;background:#fff;border-bottom:1rpx solid #d9e4f2;}
.config-scroll{width:100%;height:calc(100vh - 104rpx - env(safe-area-inset-top));padding:24rpx 28rpx calc(48rpx + env(safe-area-inset-bottom));box-sizing:border-box;overflow-x:hidden;}
```

- [ ] **Step 4: 实现右图紧凑入口、总览和故障卡**

```css
.tab-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8rpx;padding:8rpx;border-radius:16rpx;background:#edf5ff;}
.tab{height:68rpx;min-width:0;display:flex;align-items:center;justify-content:center;border-radius:12rpx;overflow:hidden;white-space:nowrap;}
.tab.active{background:#2f73ee;color:#fff;box-shadow:0 6rpx 14rpx rgba(47,115,238,.18);}
.shared-row,.summary-top,.summary-actions,.failure-head,.advanced-head{display:flex;align-items:center;justify-content:space-between;min-width:0;}
.summary-stats{display:grid;grid-template-columns:1fr 1fr;gap:14rpx;}
.summary-toggle{padding:6rpx 12rpx;border:1rpx solid #8db9f7;border-radius:10rpx;color:#2f73ee;}
.advanced-section{margin-top:16rpx;padding-top:16rpx;border-top:1rpx solid #e2ebf6;}
```

所有标题、说明、统计和按钮使用 spec 规定的三级字号，`.field`、`.accordion-head`、`.save-btn` 设置稳定高度与 `box-sizing:border-box`；长端点使用 `overflow-wrap:anywhere`。

- [ ] **Step 5: 把视觉 smoke 登记到完整验证**

在 `scripts/validate.js` 的 smoke 列表中加入：

```js
runNodeScript("admin-v2-layout-smoke.js");
```

调用位置与其他 `admin-v2-*` smoke 相邻，失败必须让 `validate.js` 非零退出。

- [ ] **Step 6: 运行视觉和静态测试**

Run: `node scripts/admin-v2-layout-smoke.js`

Expected: PASS，输出 `admin-v2-layout-smoke: PASS`。

Run: `node scripts/admin-v2-pages-smoke.js`

Expected: PASS，WXML 结构与 WXSS 四列规则同时通过。

- [ ] **Step 7: 提交视觉修改**

```bash
git add pages/admin-config/admin-config.wxss scripts/admin-v2-layout-smoke.js scripts/validate.js
git commit -m "style: match admin config right reference"
```

### Task 4: 专项与完整回归

**Files:**
- Verify: `pages/admin-config/*`
- Verify: `scripts/admin-v2-*.js`
- Verify: `scripts/validate.js`

**Interfaces:**
- Consumes: Tasks 1-3 的完整页面。
- Produces: 可进入统一发布闸门的干净提交。

- [ ] **Step 1: 安装验证所需依赖**

Run in `cloudfunctions/api`: `npm ci --ignore-scripts --no-audit --no-fund`

Expected: exit code `0`，`node_modules` 只作为本地验证产物。

Run in `cloudfunctions/payment-api`: `npm ci --ignore-scripts --no-audit --no-fund`

Expected: exit code `0`。

- [ ] **Step 2: 运行管理页专项测试**

```bash
node scripts/admin-v2-layout-smoke.js
node scripts/admin-v2-pages-smoke.js
node scripts/admin-v2-pages-runtime-smoke.js
node scripts/admin-config-layout-smoke.js
```

Expected: 四条命令全部 exit code `0`。

- [ ] **Step 3: 运行完整工程验证**

Run: `node scripts/validate.js`

Expected: exit code `0`，最后输出 `微信小程序工程静态检查通过。`。

- [ ] **Step 4: 检查差异和工作树**

```bash
git diff --check
git status --short
```

Expected: 无空白错误；只存在本计划列出的文件，`node_modules` 被忽略。

- [ ] **Step 5: 提交测试修正**

若完整验证要求对计划内测试做小修，提交：

```bash
git add scripts/admin-v2-layout-smoke.js scripts/admin-v2-pages-smoke.js scripts/admin-v2-pages-runtime-smoke.js scripts/validate.js
git commit -m "test: lock admin config reference layout"
```

没有额外修改时跳过该提交，不创建空提交。

### Task 5: 版本、正式打包和微信开发者工具验收

**Files:**
- Package source: `D:\aips小程序\wechat-miniapp-admin-config-right-20260831`
- Release controller: `D:\aips小程序\wechat-miniapp\scripts\release.ps1`
- Verify: 统一发布记录、不可变 ZIP、微信开发者工具模拟器。

**Interfaces:**
- Consumes: Task 4 的干净分支提交。
- Produces: 发布闸门分配的新 patch 版本、正式 ZIP、release record 和开发者工具编译结果。

- [ ] **Step 1: 使用统一闸门分配版本并准备正式包**

Run from `D:\aips小程序\wechat-miniapp`：

```powershell
$operationId = "op-admin-config-right-" + (Get-Date -Format "yyyyMMddHHmmss")
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\release.ps1 `
  -OperationId $operationId `
  -SourcePath 'D:\aips小程序\wechat-miniapp-admin-config-right-20260831' `
  -IncludePath @(
    'pages/admin-config/admin-config.json',
    'pages/admin-config/admin-config.wxml',
    'pages/admin-config/admin-config.js',
    'pages/admin-config/admin-config.wxss',
    'scripts/admin-v2-layout-smoke.js',
    'scripts/admin-v2-pages-smoke.js',
    'scripts/admin-v2-pages-runtime-smoke.js',
    'scripts/validate.js'
  ) `
  -PrepareOnly `
  -KeepWorktree
```

Expected: 闸门自动分配当前未占用 patch 版本，更新完整版本组并生成非零 ZIP；禁止手工复用已取消的 `0.57.83`、`.84`、`.85`。

- [ ] **Step 2: 校验发布记录和 ZIP**

使用 release 输出的 `operationId` 运行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\release-status.ps1 -OperationId $operationId -Report
```

Expected: package/validate 状态成功；记录 ZIP 绝对路径、字节数和 SHA256。执行时用真实 `operationId` 替换命令参数，不得另建票据。

- [ ] **Step 3: 导入发布工作树并编译**

使用 `release-gate.ps1` 的既有接口：

```powershell
$releaseWorktree = "D:\aips小程序\wechat-miniapp-release-worktrees\release-$operationId"
. .\scripts\release-gate.ps1
Invoke-ReleasePreviewImport `
  -CliPath 'D:\微信web开发者工具\wechatide.cmd' `
  -ClientName 'default' `
  -ProjectPath $releaseWorktree
```

Expected: `project_import`、`open_project_window`、`simulator_refresh` 全部成功，连续三次控制台检查没有实际编译错误。执行时使用本次 release 输出的工作树，禁止导入旧 `0.57.82` 工作树。

- [ ] **Step 4: 视觉验收**

在微信开发者工具选择 `390 x 844` 设备，确认：无重复导航；四项入口为单行文字；共享视频左右布局；配置总览默认只显示状态、展开和真实统计；故障切换与高级参数同卡且默认折叠；保存按钮无裁切。

- [ ] **Step 5: 交付记录**

最终报告必须包含新版本号、ZIP 绝对路径、SHA256、专项测试、完整验证、微信开发者工具编译状态，以及未进行 CloudBase 部署这一事实。
