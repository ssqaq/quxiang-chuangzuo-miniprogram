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
["face", "analysis", "image", "tencentImage", "video"].forEach((section) => {
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
  (quickLaunchBlock.match(/quick-tencentImage/g) || []).length,
  0,
  "腾讯版不能新增顶部快捷入口"
);
const tencentRowIndex = currentConfigBlock.indexOf('data-section="tencentImage"');
const tencentPanelIndex = currentConfigBlock.indexOf('id="config-editor-tencentImage"');
assert.ok(tencentRowIndex >= 0, "腾讯版当前配置入口缺失");
assert.ok(tencentPanelIndex > tencentRowIndex, "腾讯版参数区没有紧跟腾讯版模型行");
const imageRowIndex = currentConfigBlock.indexOf('data-section="image"');
const videoRowIndex = currentConfigBlock.indexOf('data-section="video"');
assert.ok(
  imageRowIndex < tencentRowIndex && tencentRowIndex < videoRowIndex,
  "腾讯版必须严格位于普通生图模型与视频模型之间"
);
assert.strictEqual(
  (wxml.match(/class="current-config-row/g) || []).length,
  5,
  "当前配置模型行数量发生变化"
);
assert.strictEqual(
  (wxml.match(/class="config-editor-focus-tip"/g) || []).length,
  6,
  "五个模型参数区和统一配置区都必须显示当前配置定位提示"
);
const faceRowIndex = currentConfigBlock.indexOf('data-section="face"');
const oldTencentCardArea = currentConfigBlock.slice(0, faceRowIndex);
assert.ok(
  !oldTencentCardArea.includes('class="tencent-status-card"'),
  "当前配置顶部的旧腾讯大卡片必须删除"
);
assert.strictEqual(
  (wxml.match(/class="tencent-status-card"/g) || []).length,
  1,
  "腾讯参数卡只能存在于腾讯版展开区一次"
);
assert.strictEqual(
  (wxml.match(/class="tencent-test-title"/g) || []).length,
  1,
  "腾讯真实测试区域只能出现一次"
);
assert.strictEqual(
  (wxml.match(/bindtap="runTencentRealTest"/g) || []).length,
  1,
  "腾讯真实测试按钮只能出现一次"
);
[
  "secretId",
  "secretKey",
  "region",
  "endpoint",
  "apiVersion",
  "action",
  "model",
  "swapModelType",
  "logoAddText",
  "timeoutText",
  "maxImageBytesText",
  "lastCallStatusText",
  "lastCallStageText",
  "lastDurationText",
  "lastCalledAt",
  "lastErrorMessage"
].forEach((field) => {
  assert.ok(
    wxml.includes(`tencentFaceFusionStatus.${field}`),
    `腾讯版只读参数缺少 ${field}`
  );
});
assert.ok(
  wxml.includes("{{tencentFaceFusionStatus.model}} · {{tencentFaceFusionStatus.region}}")
    && wxml.includes("{{tencentFaceFusionStatus.statusText}}"),
  "腾讯版配置行缺少模型、区域或状态摘要"
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
const apiKeyInputBySection = apiKeyInputs.reduce((result, input) => {
  const match = input.match(/data-section="([^"]+)"/);
  if (match) result[match[1]] = input;
  return result;
}, {});
assert.strictEqual(apiKeyInputs.length, 5, "五个主备模型 API Key 输入框必须完整");
assert.ok(
  ["face", "analysis", "video"].every((section) => (
    apiKeyInputBySection[section]
    && /\bpassword\b/.test(apiKeyInputBySection[section])
  )),
  "人脸、图片分析和视频 API Key 必须继续使用密码输入"
);
assert.ok(
  ["image", "imageBackup"].every((section) => (
    apiKeyInputBySection[section]
    && !/\bpassword\b/.test(apiKeyInputBySection[section])
  )),
  "图片主备 API Key 必须直接显示完整内容"
);
assert.ok(
  wxml.includes("effective.image.apiKeyConfigured")
    && wxml.includes("effective.imageBackup.apiKeyConfigured")
    && (wxml.match(/已显示完整 Key/g) || []).length >= 2,
  "图片主备模型没有显示完整密钥状态"
);
assert.ok(
  wxss.includes(".api-key-config-state {")
    && wxss.includes(".api-key-field-tip {"),
  "图片主备模型密钥状态样式缺失"
);
assert.ok(
  wxml.includes("图片主备切换统计")
    && wxml.includes("管理员配置修改记录")
    && wxml.includes("imageProviderStats.primary")
    && wxml.includes("configAuditLogs.logs"),
  "主备统计和配置审计没有放进管理页"
);
assert.ok(
  wxss.includes(".image-provider-stats-grid {")
    && wxss.includes(".config-audit-list {"),
  "主备统计和配置审计样式缺失"
);
assert.ok(
  js.includes("refreshImageProviderStats")
    && js.includes("refreshConfigAudit")
    && js.includes("cloud.getImageProviderFailoverStats")
    && js.includes("cloud.getAdminConfigAuditLogs"),
  "管理页没有接入主备统计和配置审计刷新"
);
assert.ok(
  js.includes("function normalizeAdminProviderInput")
    && js.includes("function displayAdminProvider")
    && js.includes('xingju: "星炬"')
    && js.includes('lingyun: "凌云"')
    && js.includes('dashscope: "阿里云百炼"')
    && js.includes('provider: displayAdminProvider(face.provider)')
    && js.includes('provider: displayAdminProvider(analysis.provider)')
    && js.includes('provider: displayAdminImageProvider(image.provider)')
    && js.includes('provider: displayAdminImageProvider(imageBackup.provider, "凌云")')
    && js.includes('provider: displayAdminProvider(video.provider)')
    && js.includes("provider: normalizeAdminProviderInput(form.face.provider)")
    && js.includes("provider: normalizeAdminProviderInput(form.analysis.provider)")
    && js.includes("provider: normalizeAdminImageProviderInput(form.image.provider)")
    && js.includes("provider: normalizeAdminImageProviderInput(form.imageBackup.provider)")
    && js.includes("provider: normalizeAdminProviderInput(form.video.provider)")
    && js.includes("const provider = normalizeAdminProviderInput(source.provider)")
    && js.includes("ADMIN_PROVIDER_FORM_SECTIONS.includes(section)"),
  "管理员模型服务商中文显示或英文传参映射缺失"
);
assert.ok(
  wxml.includes('value="{{form.face.provider}}"')
    && wxml.includes('value="{{form.analysis.provider}}"')
    && wxml.includes('value="{{form.image.provider}}"')
    && wxml.includes('value="{{form.imageBackup.provider}}"')
    && wxml.includes('value="{{form.video.provider}}"')
    && wxml.includes("主模型：{{form.image.provider")
    && wxml.includes("备用模型：{{form.imageBackup.provider")
    && !wxml.includes("imageProviderDisplayName")
    && !wxml.includes("imageBackupProviderDisplayName"),
  "管理员模型服务商没有直接使用已中文化的表单值"
);
assert.ok(
  wxml.includes('data-section="imageBackup" data-key="mode"')
    && wxml.includes('range="{{imageBackupQualityOptions}}"')
    && wxml.includes('bindchange="onImageBackupQualityChange"')
    && wxml.includes('range="{{imageBackupSizeOptions}}"')
    && wxml.includes('bindchange="onImageBackupSizeChange"')
    && wxml.includes('data-section="imageBackup" data-key="timeoutMs"'),
  "备用模型没有完整显示模式、清晰度、尺寸比例和超时四项配置"
);
assert.ok(
  js.includes("imageBackupQualityOptions")
    && js.includes("imageBackupSizeOptions")
    && js.includes("onImageBackupQualityChange(event)")
    && js.includes("onImageBackupSizeChange(event)")
    && js.includes('mode: String(form.imageBackup.mode || "edits")'),
  "备用模型四项配置没有接入独立状态或保存逻辑"
);
assert.ok(
  (wxml.match(/data-model-config="imageBackup"/g) || []).length === 2
    && wxml.includes('bindtap="runImageBackupEditCapabilityProbe"')
    && wxml.includes("imageBackupEditCapabilityProbe.checked")
    && wxml.includes("imageBackupEditCapabilityLoading")
    && wxml.includes("测试备用生图模型连接")
    && wxml.includes("获取备用生图模型列表"),
  "备用模型缺少测试连接、获取模型或检查图片编辑配置按钮"
);
assert.ok(
  js.includes('modelActionTarget: ""')
    && js.includes('modelPickerTarget: ""')
    && js.includes("modelConfigKeyForAction")
    && js.includes("runImageBackupEditCapabilityProbe()")
    && js.includes('"imageBackupEditCapabilityProbe"')
    && js.includes('[`form.${configKey}.model`]: value'),
  "备用模型三个按钮没有接入独立目标、结果或模型选择逻辑"
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
    && js.includes(': "#config-editor";')
    && js.includes('tencentImage: "生图模型-腾讯版"')
    && js.includes('"tencentImage",'),
  "模型入口滚动目标映射不完整"
);
assert.ok(
  js.includes('section === "tencentImage" && this.data.activeConfigSection === section'),
  "腾讯版配置行再次点击后没有收起"
);
const localStatusSaveStart = js.indexOf("function saveTencentFaceFusionLocalStatus(status)");
const localStatusSaveEnd = js.indexOf("function mergeTencentFaceFusionStatus", localStatusSaveStart);
const localStatusSaveBody = js.slice(localStatusSaveStart, localStatusSaveEnd);
assert.ok(localStatusSaveStart >= 0 && localStatusSaveEnd > localStatusSaveStart);
assert.ok(!localStatusSaveBody.includes("secretId"), "腾讯本地测试状态不能保存 SecretId");
assert.ok(!localStatusSaveBody.includes("secretKey"), "腾讯本地测试状态不能保存 SecretKey");

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
  "admin config layout smoke: OK (五个模型参数区就地展开；腾讯版只读且位于生图和视频之间)"
);
