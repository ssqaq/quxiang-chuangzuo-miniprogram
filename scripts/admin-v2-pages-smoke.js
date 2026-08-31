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
});

const appConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "app.json"), "utf8"));
["pages/admin-dashboard/admin-dashboard", "pages/admin-provider/admin-provider", "pages/admin-config/admin-config", "pages/admin-operations/admin-operations"].forEach((page) => {
  assert.ok(appConfig.pages.includes(page), `app.json 未登记 ${page}`);
});

const dashboard = read("admin-dashboard", "wxml");
const dashboardJs = read("admin-dashboard", "js");
const workbenchJs = fs.readFileSync(path.join(projectRoot, "pages", "workbench", "workbench.js"), "utf8");
assert.ok(dashboard.includes("开始新创作") && dashboard.includes("开始新创作-腾讯版"));
assert.ok(dashboard.includes("共享视频模型") && dashboard.includes("运营数据"));
assert.ok(dashboardJs.includes("用量") && dashboardJs.includes("积分") && dashboardJs.includes("成本") && dashboardJs.includes("用户"));
assert.ok(dashboardJs.includes('(item.role || "primary") === "primary"'), "控制台就绪数只能统计主模型");
assert.ok(dashboardJs.includes("pages/admin-operations/admin-operations?view="), "运营数据入口必须跳转新运营页");
assert.ok(workbenchJs.includes('wx.navigateTo({ url: "/pages/admin-dashboard/admin-dashboard" })'), "工作台管理员入口必须进入新控制台");

const providerWxml = read("admin-provider", "wxml");
const providerWxss = read("admin-provider", "wxss");
const providerJs = read("admin-provider", "js");
assert.ok(providerWxml.includes("供应商目录") && providerWxml.includes("新增供应商"));
assert.ok(providerWxml.includes("测试连接") && providerWxml.includes("获取模型") && providerWxml.includes("手动确认模型"));
assert.ok(providerWxml.includes("腾讯 TC3") && providerWxml.includes("人脸融合依赖"));
assert.ok(providerWxml.includes("删除供应商") && providerWxml.includes("保存供应商"));
assert.ok(providerJs.includes("for (let index = 0; index < labels.length; index += 2)"), "功能标签必须每行最多两个");
assert.ok(providerWxss.includes(".provider-list::-webkit-scrollbar") && providerWxss.includes("scrollbar-width:none"), "供应商列表应可滚动且隐藏滚动条");
assert.ok(providerJs.includes("selectedFetchedModel: \"\"") && providerJs.includes("modelPickerOpen: models.length > 0"), "获取真实模型后必须等待管理员手动确认");
assert.ok(providerWxss.includes("height:103.25rpx") && providerWxss.includes("flex:0 0 890rpx"), "375px 宽度下供应商目录首屏应稳定显示八条");
assert.ok(!/(sk-[A-Za-z0-9_-]{8,}|AKID[A-Za-z0-9_-]{4,}|secret-example)/.test(providerJs), "供应商演示数据不得包含明文密钥");
assert.ok(!providerJs.includes("fallbackModelsFor") && !providerJs.includes("供应商已保存到当前页面") && !providerJs.includes("已从当前页面移除"), "正式供应商页不得伪造模型或本地保存成功");

const configWxml = read("admin-config", "wxml");
const configJs = read("admin-config", "js");
assert.ok(configJs.includes('"standard.face"') && configJs.includes('"tencent.face"') && configJs.includes('"shared.video"'));
assert.ok(configWxml.includes("主模型") && configWxml.includes("收回") && configWxml.includes("展开"));
assert.ok(configWxml.includes("备用{{selectedTab.label}}") && configWxml.includes("高级参数"));
assert.ok(configWxml.includes("超时策略") && configWxml.includes("失败策略") && configWxml.includes("重试次数"));
assert.ok(configWxml.includes("1K") === false, "清晰度选项应来自页面数据，避免 WXML 数组字面量编译问题");
assert.ok(configJs.includes('["1K", "2K", "4K"]') && configJs.includes('["480p", "720p", "1080p"]'));
assert.ok(configJs.includes('["3:4", "9:16", "16:9"]'));
assert.ok(!configWxml.includes("备用超时") && !configWxml.includes("图片生成模式"));
assert.ok(configJs.includes("model.confirmed === true") && configJs.includes("payload && payload.supplierModels"), "功能配置只能合并并选择已确认模型");
assert.ok(configJs.includes("summaryForGroup") && configWxml.includes("{{configuredCount}} / {{totalCount}}"), "配置总览必须按当前分组统计");
assert.ok(configJs.includes("getAdminProviderSecretsV2") && configWxml.includes("selectedTab.backupKeyText"), "管理员明文凭据必须从专用接口按供应商读取");
assert.ok(configWxml.includes("selectedTab.backupEndpoint") && !configWxml.includes("selectedTab.backupProvider || '尚未配置'"), "备用 API 端点必须显示供应商真实端点");
assert.ok((configJs.match(/saveAdminBindingV2\(/g) || []).length === 2, "主备绑定必须连续执行两次 CAS 保存");
assert.ok(!/(sk-[A-Za-z0-9_-]{8,}|AKID[A-Za-z0-9_-]{4,}|secret-example)/.test(configJs), "功能配置演示数据不得包含明文密钥");
assert.ok(!configJs.includes("已保存当前页面配置"), "功能配置云端失败时不得假报保存成功");

const configWxss = read("admin-config", "wxss");
assert.ok(configWxss.includes("grid-template-columns:repeat(4,minmax(0,1fr))"), "四项页签必须固定为四列，不能横向滚动");

const operations = read("admin-operations", "wxml");
const operationsJs = read("admin-operations", "js");
const operationsWxss = read("admin-operations", "wxss");
assert.ok(operationsJs.includes("模型用量统计") && operationsJs.includes("积分管理") && operationsJs.includes("成本统计") && operationsJs.includes("用户管理"));
assert.ok(operationsJs.includes("getModelUsageStats") && operationsJs.includes("getAdminUserStats"), "运营页必须接真实用量和用户接口");
assert.ok(operationsJs.includes("exportModelUsageStats") && operationsJs.includes("exportAdminUserStats"), "运营页必须接真实导出接口");
assert.ok(operationsJs.includes("没有积分汇总接口") && operationsJs.includes("不伪造"), "积分没有汇总接口时必须显示真实空态");
assert.ok(operations.includes("toggleRow") && operations.includes("switchView"), "运营明细必须支持展开收回和四项切换");
assert.ok(operationsWxss.includes("grid-template-columns:repeat(4,minmax(0,1fr))") && operationsWxss.includes("overflow:hidden"), "运营页 375px 下不得横向溢出");
assert.ok(fs.existsSync(path.join(__dirname, "admin-operations-runtime-smoke.js")), "缺少运营页运行 smoke");

console.log("admin-v2-pages-smoke: PASS (dashboard/provider/config/375/UTF-8/interactions)");
