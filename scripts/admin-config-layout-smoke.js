/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const pageRoot = path.join(__dirname, "..", "pages", "admin");
const normalizeNewlines = (value) => value.replace(/\r\n/g, "\n");
const wxml = normalizeNewlines(
  fs.readFileSync(path.join(pageRoot, "admin.wxml"), "utf8")
);
const wxss = normalizeNewlines(
  fs.readFileSync(path.join(pageRoot, "admin.wxss"), "utf8")
);
const js = normalizeNewlines(
  fs.readFileSync(path.join(pageRoot, "admin.js"), "utf8")
);

const currentConfigMarker =
  '    <view class="overview-section">\n      <view class="overview-heading">当前配置</view>';
const configEditorMarker =
  '    <view wx:if="{{activeConfigSection === \'points\' || activeConfigSection === \'costs\' || activeConfigSection === \'users\'}}" id="config-editor"';
const usageMarker = '    <view id="usage-section"';
const monitorMarker =
  '      <view\n        id="monitor-command-toggle"';

assert.strictEqual(
  (wxml.match(/id="config-editor"/g) || []).length,
  1,
  "积分/成本/用户统一配置区必须只保留一个滚动目标"
);
["face", "analysis", "image", "video"].forEach((section) => {
  assert.strictEqual(
    (wxml.match(new RegExp(`id="config-editor-${section}"`, "g")) || []).length,
    1,
    `${section} 模型参数区必须只有一个就地展开面板`
  );
});
assert.ok(
  wxml.indexOf(currentConfigMarker) < wxml.indexOf(configEditorMarker),
  "统一配置区没有放在当前配置之后"
);
assert.ok(
  wxml.indexOf(configEditorMarker) < wxml.indexOf(usageMarker),
  "统一配置区没有放在模型用量统计之前"
);
assert.ok(
  wxml.indexOf(usageMarker) < wxml.indexOf(monitorMarker),
  "模型用量统计没有放在运行监控之前"
);

const currentConfigStart = wxml.indexOf(currentConfigMarker);
const configEditorStart = wxml.indexOf(configEditorMarker);
const quickLaunchBlock = wxml.slice(0, currentConfigStart);
const currentConfigBlock = wxml.slice(currentConfigStart, configEditorStart);
["face", "analysis", "image", "video"].forEach((section) => {
  assert.strictEqual(
    (quickLaunchBlock.match(new RegExp(`class="quick-launch[^"]*quick-${section}`, "g")) || [])
      .length,
    1,
    `${section} 快捷入口缺失`
  );
  assert.ok(
    (currentConfigBlock.match(new RegExp(`data-section="${section}"`, "g")) || [])
      .length >= 2,
    `${section} 当前配置入口或参数字段缺失`
  );
  const rowIndex = currentConfigBlock.indexOf(`data-section="${section}"`);
  const panelIndex = currentConfigBlock.indexOf(`id="config-editor-${section}"`);
  assert.ok(rowIndex >= 0 && panelIndex > rowIndex, `${section} 参数区没有紧跟模型行`);
});
assert.strictEqual(
  (wxml.match(/class="current-config-row/g) || []).length,
  4,
  "当前配置模型行数量发生变化"
);
assert.strictEqual(
  (wxml.match(/class="config-editor-focus-tip"/g) || []).length,
  5,
  "四个模型参数区和统一配置区都必须显示当前配置定位提示"
);
assert.ok(
  wxss.includes(".config-editor-focus-tip {")
    && wxss.includes(".config-editor-focus-dot {")
    && wxss.includes(".config-editor-focus-help {"),
  "当前配置定位提示样式缺失"
);
assert.ok(
  wxml.includes('bindtap="refreshModelProbeResults"')
    && wxml.includes("刷新探测"),
  "模型探测结果缺少就地刷新按钮"
);
assert.ok(
  js.includes("refreshModelProbeResults()")
    && js.includes('return this.runModelProbe("");'),
  "模型探测刷新按钮没有复用全量探测流程"
);
assert.ok(
  wxss.includes(".model-probe-tools {")
    && wxss.includes(".model-probe-refresh-button {"),
  "模型探测刷新按钮样式缺失"
);
const apiKeyInputs = wxml.match(/<input[^>]*data-key="apiKey"[^>]*>/g) || [];
assert.strictEqual(apiKeyInputs.length, 5, "五个主备模型 API Key 输入框必须完整");
assert.ok(
  apiKeyInputs.every((input) => /\bpassword\b/.test(input)),
  "所有 API Key 输入框都必须使用密码输入"
);
assert.ok(
  wxml.includes("effective.image.apiKeyConfigured")
    && wxml.includes("effective.imageBackup.apiKeyConfigured")
    && (wxml.match(/已配置（不显示内容）/g) || []).length >= 2,
  "图片主备模型没有显示脱敏密钥配置状态"
);
assert.ok(
  wxss.includes(".api-key-config-state {")
    && wxss.includes(".api-key-field-tip {"),
  "图片主备模型密钥状态样式缺失"
);

const toggleStart = js.indexOf("toggleConfigSection(event)");
const toggleEnd = js.indexOf("closeConfigSection()", toggleStart);
assert.ok(toggleStart >= 0 && toggleEnd > toggleStart, "找不到配置入口处理函数");
const toggleBody = js.slice(toggleStart, toggleEnd);
const setDataIndex = toggleBody.indexOf("this.setData(");
const scrollIndex = toggleBody.indexOf("selector: configEditorSelector(nextSection)");
assert.ok(setDataIndex >= 0, "配置入口没有更新 activeConfigSection");
assert.ok(scrollIndex > setDataIndex, "配置入口滚动没有放在 setData 回调之后");
assert.ok(
  js.includes("function configEditorSelector(section)")
    && js.includes('`#config-editor-${section}`')
    && js.includes(': "#config-editor";'),
  "模型入口滚动目标映射不完整"
);

const configCssStart = wxss.indexOf(".config-editor {");
const configCssEnd = wxss.indexOf("}", configCssStart);
assert.ok(configCssStart >= 0 && configCssEnd > configCssStart, "找不到配置编辑区样式");
const configCss = wxss.slice(configCssStart, configCssEnd);
assert.ok(configCss.includes("margin-top: 8rpx;"), "配置编辑区上间距未调整");
assert.ok(configCss.includes("margin-bottom: 22rpx;"), "配置编辑区下间距未调整");
const inlineCssStart = wxss.indexOf(".config-editor-inline {");
const inlineCssEnd = wxss.indexOf("}", inlineCssStart);
assert.ok(inlineCssStart >= 0 && inlineCssEnd > inlineCssStart, "找不到就地展开样式");
const inlineCss = wxss.slice(inlineCssStart, inlineCssEnd);
assert.ok(inlineCss.includes("margin-top: -4rpx;"), "就地展开面板没有贴近模型行");

console.log(
  "admin config layout smoke: OK (四个模型参数区就地展开；其他配置保留统一编辑区)"
);
