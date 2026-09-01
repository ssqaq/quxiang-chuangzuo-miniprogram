/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "pages");
const projectRoot = path.join(__dirname, "..");

function read(page, extension) {
  return fs.readFileSync(path.join(root, page, `${page}.${extension}`), "utf8");
}

function assertNoMojibake(source, name) {
  assert.ok(!/[\uFFFD]/.test(source), `${name} 不能包含替换乱码字符`);
}

function pageFilesExist(page) {
  ["json", "js", "wxml", "wxss"].forEach((extension) => {
    const file = path.join(root, page, `${page}.${extension}`);
    assert.ok(fs.existsSync(file), `缺少 ${file}`);
    assertNoMojibake(fs.readFileSync(file, "utf8"), file);
  });
}

function assertPreviewSourceMarker(page) {
  const wxml = read(page, "wxml");
  assert.ok(wxml.includes('data-preview-source="{{source}}"'), `${page} 必须标记真实/演示数据来源`);
  assert.ok(wxml.includes('data-preview-fixture="{{demoMode ? fixtureId : \'\'}}"'), `${page} 只有演示模式可以挂 fixture`);
  assert.ok(wxml.includes("{{demoMode ? '演示' : '真实'}}"), `${page} 调试入口必须统一显示演示/真实状态`);
}

function assertWxmlHandlers(page) {
  const wxml = read(page, "wxml");
  const js = read(page, "js");
  const handlers = Array.from(wxml.matchAll(/bind(?:tap|change|input)="([A-Za-z0-9_]+)"/g), match => match[1]);
  handlers.forEach((handler) => {
    assert.ok(new RegExp(`\\n\\s*(?:async\\s+)?${handler}\\(`).test(js), `${page} 缺少 WXML 事件方法 ${handler}`);
  });
  ["view", "text", "button", "picker", "scroll-view"].forEach((tag) => {
    const opened = (wxml.match(new RegExp(`<${tag}(?:\\s|>)`, "g")) || []).length;
    const closed = (wxml.match(new RegExp(`</${tag}>`, "g")) || []).length;
    assert.strictEqual(opened, closed, `${page} 的 <${tag}> 标签未闭合`);
  });
}

["admin-dashboard", "admin-provider", "admin-config", "admin-operations"].forEach((page) => {
  pageFilesExist(page);
  assertWxmlHandlers(page);
  assertPreviewSourceMarker(page);
});

const appConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "app.json"), "utf8"));
["pages/admin-dashboard/admin-dashboard", "pages/admin-provider/admin-provider", "pages/admin-config/admin-config", "pages/admin-operations/admin-operations"].forEach((page) => {
  assert.ok(appConfig.pages.includes(page), `app.json 未登记 ${page}`);
});

const dashboard = read("admin-dashboard", "wxml");
const dashboardJs = read("admin-dashboard", "js");
const dashboardJson = JSON.parse(read("admin-dashboard", "json"));
const workbenchJs = fs.readFileSync(path.join(projectRoot, "pages", "workbench", "workbench.js"), "utf8");
assert.ok(dashboard.includes("开始新创作") && dashboard.includes("开始新创作-腾讯版"));
assert.ok(dashboard.includes("共享视频模型") && dashboard.includes("运营数据"));
assert.ok(dashboardJs.includes("用量") && dashboardJs.includes("积分") && dashboardJs.includes("成本") && dashboardJs.includes("用户"));
assert.ok(dashboardJs.includes('(item.role || "primary") === "primary"'), "控制台就绪数只能统计主模型");
assert.ok(dashboardJs.includes("pages/admin-operations/admin-operations?view="), "运营数据入口必须跳转新运营页");
assert.ok(dashboardJs.includes("featureSlots.length + 1") && dashboardJs.includes("isReady(video)"), "控制台九项统计必须包含共享视频且只统计主模型");
assert.strictEqual(dashboardJson.navigationStyle, "custom", "控制台必须关闭原生标题栏，避免出现双导航");
assert.ok(dashboard.includes('style="{{appbarStyle}}"') && dashboard.includes('style="{{dashboardScrollStyle}}"'), "控制台必须绑定自定义导航和滚动高度");
assert.ok(dashboardJs.includes("onResize()"), "控制台尺寸变化时必须重算导航高度");
assert.ok(!dashboard.includes('class="metric-icon"'), "运营四卡必须和浏览器基准一样只显示标题与动作");
assert.ok(workbenchJs.includes('wx.navigateTo({ url: "/pages/admin-dashboard/admin-dashboard" })'), "工作台管理员入口必须进入新控制台");

const providerWxml = read("admin-provider", "wxml");
const providerWxss = read("admin-provider", "wxss");
const providerJs = read("admin-provider", "js");
const providerJson = JSON.parse(read("admin-provider", "json"));
assert.strictEqual(providerJson.navigationStyle, "custom", "供应商页必须关闭原生标题栏，避免出现双导航");
assert.ok(!/class=["'][^"']*\bback\b/.test(providerWxml), "供应商页右图没有返回箭头");
assert.ok(providerWxml.includes('class="provider-card"') && providerWxml.includes('wx:if="{{!editing}}"'), "供应商页必须使用右图外卡，编辑态隐藏不可变 ID");
assert.ok(providerWxml.includes("供应商目录") && providerWxml.includes("新增供应商"));
assert.ok(providerWxml.includes("测试连接") && providerWxml.includes("获取模型") && providerWxml.includes("手动确认模型"));
assert.ok(providerWxml.includes("腾讯 TC3") && providerWxml.includes("人脸融合依赖"));
assert.ok(providerWxml.includes("删除供应商") && providerWxml.includes("保存供应商"));
assert.ok(providerJs.includes("for (let index = 0; index < labels.length; index += 2)"), "功能标签必须每行最多两个");
assert.ok(providerWxss.includes(".provider-list::-webkit-scrollbar") && providerWxss.includes("scrollbar-width:none"), "供应商列表应可滚动且隐藏滚动条");
assert.ok(providerJs.includes("selectedFetchedModel: \"\"") && providerJs.includes("modelPickerOpen: models.length > 0"), "获取真实模型后必须等待管理员手动确认");
assert.ok(providerWxss.includes("height:113.5rpx") && providerWxss.includes("flex:0 0 992rpx"), "375px 宽度下供应商目录首屏应稳定显示八条");
assert.ok(providerJs.includes("mergeDirectoryTemplates") && providerJs.includes("isTemplate: true"), "云端目录不足八条时必须补齐可编辑的未配置模板");
assert.ok(providerJs.includes("const nextProviders = mergeDirectoryTemplates(providers)") && providerJs.includes("providers: nextProviders"), "删除供应商后必须立即补齐目录模板，不能留下空白");
assert.ok(!/(sk-[A-Za-z0-9_-]{8,}|AKID[A-Za-z0-9_-]{4,}|secret-example)/.test(providerJs), "供应商演示数据不得包含明文密钥");
assert.ok(!providerJs.includes("fallbackModelsFor") && !providerJs.includes("供应商已保存到当前页面") && !providerJs.includes("已从当前页面移除"), "正式供应商页不得伪造模型或本地保存成功");

const configWxml = read("admin-config", "wxml");
const configJs = read("admin-config", "js");
const configJson = JSON.parse(read("admin-config", "json"));
assert.strictEqual(configJson.navigationStyle, "custom", "功能配置页必须关闭原生标题栏，避免出现双导航");
assert.ok(!/class=["'][^"']*\bback\b/.test(configWxml), "功能配置右图没有返回箭头");
assert.ok(configJs.includes('"standard.face"') && configJs.includes('"tencent.face"') && configJs.includes('"shared.video"'));
assert.ok(configWxml.includes("主模型") && configWxml.includes("收起") && configWxml.includes("展开"));
assert.ok(configWxml.includes("{{selectedTab.backupTitle}}") && configWxml.includes("高级参数"));
assert.ok(configJs.includes('backupTitle: `备用${def.label}${def.label.endsWith("模型") ? "" : "模型"}`'), "备用模型标题必须和右图一致，同时避免出现“模型模型”");
assert.ok(["standard-group", "tencent-group", "shared-group"].every(className => configWxml.includes(className)), "功能入口必须拆成普通、腾讯和共享视频三类结构");
assert.ok(configWxml.includes('wx:for="{{groups[0].tabs}}"') && configWxml.includes('wx:for="{{groups[1].tabs}}"') && configWxml.includes('wx:for="{{groups[2].tabs}}"'), "三类入口必须分别绑定真实分组数据");
assert.ok(!/class=["'][^"']*\btab-(?:icon|status)\b/.test(configWxml) && !configWxml.includes("{{tab.icon}}") && !configWxml.includes("{{tab.status}}"), "右图入口只能显示单行功能名称");
assert.ok(configWxml.indexOf('class="summary-card"') < configWxml.indexOf('class="main-model-card') && configWxml.indexOf('class="main-model-card') < configWxml.indexOf('class="failure-card"'), "主模型展开态必须位于总览和故障切换之间");
assert.ok(configWxml.indexOf('class="failure-card"') < configWxml.indexOf("advanced-body") && configWxml.indexOf("advanced-body") < configWxml.indexOf('class="save-btn"'), "高级参数必须并入故障切换卡");
assert.ok(!/class=["'][^"']*(?:^|\s)(?:model-card|advanced-card)(?:\s|$)/.test(configWxml), "不能恢复旧版主模型或高级参数卡类名");
assert.ok(configWxml.includes("超时策略") && configWxml.includes("失败策略") && configWxml.includes("重试次数") && configWxml.includes("保留原 Key") && configWxml.includes("保存前校验"));
assert.ok(configWxml.includes("启用当前功能的备用模型") && configWxml.includes('disabled="{{saving}}"'), "备用文案和保存按钮锁必须与右图及保存流程一致");
assert.ok(configWxml.includes('class="save-btn return-btn"') && configWxml.includes('bindtap="backToDashboard"') && configWxml.includes("返回控制台"), "保存按钮下一行必须提供同规格返回控制台按钮");
assert.ok(configJs.includes("backToDashboard()") && configJs.includes("getCurrentPages") && configJs.includes("previousRoute.includes") && configJs.includes("/pages/admin-dashboard/admin-dashboard"), "返回控制台按钮必须优先返回控制台上一页并能处理直达配置页");
assert.ok(configWxml.includes('class="backup-checkbox {{selectedTab.backupEnabled ? \'checked\' : \'\'}}"') && !configWxml.includes("<switch"), "备用启用必须使用右图小方框，不得使用大 switch");
assert.ok(configWxml.includes("图片编辑模式") === false && configWxml.includes("selectedTab.modeLabel") && configWxml.includes("selectedTab.sizeLabel"), "生图模式和尺寸必须由页面数据驱动");
assert.ok(configWxml.includes("1K") === false, "清晰度选项应来自页面数据，避免 WXML 数组字面量编译问题");
assert.ok(configJs.includes('["1K", "2K", "4K"]') && configJs.includes('["480p", "720p", "1080p"]'));
assert.ok(configJs.includes('["3:4", "9:16", "16:9"]'));
assert.ok(configJs.includes('{ value: "edits", label: "图片编辑模式" }') && configJs.includes('{ value: "1080x1440", label: "照片：1080×1440" }'));
assert.ok(!configWxml.includes("备用超时") && !configWxml.includes("图片生成模式"));
assert.ok(configJs.includes("model.confirmed === true") && configJs.includes("payload && payload.supplierModels"), "功能配置只能合并并选择已确认模型");
assert.ok(configJs.includes("summaryForGroup") && configWxml.includes("{{configuredCount}} / {{totalCount}}"), "配置总览必须按当前分组统计");
assert.ok(configWxml.includes("{{backupCount}} 个已启用") && !/>\s*4\s*\/\s*4\s*</.test(configWxml) && !/>\s*3\s*个已启用\s*</.test(configWxml), "总览数字必须来自真实配置，不能照截图硬编码");
assert.ok(configJs.includes("getAdminProviderSecretsV2") && configWxml.includes("selectedTab.backupKeyText"), "管理员明文凭据必须从专用接口按供应商读取");
assert.ok(configWxml.includes("selectedTab.backupEndpoint") && !configWxml.includes("selectedTab.backupProvider || '尚未配置'"), "备用 API 端点必须显示供应商真实端点");
assert.ok((configJs.match(/saveAdminSlotV2\(/g) || []).length === 1 && !configJs.includes("saveAdminBindingV2("), "主备绑定必须单次原子保存");
assert.ok(configJs.includes("primaryPatch") && configJs.includes("backupPatch") && configJs.includes("advancedPatch"), "slot 保存必须同时提交主备补丁和高级参数");
assert.ok(configJs.includes('status: backupReady ? "ready" : "not-ready"') && !configJs.includes('status: "disabled"'), "备用关闭必须使用 not-ready");
assert.ok(configJs.includes('读取失败 · 保留已保存状态') && configJs.includes('status: "success", value: null'), "API Key 读取必须区分空值和失败");
assert.ok(configJs.includes('已保存 · 明文仅管理员可见') && !configJs.includes('return String(secret.apiKey)'), "功能配置页只能显示密钥三态文案，不能回显明文");
assert.ok(!/(sk-[A-Za-z0-9_-]{8,}|AKID[A-Za-z0-9_-]{4,}|secret-example)/.test(configJs), "功能配置演示数据不得包含明文密钥");
assert.ok(!configJs.includes("已保存当前页面配置"), "功能配置云端失败时不得假报保存成功");
assert.ok(configJs.includes("if (this.data.saving) return") && configJs.includes("保存失败，主备配置均未更改"), "保存必须防双击且原子失败");
assert.ok(providerJs.includes("input.modelId || confirmedModels[0]") && providerJs.includes("已保存 · 明文仅管理员可见"), "供应商档案必须显示已确认模型并保持密钥安全状态文案");
assert.ok(providerWxss.includes(".tc3-panel .field-heading") && providerWxss.includes(".capability > text") && providerWxss.includes("text-overflow:ellipsis"), "TC3 字段和能力项在窄栏内必须保持可读");
assert.ok(providerWxss.includes("margin:-8rpx -13rpx") && providerWxss.includes("max-width:44%"), "窄栏勾选控件和 TC3 状态文案不能挤压字段标题");

const configWxss = read("admin-config", "wxss");
assert.ok(/grid-template-columns:\s*repeat\(4\s*,\s*minmax\(0\s*,\s*1fr\)\)/.test(configWxss), "四项页签必须固定为四列，不能横向滚动");
assert.ok(/font-family:\s*["']Microsoft YaHei["']\s*,\s*["']PingFang SC["']\s*,/.test(configWxss), "功能配置页字体栈必须与浏览器参考稿一致");
assert.ok(configWxss.includes("env(safe-area-inset-top)") && configWxss.includes("env(safe-area-inset-bottom)"), "自定义导航和页面底部必须处理安全区");
assert.ok(/overflow-x:\s*hidden/.test(configWxss) && /white-space:\s*nowrap/.test(configWxss), "窄屏下功能入口不得换行或横向溢出");
assert.ok(configWxss.includes(".backup-checkbox") && /border:\s*2rpx\s+solid/.test(configWxss), "小方框和 1px 视觉边框必须落地");
assert.ok(configWxss.includes(".advanced-selects picker") && configWxss.includes("float: none") && configWxss.includes("text-align: center"), "模式、清晰度、尺寸比例和宽高比必须视觉居中且箭头独立靠右");
assert.ok(configWxss.includes(".return-btn"), "返回控制台必须复用保存按钮规格并只覆盖配色和间距");
assert.ok(/\.tab\s*\{[^}]*height:\s*64rpx/.test(configWxss), "功能页签高度必须与右图 64rpx 合同一致");
assert.ok(/\.summary-subtitle\s*\{[^}]*font-size:\s*20rpx/.test(configWxss), "总览副标题字号必须为 20rpx");
assert.ok(/\.helper\s*\{[^}]*font-size:\s*18rpx/.test(configWxss), "辅助文案字号必须为 18rpx");
assert.ok(/\.summary-status,[\s\S]*?\.card-state\s*\{[^}]*font-size:\s*18rpx/.test(configWxss), "状态胶囊字号必须为 18rpx");
assert.ok(fs.existsSync(path.join(__dirname, "admin-v2-layout-smoke.js")), "缺少右图布局专项 smoke");

const operations = read("admin-operations", "wxml");
const operationsJs = read("admin-operations", "js");
const operationsWxss = read("admin-operations", "wxss");
const operationsJson = JSON.parse(read("admin-operations", "json"));
assert.ok(operationsJs.includes("模型用量统计") && operationsJs.includes("积分管理") && operationsJs.includes("成本统计") && operationsJs.includes("用户管理"));
assert.ok(operationsJs.includes("getModelUsageStats") && operationsJs.includes("getAdminUserStats"), "运营页必须接真实用量和用户接口");
assert.ok(operationsJs.includes("exportModelUsageStats") && operationsJs.includes("exportAdminUserStats"), "运营页必须接真实导出接口");
assert.ok(operationsJs.includes("没有积分汇总接口") && operationsJs.includes("不伪造"), "积分没有汇总接口时必须显示真实空态");
assert.ok(operations.includes("toggleRow") && operationsJs.includes("switchView"), "运营明细必须支持展开收回和四项 URL 视图切换");
assert.strictEqual(operationsJson.navigationStyle, "custom", "运营页必须关闭原生标题栏，避免出现双导航");
assert.ok(operations.includes('style="{{appbarStyle}}"') && operations.includes('style="{{operationsScrollStyle}}"'), "运营页必须绑定自定义导航和滚动高度");
assert.ok(operationsJs.includes("onResize()"), "运营页尺寸变化时必须重算导航高度");
assert.ok(operations.includes("返回控制台"), "运营页导航文案必须与浏览器基准一致");
assert.ok(!operations.includes('class="view-tabs"') && !operations.includes('class="quick-links"'), "运营页不能显示浏览器基准没有的额外页签和快捷入口");
assert.ok(operations.includes('wx:if="{{!loading && !empty}}" class="foot-note"'), "运营空态不能重复显示底部说明");
assert.ok(operationsWxss.includes("font-family:\"Microsoft YaHei\",\"PingFang SC\"") && operationsWxss.includes("overflow-x:hidden"), "运营页 375px 下不得横向溢出且字体栈必须与浏览器参考稿一致");
assert.ok(fs.existsSync(path.join(__dirname, "admin-operations-runtime-smoke.js")), "缺少运营页运行 smoke");

console.log("admin-v2-pages-smoke: PASS (dashboard/provider/config/right-reference/375/UTF-8/interactions)");
