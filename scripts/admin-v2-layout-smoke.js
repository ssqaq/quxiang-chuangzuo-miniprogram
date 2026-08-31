/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function hasClass(tag, className) {
  const match = tag.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/);
  return Boolean(match && new RegExp(`(?:^|\\s)${className}(?:\\s|$)`).test(match[2]));
}

function viewBlock(source, className) {
  const tags = Array.from(source.matchAll(/<\/?view\b[^>]*>/g));
  const openingIndex = tags.findIndex(match => !match[0].startsWith("</") && hasClass(match[0], className));
  assert.ok(openingIndex >= 0, `WXML 缺少 .${className}`);
  let depth = 0;
  for (let index = openingIndex; index < tags.length; index += 1) {
    const tag = tags[index][0];
    if (tag.startsWith("</")) depth -= 1;
    else if (!tag.endsWith("/>")) depth += 1;
    if (depth === 0) return source.slice(tags[openingIndex].index, tags[index].index + tag.length);
  }
  assert.fail(`WXML 中 .${className} 没有闭合`);
}

function cssRule(source, selector) {
  const matches = Array.from(source.matchAll(/([^{}]+)\{([^{}]*)\}/gm))
    .filter(match => match[1].split(",").some(item => item.trim() === selector));
  assert.ok(matches.length, `WXSS 缺少 ${selector} 规则`);
  return matches.map(match => match[2]).join(";");
}

function cssValue(rule, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = Array.from(rule.matchAll(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "gm")));
  return matches.length ? matches[matches.length - 1][1].trim() : "";
}

function assertRpxBetween(rule, property, minimum, maximum, label) {
  const value = cssValue(rule, property);
  const match = value.match(/^(\d+(?:\.\d+)?)rpx$/);
  assert.ok(match, `${label} 必须使用固定 rpx，当前为 ${value || "未设置"}`);
  const number = Number(match[1]);
  assert.ok(number >= minimum && number <= maximum, `${label} 应在 ${minimum}-${maximum}rpx，当前为 ${value}`);
}

function assertRpx(rule, property, expected, label) {
  const value = cssValue(rule, property);
  assert.strictEqual(value, `${expected}rpx`, `${label} 必须为 ${expected}rpx，当前为 ${value || "未设置"}`);
}

const json = JSON.parse(read("pages/admin-config/admin-config.json"));
const js = read("pages/admin-config/admin-config.js");
const wxml = read("pages/admin-config/admin-config.wxml");
const wxss = read("pages/admin-config/admin-config.wxss");
const providerJson = JSON.parse(read("pages/admin-provider/admin-provider.json"));
const providerJs = read("pages/admin-provider/admin-provider.js");
const providerWxml = read("pages/admin-provider/admin-provider.wxml");
const providerWxss = read("pages/admin-provider/admin-provider.wxss");
const validate = read("scripts/validate.js");
const dashboardJson = JSON.parse(read("pages/admin-dashboard/admin-dashboard.json"));
const dashboardWxml = read("pages/admin-dashboard/admin-dashboard.wxml");
const dashboardJs = read("pages/admin-dashboard/admin-dashboard.js");
const dashboardWxss = read("pages/admin-dashboard/admin-dashboard.wxss");
const operationsJson = JSON.parse(read("pages/admin-operations/admin-operations.json"));
const operationsWxml = read("pages/admin-operations/admin-operations.wxml");
const operationsJs = read("pages/admin-operations/admin-operations.js");
const operationsWxss = read("pages/admin-operations/admin-operations.wxss");

assert.strictEqual(json.navigationStyle, "custom", "功能配置页必须使用自定义导航，不能重复显示微信原生标题栏");
assert.ok(wxml.includes('class="appbar"') && wxml.includes("功能配置") && wxml.includes("供应商管理"), "自定义导航必须保留标题和供应商入口");
assert.ok(!/class=["'][^"']*\bback\b/.test(wxml), "功能配置右图没有返回箭头");
assert.ok(wxml.includes('style="{{appbarStyle}}"') && wxml.includes('style="{{configScrollStyle}}"'), "自定义导航和滚动区必须绑定真机测量结果");
assert.ok(js.includes("getMenuButtonBoundingClientRect") && js.includes("statusBarHeight") && js.includes("capsuleRightInset"), "自定义导航必须读取状态栏和微信胶囊位置");
assert.ok(/const\s+adminV2ExecutableSmokeFiles\s*=/.test(validate), "validate 必须单列本次需要真正执行的页面 smoke");
assert.ok(/for\s*\(const relative of adminV2ExecutableSmokeFiles\)[\s\S]*?execFileSync/.test(validate), "validate 必须真正执行本次页面 smoke，不能只检查文件存在");

["standard-group", "tencent-group", "shared-group"].forEach(className => viewBlock(wxml, className));
assert.ok(viewBlock(wxml, "standard-group").includes('wx:for="{{groups[0].tabs}}"'), "普通创作入口必须绑定第一组真实功能数据");
assert.ok(viewBlock(wxml, "tencent-group").includes('wx:for="{{groups[1].tabs}}"'), "腾讯版入口必须绑定第二组真实功能数据");
assert.ok(viewBlock(wxml, "shared-group").includes('wx:for="{{groups[2].tabs}}"'), "共享视频入口必须绑定第三组真实功能数据");
assert.ok(wxml.includes('class="group-pending"'), "腾讯版异常状态必须聚合显示在分组标题旁");
assert.ok(!/class=["'][^"']*\btab-(?:icon|status)\b/.test(wxml), "功能入口只能显示单行名称，不能恢复图标或逐项状态文字");
assert.ok(!wxml.includes("{{tab.icon}}") && !wxml.includes("{{tab.status}}"), "功能入口不得渲染旧版图标或逐项状态字段");
assert.ok(!/\.tab-(?:icon|status)\b/.test(wxss), "WXSS 不应继续保留旧版入口图标或状态样式");

const summary = viewBlock(wxml, "summary-card");
assert.ok(summary.includes("{{configuredCount}} / {{totalCount}}") && summary.includes("{{backupCount}} 个已启用"), "配置总览必须继续读取真实统计数据");
assert.ok(!/>\s*4\s*\/\s*4\s*</.test(summary) && !/>\s*3\s*个已启用\s*</.test(summary), "配置总览不得为贴图硬编码 4 / 4 或 3 个已启用");
assert.ok(!/class=["'][^"']*\bmain-model-card\b/.test(summary), "展开的主模型不能塞进配置总览卡内部");
assert.ok(/wx:if=["']\{\{selectedTab && mainExpanded\}\}["'][^>]*class=["'][^"']*\bmain-model-card\b/.test(wxml), "主模型独立卡必须精确绑定 mainExpanded");
assert.ok(wxml.indexOf('class="summary-card"') < wxml.indexOf("main-model-card") && wxml.indexOf("main-model-card") < wxml.indexOf('class="failure-card"'), "主模型独立卡必须位于总览和故障切换之间");

const failure = viewBlock(wxml, "failure-card");
assert.ok(/class=["'][^"']*\baccordion-body\b/.test(failure), "备用模型详情必须保留在故障切换卡内部");
assert.ok(/class=["'][^"']*\badvanced-body\b/.test(failure), "高级参数详情必须并入故障切换卡");
assert.ok(/wx:if=["']\{\{backupExpanded\}\}["'][^>]*class=["'][^"']*\baccordion-body\b/.test(failure), "备用模型详情必须精确绑定 backupExpanded");
assert.ok(/wx:if=["']\{\{advancedExpanded\}\}["'][^>]*class=["'][^"']*\badvanced-body\b/.test(failure), "高级参数详情必须精确绑定 advancedExpanded");
assert.ok(!/class=["'][^"']*\badvanced-card\b/.test(wxml), "高级参数不能继续单独占用一张卡");
assert.ok(failure.includes("保留原 Key") && failure.includes("保存前校验") && failure.includes("高级参数只影响当前功能"), "高级参数展开态必须完整还原右图");

const pageRule = cssRule(wxss, "page");
assert.ok(/^\s*["']Microsoft YaHei["']\s*,\s*["']PingFang SC["']\s*,/.test(cssValue(pageRule, "font-family")), "页面字体栈必须与浏览器参考稿一致");
assert.ok(["", "400", "normal"].includes(cssValue(pageRule, "font-weight")), "不能再给整个页面强制统一粗体");
assert.ok(wxss.includes("env(safe-area-inset-top)"), "自定义导航必须为状态栏和刘海保留顶部安全区");
assert.ok(wxss.includes("env(safe-area-inset-bottom)"), "页面底部必须保留安全区");

const pageLayoutRule = cssRule(wxss, ".config-page");
assert.strictEqual(cssValue(pageLayoutRule, "overflow-x"), "hidden", "页面必须阻止横向溢出");
const scrollRule = cssRule(wxss, ".config-scroll");
assert.strictEqual(cssValue(scrollRule, "width"), "100%", "滚动区域必须锁定为视口宽度");
assert.strictEqual(cssValue(scrollRule, "box-sizing"), "border-box", "滚动区域宽度必须包含内边距");
assert.strictEqual(cssValue(scrollRule, "overflow-x"), "hidden", "滚动区域必须隐藏横向溢出");

const gridRule = cssRule(wxss, ".tab-grid");
assert.ok(/repeat\(4\s*,\s*minmax\(0\s*,\s*1fr\)\)/.test(cssValue(gridRule, "grid-template-columns")), "普通和腾讯入口必须保持四列等分");
assert.strictEqual(cssValue(gridRule, "min-width"), "0", "四列入口容器必须允许在窄屏收缩");
const tabRule = cssRule(wxss, ".tab");
assert.strictEqual(cssValue(tabRule, "min-width"), "0", "功能入口必须允许等分收缩");
assert.strictEqual(cssValue(tabRule, "white-space"), "nowrap", "功能名称必须保持单行");
assert.strictEqual(cssValue(tabRule, "overflow"), "hidden", "功能名称不能撑出卡片");
assertRpx(tabRule, "height", 64, "功能入口高度");
assertRpx(cssRule(wxss, ".standard-group"), "min-height", 150, "标准功能组参考高度");
assertRpx(cssRule(wxss, ".tencent-group"), "min-height", 154, "腾讯功能组参考高度");
assertRpx(cssRule(wxss, ".shared-group"), "min-height", 112, "共享视频组参考高度");
assertRpx(cssRule(wxss, ".summary-top"), "min-height", 72, "配置总览标题区参考高度");
assertRpx(cssRule(wxss, ".summary-stats > view"), "min-height", 127, "配置总览数字区参考高度");
assertRpx(cssRule(wxss, ".failure-head"), "min-height", 79, "故障切换标题区参考高度");
assertRpx(cssRule(wxss, ".accordion-head"), "min-height", 108, "备用模型折叠行参考高度");
assertRpx(cssRule(wxss, ".failure-card"), "margin-bottom", 20, "保存按钮前参考间距");

assertRpx(cssRule(wxss, ".appbar-title"), "font-size", 42, "页面标题字号");
assertRpx(cssRule(wxss, ".card-title"), "font-size", 30, "卡片标题字号");
assertRpx(cssRule(wxss, ".group-title"), "font-size", 24, "分组标题字号");
assertRpx(cssRule(wxss, ".tab-label"), "font-size", 18, "功能入口字号");
assertRpx(cssRule(wxss, ".summary-number"), "font-size", 32, "配置统计字号");
assertRpx(cssRule(wxss, ".summary-subtitle"), "font-size", 20, "总览副标题字号");
assertRpx(cssRule(wxss, ".helper"), "font-size", 18, "辅助文案字号");
assertRpx(cssRule(wxss, ".summary-status"), "font-size", 18, "状态胶囊字号");
assertRpx(cssRule(wxss, ".save-btn"), "height", 96, "保存按钮高度");
assert.strictEqual(cssValue(cssRule(wxss, ".config-page .save-btn"), "width"), "100%", "保存按钮必须用高优先级规则撑满卡片宽度");
assertRpx(cssRule(wxss, ".field-label"), "font-size", 19, "字段标签字号");
assertRpx(cssRule(wxss, ".picker-value"), "font-size", 22, "字段值字号");
assertRpx(cssRule(wxss, ".summary-toggle"), "width", 80, "总览展开按钮宽度");
assertRpx(cssRule(wxss, ".summary-toggle"), "height", 48, "总览展开按钮高度");

assert.strictEqual(providerJson.navigationStyle, "custom", "供应商页必须使用自定义导航");
assert.ok(providerWxml.includes('class="provider-card"') && !/class=["'][^"']*\bback\b/.test(providerWxml), "供应商页必须有右图外卡且没有返回箭头");
assert.ok(providerWxml.includes('style="{{appbarStyle}}"') && providerWxml.includes('style="{{providerScrollStyle}}"'), "供应商页必须绑定真机导航高度");
assert.ok(providerJs.includes("getMenuButtonBoundingClientRect") && providerJs.includes("providerScrollStyle"), "供应商页必须为微信胶囊留出安全区");
assert.ok(/grid-template-columns:\s*252rpx\s+minmax\(0\s*,\s*1fr\)/.test(providerWxss), "供应商双栏必须按右图使用 252rpx 左栏");
assert.ok(/\.provider-card\s*\{[^}]*border-radius:\s*28rpx/.test(providerWxss), "供应商外卡圆角必须为 28rpx");
assert.ok(/\.provider-name text\s*\{[^}]*font-size:\s*21rpx/.test(providerWxss), "供应商名称字号必须可读");
assert.strictEqual(cssValue(cssRule(providerWxss, ".provider-row.active"), "border"), "4rpx solid #2f73ee", "选中供应商必须使用 4rpx 边框");
assert.strictEqual(cssValue(cssRule(providerWxss, ".provider-row.active"), "padding"), "6rpx 7rpx", "选中供应商必须内缩 padding 保持外框尺寸不变");
assert.ok(/\.field-label\s*\{[^}]*font-size:\s*19rpx/.test(providerWxss), "供应商字段标签字号必须对齐右图");

assert.ok(!/[\uFFFD]/.test(json.navigationBarTitleText + wxml + wxss + providerWxml + providerWxss), "管理页不能包含替换乱码字符");

assert.strictEqual(dashboardJson.navigationStyle, "custom", "控制台必须使用自定义导航");
assert.ok(dashboardWxml.includes('style="{{appbarStyle}}"') && dashboardWxml.includes('style="{{dashboardScrollStyle}}"'), "控制台必须绑定动态导航高度");
assert.ok(dashboardJs.includes("getMenuButtonBoundingClientRect") && dashboardJs.includes("dashboardScrollStyle"), "控制台必须为微信胶囊留出安全区");
assert.ok(dashboardJs.includes("onResize()"), "控制台必须响应屏幕尺寸变化");
assert.ok(operationsJson.navigationStyle === "custom", "运营页必须使用自定义导航");
assert.ok(operationsWxml.includes('style="{{appbarStyle}}"') && operationsWxml.includes('style="{{operationsScrollStyle}}"'), "运营页必须绑定动态导航高度");
assert.ok(operationsWxml.includes("返回控制台"), "运营页必须保留返回控制台入口");
assert.ok(!/class=["'][^"']*\bback\b/.test(operationsWxml), "运营页右图没有返回箭头");
assert.ok(!operationsWxml.includes('class="view-tabs"') && !operationsWxml.includes('class="quick-links"'), "运营页不能显示额外页签和快捷入口");
assert.ok(operationsJs.includes("getMenuButtonBoundingClientRect") && operationsJs.includes("operationsScrollStyle"), "运营页必须为微信胶囊留出安全区");
assert.ok(operationsJs.includes("onResize()"), "运营页必须响应屏幕尺寸变化");
assert.ok(/font-family:\s*["']Microsoft YaHei["']\s*,\s*["']PingFang SC["']/.test(dashboardWxss) && /font-family:\s*["']Microsoft YaHei["']\s*,\s*["']PingFang SC["']/.test(operationsWxss), "控制台和运营页字体栈必须与浏览器参考稿一致");
assert.ok(operationsWxss.includes("env(safe-area-inset-bottom)"), "运营页底部必须保留安全区");

console.log("admin-v2-layout-smoke: PASS (right-reference/custom-nav/groups/nesting/type/safe-area/overflow)");
