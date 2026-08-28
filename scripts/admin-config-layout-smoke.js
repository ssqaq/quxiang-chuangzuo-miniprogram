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
  "服务商/积分/成本/用户统一配置区必须只保留一个滚动目标"
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
  (quickLaunchBlock.match(/quick-tencentImage/g) || []).length,
  0,
  "腾讯版不能新增顶部快捷入口"
);
const imageRowIndex = currentConfigBlock.indexOf('data-section="image"');
const tencentRowIndex = currentConfigBlock.indexOf('data-section="tencentFaceFusion"');
const videoRowIndex = currentConfigBlock.indexOf('data-section="video"');
assert.ok(
  imageRowIndex >= 0 && imageRowIndex < tencentRowIndex && tencentRowIndex < videoRowIndex,
  "当前配置顺序必须是：生图模型 → 开始新创作-腾讯版 → 视频模型"
);
assert.strictEqual(
  (wxml.match(/class="current-config-row/g) || []).length,
  5,
  "当前配置模型行必须包含人脸、分析、生图、腾讯版和视频五项"
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
  (wxml.match(/class="[^"]*\btencent-status-card\b[^"]*"/g) || []).length,
  1,
  "腾讯参数卡只能存在于独立腾讯版配置面板一次"
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
  "logoAdd",
  "timeoutMs",
  "maxImageBytes"
].forEach((field) => {
  assert.ok(
    wxml.includes(`form.tencentFaceFusion.${field}`),
    `腾讯融合可编辑参数缺少 ${field}`
  );
});
assert.ok(
  wxml.includes("{{tencentFaceFusionStatus.statusText}}")
    && wxml.includes("{{tencentFaceFusionStatus.configured")
    && wxml.includes("value=\"{{form.tencentFaceFusion.model}}\"")
    && wxml.includes("value=\"{{form.tencentFaceFusion.region}}\""),
  "独立腾讯版面板缺少模型、区域或状态信息"
);
const imageEditorStart = wxml.indexOf('id="config-editor-image"');
const tencentEditorStart = wxml.indexOf('id="config-editor-tencentFaceFusion"');
assert.ok(imageEditorStart >= 0 && tencentEditorStart > imageEditorStart, "腾讯版面板必须位于生图面板之后");
const imageEditorBlock = wxml.slice(imageEditorStart, tencentEditorStart);
assert.ok(
  !imageEditorBlock.includes("tencent-tabs")
    && !imageEditorBlock.includes("tencentImageTab")
    && !imageEditorBlock.includes("switchTencentImageTab")
    && !imageEditorBlock.includes("tencent-fusion-tab-panel"),
  "普通生图面板不应再渲染腾讯融合页签"
);
const tencentEditorBlock = wxml.slice(tencentEditorStart, wxml.indexOf('data-section="video"', tencentEditorStart));
assert.strictEqual(
  (wxml.match(/data-section="tencentFaceFusion"/g) || []).length,
  11,
  "腾讯版编辑面板的参数字段和配置入口必须绑定同一 section"
);
assert.ok(
  /class="[^"]*\btencent-pipeline-editor\b[^"]*"/.test(tencentEditorBlock)
    && tencentEditorBlock.includes("开始新创作-腾讯版")
    && tencentEditorBlock.includes("tencentPipelineWizardStep")
    && tencentEditorBlock.includes("第 1 步：选择主生图模型")
    && tencentEditorBlock.includes("第 2 步：要不要启用备用生图")
    && tencentEditorBlock.includes("第 3 步：配置腾讯融合")
    && tencentEditorBlock.includes("第 4 步：测试并保存"),
  "独立腾讯版面板缺少四步向导"
);
assert.ok(
  !wxml.includes("tencentImageModelRole")
    && !wxml.includes("switchTencentImageModel")
    && wxml.includes("主模型：{{form.image.provider")
    && wxml.includes("备用模型：{{form.imageBackup.provider"),
  "图片模型和腾讯版的主备模型配置结构异常"
);
assert.ok(
  wxml.includes('data-model-config="image"')
    && wxml.includes('data-model-config="imageBackup"')
    && wxml.includes("data-section=\"image\"")
    && wxml.includes("data-section=\"imageBackup\""),
  "图片主备没有分别绑定 form.image/form.imageBackup"
);
assert.ok(
  js.includes("emptyTencentFaceFusionForm")
    && js.includes("tencentFaceFusionConfigFromForm")
    && js.includes("validateTencentFaceFusionForm")
    && js.includes("formWithTencentFaceFusionSecrets")
    && js.includes("onTencentLogoAddChange")
    && js.includes("onImageBackupCompatibilityChange"),
  "生图模型页面逻辑没有接入编辑、校验和主备配置"
);
assert.ok(
  wxml.includes("tencentFaceFusionFieldErrors.endpoint")
    && wxml.includes("tencentFaceFusionFieldErrors.apiVersion")
    && wxml.includes("tencentFaceFusionFieldErrors.timeoutMs"),
  "腾讯版字段错误提示缺失"
);
assert.ok(
  wxml.includes("腾讯测试参数")
    || wxml.includes("测试使用当前页面填写值")
    || wxml.includes("测试会使用当前页面填写的腾讯参数"),
  "腾讯真实测试没有说明使用当前页面参数"
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
const apiKeyInputs = wxml.match(
  /<input[^>]*(?:data-key|data-field-key)="apiKey"[^>]*>/g
) || [];
const apiKeyInputBySection = apiKeyInputs.reduce((result, input) => {
  const match = input.match(/data-section="([^"]+)"/);
  if (match) result[match[1]] = input;
  return result;
}, {});
assert.strictEqual(
  apiKeyInputs.length >= 8,
  true,
  "普通配置加图片主备、视频主备的 API Key 输入框必须完整"
);
assert.ok(
  ["face", "analysis", "image", "imageBackup"].every((section) => (
    apiKeyInputBySection[section]
    && !/\bpassword\b/.test(apiKeyInputBySection[section])
  )),
  "人脸、图片分析和图片主备 API Key 必须直接显示完整内容"
);
assert.ok(
  apiKeyInputBySection.video
    && /\bdisabled\b/.test(apiKeyInputBySection.video)
    && !/\bpassword\b/.test(apiKeyInputBySection.video),
  "视频 API Key 必须只读显示，不能再用密码输入"
);
assert.ok(
  apiKeyInputBySection.videoBackup
    && /\bdisabled\b/.test(apiKeyInputBySection.videoBackup)
    && !/\bpassword\b/.test(apiKeyInputBySection.videoBackup),
  "备用视频 API Key 必须只读显示，不能再用密码输入"
);
assert.ok(
  (wxml.match(/data-section="image" data-(?:key|field-key)="apiKey"/g) || []).length >= 1
    && (wxml.match(/data-section="imageBackup" data-(?:key|field-key)="apiKey"/g) || []).length >= 1,
  "图片主备 API Key 输入框缺失"
);
assert.ok(
  wxml.includes("form.image.apiKeyConfigured")
    && wxml.includes("form.face.apiKeyConfigured")
    && wxml.includes("form.analysis.apiKeyConfigured")
    && wxml.includes("form.imageBackup.apiKeyConfigured")
    && wxml.includes("form.video.apiKeyConfigured")
    && (wxml.match(/已显示完整 Key/g) || []).length >= 5
    && wxml.includes("已显示完整内容"),
  "五组模型或腾讯融合没有显示完整密钥状态"
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
  wxml.includes('range="{{faceProviderProfileOptions}}"')
    && wxml.includes('range="{{analysisProviderProfileOptions}}"')
    && wxml.includes('range="{{imageProviderProfileOptions}}"')
    && wxml.includes('range="{{imageBackupProviderProfileOptions}}"')
    && wxml.includes('range="{{videoProviderProfileOptions}}"')
    && wxml.includes('bindchange="onProviderProfileChange"')
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
  wxml.includes('class="image-wizard-intro"')
    && wxml.includes('class="image-wizard-progress"')
    && wxml.includes('bindtap="onImageWizardNext"')
    && wxml.includes('bindtap="onImageWizardPrev"')
    && wxml.includes('bindchange="onImageBackupEnabledChange"')
    && wxml.includes('bindtap="toggleImageAdvancedSettings"')
    && js.includes("validateImageWizardStep")
    && js.includes("imageWizardAdvancedOpen")
    && js.includes("Math.min(5, Math.round(parsed))"),
  "图片主备四步向导、备用开关或重试次数限制缺失"
);
assert.ok(
  wxml.includes("视频服务商设置")
    && wxml.includes("videoWizardStep")
    && wxml.includes('bindchange="onVideoBackupEnabledChange"')
    && wxml.includes("启用备用视频模型")
    && wxml.includes("onVideoWizardNext")
    && wxml.includes("onVideoWizardPrev")
    && wxml.includes("toggleVideoAdvancedSettings")
    && js.includes("validateVideoWizardStep")
    && js.includes("videoWizardAdvancedOpen")
    && js.includes("videoBackup.enabled"),
  "视频主备四步向导、备用开关或保存链路缺失"
);
assert.ok(
  (wxml.match(/data-model-config="imageBackup"/g) || []).length >= 2
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
     && js.includes("imageBackupEditCapabilityProbe")
     && js.includes("const configKey = modelConfigKeyForAction(")
     && js.includes("updateAdminProviderProfileForm")
     && js.includes("model: value"),
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
    && js.includes('tencentFaceFusion: "开始新创作-腾讯版"')
    && js.includes('"tencentFaceFusion"'),
  "模型入口滚动目标映射不完整"
);
assert.ok(
  js.includes('const section = rawSection === "tencentImage"')
    && js.includes('? "tencentFaceFusion" : rawSection;')
    && js.includes('this.data.activeConfigSection === section'),
  "腾讯旧入口没有迁移到独立腾讯版，或配置行再次点击后没有收起"
);
assert.ok(
  js.includes("validateTencentWizardStep")
    && js.includes("onTencentWizardNext")
    && js.includes("onTencentWizardPrev")
    && js.includes("tencentPipelineWizardStep")
    && wxml.includes("entryHealth.tencentFaceFusion")
    && wxml.includes("currentConfigModels.tencentFaceFusion"),
  "独立腾讯版四步向导、状态汇总或模型摘要没有接入管理页逻辑"
);
assert.ok(
  !js.includes("TENCENT_FACEFUSION_LAST_TEST_STORAGE_KEY")
    && !js.includes("saveTencentFaceFusionLocalStatus")
    && !js.includes("mergeTencentFaceFusionStatus"),
  "腾讯测试状态不能依赖本地缓存合并"
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
  "admin config layout smoke: OK (独立腾讯版卡片、四步向导和图片主备结构正确)"
);
