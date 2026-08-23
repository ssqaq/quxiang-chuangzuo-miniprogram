const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const jsonFiles = [
  "app.json",
  "project.config.json",
  "project.private.config.json",
  "sitemap.json",
  "pages/index/index.json",
  "pages/splash/splash.json",
  "pages/workbench/workbench.json",
  "pages/publish-export/publish-export.json",
  "pages/photo-to-video/photo-to-video.json",
  "pages/points/points.json",
  "pages/admin/admin.json",
  "cloudfunctions/api/package.json"
];
const jsFiles = [
  "app.js",
  "config.js",
  "services/cloud.js",
  "utils/storage.js",
  "utils/prompt.js",
  "utils/web-pose.js",
  "utils/mask.js",
  "utils/image.js",
  "utils/canvas-gesture.js",
  "utils/circle-gesture.js",
  "utils/publish-export.js",
  "utils/interaction-log.js",
  "utils/diagnostic-log.js",
  "pages/splash/splash.js",
  "pages/workbench/workbench.js",
  "pages/publish-export/publish-export.js",
  "pages/photo-to-video/photo-to-video.js",
  "pages/points/points.js",
  "pages/admin/admin.js",
  "pages/index/index.js",
  "pages/records/records.js",
  "cloudfunctions/api/index.js",
  "cloudfunctions/api/lib/logger.js",
  "cloudfunctions/api/lib/retry.js",
  "cloudfunctions/api/lib/multipart.js",
  "cloudfunctions/api/lib/web-pose.js",
  "scripts/check-deployment.js",
  "scripts/compat-smoke.js",
  "scripts/ai-provider-smoke.js",
  "scripts/image-smoke.js",
  "scripts/web-pose-smoke.js",
  "scripts/canvas-gesture-smoke.js",
  "scripts/index-canvas-touch-smoke.js",
  "scripts/page-scroll-lock-smoke.js",
  "scripts/circle-gesture-smoke.js",
  "scripts/auto-face-fallback-smoke.js",
  "scripts/cloud-error-propagation-smoke.js",
  "scripts/diagnostic-log-smoke.js",
  "scripts/generation-experience-smoke.js",
  "scripts/photo-to-video-smoke.js",
  "scripts/video-provider-smoke.js",
  "scripts/admin-config-smoke.js",
  "scripts/points-checkin-smoke.js",
  "scripts/generation-concurrency-smoke.js",
  "scripts/workbench-interaction-smoke.js",
  "scripts/model-usage-stats-smoke.js",
  "scripts/model-cost-stats-smoke.js"
];
const pythonFiles = ["scripts/package-release.py"];
const powerShellFiles = [
  "scripts/check-devtools.ps1",
  "scripts/refresh-preview.ps1"
];

for (const relative of jsonFiles) {
  const file = path.join(root, relative);
  JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`JSON OK  ${relative}`);
}

for (const relative of jsFiles) {
  const file = path.join(root, relative);
  cp.execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  console.log(`JS OK    ${relative}`);
}

for (const relative of pythonFiles) {
  const file = path.join(root, relative);
  cp.execFileSync("python", [
    "-c",
    "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
    file
  ], {
    stdio: "pipe",
    env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: "1" })
  });
  console.log(`PY OK    ${relative}`);
}

if (process.platform === "win32") {
  for (const relative of powerShellFiles) {
    const file = path.join(root, relative);
    const escaped = file.replace(/'/g, "''");
    const command = `[scriptblock]::Create((Get-Content -LiteralPath '${escaped}' -Raw)) | Out-Null`;
    cp.execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ], { stdio: "pipe" });
    console.log(`PS OK    ${relative}`);
  }
}

const required = [
  "app.json",
  "app.js",
  "project.config.json",
  "pages/splash/splash.js",
  "pages/splash/splash.json",
  "pages/splash/splash.wxml",
  "pages/splash/splash.wxss",
  "assets/brand/brand-icon.png",
  "assets/contact/author-wechat-qr.jpg",
  "pages/workbench/workbench.wxml",
  "pages/workbench/workbench.wxss",
  "utils/interaction-log.js",
  "utils/diagnostic-log.js",
  "scripts/refresh-preview.ps1",
  "一键刷新预览.cmd",
  "pages/publish-export/publish-export.js",
  "pages/publish-export/publish-export.json",
  "pages/publish-export/publish-export.wxml",
  "pages/publish-export/publish-export.wxss",
  "pages/photo-to-video/photo-to-video.js",
  "pages/photo-to-video/photo-to-video.json",
  "pages/photo-to-video/photo-to-video.wxml",
  "pages/photo-to-video/photo-to-video.wxss",
  "pages/points/points.js",
  "pages/points/points.json",
  "pages/points/points.wxml",
  "pages/points/points.wxss",
  "pages/admin/admin.js",
  "pages/admin/admin.json",
  "pages/admin/admin.wxml",
  "pages/admin/admin.wxss",
  "pages/index/index.wxml",
  "pages/index/index.wxss",
  "utils/canvas-gesture.js",
  "utils/circle-gesture.js",
  "scripts/canvas-gesture-smoke.js",
  "scripts/circle-gesture-smoke.js",
  "scripts/auto-face-fallback-smoke.js",
  "scripts/points-checkin-smoke.js",
  "scripts/model-cost-stats-smoke.js",
  "cloudfunctions/api/index.js"
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) {
    throw new Error(`缺少必要文件：${relative}`);
  }
}

const indexWxml = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
const appJson = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
const indexPageJson = JSON.parse(
  fs.readFileSync(path.join(root, "pages/index/index.json"), "utf8")
);
const projectConfig = JSON.parse(
  fs.readFileSync(path.join(root, "project.config.json"), "utf8")
);
const configJs = fs.readFileSync(path.join(root, "config.js"), "utf8");
const appWxss = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");
const splashJs = fs.readFileSync(path.join(root, "pages/splash/splash.js"), "utf8");
const splashWxml = fs.readFileSync(path.join(root, "pages/splash/splash.wxml"), "utf8");
const splashWxss = fs.readFileSync(path.join(root, "pages/splash/splash.wxss"), "utf8");
const workbenchJs = fs.readFileSync(path.join(root, "pages/workbench/workbench.js"), "utf8");
const workbenchWxml = fs.readFileSync(path.join(root, "pages/workbench/workbench.wxml"), "utf8");
const workbenchWxss = fs.readFileSync(path.join(root, "pages/workbench/workbench.wxss"), "utf8");
const publishExportJs = fs.readFileSync(
  path.join(root, "pages/publish-export/publish-export.js"),
  "utf8"
);
const publishExportWxml = fs.readFileSync(
  path.join(root, "pages/publish-export/publish-export.wxml"),
  "utf8"
);
const publishExportWxss = fs.readFileSync(
  path.join(root, "pages/publish-export/publish-export.wxss"),
  "utf8"
);
const publishExportUtil = fs.readFileSync(
  path.join(root, "utils/publish-export.js"),
  "utf8"
);
const photoToVideoJs = fs.readFileSync(
  path.join(root, "pages/photo-to-video/photo-to-video.js"),
  "utf8"
);
const photoToVideoWxml = fs.readFileSync(
  path.join(root, "pages/photo-to-video/photo-to-video.wxml"),
  "utf8"
);
const photoToVideoWxss = fs.readFileSync(
  path.join(root, "pages/photo-to-video/photo-to-video.wxss"),
  "utf8"
);
const indexJs = fs.readFileSync(path.join(root, "pages/index/index.js"), "utf8");
const indexWxss = fs.readFileSync(path.join(root, "pages/index/index.wxss"), "utf8");
const canvasGestureJs = fs.readFileSync(
  path.join(root, "utils/canvas-gesture.js"),
  "utf8"
);
const recordsJs = fs.readFileSync(path.join(root, "pages/records/records.js"), "utf8");
const recordsWxml = fs.readFileSync(path.join(root, "pages/records/records.wxml"), "utf8");
const recordsWxss = fs.readFileSync(path.join(root, "pages/records/records.wxss"), "utf8");
const cloudJs = fs.readFileSync(path.join(root, "cloudfunctions/api/index.js"), "utf8");
const clientCloudJs = fs.readFileSync(path.join(root, "services/cloud.js"), "utf8");
const cloudErrorSmokeJs = fs.readFileSync(
  path.join(root, "scripts/cloud-error-propagation-smoke.js"),
  "utf8"
);
const storageJs = fs.readFileSync(path.join(root, "utils/storage.js"), "utf8");
const webPoseJs = fs.readFileSync(path.join(root, "utils/web-pose.js"), "utf8");
const adminJs = fs.readFileSync(path.join(root, "pages/admin/admin.js"), "utf8");
const adminWxml = fs.readFileSync(path.join(root, "pages/admin/admin.wxml"), "utf8");
const adminWxss = fs.readFileSync(path.join(root, "pages/admin/admin.wxss"), "utf8");
const pointsJs = fs.readFileSync(path.join(root, "pages/points/points.js"), "utf8");
const pointsWxml = fs.readFileSync(path.join(root, "pages/points/points.wxml"), "utf8");
const pointsWxss = fs.readFileSync(path.join(root, "pages/points/points.wxss"), "utf8");
const refreshPreviewPs1 = fs.readFileSync(
  path.join(root, "scripts/refresh-preview.ps1"),
  "utf8"
);
if (!projectConfig.setting || projectConfig.setting.minified !== true) {
  throw new Error("微信开发者工具 JS 压缩没有开启，请确认 project.config.json 的 setting.minified 为 true。");
}
if (indexPageJson.navigationBarTitleText !== "") {
  throw new Error("首页顶部导航栏标题没有清空，请确认 pages/index/index.json 的 navigationBarTitleText 为空。");
}
if (
  appJson.window.navigationBarTitleText !== "圈像创作"
  || !indexWxml.includes('class="hero-title">圈像创作</view>')
  || !indexJs.includes('title: "圈像创作"')
) {
  throw new Error("小程序名称没有统一更新为“圈像创作”。");
}
if (
  !appJson.pages.includes("pages/admin/admin")
  || !adminJs.includes("cloud.getAdminStatus()")
  || !adminJs.includes("cloud.getAdminConfig()")
  || !adminJs.includes("cloud.saveAdminConfig")
  || !adminJs.includes("cloud.checkDeployment()")
  || !adminJs.includes("cloud.listDeploymentLogs()")
  || !adminWxml.includes("生图模型")
  || !adminWxml.includes("视频模型")
  || !adminWxml.includes("立即检查线上部署")
  || !adminWxml.includes("部署检查日志")
  || !adminWxml.includes("API Key")
  || !adminWxss.includes(".admin-grid")
  || !adminWxss.includes(".deployment-grid")
) {
  throw new Error("管理员配置页或部署检查日志入口不完整。");
}
if (
  !clientCloudJs.includes('action: "getModelUsageStats"')
  || !adminJs.includes("cloud.getModelUsageStats(30)")
  || !adminJs.includes("refreshModelUsage")
  || !adminWxml.includes("模型用量统计")
  || !adminWxml.includes("最近7天")
  || !adminWxml.includes("天每日明细")
  || !adminWxss.includes(".usage-summary-grid")
  || !adminWxss.includes(".usage-type-grid")
  || !adminWxss.includes(".usage-daily-list")
  || !cloudJs.includes("MODEL_USAGE_EVENT_COLLECTION")
  || !cloudJs.includes("getModelUsageStats")
  || !cloudJs.includes("video.create")
  || !cloudJs.includes("video.query")
  || !cloudJs.includes("aggregateModelUsageEvents")
) {
  throw new Error("三类模型用量统计入口或统计规则不完整。");
}
if (
  !clientCloudJs.includes("exportModelUsageStats")
  || !adminJs.includes("exportModelUsage")
  || !adminWxml.includes("按用户统计")
  || !adminWxml.includes("按模型名称分组")
  || !adminWxml.includes("按月份统计")
  || !adminWxml.includes("模型成本配置（人民币）")
  || !adminWxml.includes("导出 Excel")
  || !adminWxss.includes(".usage-cost-summary")
  || !adminWxss.includes(".usage-user-list")
  || !adminWxss.includes(".usage-monthly-list")
  || !cloudJs.includes("exportModelUsageStats")
  || !cloudJs.includes("buildModelUsageExportWorkbook")
  || !cloudJs.includes("resolveCostConfig")
  || !cloudJs.includes("userHash")
  || !cloudJs.includes("shiftMonthKey")
  || !cloudJs.includes("MODEL_COST_CONFIG_VERSION")
) {
  throw new Error("模型成本、按用户/模型、月度统计或 Excel 导出功能不完整。");
}
if (
  !appJson.pages.includes("pages/points/points")
  || !workbenchJs.includes("refreshPoints()")
  || !workbenchJs.includes("openPoints()")
  || !workbenchJs.includes("checkIn()")
  || !configJs.includes('cardTitle: "每日签到"')
  || !configJs.includes('streakPrefix: "连续签到"')
  || !configJs.includes('notCheckedIn: "今天还没签到"')
  || !configJs.includes('checkedIn: "今天已签到"')
  || !configJs.includes('freePrefix: "今天还可免费用"')
  || !configJs.includes('promoActive: "活动期间免费"')
  || !workbenchWxml.includes("pointsCopy.cardTitle")
  || !workbenchWxml.includes("pointsCopy.promoActive")
  || !workbenchWxml.includes('bindtap="openPoints"')
  || !workbenchWxml.includes('catchtap="checkIn"')
  || !workbenchWxss.includes(".points-entry-card")
  || !workbenchWxss.includes(".points-entry-promo-active")
  || !workbenchWxss.includes("justify-content: flex-start")
  || !workbenchWxss.includes("font-size: 18rpx")
  || !workbenchJs.includes("pointsCopy: config.points.copy")
  || !workbenchJs.includes("buildCheckInToast")
  || !pointsJs.includes("cloud.getUserPoints()")
  || !pointsJs.includes("cloud.checkIn()")
  || !pointsJs.includes("cloud.getPointLedger()")
  || !pointsJs.includes("pointsCopy: config.points.copy")
  || !pointsJs.includes("buildCheckInToast")
  || !pointsWxml.includes("pointsCopy.pointsSectionTitle")
  || !pointsWxml.includes("积分明细")
  || !pointsWxml.includes("pointsCopy.bindAndCheckIn")
  || !pointsWxml.includes("pointsCopy.pointsPromo")
  || !pointsWxss.includes(".streak-progress-fill")
  || !pointsWxss.includes(".ledger-row")
  || !cloudJs.includes('action === "getUserPoints"')
  || !cloudJs.includes('action === "checkIn"')
  || !cloudJs.includes('action === "getPointLedger"')
  || !clientCloudJs.includes("getUserPoints")
  || !clientCloudJs.includes("checkIn")
  || !clientCloudJs.includes("getPointLedger")
  || !configJs.includes("checkInDuplicate")
  || !configJs.includes("pointsPromo")
  || !refreshPreviewPs1.includes("wechat-miniapp-preview-latest-qr.png")
  || !refreshPreviewPs1.includes("wechat-miniapp-preview-latest-info.json")
) {
  throw new Error("积分签到入口、明细页或云函数路由不完整。");
}
if (
  !indexWxml.includes('class="hero-heading"')
  || !indexWxml.includes("区域锁定 · 人像参考 · AI 提示词")
  || !indexWxml.includes('wx:if="{{step === 0}}" class="primary-btn nav-action-button" bindtap="backToWorkbench">返回主页</button>')
  || indexWxml.includes('class="hero-back-button"')
  || indexWxml.includes('class="main-image-back-button"')
  || indexWxml.includes('class="hero-actions"')
) {
  throw new Error("创作页顶部卡片或底部导航区的标题、状态、说明和返回按钮结构不完整。");
}
const heroStyle = indexWxss.match(/\.hero\s*\{([^}]*)\}/);
const heroHeadingStyle = indexWxss.match(/\.hero-heading\s*\{([^}]*)\}/);
const heroSubtitleStyle = indexWxss.match(/\.hero-subtitle\s*\{([^}]*)\}/);
const heroStatusStyle = indexWxss.match(/\.status\s*\{([^}]*)\}/);
const navActionsStyle = indexWxss.match(/\.nav-actions\s*\{([^}]*)\}/);
const navActionButtonsStyle = indexWxss.match(/\.nav-actions button\s*\{([^}]*)\}/);
if (
  !heroStyle
  || !/flex-direction:\s*column/.test(heroStyle[1])
  || !/align-items:\s*stretch/.test(heroStyle[1])
  || !heroHeadingStyle
  || !/justify-content:\s*space-between/.test(heroHeadingStyle[1])
  || !heroSubtitleStyle
  || !/white-space:\s*nowrap/.test(heroSubtitleStyle[1])
  || !heroStatusStyle
  || !/white-space:\s*nowrap/.test(heroStatusStyle[1])
) {
  throw new Error("创作页顶部卡片或底部导航按钮样式不完整。");
}
if (
  !indexWxml.includes('class="primary-btn nav-action-button" bindtap="nextStep">下一步</button>')
  || !indexWxss.includes(".main-image-action-button,\n.nav-action-button")
  || !navActionsStyle
  || !/margin:\s*8rpx calc\(28rpx \+ 1px\) 0/.test(navActionsStyle[1])
  || !navActionButtonsStyle
  || !/width:\s*0/.test(navActionButtonsStyle[1])
  || !/flex:\s*1 1 0/.test(navActionButtonsStyle[1])
  || !/margin:\s*0/.test(navActionButtonsStyle[1])
) {
  throw new Error("底部步骤按钮没有收进卡片内边线，或没有复用“选择主图”的按钮规格。");
}
if (appJson.subpackages) {
  throw new Error("纯云端版本不应再配置本地人脸识别分包。");
}
const removedLocalFacePaths = [
  "utils/local-face.js",
  "utils/face-runtime",
  "face-runtime",
  "assets/face"
];
for (const relative of removedLocalFacePaths) {
  if (fs.existsSync(path.join(root, relative))) {
    throw new Error(`纯云端版本仍残留本地识别文件：${relative}`);
  }
}
const forbiddenLocalFacePatterns = [
  "localFace",
  "local-face",
  "face-runtime",
  "localFaceAssets",
  "WXWebAssembly",
  "MediaPipe"
];
const cloudOnlySources = [
  ["app.js", appJs],
  ["config.js", configJs],
  ["project.config.json", JSON.stringify(projectConfig)],
  ["pages/index/index.js", indexJs],
  ["pages/index/index.wxml", indexWxml],
  ["pages/index/index.wxss", indexWxss]
];
for (const [sourceName, source] of cloudOnlySources) {
  for (const pattern of forbiddenLocalFacePatterns) {
    if (source.includes(pattern)) {
      throw new Error(
        `纯云端版本的 ${sourceName} 仍包含本地识别标记：${pattern}`
      );
    }
  }
}
if (
  appJson.pages[0] !== "pages/splash/splash"
  || appJson.pages[1] !== "pages/workbench/workbench"
  || !splashJs.includes("setTimeout")
  || !splashJs.includes("REDIRECT_DELAY = 888")
  || !splashJs.includes("openWorkbench()")
  || !splashJs.includes("wx.redirectTo")
  || !splashJs.includes('wx.reLaunch')
  || !splashJs.includes('WORKBENCH_URL = "/pages/workbench/workbench"')
  || !splashWxml.includes('src="/assets/brand/brand-icon.png"')
  || !splashWxml.includes("圈定想改的，创作想要的。")
  || !splashWxml.includes("局部创作，整体可控")
  || !splashWxml.includes("正在进入创作空间")
  || !splashWxss.includes("background: #ffffff")
) {
  throw new Error("启动页没有完整配置图标、品牌文案或自动进入首页逻辑。");
}
const commonFeatureHeadingCount = (
  workbenchWxml.match(/<text>常用功能<\/text>/g) || []
).length;
const commonFeatureSubtitleCount = (
  workbenchWxml.match(/class="feature-group-subtitle"/g) || []
).length;
const workbenchEntryCardCount = workbenchWxml.includes('wx:if="{{adminVisible}}"') ? 6 : 5;
const diagnosticFeatureHeadingStyle = workbenchWxss.match(
  /\.diagnostic-feature-heading\s*\{([^}]*)\}/
);
const contactAuthorCardStyle = workbenchWxss.match(
  /\.contact-author-card\s*\{([^}]*)\}/
);
const contactAuthorQrStyle = workbenchWxss.match(
  /\.contact-author-qr\s*\{([^}]*)\}/
);
const contactAuthorSaveButtonStyle = workbenchWxss.match(
  /\.contact-author-save-button\s*\{([^}]*)\}/
);
const recentCardEmptyStyle = workbenchWxss.match(
  /\.recent-card-empty\s*\{([^}]*)\}/
);
if (
  !workbenchJs.includes("storage.loadProject()")
  || !workbenchJs.includes("storage.loadRecords()")
  || !workbenchJs.includes("storage.clearProject()")
  || !workbenchWxml.includes("今天，想创作什么？")
  || !workbenchJs.includes("开始新创作")
  || workbenchJs.includes("局部换脸")
  || workbenchJs.includes("换穿搭")
  || workbenchJs.includes("调姿势")
  || workbenchWxml.includes("继续上次编辑")
  || workbenchWxml.includes("未完成项目")
  || workbenchWxml.includes("draft-card")
  || workbenchWxml.includes("draft-empty")
  || workbenchJs.includes("continueDraft")
  || workbenchJs.includes("getProgress")
  || !workbenchWxml.includes("制作记录")
  || !workbenchWxss.includes(".hero-orbit-red")
  || !workbenchWxss.includes(".entry-card-custom")
  || !workbenchWxml.includes("workbench-link-card")
  || !workbenchWxml.includes("workbench-feature-stack")
  || !workbenchWxml.includes("feature-group-heading")
  || !workbenchWxml.includes("feature-group-dot")
  || commonFeatureHeadingCount !== 1
  || commonFeatureSubtitleCount !== 2
  || !workbenchWxml.includes('class="feature-group-heading diagnostic-feature-heading"')
  || workbenchWxml.indexOf("diagnostic-feature-heading") > workbenchWxml.indexOf('class="card interaction-log-card"')
  || !diagnosticFeatureHeadingStyle
  || !/margin-top:\s*28rpx/.test(diagnosticFeatureHeadingStyle[1])
  || !workbenchWxml.includes('class="card contact-author-card"')
  || workbenchWxml.indexOf("contact-author-card") < workbenchWxml.indexOf("interaction-log-card")
  || !workbenchWxml.includes('src="{{authorQrPath}}"')
  || !workbenchWxml.includes('bindtap="previewAuthorQr"')
  || !workbenchWxml.includes('show-menu-by-longpress="true"')
  || !workbenchWxml.includes('bindtap="saveAuthorQr"')
  || !workbenchWxml.includes("保存二维码")
  || !workbenchJs.includes('AUTHOR_QR_PATH = "/assets/contact/author-wechat-qr.jpg"')
  || !workbenchJs.includes("previewAuthorQr()")
  || !workbenchJs.includes("saveAuthorQr()")
  || !workbenchJs.includes("wx.saveImageToPhotosAlbum")
  || !contactAuthorCardStyle
  || !/margin-top:\s*16rpx/.test(contactAuthorCardStyle[1])
  || !contactAuthorQrStyle
  || !/width:\s*420rpx/.test(contactAuthorQrStyle[1])
  || !contactAuthorSaveButtonStyle
  || !/width:\s*100%/.test(contactAuthorSaveButtonStyle[1])
  || workbenchWxml.includes("recent-empty-icon")
  || workbenchWxml.includes('wx:else class="recent-empty"')
  || workbenchWxml.includes("还没有制作记录，完成一张照片后会显示在这里。")
  || workbenchWxml.includes("recent-empty-copy")
  || !workbenchWxml.includes("'recent-card-filled' : 'recent-card-empty'")
  || !recentCardEmptyStyle
  || !/min-height:\s*0/.test(recentCardEmptyStyle[1])
  || !workbenchWxss.includes("white-space: nowrap")
  || !workbenchWxss.includes("text-overflow: ellipsis")
  || !workbenchWxss.includes("margin-left: 94rpx")
  || !workbenchWxss.includes("margin-left: 78rpx")
  || !workbenchWxss.includes(".workbench-feature-stack .entry-grid")
  || !workbenchWxss.includes(".workbench-feature-stack .recent-card")
  || !workbenchWxss.includes(".workbench-feature-stack .publish-export-entry")
  || !workbenchWxss.includes("margin-bottom: 12rpx")
  || !workbenchWxss.includes("margin-bottom: 20rpx")
  || !workbenchWxss.includes("margin-top: 20rpx")
  || !workbenchWxml.includes("feature-card-icon")
  || !workbenchWxml.includes('catchtap="openRecords"')
  || !workbenchWxml.includes('catchtap="previewRecord"')
  || !workbenchJs.includes(".slice(0, 1)")
  || !workbenchWxss.includes(".feature-card-leading")
  || !workbenchWxss.includes(".recent-card-icon")
  || workbenchWxss.includes(".draft-card")
  || workbenchWxss.includes(".draft-empty")
  || workbenchWxss.includes(".empty-project-icon")
  || !workbenchWxss.includes(".workbench-link-card")
  || !workbenchWxss.includes(".workbench-link-card-hover")
  || !workbenchWxss.includes(".workbench-feature-stack")
  || !workbenchWxss.includes(".workbench-feature-stack .entry-grid")
  || !workbenchWxss.includes("margin-top: 16rpx")
  || !workbenchWxss.includes(".feature-group-heading")
  || !workbenchWxss.includes(".feature-group-dot")
  || !workbenchWxss.includes("margin-bottom: 6rpx")
  || !workbenchWxss.includes("font-size: 30rpx")
  || workbenchWxss.includes(".recent-empty-icon")
  || workbenchWxss.includes(".recent-empty-copy")
  || !workbenchWxss.includes(".recent-card")
  || !workbenchWxss.includes(".home-feature-card")
  || !workbenchWxss.includes("min-height: 148rpx")
  || !workbenchWxss.includes("transition: transform 0.08s ease")
  || !workbenchWxss.includes("transform: scale(0.985)")
  || (workbenchWxml.match(/hover-start-time="0"/g) || []).length !== workbenchEntryCardCount
  || (workbenchWxml.match(/hover-stay-time="70"/g) || []).length !== workbenchEntryCardCount
  || !workbenchJs.includes("openPage(url, failureTitle, logLabel)")
  || !workbenchJs.includes("replacePage(url, failureTitle, logLabel)")
  || !workbenchJs.includes("wx.redirectTo")
  || !workbenchJs.includes('this.openPage(url, "制作页打开失败", "已打开制作页")')
  || !workbenchJs.includes("this._navigating = true")
  || workbenchJs.includes("wx.showLoading")
  || workbenchJs.includes("wx.hideLoading")
  || workbenchJs.includes("this.data.navigating")
  || workbenchJs.includes("navigating: false")
  || (workbenchWxml.match(/home-feature-arrow/g) || []).length !== workbenchEntryCardCount
  || !workbenchWxml.includes("recent-more-arrow")
  || !workbenchWxml.includes("recent-more-label")
  || !workbenchWxss.includes(".home-feature-arrow")
  || !workbenchWxss.includes(".recent-more-arrow")
  || !workbenchWxss.includes("font-size: 36rpx")
  || !workbenchWxss.includes("right: 18rpx")
  || !workbenchWxss.includes("@keyframes workbench-page-enter")
  || !workbenchWxss.includes("animation: workbench-page-enter 180ms ease-out both")
  || !workbenchWxss.includes("transform: translateY(8rpx)")
  || !workbenchWxss.includes("animation: none")
  || !workbenchWxss.includes("border-color: #f2ddc5")
  || !workbenchWxss.includes("@media (min-width: 400px)")
  || !workbenchWxss.includes("@media (max-width: 340px)")
) {
  throw new Error("创作工作台统一箭头、进入动画或现有入口体验不完整。");
}
if (
  !indexJs.includes("wx.nextTick(loadRecordsAfterFirstRender)")
  || !indexJs.includes("setTimeout(loadRecordsAfterFirstRender, 0)")
  || !indexJs.includes("[index] 制作页首屏初始化完成")
  || !indexJs.includes("const isPreload = options.preload === \"1\"")
  || !indexJs.includes("resetForNewCreation(mode)")
  || !indexJs.includes("pendingNewCreation")
) {
  throw new Error("制作页云端记录读取没有延后到首屏显示之后。");
}
if (
  !workbenchJs.includes("buildNewCreationUrl")
  || !workbenchJs.includes("new=1")
  || !workbenchJs.includes("url,")
  || !workbenchJs.includes("pendingNewCreation")
  || !workbenchJs.includes("openNewCreationPage(url)")
  || !workbenchJs.includes("wx.redirectTo")
  || !workbenchJs.includes("wx.reLaunch")
  || !workbenchJs.includes('"draft-auto-clear"')
  || workbenchJs.includes('confirmText: "清除新建"')
  || workbenchJs.includes('cancelText: "保留草稿"')
  || workbenchJs.includes("draft-confirmation")
  || workbenchJs.includes("draft-kept")
  || !workbenchWxml.includes('bindtap="startNew"')
) {
  throw new Error("开始新创作没有配置稳定跳转和失败兜底逻辑。");
}
if (
  !workbenchJs.includes('require("../../utils/diagnostic-log")')
  || !workbenchJs.includes("refreshDiagnostics()")
  || !workbenchJs.includes("toggleDiagnosticPanel()")
  || !workbenchJs.includes("diagnosticExpanded: false")
  || !workbenchJs.includes("copyDiagnosticReport()")
  || !workbenchJs.includes("clearDiagnosticLogs()")
  || !workbenchJs.includes("refreshAdminAccess()")
  || !workbenchJs.includes("adminVisible")
  || !workbenchJs.includes("new-creation-navigation-timeout")
  || !workbenchJs.includes("draft-auto-clear")
  || !workbenchWxml.includes("查看问题报告")
  || !workbenchWxml.includes("<text>其他服务</text>")
  || !workbenchWxml.includes("作品记录、图片优化和问题反馈")
  || !workbenchWxml.includes("服务记录")
  || !workbenchWxml.includes("查看问题报告")
  || !workbenchWxml.includes("作者微信")
  || !workbenchWxml.includes("添加微信咨询")
  || !workbenchWxml.includes("diagnosticStats.eventCount")
  || !workbenchWxml.includes('catchtap="toggleDiagnosticPanel"')
  || !workbenchWxml.includes("diagnosticExpanded ? '收起' : '展开'")
  || !workbenchWxml.includes("diagnostic-expanded-content")
  || !(
    workbenchWxml.includes("bindtap=\"copyDiagnosticReport\"")
    || workbenchWxml.includes("catchtap=\"copyDiagnosticReport\"")
  )
  || !workbenchWxml.includes("复制报告")
  || !workbenchWxml.includes("interaction-log-primary-button")
  || !workbenchWxss.includes("height: 72rpx")
  || !workbenchWxss.includes("flex: 1 1 0")
  || !workbenchWxss.includes("gap: 12rpx")
  || !workbenchWxss.includes(".interaction-log-primary-button")
  || !workbenchWxml.includes("diagnosticEvents")
  || !workbenchWxss.includes(".interaction-log-card")
  || !workbenchWxss.includes(".interaction-log-list")
  || !workbenchWxss.includes(".diagnostic-toggle-head")
  || !workbenchWxss.includes(".diagnostic-toggle-arrow-expanded")
  || !indexJs.includes('require("../../utils/diagnostic-log")')
  || !indexJs.includes('logMethod("auto-face"')
  || !photoToVideoJs.includes('require("../../utils/diagnostic-log")')
  || !photoToVideoJs.includes('diagnosticLog.info("video"')
  || !publishExportJs.includes('require("../../utils/diagnostic-log")')
  || !publishExportJs.includes('diagnosticLog.info("export"')
  || !recordsJs.includes('require("../../utils/diagnostic-log")')
  || !recordsJs.includes('diagnosticLog.info("records"')
  || !fs.existsSync(path.join(root, "scripts", "diagnostic-log-smoke.js"))
  || !fs.existsSync(path.join(root, "scripts", "refresh-preview.ps1"))
  || !fs.existsSync(path.join(root, "一键刷新预览.cmd"))
) {
  throw new Error("故障排查报告、真机跳转兜底或一键刷新预览功能不完整。");
}
if (
  !clientCloudJs.includes('action: "getAdminStatus"')
  || !clientCloudJs.includes("retryLimit: 0")
  || !clientCloudJs.includes("silent: true")
  || !clientCloudJs.includes("if (silent)")
  || !cloudErrorSmokeJs.includes("管理员入口探测失败时只应静默请求一次")
) {
  throw new Error("管理员入口探测失败时没有静默处理，仍会刷重试报错。");
}
if (
  !workbenchWxml.includes("降低 AI 痕迹")
  || !workbenchWxml.includes('bindtap="openPublishExport"')
  || !workbenchJs.includes('"/pages/publish-export/publish-export"')
  || !workbenchJs.includes("openPublishExport()")
  || !workbenchWxss.includes(".publish-export-entry")
  || workbenchWxml.indexOf("降低 AI 痕迹") < workbenchWxml.indexOf("制作记录")
) {
  throw new Error("首页“降低AI识别率再导出照片”入口没有放在制作记录卡片下面。");
}
if (
  !appJson.pages.includes("pages/publish-export/publish-export")
  || !publishExportJs.includes("storage.loadRecords()")
  || !publishExportJs.includes("cloud.listRecords()")
  || !publishExportJs.includes("scopeOptions")
  || !publishExportJs.includes("最新一张")
  || !publishExportJs.includes("全部记录")
  || publishExportJs.includes('value: "device"')
  || !publishExportJs.includes("usingDevicePhotos")
  || !publishExportJs.includes("chooseDevicePhotos()")
  || !publishExportJs.includes("wx.chooseMedia")
  || !publishExportJs.includes("wx.chooseImage")
  || !publishExportJs.includes("deviceRecords")
  || !publishExportJs.includes("publishExport.resolveImageSource")
  || !publishExportJs.includes("publishExport.renderToTempFile")
  || !publishExportJs.includes("publishExport.saveToAlbum")
  || !publishExportWxml.includes("降低AI识别率再导出照片")
  || !publishExportWxml.includes("会生成一张新的处理图，原图不变；图片里的文字和水印不会被删除。")
  || !publishExportWxml.includes("1. 导入照片")
  || !publishExportWxml.includes("从手机相册选择照片导入")
  || !publishExportWxml.includes("选择照片")
  || !publishExportWxml.includes("source-upload-card")
  || publishExportWxml.includes("手机照片")
  || publishExportWxml.includes("scope === 'device'")
  || !publishExportWxml.includes("usingDevicePhotos")
  || !publishExportWxml.includes('class="primary-btn upload-main-button" bindtap="goToCreate"')
  || !publishExportWxml.includes("开始导出并保存到相册")
  || !publishExportWxml.includes('bindtap="backToWorkbench"')
  || !publishExportWxss.includes(".publish-export-canvas")
  || !publishExportWxss.includes(".source-upload-card")
  || !publishExportWxss.includes(".upload-main-button")
  || !publishExportWxss.includes(".scope-button-active")
  || !publishExportUtil.includes("wx.canvasToTempFilePath")
  || !publishExportUtil.includes("wx.saveImageToPhotosAlbum")
  || !publishExportUtil.includes("getOutputSize")
) {
  throw new Error("降低AI识别率再导出照片页面或 Canvas 保存链路不完整。");
}
const publishScopeButtonStyle = publishExportWxss.match(
  /\.scope-button\s*\{([^}]*)\}/
);
if (
  !publishScopeButtonStyle
  || !/height:\s*80rpx/.test(publishScopeButtonStyle[1])
  || !/min-height:\s*80rpx/.test(publishScopeButtonStyle[1])
  || !/font-size:\s*28rpx/.test(publishScopeButtonStyle[1])
  || !/align-items:\s*center/.test(publishScopeButtonStyle[1])
  || !/justify-content:\s*center/.test(publishScopeButtonStyle[1])
  || !/line-height:\s*1/.test(publishScopeButtonStyle[1])
) {
  throw new Error("“最新一张/全部记录”按钮没有和主图操作按钮统一字号、高度或居中规则。");
}
if (
  !appJson.pages.includes("pages/photo-to-video/photo-to-video")
  || !workbenchWxml.includes("照片转实况图")
  || !workbenchWxml.includes("生成动态视频，照片也会保留")
  || !workbenchWxml.includes('bindtap="openPhotoToVideo"')
  || !workbenchJs.includes("openPhotoToVideo()")
  || !workbenchJs.includes('"/pages/photo-to-video/photo-to-video"')
  || !workbenchWxss.includes(".photo-to-video-entry")
  || !photoToVideoJs.includes("cloud.getVideoProviderStatus()")
  || !photoToVideoJs.includes("cloud.createVideoTask")
  || !photoToVideoJs.includes("cloud.queryVideoTask")
  || !photoToVideoJs.includes("wx.saveImageToPhotosAlbum")
  || !photoToVideoJs.includes("wx.saveVideoToPhotosAlbum")
  || !photoToVideoJs.includes("onPreviewTouchStart()")
  || !photoToVideoJs.includes("retryOne(event = {})")
  || !photoToVideoWxml.includes("照片转动态视频")
  || !photoToVideoWxml.includes("不会自动变成系统实况照片")
  || !photoToVideoWxml.includes('class="live-preview-touch-layer"')
  || !photoToVideoWxml.includes('id="photo-to-video-preview"')
  || !photoToVideoWxss.includes(".live-preview-image")
  || !photoToVideoWxss.includes(".live-preview-video-visible")
  || !cloudJs.includes('action === "videoProviderStatus"')
  || !cloudJs.includes('action === "createVideoTask"')
  || !cloudJs.includes('action === "queryVideoTask"')
  || !cloudJs.includes("VIDEO_PROVIDER_NOT_CONFIGURED")
  || !cloudJs.includes("buildVideoGenerationPayload")
  || !cloudJs.includes("normalizeVideoCreateResponse")
  || !cloudJs.includes("normalizeVideoQueryResponse")
  || !cloudJs.includes("AI_VIDEO_BASE_URL")
  || cloudJs.includes("VIDEO_PROVIDER_PROTOCOL_PENDING")
  || !photoToVideoJs.includes("maxConcurrent")
  || !photoToVideoJs.includes("PHOTO_TO_VIDEO_CANCELLED")
  || !photoToVideoJs.includes("resultFileID")
  || !photoToVideoJs.includes("flushPhotoToVideoCleanup")
  || !photoToVideoJs.includes("enqueuePhotoToVideoCleanup")
  || !storageJs.includes("loadPhotoToVideoCleanup")
  || !storageJs.includes("savePhotoToVideoCleanup")
  || !clientCloudJs.includes("function deleteFile")
) {
  throw new Error("照片转动态视频入口、长按预览或云函数接口骨架不完整。");
}
if (
  indexWxml.includes("<text>项目设置</text>")
  || indexWxml.includes('bindtap="clearProject"')
  || indexWxml.includes('bindinput="onProjectNameInput"')
) {
  throw new Error("首页仍然包含已删除的项目设置卡片或事件绑定。");
}
const singleLineInputStyle = appWxss.match(/\.input\s*\{([^}]*)\}/);
if (
  !singleLineInputStyle
  || !/height:\s*84rpx/.test(singleLineInputStyle[1])
  || !/line-height:\s*84rpx/.test(singleLineInputStyle[1])
) {
  throw new Error("普通单行输入框缺少明确高度或文字居中规则。");
}
if (
  !indexWxml.includes('bindtap="clearMainImage"')
  || !indexWxml.includes('class="primary-btn main-image-action-button main-image-clear"')
  || !indexWxml.includes('class="canvas-image"')
  || !indexWxml.includes('disable-scroll="{{true}}"')
  || !indexWxml.includes('catchtouchmove="onCanvasTouchMove"')
) {
  throw new Error("主图清除按钮或红圈分层绘制结构不完整。");
}
const canvasTouchEvents = ["start", "move", "end", "cancel"];
if (
  indexWxml.includes("<page-meta")
  || indexJs.includes("pageScrollLocked")
  || indexJs.includes("pageScrollStyle")
  || indexJs.includes("setPageScrollLock")
  || indexJs.includes("restorePageScrollPosition")
  || indexJs.includes("wx.pageScrollTo")
  || indexJs.includes("position: fixed")
  || indexPageJson.disableScroll !== undefined
  || indexWxml.includes("capture-catchtouch")
  || canvasTouchEvents.some((eventName) => (
    (indexWxml.match(new RegExp(`catchtouch${eventName}=\"onCanvasTouch`, "g")) || []).length !== 1
  ))
  || !indexJs.includes("getActiveTouchCount(event)")
  || !indexJs.includes("this.getActiveTouchCount(event) > 0")
  || !indexJs.includes("_pinchAwaitingRelease")
) {
  throw new Error("图片双指手势仍包含旧滚动补偿、重复绑定或缺少抬手保护。");
}
if (
  !indexWxml.includes('class="canvas-viewport"')
  || !indexWxml.includes("canvasScale")
  || !indexWxml.includes("canvasOffsetX")
  || !indexWxml.includes('catchtouchstart="onCanvasTouchStart"')
  || !indexWxml.includes('catchtouchmove="onCanvasTouchMove"')
  || indexWxml.includes("canvas-zoom-controls")
  || indexWxml.includes("canvas-zoom-button")
  || indexWxml.includes("canvas-zoom-label")
  || indexWxml.includes("canvas-zoom-reset")
  || indexWxml.includes("用手指从左上拖到右下")
  || !indexJs.includes("createPinchState")
  || !indexJs.includes("createTouchCoordinateContext")
  || !indexJs.includes("updatePinchView")
  || !indexJs.includes("mapViewportPointToCanvas")
  || !indexJs.includes("getViewportPoint(touch)")
  || !indexJs.includes("this.getCanvasPoint(touch)")
  || !indexJs.includes("resolveTouchPoints")
  || !indexJs.includes("zoomIn()")
  || !indexJs.includes("zoomOut()")
  || !indexJs.includes("resetCanvasView()")
  || !canvasGestureJs.includes("MAX_SCALE = 3.5")
  || !canvasGestureJs.includes("PINCH_SCALE_THRESHOLD = 0.04")
  || !canvasGestureJs.includes("PINCH_PAN_THRESHOLD = 10")
  || !canvasGestureJs.includes("createPinchState")
  || !canvasGestureJs.includes("createTouchCoordinateContext")
  || !canvasGestureJs.includes("resolveTouchPoints")
  || !canvasGestureJs.includes("updatePinchView")
  || canvasGestureJs.includes("source.offsetX")
  || canvasGestureJs.includes("source.screenX")
  || indexJs.includes("captureGestureEvent")
  || indexJs.includes("_lastGestureEvent")
) {
  throw new Error("主图双指缩放、平移或单指绘圈手势结构不完整。");
}
const mainImageActionStyle = fs.readFileSync(
  path.join(root, "pages/index/index.wxss"),
  "utf8"
).match(/\.main-image-action-button,\s*\.nav-action-button\s*\{([^}]*)\}/);
const mainImageActionsStyle = indexWxss.match(
  /\.main-image-actions button,\s*\.mask-action-row button\s*\{([^}]*)\}/
);
const maskActionRowStyle = indexWxss.match(
  /\.mask-action-row\s*\{\s*margin-top:\s*16rpx;/
);
if (
  !mainImageActionStyle
  || !mainImageActionsStyle
  || !maskActionRowStyle
  || !/height:\s*80rpx/.test(mainImageActionStyle[1])
  || !/font-size:\s*28rpx/.test(mainImageActionStyle[1])
  || !/align-items:\s*center/.test(mainImageActionStyle[1])
  || !/width:\s*100%/.test(indexWxss.match(/\.main-image-actions,\s*\.mask-action-row\s*\{([^}]*)\}/)[1])
  || !/width:\s*0/.test(mainImageActionsStyle[1])
  || !/flex:\s*1\s+1\s+0/.test(mainImageActionsStyle[1])
  || !/min-width:\s*0/.test(mainImageActionsStyle[1])
  || !maskActionRowStyle
  || !/box-sizing:\s*border-box/.test(mainImageActionsStyle[1])
) {
  throw new Error("两行主图操作按钮没有使用统一高度、字号、垂直居中或固定等宽规则。");
}
if (
  !indexJs.includes("clearMainImage()")
  || !indexJs.includes("autoFaceCircle()")
  || !indexJs.includes("selectFaceForCircle(faces, currentCircle)")
  || !indexJs.includes("circleFromFace(face)")
  || !indexJs.includes("this.scheduleCanvasDraw(preview)")
  || indexJs.includes("ctx.drawImage(image.path")
) {
  throw new Error("主图清除逻辑或红圈限帧优化没有正确生效。");
}
if (
  !indexWxml.includes('bindtap="autoFaceCircle"')
  || !indexWxml.includes("自动识别人脸")
  || indexWxml.includes("红圈自动贴脸")
  || !indexWxml.includes('class="mask-action-row"')
  || (indexWxml.match(/class="primary-btn main-image-action-button mask-action-button"/g) || []).length !== 2
  || indexWxml.includes('class="circle-info"')
  || !indexJs.includes("await cloud.detectFaceCircle({")
  || !indexJs.includes("this.enterManualFaceCircle(null)")
  || !indexJs.includes("this.enterManualFaceCircle(cloudError)")
  || !indexJs.includes('"cloud-start"')
  || !indexJs.includes('"detect-complete"')
  || !indexJs.includes('"cache-hit"')
  || !indexJs.includes("preloadMainImageUpload")
  || !indexJs.includes("AUTO_FACE_WIDTH_SCALE = 1.2")
  || !indexJs.includes("AUTO_FACE_HEIGHT_SCALE = 1.15")
  || !indexJs.includes("autoFaceStatus: createAutoFaceStatus()")
  || !cloudJs.includes('action === "detectFaceCircle"')
  || !cloudJs.includes("normalizeFaceDetections")
  || !cloudJs.includes('"cloud.download.finish"')
  || !cloudJs.includes('"face-detection.finish"')
  || !cloudJs.includes("imageEncodingMs")
  || !fs.readFileSync(path.join(root, "services/cloud.js"), "utf8").includes("detectFaceCircle(payload)")
) {
  throw new Error(
    "自动贴脸的云端调用、上传复用、缓存、尺寸控制、耗时日志或手动兜底逻辑不完整。"
  );
}
if (
  indexWxml.includes("云端自动贴脸完成")
  || indexWxml.includes("详细链路已写入故障排查报告")
  || indexWxml.includes("到工作台打开“故障排查报告”")
  || indexWxml.includes("auto-face-diagnostics-message")
  || indexWxml.includes("auto-face-diagnostics-meta")
  || indexWxml.includes("auto-face-diagnostics-hint")
  || !indexWxml.includes('class="auto-face-diagnostics-status"')
  || !indexWxml.includes('class="auto-face-diagnostics-duration"')
  || !indexWxml.includes("autoFaceStatus.durationText")
  || indexWxml.indexOf("auto-face-diagnostics-duration") > indexWxml.indexOf("auto-face-diagnostics-state")
) {
  throw new Error("自动贴脸卡片仍显示说明文字，或“用时”没有放到“已完成”左侧。");
}
const autoFaceStatusStyle = indexWxss.match(/\.auto-face-diagnostics-status\s*\{([^}]*)\}/);
const autoFaceDurationStyle = indexWxss.match(/\.auto-face-diagnostics-duration\s*\{([^}]*)\}/);
const autoFaceHeadStyle = indexWxss.match(/\.auto-face-diagnostics-head\s*\{([^}]*)\}/);
const autoFaceLeadingStyle = indexWxss.match(/\.auto-face-diagnostics-leading\s*\{([^}]*)\}/);
const autoFaceTitleStyle = indexWxss.match(/\.auto-face-diagnostics-title\s*\{([^}]*)\}/);
const autoFaceStateStyle = indexWxss.match(/\.auto-face-diagnostics-state\s*\{([^}]*)\}/);
if (
  !autoFaceStatusStyle
  || !/display:\s*flex/.test(autoFaceStatusStyle[1])
  || !/align-items:\s*center/.test(autoFaceStatusStyle[1])
  || !autoFaceDurationStyle
  || !autoFaceHeadStyle
  || !/min-height:\s*42rpx/.test(autoFaceHeadStyle[1])
  || !autoFaceLeadingStyle
  || !/display:\s*flex/.test(autoFaceLeadingStyle[1])
  || !/height:\s*42rpx/.test(autoFaceLeadingStyle[1])
  || !/align-items:\s*center/.test(autoFaceLeadingStyle[1])
  || !autoFaceTitleStyle
  || !/line-height:\s*42rpx/.test(autoFaceTitleStyle[1])
  || !/white-space:\s*nowrap/.test(autoFaceTitleStyle[1])
  || !autoFaceStateStyle
  || !/height:\s*42rpx/.test(autoFaceStateStyle[1])
) {
  throw new Error("自动贴脸卡片的标题、耗时和状态没有使用同高横向对齐布局。");
}
if (
  indexWxml.includes('class="asset-name"')
  || (indexWxml.match(/<textarea class="asset-note"/g) || []).length !== 2
  || (indexWxml.match(/class="asset-card-main"/g) || []).length !== 2
  || !indexWxml.includes('class="asset-actions face-actions"')
  || !indexWxml.includes('class="kind-switch"')
) {
  throw new Error("第 3 步参考素材卡片仍显示文件名，或全宽两行备注框结构不完整。");
}
const referenceActionStyle = indexWxss.match(/\.reference-action-btn\s*\{([^}]*)\}/);
const assetNoteStyle = indexWxss.match(/\.asset-note\s*\{([^}]*)\}/);
const actionRowStyle = indexWxss.match(/\.asset-actions,\s*\.kind-switch\s*\{([^}]*)\}/);
if (
  !referenceActionStyle
  || !/min-width:\s*0/.test(referenceActionStyle[1])
  || !/flex:\s*1/.test(referenceActionStyle[1])
  || !/white-space:\s*nowrap/.test(referenceActionStyle[1])
  || !assetNoteStyle
  || !/height:\s*104rpx/.test(assetNoteStyle[1])
  || !/line-height:\s*38rpx/.test(assetNoteStyle[1])
  || !actionRowStyle
  || !/flex-wrap:\s*nowrap/.test(actionRowStyle[1])
) {
  throw new Error("参考素材按钮单行布局或两行备注框样式不完整。");
}
if (
  !indexWxml.includes('class="analysis-actions"')
  || !indexWxml.includes('bindtap="analyzeMainImage"')
  || !indexWxml.includes('bindtap="analyzeWebPoses"')
  || !indexWxml.includes("AI 分析主图")
  || !indexWxml.includes("参考网感分析")
  || !indexWxml.includes("可以先手动填写;")
  || !indexWxml.includes("AI分析主图会填充四段描述，")
  || !indexWxml.includes("参考网感分析 会给出更上镜的姿势建议。")
  || indexWxml.includes("8 条更上镜")
  || indexWxml.includes("8条更上镜")
  || !indexWxml.includes('bindtap="selectWebPose"')
) {
  throw new Error("第 4 步双分析按钮、三行说明文案或网感姿势选择列表不完整。");
}
const desktopGuidance = [
  "请描述原图的场景地点、背景环境、时间氛围、拍摄设备感、图片画质、是否手机拍摄、是否普通生活照，以及哪些场景内容必须保持原样。",
  "请描述原图中人物的身体姿势、手部动作、头部角度、肩颈姿态、与镜头距离、身体朝向，并说明原动作和红圈外身体部分需要完全不变。",
  "请描述原图中红圈内原先的面部朝向、头部角度、眼神方向、视线落点、表情情绪、嘴唇状态和眉眼状态；替换后仍要匹配这些原图条件。",
  "请具体描述原图红圈内面部光影：光线颜色/色温，来自画面哪一侧，落在额头、鼻梁、脸颊、下巴等位置；阴影在眼窝、鼻翼、下颌或颈部哪里，高光和肤色反射如何；同时写妆容浓淡、皮肤纹理、清晰度、噪点、压缩痕迹和普通手机拍摄画质。"
];
if (
  desktopGuidance.some((text) => !indexWxml.includes(text))
  || !indexWxml.includes("光影、妆容与画质")
) {
  throw new Error("桌面端四段完整填写说明没有全部迁移到第 4 步。");
}
const compactAreaStyle = indexWxss.match(/\.compact-area\s*\{([^}]*)\}/);
if (
  !compactAreaStyle
  || !/height:\s*230rpx/.test(compactAreaStyle[1])
  || !/line-height:\s*38rpx/.test(compactAreaStyle[1])
) {
  throw new Error("第 4 步长说明输入框高度或行距不完整。");
}
if (
  indexWxml.includes("生成 / 刷新提示词")
  || indexWxml.includes("提示词草稿")
  || indexWxml.includes('bindtap="copyPrompt"')
  || indexWxml.includes('bindinput="onPromptInput"')
  || indexWxml.includes("负面约束")
  || indexJs.includes("copyPrompt()")
  || indexJs.includes("onPromptInput(event)")
  || indexWxss.includes(".prompt-box")
  || indexWxss.includes(".prompt-area")
  || indexWxss.includes(".negative-label")
) {
  throw new Error("用户不要的提示词草稿、复制、编辑或负面约束显示仍有残留。");
}
if (
  !indexJs.includes("refreshPromptDraft()")
  || !indexJs.includes("if (this.data.step === 3) this.refreshPromptDraft()")
  || !indexJs.includes("const promptProject = this.refreshPromptDraft()")
  || !indexJs.includes("project: promptProject")
  || !indexWxml.includes('wx:if="{{step === 3}}"')
) {
  throw new Error("隐藏草稿后的后台提示词自动刷新流程不完整。");
}
const analysisActionStyle = indexWxss.match(/\.analysis-action-button\s*\{([^}]*)\}/);
if (
  !analysisActionStyle
  || !/height:\s*72rpx/.test(analysisActionStyle[1])
  || !/font-size:\s*25rpx/.test(analysisActionStyle[1])
  || !/align-items:\s*center/.test(analysisActionStyle[1])
) {
  throw new Error("两个分析按钮没有共用相同高度、字号和垂直居中规则。");
}
if (
  !indexJs.includes("async analyzeWebPoses()")
  || !indexJs.includes("selectWebPose(event)")
  || !indexJs.includes("appendWebPosePromptBlock(")
  || !indexJs.includes("webPoseSuggestions: []")
  || !indexJs.includes("selectedWebPose: null")
) {
  throw new Error("网感姿势分析、选择、清除或发送追加逻辑不完整。");
}
if (
  !cloudJs.includes('action === "analyzeWebPoses"')
  || !cloudJs.includes("async function analyzeWebPoses(event)")
  || !cloudJs.includes("normalizeWebPoseSuggestions")
  || !webPoseJs.includes("【网感姿势授权开始】")
) {
  throw new Error("云端网感分析接口或提示词授权块不完整。");
}
if (
  indexWxml.includes("MVP 首版通过云函数调用服务端模型")
  || indexWxml.includes("我确认拥有主图、人脸和穿搭素材的使用授权")
  || indexWxml.includes('bindchange="onConsentChange"')
  || indexJs.includes("consentConfirmed")
  || indexJs.includes("onConsentChange")
  || cloudJs.includes("consent-required")
) {
  throw new Error("第 5 步仍残留已删除的技术说明或素材授权勾选限制。");
}
if (
  !indexWxml.includes('class="card generation-card"')
  || !indexWxml.includes('class="generation-actions"')
  || !indexWxml.includes('class="primary-btn generate-button"')
  || !indexWxml.includes('class="secondary-btn generation-records-button"')
  || !indexWxml.includes('class="generation-waiting generation-waiting-{{generationStage}}"')
  || !indexWxml.includes("generationElapsedSeconds")
  || !indexJs.includes("startGenerationTimer()")
  || !indexJs.includes("stopGenerationTimer()")
  || !indexJs.includes("generationWaitText")
  || !indexWxss.includes(".generation-waiting")
  || !indexWxss.includes("@keyframes generation-waiting-spin")
) {
  throw new Error("第 5 步生成等待状态或操作卡结构不完整。");
}
const generationActionStyle = indexWxss.match(/\.generation-actions button\s*\{([^}]*)\}/);
if (
  !generationActionStyle
  || !/height:\s*84rpx/.test(generationActionStyle[1])
  || !/font-size:\s*29rpx/.test(generationActionStyle[1])
  || !/width:\s*100%/.test(generationActionStyle[1])
) {
  throw new Error("第 5 步两个操作按钮没有统一大字号和同宽规则。");
}
if (
  appJson.tabBar
  || fs.existsSync(path.join(root, "custom-tab-bar/index.js"))
  || indexJs.includes("getTabBar")
  || recordsJs.includes("getTabBar")
  || indexJs.includes("wx.switchTab")
  || !indexJs.includes('wx.navigateTo({ url: "/pages/records/records" })')
  || !recordsWxml.includes('bindtap="backToCreate"')
  || !recordsWxml.includes("返回制作")
  || !recordsJs.includes("backToCreate()")
  || !recordsJs.includes('wx.reLaunch({ url: "/pages/index/index" })')
  || !recordsWxml.includes('bindtap="clearAll"')
  || !recordsWxml.includes("清空全部")
  || !recordsJs.includes("async clearAll()")
  || !recordsJs.includes("cloud.deleteRecord(item.id)")
  || !recordsJs.includes("部分记录未清理")
  || !recordsJs.includes("removingId")
  || !recordsWxss.includes(".records-clear-button")
  || !recordsWxss.includes(".record-remove-button")
  || !recordsWxss.includes(".records-back-button")
  || !indexWxss.includes("@media (min-width: 360px) and (max-width: 389px)")
  || !indexWxss.includes("@media (min-width: 400px) and (max-width: 430px)")
  || !recordsWxss.includes("@media (min-width: 360px) and (max-width: 389px)")
  || !recordsWxss.includes("@media (min-width: 400px) and (max-width: 430px)")
  || !workbenchWxss.includes("@media (min-width: 360px) and (max-width: 389px)")
  || !workbenchWxss.includes("@media (min-width: 400px) and (max-width: 430px)")
  || !/env\(safe-area-inset-bottom\)/.test(appWxss)
) {
  throw new Error("记录页删除清理、进入返回或375/414屏幕适配不完整。");
}
if (
  !indexWxml.includes("选择不需要修改的内容")
  || !indexWxml.includes("勾选的内容会保持原图，不参与修改。")
  || !indexWxml.includes('bindtap="toggleLockPanel"')
  || !indexWxml.includes('bindchange="onLockedElementsChange"')
  || !indexWxml.includes('wx:for="{{lockedElementOptions}}"')
  || !indexWxml.includes('class="textarea custom-lock-area"')
  || !indexWxml.includes("每行填写一项")
  || !indexJs.includes("createLockedElementOptions(")
  || !indexJs.includes("parseCustomLocks(")
  || !indexJs.includes("toggleLockPanel()")
  || !indexJs.includes("onLockedElementsChange(event)")
  || !indexJs.includes("lockedSelectionCount")
) {
  throw new Error("第 4 步固定保护选项、折叠交互或自定义内容逻辑不完整。");
}
const lockPanelControlStyle = indexWxss.match(/\.lock-panel-control\s*\{([^}]*)\}/);
const lockPanelHeadStyle = indexWxss.match(/\.lock-panel-head\s*\{([^}]*)\}/);
const lockPanelTitleStyle = indexWxss.match(/\.lock-panel-title\s*\{([^}]*)\}/);
const lockPanelToolbarStyle = indexWxss.match(/\.lock-panel-toolbar\s*\{([^}]*)\}/);
if (
  !indexWxml.includes('catchtap="selectAllLockedElements"')
  || !indexWxml.includes(">全选</button>")
  || (indexWxml.match(/class="lock-panel-control"/g) || []).length !== 2
  || !indexWxml.includes('class="lock-panel-copy"')
  || !indexWxml.includes('class="lock-panel-toolbar"')
  || !indexJs.includes("selectAllLockedElements()")
  || !indexJs.includes("const lockedElements = LOCKED_ELEMENTS.slice()")
  || !lockPanelHeadStyle
  || !/flex-direction:\s*column/.test(lockPanelHeadStyle[1])
  || !lockPanelTitleStyle
  || !/font-size:\s*36rpx/.test(lockPanelTitleStyle[1])
  || !lockPanelToolbarStyle
  || !/display:\s*flex/.test(lockPanelToolbarStyle[1])
  || !/justify-content:\s*space-between/.test(lockPanelToolbarStyle[1])
  || !lockPanelControlStyle
  || !/width:\s*72rpx/.test(lockPanelControlStyle[1])
  || !/min-width:\s*72rpx/.test(lockPanelControlStyle[1])
  || !/max-width:\s*72rpx/.test(lockPanelControlStyle[1])
  || !/height:\s*44rpx/.test(lockPanelControlStyle[1])
  || !/font-size:\s*22rpx/.test(lockPanelControlStyle[1])
) {
  throw new Error("保护选项标题字号、全选和收起按钮样式或全选逻辑不完整。");
}
const finalPrevStyle = indexWxss.match(/\.nav-actions\s+\.final-prev-button\s*\{([^}]*)\}/);
if (
  !indexWxml.includes('class="primary-btn nav-action-button {{step === 4 ? \'final-prev-button\' : \'\'}')
  || !finalPrevStyle
  || !/background:\s*#1f6feb\s*!important/.test(finalPrevStyle[1])
  || !/color:\s*#ffffff\s*!important/.test(finalPrevStyle[1])
) {
  throw new Error("第 5 步“上一步”没有和“去生成”使用同样的蓝色主按钮样式。");
}
const lockChipStyle = indexWxss.match(/\.lock-chip\s*\{([^}]*)\}/);
const customLockAreaStyle = indexWxss.match(/\.custom-lock-area\s*\{([^}]*)\}/);
if (
  !lockChipStyle
  || !/min-height:\s*58rpx/.test(lockChipStyle[1])
  || !customLockAreaStyle
  || !/height:\s*180rpx/.test(customLockAreaStyle[1])
  || !/line-height:\s*38rpx/.test(customLockAreaStyle[1])
) {
  throw new Error("保护选项按钮或加高自定义文字框样式不完整。");
}

console.log("微信小程序工程静态检查通过。");
