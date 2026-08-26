const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const jsonFiles = [
  "app.json",
  "project.config.json",
  "sitemap.json",
  "pages/index/index.json",
  "pages/splash/splash.json",
  "pages/profile/profile.json",
  "pages/workbench/workbench.json",
  "pages/tencent-face-fusion/tencent-face-fusion.json",
  "pages/publish-export/publish-export.json",
  "pages/photo-to-video/photo-to-video.json",
  "pages/watermark-remover/watermark-remover.json",
  "pages/photo-guide/photo-guide.json",
  "pages/points/points.json",
  "pages/admin/admin.json",
  "pages/repair/repair.json",
  "cloudfunctions/api/package.json",
  "cloudfunctions/watermark-gateway/package.json",
  "cloudfunctions/api/config.json",
  "scripts/database-indexes.json",
  "scripts/cloud-database-index-manager/package.json"
];
const optionalJsonFiles = ["project.private.config.json"];
const jsFiles = [
  "app.js",
  "config.js",
  "services/cloud.js",
  "utils/storage.js",
  "utils/prompt.js",
  "utils/web-pose.js",
  "utils/mask.js",
  "utils/repair.js",
  "utils/image.js",
  "utils/publish-export-core.js",
  "utils/canvas-gesture.js",
  "utils/image-preview.js",
  "components/main-image-preview/main-image-preview.js",
  "components/image-preview/image-preview.js",
  "utils/circle-gesture.js",
  "utils/publish-export.js",
  "utils/interaction-log.js",
  "utils/diagnostic-log.js",
  "utils/points-ui.js",
  "pages/splash/splash.js",
  "pages/profile/profile.js",
  "pages/workbench/workbench.js",
  "pages/tencent-face-fusion/tencent-face-fusion.js",
  "pages/publish-export/publish-export.js",
  "pages/photo-to-video/photo-to-video.js",
  "pages/watermark-remover/watermark-remover.js",
  "pages/photo-guide/photo-guide.js",
  "pages/points/points.js",
  "pages/admin/admin.js",
  "scripts/admin-runtime-compat-smoke.js",
  "scripts/admin-loading-smoke.js",
  "scripts/admin-layout-state-smoke.js",
  "scripts/admin-usage-entry-smoke.js",
  "scripts/admin-responsive-smoke.js",
  "scripts/admin-config-layout-smoke.js",
  "scripts/image-quality-smoke.js",
  "scripts/image-edit-routing-smoke.js",
  "scripts/image-provider-failover-smoke.js",
  "scripts/tencent-face-fusion-page-smoke.js",
  "scripts/tencent-face-fusion-smoke.js",
  "scripts/release-safety-smoke.js",
  "pages/index/index.js",
  "pages/records/records.js",
  "pages/repair/repair.js",
  "cloudfunctions/api/index.js",
  "cloudfunctions/watermark-gateway/index.js",
  "cloudfunctions/api/lib/logger.js",
  "cloudfunctions/api/lib/retry.js",
  "cloudfunctions/api/lib/multipart.js",
  "cloudfunctions/api/lib/web-pose.js",
  "cloudfunctions/api/lib/publish-export-core.js",
  "cloudfunctions/api/lib/action-registry.js",
  "cloudfunctions/api/lib/generation-execution-kernel.js",
  "cloudfunctions/api/lib/generation-state-machine.js",
  "cloudfunctions/api/lib/image-pixel-codec.js",
  "cloudfunctions/api/lib/image-composite.js",
  "cloudfunctions/api/lib/pixel-acceptance.js",
  "cloudfunctions/api/lib/pixel-protection-flow.js",
  "cloudfunctions/api/tests/pixel-protection.test.js",
  "scripts/database-index-core.js",
  "scripts/action-registry-smoke.js",
  "scripts/generation-execution-kernel-smoke.js",
  "scripts/generation-state-machine-smoke.js",
  "scripts/database-index-smoke.js",
  "scripts/cloud-database-index-manager/index.js",
  "scripts/check-deployment.js",
  "scripts/compat-smoke.js",
  "scripts/ai-provider-smoke.js",
  "scripts/image-smoke.js",
  "scripts/web-pose-smoke.js",
  "scripts/canvas-gesture-smoke.js",
  "scripts/index-canvas-touch-smoke.js",
  "scripts/page-scroll-lock-smoke.js",
  "scripts/real-device-textarea-smoke.js",
  "scripts/circle-gesture-smoke.js",
  "scripts/auto-face-fallback-smoke.js",
  "scripts/cloud-error-propagation-smoke.js",
  "scripts/diagnostic-log-smoke.js",
  "scripts/diagnostic-admin-logs-smoke.js",
  "scripts/generation-experience-smoke.js",
  "scripts/photo-to-video-smoke.js",
  "scripts/video-provider-smoke.js",
  "scripts/admin-config-smoke.js",
  "scripts/analysis-model-smoke.js",
  "scripts/analysis-cost-probe-smoke.js",
  "scripts/user-profile-smoke.js",
  "scripts/database-init-smoke.js",
  "scripts/points-checkin-smoke.js",
  "scripts/generation-concurrency-smoke.js",
  "scripts/repair-smoke.js",
  "scripts/workbench-interaction-smoke.js",
  "scripts/workbench-media-parser-layout-smoke.js",
  "scripts/watermark-m0-smoke.js",
  "scripts/watermark-transfer-smoke.js",
  "scripts/model-usage-stats-smoke.js",
  "scripts/model-cost-stats-smoke.js",
  "scripts/model-failure-stats-smoke.js",
  "scripts/auto-face-failure-stats-smoke.js",
  "scripts/photo-to-video-cleanup-smoke.js",
  "scripts/photo-to-video-session-smoke.js",
  "scripts/auto-face-probe-history-smoke.js",
  "scripts/publish-export-advanced-smoke.js",
  "scripts/publish-export-cloud-smoke.js",
  "scripts/main-image-preview-smoke.js",
  "scripts/image-preview-screenshot-smoke.js",
  "scripts/qr-real-device-smoke.js",
  "scripts/deployment-script-smoke.js"
];
const pythonFiles = ["scripts/package-release.py"];
const powerShellFiles = [
  "scripts/check-devtools.ps1",
  "scripts/deploy-and-verify-api.ps1",
  "scripts/init-cloud-database.ps1",
  "scripts/refresh-preview.ps1",
  "scripts/sync-to-github.ps1",
  "scripts/check-cloud-database-indexes.ps1",
  "scripts/install-git-hooks.ps1",
  "scripts/write-release-record.ps1"
];

for (const relative of jsonFiles) {
  const file = path.join(root, relative);
  JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`JSON OK  ${relative}`);
}

for (const relative of optionalJsonFiles) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    console.log(`JSON SKIP ${relative}（本机私有配置不存在）`);
    continue;
  }
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
    const command = `[scriptblock]::Create([IO.File]::ReadAllText('${escaped}', [Text.Encoding]::UTF8)) | Out-Null`;
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
  "pages/profile/profile.js",
  "pages/profile/profile.json",
  "pages/profile/profile.wxml",
  "pages/profile/profile.wxss",
  "assets/brand/brand-icon.png",
  "assets/contact/author-wechat-qr.jpg",
  "pages/workbench/workbench.wxml",
  "pages/workbench/workbench.wxss",
  "pages/tencent-face-fusion/tencent-face-fusion.js",
  "pages/tencent-face-fusion/tencent-face-fusion.json",
  "pages/tencent-face-fusion/tencent-face-fusion.wxml",
  "pages/tencent-face-fusion/tencent-face-fusion.wxss",
  "utils/interaction-log.js",
  "utils/diagnostic-log.js",
  "utils/points-ui.js",
  "scripts/refresh-preview.ps1",
  "scripts/sync-to-github.ps1",
  "scripts/install-git-hooks.ps1",
  "scripts/install-git-hooks.cmd",
  "scripts/write-release-record.ps1",
  "一键刷新预览.cmd",
  "pages/publish-export/publish-export.js",
  "pages/publish-export/publish-export.json",
  "pages/publish-export/publish-export.wxml",
  "pages/publish-export/publish-export.wxss",
  "pages/photo-to-video/photo-to-video.js",
  "pages/photo-to-video/photo-to-video.json",
  "pages/photo-to-video/photo-to-video.wxml",
  "pages/photo-to-video/photo-to-video.wxss",
  "pages/watermark-remover/watermark-remover.js",
  "pages/watermark-remover/watermark-remover.json",
  "pages/watermark-remover/watermark-remover.wxml",
  "pages/watermark-remover/watermark-remover.wxss",
  "assets/media/media-parser-demo.mp4",
  "assets/media/media-parser-demo.jpg",
  "pages/points/points.js",
  "pages/points/points.json",
  "pages/points/points.wxml",
  "pages/points/points.wxss",
  "pages/admin/admin.js",
  "pages/admin/admin.json",
  "pages/admin/admin.wxml",
  "pages/admin/admin.wxss",
  "scripts/admin-loading-smoke.js",
  "scripts/admin-runtime-compat-smoke.js",
  "scripts/admin-layout-state-smoke.js",
  "scripts/admin-usage-entry-smoke.js",
  "scripts/admin-responsive-smoke.js",
  "scripts/admin-config-layout-smoke.js",
  "scripts/image-quality-smoke.js",
  "scripts/image-edit-routing-smoke.js",
  "scripts/image-provider-failover-smoke.js",
  "scripts/tencent-face-fusion-page-smoke.js",
  "scripts/tencent-face-fusion-smoke.js",
  "scripts/release-safety-smoke.js",
  "scripts/diagnostic-admin-logs-smoke.js",
  "pages/index/index.wxml",
  "pages/index/index.wxss",
  "utils/canvas-gesture.js",
  "utils/image-preview.js",
  "components/main-image-preview/main-image-preview.js",
  "components/main-image-preview/main-image-preview.json",
  "components/main-image-preview/main-image-preview.wxml",
  "components/main-image-preview/main-image-preview.wxss",
  "components/image-preview/image-preview.js",
  "components/image-preview/image-preview.json",
  "components/image-preview/image-preview.wxml",
  "components/image-preview/image-preview.wxss",
  "utils/circle-gesture.js",
  "utils/publish-export-core.js",
  "workers/publish-export-worker.js",
  "cloudfunctions/api/lib/publish-export-core.js",
  "cloudfunctions/api/lib/action-registry.js",
  "cloudfunctions/api/lib/generation-execution-kernel.js",
  "cloudfunctions/api/lib/generation-state-machine.js",
  "cloudfunctions/api/lib/image-pixel-codec.js",
  "cloudfunctions/api/lib/image-composite.js",
  "cloudfunctions/api/lib/pixel-acceptance.js",
  "cloudfunctions/api/lib/pixel-protection-flow.js",
  "cloudfunctions/api/tests/pixel-protection.test.js",
  "scripts/canvas-gesture-smoke.js",
  "scripts/action-registry-smoke.js",
  "scripts/generation-execution-kernel-smoke.js",
  "scripts/generation-state-machine-smoke.js",
  "scripts/circle-gesture-smoke.js",
  "scripts/auto-face-fallback-smoke.js",
  "scripts/database-init-smoke.js",
  "scripts/init-cloud-database.ps1",
  "scripts/points-checkin-smoke.js",
  "scripts/model-cost-stats-smoke.js",
  "scripts/analysis-cost-probe-smoke.js",
  "scripts/auto-face-failure-stats-smoke.js",
  "cloudfunctions/api/index.js",
  "cloudfunctions/api/config.json",
  "cloudfunctions/watermark-gateway/index.js",
  "cloudfunctions/watermark-gateway/package.json",
  "cloudfunctions/watermark-gateway/.env.example",
  "docs/superpowers/specs/2026-08-25-zhuceka-watermark-provider-design.md",
  "scripts/workbench-media-parser-layout-smoke.js",
  "scripts/photo-to-video-cleanup-smoke.js",
  "scripts/photo-to-video-session-smoke.js",
  "scripts/watermark-transfer-smoke.js",
  "scripts/auto-face-probe-history-smoke.js",
  "scripts/publish-export-advanced-smoke.js",
  "scripts/publish-export-cloud-smoke.js",
  "scripts/main-image-preview-smoke.js",
  "scripts/image-preview-screenshot-smoke.js",
  "scripts/qr-real-device-smoke.js",
  "scripts/database-indexes.json",
  "scripts/database-index-core.js",
  "scripts/database-index-smoke.js",
  "scripts/deploy-and-verify-api.ps1",
  "scripts/deployment-script-smoke.js",
  "scripts/check-cloud-database-indexes.ps1",
  "scripts/cloud-database-index-manager/package.json",
  "scripts/cloud-database-index-manager/package-lock.json",
  "scripts/cloud-database-index-manager/index.js"
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) {
    throw new Error(`缺少必要文件：${relative}`);
  }
}

const databaseIndexes = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/database-indexes.json"), "utf8")
);
const databaseIndexPs1 = fs.readFileSync(
  path.join(root, "scripts/check-cloud-database-indexes.ps1"),
  "utf8"
);
if (
  databaseIndexes.version !== 1
  || !Array.isArray(databaseIndexes.indexes)
  || databaseIndexes.indexes.length !== 12
  || !databaseIndexes.indexes.some((item) => (
    item
    && item.collection === "watermark_transfer_temp_assets"
    && item.name === "idx_cleanup_after_asc"
    && Array.isArray(item.keys)
    && item.keys.length === 1
    && item.keys[0].name === "cleanupAfter"
    && item.keys[0].direction === 1
  ))
  || !databaseIndexPs1.includes("TENCENTCLOUD_SECRET_ID")
  || !databaseIndexPs1.includes("TENCENTCLOUD_SECRET_KEY")
  || !databaseIndexPs1.includes("Create this index? [Y/N/A/Q]")
  || !databaseIndexPs1.includes("Type the full index name to rebuild")
  || !databaseIndexPs1.includes("DATABASE_INDEX_CHECK_INCOMPLETE")
) {
  throw new Error("云数据库索引检查和逐项确认工具不完整。");
}

const indexWxml = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
const appJson = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
const indexPageJson = JSON.parse(
  fs.readFileSync(path.join(root, "pages/index/index.json"), "utf8")
);
const projectConfig = JSON.parse(
  fs.readFileSync(path.join(root, "project.config.json"), "utf8")
);
const appConfig = require(path.join(root, "config.js"));
const apiPackage = JSON.parse(
  fs.readFileSync(path.join(root, "cloudfunctions/api/package.json"), "utf8")
);
const apiLock = JSON.parse(
  fs.readFileSync(path.join(root, "cloudfunctions/api/package-lock.json"), "utf8")
);
const watermarkGatewayPackage = JSON.parse(
  fs.readFileSync(
    path.join(root, "cloudfunctions/watermark-gateway/package.json"),
    "utf8"
  )
);
const watermarkGatewayJs = fs.readFileSync(
  path.join(root, "cloudfunctions/watermark-gateway/index.js"),
  "utf8"
);
const watermarkGatewayEnvExample = fs.readFileSync(
  path.join(root, "cloudfunctions/watermark-gateway/.env.example"),
  "utf8"
);
const apiEnvExample = fs.readFileSync(
  path.join(root, "cloudfunctions/api/.env.example"),
  "utf8"
);
const cloudTriggerConfig = JSON.parse(
  fs.readFileSync(path.join(root, "cloudfunctions/api/config.json"), "utf8")
);
if (cloudTriggerConfig.timeout !== 900) {
  fail("cloudfunctions/api/config.json timeout 必须为 900 秒");
}
const configJs = fs.readFileSync(path.join(root, "config.js"), "utf8");
const appWxss = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");
const splashJs = fs.readFileSync(path.join(root, "pages/splash/splash.js"), "utf8");
const splashWxml = fs.readFileSync(path.join(root, "pages/splash/splash.wxml"), "utf8");
const splashWxss = fs.readFileSync(path.join(root, "pages/splash/splash.wxss"), "utf8");
const profileJs = fs.readFileSync(path.join(root, "pages/profile/profile.js"), "utf8");
const profileWxml = fs.readFileSync(path.join(root, "pages/profile/profile.wxml"), "utf8");
const profileWxss = fs.readFileSync(path.join(root, "pages/profile/profile.wxss"), "utf8");
const workbenchJs = fs.readFileSync(path.join(root, "pages/workbench/workbench.js"), "utf8");
const workbenchWxml = fs.readFileSync(path.join(root, "pages/workbench/workbench.wxml"), "utf8");
const workbenchWxss = fs.readFileSync(path.join(root, "pages/workbench/workbench.wxss"), "utf8");
const tencentFaceFusionJs = fs.readFileSync(
  path.join(root, "pages/tencent-face-fusion/tencent-face-fusion.js"),
  "utf8"
);
const tencentFaceFusionWxml = fs.readFileSync(
  path.join(root, "pages/tencent-face-fusion/tencent-face-fusion.wxml"),
  "utf8"
);
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
const publishExportCoreJs = fs.readFileSync(
  path.join(root, "utils/publish-export-core.js"),
  "utf8"
);
const publishExportWorkerJs = fs.readFileSync(
  path.join(root, "workers/publish-export-worker.js"),
  "utf8"
);
const cloudPublishExportCoreJs = fs.readFileSync(
  path.join(root, "cloudfunctions/api/lib/publish-export-core.js"),
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
const promptJs = fs.readFileSync(path.join(root, "utils/prompt.js"), "utf8");
const repairJs = fs.readFileSync(path.join(root, "pages/repair/repair.js"), "utf8");
const repairWxml = fs.readFileSync(path.join(root, "pages/repair/repair.wxml"), "utf8");
const repairWxss = fs.readFileSync(path.join(root, "pages/repair/repair.wxss"), "utf8");
const canvasGestureJs = fs.readFileSync(
  path.join(root, "utils/canvas-gesture.js"),
  "utf8"
);
const recordsJs = fs.readFileSync(path.join(root, "pages/records/records.js"), "utf8");
const recordsWxml = fs.readFileSync(path.join(root, "pages/records/records.wxml"), "utf8");
const recordsWxss = fs.readFileSync(path.join(root, "pages/records/records.wxss"), "utf8");
const cloudJs = fs.readFileSync(path.join(root, "cloudfunctions/api/index.js"), "utf8");
const generationKernelJs = fs.readFileSync(
  path.join(root, "cloudfunctions/api/lib/generation-execution-kernel.js"),
  "utf8"
);
const clientCloudJs = fs.readFileSync(path.join(root, "services/cloud.js"), "utf8");
const diagnosticLogJs = fs.readFileSync(
  path.join(root, "utils/diagnostic-log.js"),
  "utf8"
);
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
const initCloudDatabasePs1 = fs.readFileSync(
  path.join(root, "scripts/init-cloud-database.ps1"),
  "utf8"
);
const cleanupSmokeJs = fs.readFileSync(
  path.join(root, "scripts/photo-to-video-cleanup-smoke.js"),
  "utf8"
);
const getCssRule = (css, selector) => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : "";
};
const getCssProperty = (rule, property) => {
  const match = rule.match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`));
  return match ? match[1].trim() : "";
};
if (
  !appConfig.appVersion
  || apiPackage.version !== appConfig.appVersion
  || apiLock.version !== appConfig.appVersion
  || watermarkGatewayPackage.version !== appConfig.appVersion
  || !new RegExp(
    `const API_BUILD_VERSION = "${appConfig.appVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`
  ).test(cloudJs)
  || !/const API_BUILD_MARKER = "[^"]+"/.test(cloudJs)
  || !appConfig.photoToVideo
  || !appConfig.photoToVideo.cleanup
  || appConfig.photoToVideo.cleanup.idlePeriodMs !== 2 * 60 * 60 * 1000
  || appConfig.photoToVideo.cleanup.gracePeriodMs !== 3 * 24 * 60 * 60 * 1000
) {
  throw new Error("小程序、主云函数、媒体解析网关、云函数锁文件版本不一致，或照片转视频 2 小时/3×24 小时清理配置不正确。");
}
if (
  !cloudJs.includes("createGenerationExecutionKernel")
  || !cloudJs.includes("const generationExecutionKernel = createGenerationKernel()")
  || !cloudJs.includes("generationExecutionKernel.generate(event, context)")
  || !cloudJs.includes("operation.kind === \"image\"")
  || !generationKernelJs.includes("async function generate")
  || !generationKernelJs.includes("async function processGenerationQueue")
  || !generationKernelJs.includes("async function reconcileGenerationOperations")
  || !generationKernelJs.includes("deleteFile")
  || !generationKernelJs.includes("tempFileUrl")
  || !fs.existsSync(
    path.join(root, "scripts/generation-execution-kernel-smoke.js")
  )
) {
  throw new Error("生图执行内核、依赖注入、统一状态写入或内核专项测试不完整。");
}
if (
  appConfig.imageMode !== "edits"
  || !configJs.includes('imageMode: "edits"')
  || !/^AI_IMAGE_MODE=edits$/m.test(apiEnvExample)
  || !cloudJs.includes('firstEnv(["AI_IMAGE_PRIMARY_MODE", "AI_IMAGE_MODE"], DEFAULT_IMAGE_MODE)')
  || !cloudJs.includes("function hasImageEditAssets")
  || !cloudJs.includes('if (hasImageEditAssets(payload)) return "edits";')
  || !cloudJs.includes("missing-edit-asset")
  || !cloudJs.includes("function classifyImageEditResponse")
  || !cloudJs.includes('"image-edit-unsupported"')
  || !cloudJs.includes('"image-edit-endpoint-invalid"')
  || !cloudJs.includes('"image-edit-model-unsupported"')
  || !cloudJs.includes('"image-edit-upstream-error"')
  || !cloudJs.includes('imageEdit: true')
  || !cloudJs.includes('"image-edit.upstream-error"')
  || !cloudJs.includes("AI_IMAGE_EDIT_ENDPOINT")
  || !indexJs.includes("resolveImageGenerationMode(promptProject)")
  || !adminJs.includes('mode: "edits"')
  || !adminJs.includes('mode: image.mode || "edits"')
) {
  throw new Error("人脸替换的 edits 默认模式、素材强制分流或管理员默认配置不完整。");
}
if (
  !cloudJs.includes("function createFaceProtectionMask")
  || !cloudJs.includes("function faceProtectionRects")
  || !cloudJs.includes("TENCENT_FACE_PROTECTION_MARGIN_RATIO = 0.22")
  || !cloudJs.includes("TENCENT_PIPELINE_FACE_NOT_FOUND")
  || !cloudJs.includes("TENCENT_PIPELINE_MASK_REQUIRED")
  || !cloudJs.includes("detectTencentPipelineFaces")
  || !cloudJs.includes("probeImageEditCapability")
  || !clientCloudJs.includes('action: "probeImageEditCapability"')
  || !adminJs.includes("runImageEditCapabilityProbe")
  || !adminWxml.includes("检查图片编辑配置")
  || !adminJs.includes('liveVerifiedText: "未真实生图"')
  || !tencentFaceFusionJs.includes("PIPELINE_WAIT_TIMEOUT_MS = 150000")
  || !tencentFaceFusionJs.includes("continueStatusQuery()")
  || !tencentFaceFusionJs.includes("TENCENT_PIPELINE_CLIENT_TIMEOUT")
  || !tencentFaceFusionWxml.includes("生成脸部保护 mask")
  || !tencentFaceFusionWxml.includes('class="pipeline-dot">4</view>')
  || !tencentFaceFusionWxml.includes("继续查询结果")
) {
  throw new Error("腾讯版脸部保护 mask、管理员图片编辑检查或等待超时恢复逻辑不完整。");
}
if (
  !watermarkGatewayJs.includes('process.env.ZHUCEKA_UID')
  || !watermarkGatewayJs.includes('process.env.ZHUCEKA_KEY')
  || !watermarkGatewayJs.includes("resolveProviderRedirect")
  || !watermarkGatewayJs.includes("allowedOrigin")
  || /ZHUCEKA_UID\s*=\s*\d{5,}/.test(watermarkGatewayJs)
  || /ZHUCEKA_KEY\s*=\s*[A-Za-z0-9_-]{8,}/.test(watermarkGatewayJs)
  || !watermarkGatewayEnvExample.includes("在云函数控制台填写真实UID")
  || !watermarkGatewayEnvExample.includes("在云函数控制台填写真实Key")
) {
  throw new Error("媒体解析网关缺少环境变量或同源重定向防护，或疑似把真实 UID/Key 写进源码。");
}
if (
  !Array.isArray(cloudTriggerConfig.triggers)
  || !cloudTriggerConfig.triggers.some((item) => (
    item
    && item.name === "photo-to-video-idle-cleanup"
    && item.type === "timer"
    && item.config === "0 */15 * * * * *"
  ))
  || !cloudTriggerConfig.triggers.some((item) => (
    item
    && item.name === "photo-to-video-temp-cleanup"
    && item.type === "timer"
    && item.config === "0 0 3 * * * *"
  ))
  || !cloudTriggerConfig.triggers.some((item) => (
    item
    && item.name === "watermark-transfer-temp-cleanup"
    && item.type === "timer"
    && item.config === "0 */15 * * * * *"
  ))
) {
  throw new Error("照片转视频或媒体临时文件没有配置完整的自动清理触发器。");
}
if (
  !cloudJs.includes('const WATERMARK_TRANSFER_TEMP_COLLECTION = "watermark_transfer_temp_assets";')
  || !cloudJs.includes('action === "transferMedia"')
  || !cloudJs.includes('action === "releaseTransferMedia"')
  || !cloudJs.includes("cleanupWatermarkTransferTempAssets")
  || !clientCloudJs.includes('action: "transferMedia"')
  || !clientCloudJs.includes('action: "releaseTransferMedia"')
  || !clientCloudJs.includes("wx.cloud.downloadFile")
) {
  throw new Error("CloudBase 临时媒体转存、释放或下载链路不完整。");
}
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
  || !adminJs.includes("cloud.getAdminConfig")
  || !adminJs.includes("cloud.saveAdminConfig")
  || !adminJs.includes("cloud.checkDeployment()")
  || !adminJs.includes("cloud.listDeploymentLogs()")
  || !adminJs.includes("cloud.getAutoFaceProbeHistory()")
  || !adminJs.includes("refreshAutoFaceProbeHistory")
  || !clientCloudJs.includes('action: "getAutoFaceProbeHistory"')
  || !cloudJs.includes("AUTO_FACE_PROBE_LOG_COLLECTION")
  || !cloudJs.includes("getAutoFaceProbeHistory")
  || !cloudJs.includes("autoFaceProbeHistoryCutoff")
  || !adminWxml.includes("生图模型")
  || !adminWxml.includes("图片分析模型")
  || !adminWxml.includes("人脸识别模型")
  || !adminWxml.includes("视频模型")
  || !adminWxml.includes("检查线上部署")
  || !adminWxml.includes("一键刷新全部")
  || !adminWxml.includes("部署检查日志")
  || !adminWxml.includes("接口耗时")
  || !adminWxml.includes("云函数处理耗时")
  || !adminWxml.includes("探针历史")
  || !adminWxml.includes("API Key")
  || !adminWxss.includes(".admin-grid")
  || !adminWxss.includes(".deployment-grid")
  || !adminWxss.includes(".auto-face-probe-history-row")
) {
  throw new Error("管理员配置页或部署检查日志入口不完整。");
}
const adminQuickLaunchStyle = adminWxss.match(/\.quick-launch\s*\{([^}]*)\}/);
const adminConfigRowStyle = adminWxss.match(/\.current-config-row\s*\{([^}]*)\}/);
const adminCloseButtonStyle = adminWxss.match(/\.config-close-button\s*\{([^}]*)\}/);
const adminStatusCheckStyle = adminWxss.match(/\.status-check-button\s*\{([^}]*)\}/);
const adminMonitorToggleStyle = adminWxss.match(/\.monitor-toggle\s*\{([^}]*)\}/);
const adminUsageCostItemStyle = adminWxss.match(/\.usage-cost-item\s*\{([^}]*)\}/);
const adminUsageTypeCardStyle = adminWxss.match(/\.usage-type-card\s*\{([^}]*)\}/);
const adminUsageFailureSummaryStyle = adminWxss.match(/^\.usage-failure-summary-item\s*\{([^}]*)\}/m);
const adminFaceProbeSummaryStyle = adminWxss.match(/\.auto-face-probe-summary-item\s*\{([^}]*)\}/);
if (
  !adminWxml.includes("线上运行状态")
  || !adminWxml.includes("模型、积分与成本配置")
  || (
    !adminWxml.includes("更多监控与历史")
    && !adminWxml.includes("运行监控")
  )
  || (adminWxml.match(/class="quick-launch /g) || []).length < 8
  || adminWxml.indexOf("quick-face") > adminWxml.indexOf("quick-image")
  || adminWxml.indexOf("quick-face") > adminWxml.indexOf("quick-analysis")
  || adminWxml.indexOf("quick-analysis") > adminWxml.indexOf("quick-image")
  || adminWxml.indexOf("quick-image") > adminWxml.indexOf("quick-video")
  || adminWxml.indexOf("quick-usage") > adminWxml.indexOf("quick-points")
  || adminWxml.indexOf("quick-points") > adminWxml.indexOf("quick-costs")
  || adminWxml.indexOf("quick-costs") > adminWxml.indexOf("quick-users")
  || !adminWxml.includes('bindtap="jumpToUsageSection"')
  || !adminWxml.includes("entryHealth.usage.label")
  || !adminWxss.includes("grid-template-columns: repeat(4, minmax(0, 1fr))")
  || adminWxml.includes('class="console-back"') && adminWxml.includes("<button class=\"console-back\"")
  || !adminQuickLaunchStyle
  || !/width:\s*100%/.test(adminQuickLaunchStyle[1])
  || !/height:\s*136rpx/.test(adminQuickLaunchStyle[1])
  || !adminConfigRowStyle
  || !/width:\s*100%/.test(adminConfigRowStyle[1])
  || !adminCloseButtonStyle
  || !/display:\s*flex/.test(adminCloseButtonStyle[1])
  || !/align-items:\s*center/.test(adminCloseButtonStyle[1])
  || !/justify-content:\s*center/.test(adminCloseButtonStyle[1])
  || !adminStatusCheckStyle
  || !/display:\s*flex/.test(adminStatusCheckStyle[1])
  || !/align-items:\s*center/.test(adminStatusCheckStyle[1])
  || !/justify-content:\s*center/.test(adminStatusCheckStyle[1])
  || !adminMonitorToggleStyle
  || !/width:\s*100%/.test(adminMonitorToggleStyle[1])
  || !adminUsageCostItemStyle
  || !/align-items:\s*center/.test(adminUsageCostItemStyle[1])
  || !/justify-content:\s*center/.test(adminUsageCostItemStyle[1])
  || !adminUsageTypeCardStyle
  || !/align-items:\s*center/.test(adminUsageTypeCardStyle[1])
  || !/justify-content:\s*center/.test(adminUsageTypeCardStyle[1])
  || !adminUsageFailureSummaryStyle
  || !/align-items:\s*center/.test(adminUsageFailureSummaryStyle[1])
  || !/justify-content:\s*center/.test(adminUsageFailureSummaryStyle[1])
  || !adminFaceProbeSummaryStyle
  || !/align-items:\s*center/.test(adminFaceProbeSummaryStyle[1])
  || !/justify-content:\s*center/.test(adminFaceProbeSummaryStyle[1])
) {
  throw new Error("管理页八入口四列、图片分析独立配置或统计内容居中样式不完整。");
}
if (
  !appJson.pages.includes("pages/profile/profile")
  || appJson.pages[0] !== "pages/splash/splash"
  || splashJs.includes("getMyUserProfile")
  || workbenchJs.includes("ensureProfileAccess")
  || !workbenchJs.includes('"/pages/profile/profile?from=checkin"')
  || !pointsJs.includes('"/pages/profile/profile?from=checkin"')
  || !workbenchJs.includes("checkProfileAndCheckIn")
  || !pointsJs.includes("checkProfileAndCheckIn")
  || !profileWxml.includes('open-type="chooseAvatar"')
  || !profileWxml.includes('type="nickname"')
  || !profileWxml.includes('data-gender="male"')
  || !profileWxml.includes('data-gender="female"')
  || profileWxml.includes("只用于显示头像昵称和统计男女数量")
  || !profileWxml.includes("保存并签到")
  || !profileJs.includes('options.from === "checkin"')
  || !profileJs.includes('cloud.uploadAsset(this.data.avatarPath, "avatar"')
  || !profileJs.includes("cloud.saveMyUserProfile")
  || !profileJs.includes("cloud.checkIn()")
  || !profileWxss.includes(".gender-grid")
  || !clientCloudJs.includes('action: "getMyUserProfile"')
  || !clientCloudJs.includes('action: "saveMyUserProfile"')
  || !clientCloudJs.includes('action: "getAdminUserStats"')
  || !clientCloudJs.includes('action: "exportAdminUserStats"')
  || !cloudJs.includes('USER_PROFILE_COLLECTION = "user_profiles"')
  || !cloudJs.includes('REPAIR_ASSET_KINDS = new Set(["main", "mask", "face", "wardrobe", "background", "avatar"])')
  || !cloudJs.includes("getMyUserProfile")
  || !cloudJs.includes("saveMyUserProfile")
  || !cloudJs.includes("getAdminUserStats")
  || !cloudJs.includes("exportAdminUserStats")
  || !cloudJs.includes("buildAdminUserExportWorkbook")
  || !fs.existsSync(path.join(root, "scripts/user-profile-smoke.js"))
) {
  throw new Error("签到资料页、头像昵称性别保存、用户统计或隐私限制不完整。");
}
if (
  !adminJs.includes("face: {")
  || !adminJs.includes("analysis: {")
  || !adminJs.includes("buildAnalysisConfigSummary")
  || !adminJs.includes("buildCostTrend")
  || !adminJs.includes("formatUserStats")
  || !adminJs.includes("exportUserStats")
  || !adminJs.includes("buildEntryHealth")
  || !adminJs.includes("refreshAll")
  || !adminJs.includes("copyModelFailure")
  || !adminJs.includes("copyAutoFaceFailure")
  || !adminWxml.includes("最近7天成本")
  || !adminWxml.includes("总用户")
  || !adminWxml.includes("男性")
  || !adminWxml.includes("女性")
  || !adminWxml.includes("继续加载20条")
  || !adminWxml.includes("导出 Excel")
  || !adminWxml.includes("复制错误")
  || !adminWxss.includes(".cost-chart")
  || !adminWxss.includes(".admin-user-list")
  || !adminWxss.includes(".quick-launch.is-abnormal")
  || !adminWxss.includes(".copy-error-button")
  || !adminJs.includes("copyFaceConfigToAnalysis")
  || !adminJs.includes("cloud.probeModels(modelType)")
  || !adminJs.includes("probeSingleModel")
  || !adminJs.includes("mergeSingleModelProbe")
  || !adminJs.includes("analysisInputPerMillionTokens")
  || !adminWxml.includes("复制人脸配置")
  || !adminWxml.includes("探测四套模型")
  || !adminWxml.includes("单独探测")
  || !adminWxml.includes("图片分析输入 / 百万Token")
  || !adminWxml.includes("usageTypeLabel")
  || !adminWxss.includes(".config-tool-button")
  || !adminWxss.includes(".config-model-button")
  || !adminWxss.includes(".model-picker-dialog")
  || !adminJs.includes("testModelConnection")
  || !adminJs.includes("getModelOptions")
  || !adminJs.includes("cloud.listModels")
  || !adminJs.includes("onModelPickerSearchInput")
  || !adminJs.includes("filterModelOptions")
  || !adminJs.includes("formatModelConnectionFailure")
  || !adminJs.includes("modelProbeRepairAdvice")
  || !adminJs.includes("await this.runModelProbe(\"\")")
  || !adminJs.includes("compareModelNames")
  || !adminWxml.includes("搜索模型名称")
  || !adminWxml.includes("没有找到相关模型")
  || !adminWxml.includes("修复建议")
  || !adminWxss.includes(".model-picker-search-row")
  || !adminWxss.includes(".model-picker-empty")
  || !adminWxss.includes(".model-probe-repair")
  || !clientCloudJs.includes('action: "listModels"')
  || !adminWxss.includes(".model-probe-row")
  || !adminWxss.includes(".model-probe-single-button")
) {
  throw new Error("模型配置、图片分析价格、接口探测、失败类型或复制配置功能不完整。");
}
if (
  (adminWxml.match(/<text>服务商<\/text>/g) || []).length < 4
  || (adminWxml.match(/<text>使用的模型<\/text>/g) || []).length < 4
  || (adminWxml.match(/<text>接口地址<\/text>/g) || []).length < 4
  || (adminWxml.match(/<text>API Key<\/text>/g) || []).length < 4
  || adminWxml.includes("<text>Provider</text>")
  || adminWxml.includes("<text>Model</text>")
  || adminWxml.includes("<text>Base URL</text>")
  || adminWxml.includes("Endpoint（可空）")
  || adminWxml.includes("创建 Endpoint")
  || adminWxml.includes("查询 Endpoint")
) {
  throw new Error("四个模型配置区的字段中文名称或 Endpoint 删除不完整。");
}
const adminApiKeyInputs = adminWxml.match(/<input[^>]*data-key="apiKey"[^>]*>/g) || [];
if (
  adminApiKeyInputs.length !== 5
  || adminApiKeyInputs.some((input) => !/\bpassword\b/.test(input))
  || !adminWxml.includes("effective.image.apiKeyConfigured")
  || !adminWxml.includes("effective.imageBackup.apiKeyConfigured")
  || (adminWxml.match(/已配置（不显示内容）/g) || []).length < 2
  || !adminWxss.includes(".api-key-config-state")
  || !adminWxss.includes(".api-key-field-tip")
) {
  throw new Error("五个主备模型 API Key 输入框、密码保护或脱敏配置状态不完整。");
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
  || !cloudJs.includes('MODEL_USAGE_TYPES = ["image", "analysis", "face", "video"]')
  || !cloudJs.includes("visionConfigForAction")
  || !cloudJs.includes("resolveAnalysisConfig")
  || !adminWxml.includes("图片 {{item.analysis.total}}")
  || !adminWxml.includes("图片 {{item.byType.analysis.total}}")
) {
  throw new Error("四类模型用量统计入口或统计规则不完整。");
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
  || !cloudJs.includes("analysis.estimatedCost")
  || !cloudJs.includes("costs.analysis")
  || !cloudJs.includes("modelErrorMessage")
  || !cloudJs.includes("probeOneModel")
  || !cloudJs.includes("normalizeModelProbeType")
  || !cloudJs.includes("temporaryModelConfig")
  || !cloudJs.includes('action === "probeModels"')
  || !cloudJs.includes('action === "listModels"')
  || !clientCloudJs.includes('action: "probeModels"')
  || !fs.existsSync(path.join(root, "scripts/analysis-cost-probe-smoke.js"))
) {
  throw new Error("模型成本、按用户/模型、月度统计或 Excel 导出功能不完整。");
}
if (
  /function\s+\w+\s*\([^)]*\.\.\./.test(adminJs)
  || /Math\.max\([^;\n]*\.\.\./.test(adminJs)
  || /\b(?:const|let|var)\s*\[[^\]]*\.\.\.[^\]]*\]\s*=/.test(adminJs)
  || /Promise\.all\(\[[^\]]*\.\.\./s.test(adminJs)
  || !adminJs.includes("const allTasks = moduleTasks.slice();")
  || !adminJs.includes("const parts = results.slice(1);")
) {
  throw new Error("管理员页包含会触发微信开发者工具缺失 SWC iterable helper 的语法。");
}
const todaySectionIndex = adminWxml.indexOf('<view class="overview-section today-section">');
const currentConfigHeadingIndex = adminWxml.indexOf('<view class="overview-heading">当前配置</view>');
const usageSectionIndex = adminWxml.indexOf('<view id="usage-section"');
const configEditorIndex = adminWxml.indexOf('id="config-editor" class="card config-editor"');
const monitorToggleIndex = adminWxml.indexOf('class="monitor-toggle ');
const usageBeforeMonitor = usageSectionIndex >= 0
  && monitorToggleIndex >= 0
  && usageSectionIndex < monitorToggleIndex;
if (
  todaySectionIndex < 0
  || currentConfigHeadingIndex <= todaySectionIndex
  || configEditorIndex <= currentConfigHeadingIndex
  || usageSectionIndex <= configEditorIndex
  || !usageBeforeMonitor
  || !adminWxml.includes('id="config-editor-face"')
  || !adminWxml.includes('id="config-editor-analysis"')
  || !adminWxml.includes('id="config-editor-image"')
  || !adminWxml.includes('id="config-editor-video"')
  || (adminWxml.match(/class="config-editor-focus-tip"/g) || []).length !== 5
  || !adminWxss.includes(".config-editor-focus-tip")
  || !adminWxss.includes(".config-editor-focus-dot")
  || !adminJs.includes("function configEditorSelector(section)")
  || !adminJs.includes("selector: configEditorSelector(nextSection)")
  || adminWxml.includes("monitor-section-usage")
  || adminWxml.includes("monitorSections.usage")
  || !adminWxml.includes('catchtap="toggleUsageCard"')
) {
  throw new Error("管理员页面配置入口或区块顺序不正确：四个模型应就地展开，其他配置应在模型用量统计之前。");
}
if (
  !adminWxml.includes("模型调用失败统计")
  || !adminWxml.includes("失败原因前 5 名")
  || !adminWxml.includes("失败最多的模型")
  || !adminWxss.includes(".usage-failure-panel")
  || !adminWxss.includes(".usage-failure-summary")
  || !adminWxss.includes(".usage-failure-row")
  || !cloudJs.includes("failureStats")
  || !cloudJs.includes("topFailureReasons")
  || !cloudJs.includes("failureDetails")
  || !cloudJs.includes("sanitizeFailureMessage")
  || !cloudJs.includes('XLSX.utils.aoa_to_sheet(failureRows)')
) {
  throw new Error("模型调用失败统计、Top 5 原因或 Excel 失败明细功能不完整。");
}
if (
  !clientCloudJs.includes('action: "exportModelFailureStats"')
  || !clientCloudJs.includes("exportModelFailureStats(monthKey")
  || !adminJs.includes("buildModelFailureView")
  || !adminJs.includes("MODEL_FAILURE_AUTO_REFRESH_MS")
  || !adminJs.includes("startModelFailureAutoRefresh")
  || !adminJs.includes("selectModelFailureMonth")
  || !adminJs.includes("openModelFailureUserDetail")
  || !adminJs.includes("modelFailureDetailOpen")
  || !adminJs.includes("exportModelFailureStats")
  || !adminWxml.includes("modelFailureView.monthOptions")
  || !adminWxml.includes("model-failure-month-picker")
  || !adminWxml.includes("导出失败统计")
  || !adminWxml.includes("openModelFailureUserDetail")
  || !adminWxml.includes("modelFailureDetailOpen")
  || !adminWxml.includes("failure-type-tag")
  || !adminWxml.includes("failure-detail-list")
  || !adminWxss.includes(".model-failure-month-picker")
  || !adminWxss.includes(".model-failure-export-button")
  || !adminWxss.includes(".failure-type-tag.is-danger")
  || !adminWxss.includes(".failure-type-tag.is-warning")
  || !adminWxss.includes(".failure-type-tag.is-violet")
  || !adminWxss.includes(".failure-detail-list")
  || !cloudJs.includes("buildModelFailureExportWorkbook")
  || !cloudJs.includes("exportModelFailureStats")
  || !cloudJs.includes("failureStats.monthly")
  || !cloudJs.includes("users: Object.values(userMap)")
  || !cloudJs.includes("failureStats.details")
  || !cloudJs.includes("monthKey")
  || !cloudJs.includes("userHash")
  || !fs.existsSync(path.join(root, "scripts/model-failure-stats-smoke.js"))
) {
  throw new Error("模型失败统计的自动刷新、月份筛选、用户详情、颜色标记或 Excel 导出功能不完整。");
}
if (
  !clientCloudJs.includes('action: "reportAutoFaceFailure"')
  || !clientCloudJs.includes('action: "getAutoFaceFailureStats"')
  || !clientCloudJs.includes('action: "exportAutoFaceFailureStats"')
  || !adminJs.includes("cloud.getAutoFaceFailureStats()")
  || !adminJs.includes("refreshAutoFaceFailureStats")
  || !adminJs.includes("startAutoFaceFailureAutoRefresh")
  || !adminJs.includes("selectAutoFaceFailureMonth")
  || !adminJs.includes("openAutoFaceFailureUserDetail")
  || !adminJs.includes("exportAutoFaceFailureStats")
  || !adminJs.includes("AUTO_FACE_FAILURE_AUTO_REFRESH_MS")
  || !adminJs.includes("toggleAutoFaceFailureSection")
  || !adminJs.includes("autoFaceFailureSections")
  || !adminWxss.includes(".auto-face-failure-summary")
  || !adminWxss.includes(".auto-face-failure-type-list")
  || !adminWxss.includes(".auto-face-failure-recent-list")
  || !adminWxss.includes(".auto-face-failure-daily-list")
  || !adminWxss.includes(".auto-face-failure-user-list")
  || !adminWxss.includes(".auto-face-failure-monthly-list")
  || !adminWxss.includes(".failure-type-tag")
  || !adminWxss.includes(".auto-face-detail-dialog")
  || !adminWxss.includes(".auto-face-month-picker")
  || !cloudJs.includes("AUTO_FACE_FAILURE_LOG_COLLECTION")
  || !cloudJs.includes("normalizeAutoFaceFailureReport")
  || !cloudJs.includes("buildAutoFaceFailureStats")
  || !cloudJs.includes("buildAutoFaceFailureExportWorkbook")
  || !cloudJs.includes("exportAutoFaceFailureStats")
  || !cloudJs.includes("details")
  || !cloudJs.includes("userHash")
  || !cloudJs.includes("ADMIN_FORBIDDEN")
  || !fs.existsSync(path.join(root, "scripts/auto-face-failure-stats-smoke.js"))
  || adminWxml.includes("autoFaceFailure")
  || adminWxml.includes("自动贴脸失败统计")
) {
  throw new Error("自动贴脸失败后台统计能力不完整，或管理页仍残留已移除的统计界面。");
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
  || !configJs.includes('promoActive: "活动期间限时全功能不扣积分"')
  || !workbenchWxml.includes("pointsCopy.cardTitle")
  || !workbenchWxml.includes("points.promoLabel")
  || !workbenchWxml.includes("pointsCopy.pointsUnit")
  || !workbenchWxml.includes('bindtap="openPoints"')
  || !workbenchWxml.includes('catchtap="checkIn"')
  || !workbenchWxss.includes(".points-entry-card")
  || !workbenchWxss.includes(".points-entry-promo-active")
  || !workbenchWxss.includes("justify-content: flex-start")
  || !workbenchWxss.includes("font-size: 18rpx")
  || !workbenchJs.includes("pointsCopy: config.points.copy")
  || !workbenchJs.includes("buildCheckInToast")
  || !workbenchJs.includes("_checkInPromise")
  || !workbenchJs.includes("schedulePromoRefresh")
  || !workbenchJs.includes("pointsUi.getPromoRefreshDelay")
  || !pointsJs.includes("cloud.getUserPoints()")
  || !pointsJs.includes("cloud.checkIn()")
  || !pointsJs.includes("cloud.getPointLedger()")
  || !pointsJs.includes("pointsCopy: config.points.copy")
  || !pointsJs.includes("buildCheckInToast")
  || !pointsJs.includes("_checkInPromise")
  || !pointsJs.includes("schedulePromoRefresh")
  || !pointsJs.includes("pointsUi.getPromoRefreshDelay")
  || !pointsWxml.includes("pointsCopy.pointsSectionTitle")
  || !pointsWxml.includes("pointsCopy.ledgerTitle")
  || !pointsWxml.includes("pointsCopy.bindAndCheckIn")
  || !pointsWxml.includes("points.promoLabel")
  || !pointsWxml.includes("pointsCopy.usageNote")
  || !pointsWxml.includes("pointsCopy.emptyLedger")
  || !pointsWxss.includes(".streak-progress-fill")
  || !pointsWxss.includes(".ledger-row")
  || !cloudJs.includes('action === "getUserPoints"')
  || !cloudJs.includes('action === "checkIn"')
  || !cloudJs.includes('action === "getPointLedger"')
  || !cloudJs.includes('action === "initializeDatabase"')
  || !cloudJs.includes("REQUIRED_DATABASE_COLLECTIONS")
  || !cloudJs.includes("createCollection(collectionName)")
  || !clientCloudJs.includes("getUserPoints")
  || !clientCloudJs.includes("checkIn")
  || !clientCloudJs.includes("getPointLedger")
  || !configJs.includes("checkInDuplicate")
  || !configJs.includes("pointsPromo")
  || !configJs.includes("ledgerDefaultDescription")
  || !configJs.includes("checkInFailedFallback")
  || !refreshPreviewPs1.includes("wechat-miniapp-preview-latest-qr.png")
  || !refreshPreviewPs1.includes("wechat-miniapp-preview-latest-info.json")
) {
  throw new Error("积分签到入口、明细页或云函数路由不完整。");
}
if (
  !initCloudDatabasePs1.includes("initializeDatabase")
  || !initCloudDatabasePs1.includes('"automation_evaluate"')
  || !initCloudDatabasePs1.includes("DryRun")
) {
  throw new Error("云数据库一键初始化脚本不完整。");
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
  || !/\.main-image-action-button,\r?\n\.nav-action-button/.test(indexWxss)
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
  || (
    appJson.pages[1] !== "pages/workbench/workbench"
    && appJson.pages[1] !== "pages/profile/profile"
  )
  || !splashJs.includes("setTimeout")
  || !splashJs.includes("REDIRECT_DELAY = 888")
  || !(
    splashJs.includes("openWorkbench()")
    || splashJs.includes("checkUserProfile()")
  )
  || !splashJs.includes("wx.redirectTo")
  || !splashJs.includes('wx.reLaunch')
  || !splashJs.includes('WORKBENCH_URL = "/pages/workbench/workbench"')
  || !splashWxml.includes('src="/assets/brand/brand-icon.png"')
  || !splashWxml.includes("圈定想改的，创作想要的。")
  || !splashWxml.includes("局部创作，整体可控")
  || !(
    splashWxml.includes("正在进入创作空间")
    || splashWxml.includes("正在检查用户资料")
  )
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
// 统一统计工作台所有可点击入口：积分卡、常用功能、腾讯版、记录、其他服务和管理员入口。
const workbenchEntryCardCount = workbenchWxml.includes('wx:if="{{adminVisible}}"') ? 8 : 7;
const serviceFeatureHeadingStyle = workbenchWxss.match(
  /\.service-feature-heading\s*\{([^}]*)\}/
);
const mediaParserEntryStyle = workbenchWxss.match(
  /\.media-parser-entry\s*\{([^}]*)\}/
);
const mediaParserArrowStyle = workbenchWxss.match(
  /\.media-parser-entry\s+\.media-parser-arrow\s*\{([^}]*)\}/
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
  || !workbenchWxml.includes("制作记录")
  || !workbenchWxss.includes(".hero-orbit-red")
  || !workbenchWxss.includes(".entry-card-custom")
  || !workbenchWxml.includes("workbench-link-card")
  || !workbenchWxml.includes("workbench-feature-stack")
  || !workbenchWxml.includes("feature-group-heading")
  || !workbenchWxml.includes("feature-group-dot")
  || commonFeatureHeadingCount !== 1
  || commonFeatureSubtitleCount !== 2
  || !workbenchWxml.includes('class="feature-group-heading service-feature-heading"')
  || workbenchWxml.indexOf("service-feature-heading") > workbenchWxml.indexOf('class="card contact-author-card"')
  || !workbenchWxml.includes("免费去水印")
  || !workbenchWxml.includes('bindtap="openMediaParser"')
  || !workbenchJs.includes("openMediaParser()")
  || !workbenchJs.includes('"/pages/watermark-remover/watermark-remover"')
  || !workbenchWxss.includes(".media-parser-entry")
  || !mediaParserEntryStyle
  || !/display:\s*flex\s*!important/.test(mediaParserEntryStyle[1])
  || !/flex-direction:\s*row\s*!important/.test(mediaParserEntryStyle[1])
  || !/height:\s*148rpx/.test(mediaParserEntryStyle[1])
  || !mediaParserArrowStyle
  || !/position:\s*absolute/.test(mediaParserArrowStyle[1])
  || !/right:\s*18rpx/.test(mediaParserArrowStyle[1])
  || !serviceFeatureHeadingStyle
  || !/margin-top:\s*28rpx/.test(serviceFeatureHeadingStyle[1])
  || !workbenchWxml.includes('class="card contact-author-card"')
  || !workbenchWxml.includes('src="{{authorQrPath}}"')
  || !workbenchWxml.includes('bindtap="previewAuthorQr"')
  || !workbenchWxml.includes('show-menu-by-longpress="true"')
  || !workbenchWxml.includes('bindtap="saveAuthorQr"')
  || !workbenchWxml.includes("保存二维码")
  || !workbenchJs.includes('AUTHOR_QR_PATH = "/assets/contact/author-wechat-qr.jpg"')
  || !workbenchJs.includes("previewAuthorQr()")
  || !workbenchJs.includes("saveAuthorQr()")
  || !workbenchJs.includes("wx.saveImageToPhotosAlbum")
  || !workbenchJs.includes("authorQrPreviewVisible: false")
  || !workbenchJs.includes("authorQrPreviewPath: AUTHOR_QR_PATH")
  || !workbenchJs.includes("closeAuthorQrPreview()")
  || !workbenchJs.includes("onAuthorQrPreviewError()")
  || !workbenchWxml.includes("<image-preview")
  || !workbenchWxml.includes('visible="{{imagePreviewVisible}}"')
  || !workbenchWxml.includes('src="{{imagePreviewPath}}"')
  || !workbenchWxml.includes('bindclose="closeImagePreview"')
  || !workbenchWxml.includes('binderror="onImagePreviewError"')
  || !workbenchJs.includes("imagePreviewVisible: false")
  || !workbenchJs.includes("imagePreviewPath: \"\"")
  || !workbenchJs.includes("closeImagePreview()")
  || !workbenchJs.includes("imagePreviewVisible: true")
  || workbenchWxss.includes(".author-qr-preview-image")
  || workbenchWxss.includes("height: 80%")
  || !contactAuthorCardStyle
  || !/margin-top:\s*16rpx/.test(contactAuthorCardStyle[1])
  || !contactAuthorQrStyle
  || !/width:\s*420rpx/.test(contactAuthorQrStyle[1])
  || !contactAuthorSaveButtonStyle
  || !/width:\s*100%/.test(contactAuthorSaveButtonStyle[1])
  || !workbenchWxml.includes("'recent-card-filled' : 'recent-card-empty'")
  || !recentCardEmptyStyle
  || !/min-height:\s*0/.test(recentCardEmptyStyle[1])
  || !workbenchWxss.includes("white-space: nowrap")
  || !workbenchWxss.includes("text-overflow: ellipsis")
  || !workbenchWxss.includes("margin-left: 0")
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
  || !workbenchWxss.includes(".workbench-link-card")
  || !workbenchWxss.includes(".workbench-link-card-hover")
  || !workbenchWxss.includes(".workbench-feature-stack")
  || !workbenchWxss.includes(".workbench-feature-stack .entry-grid")
  || !workbenchWxss.includes("margin-top: 16rpx")
  || !workbenchWxss.includes(".feature-group-heading")
  || !workbenchWxss.includes(".feature-group-dot")
  || !workbenchWxss.includes("margin-bottom: 6rpx")
  || !workbenchWxss.includes("font-size: 30rpx")
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
  || workbenchJs.includes("refreshDiagnostics()")
  || workbenchJs.includes("toggleDiagnosticPanel()")
  || workbenchJs.includes("diagnosticExpanded")
  || workbenchJs.includes("copyDiagnosticReport()")
  || workbenchJs.includes("clearDiagnosticLogs()")
  || !workbenchJs.includes("refreshAdminAccess()")
  || !workbenchJs.includes("adminVisible")
  || !workbenchJs.includes("new-creation-navigation-timeout")
  || !workbenchJs.includes("draft-auto-clear")
  || !workbenchWxml.includes("<text>其他服务</text>")
  || !workbenchWxml.includes("联系客服和更多工具")
  || !workbenchWxml.includes("联系作者")
  || !workbenchWxml.includes("添加微信咨询")
  || workbenchWxml.indexOf('class="card admin-entry-card') < workbenchWxml.indexOf('class="card contact-author-card"')
  || !indexJs.includes('require("../../utils/diagnostic-log")')
  || !indexJs.includes('logMethod("auto-face"')
  || !photoToVideoJs.includes('require("../../utils/diagnostic-log")')
  || !photoToVideoJs.includes('diagnosticLog.info("video"')
  || !publishExportJs.includes('require("../../utils/diagnostic-log")')
  || !publishExportJs.includes('diagnosticLog.info("export"')
  || !recordsJs.includes('require("../../utils/diagnostic-log")')
  || !recordsJs.includes('diagnosticLog.info("records"')
  || !fs.existsSync(path.join(root, "scripts", "diagnostic-log-smoke.js"))
  || !fs.existsSync(path.join(root, "scripts", "diagnostic-admin-logs-smoke.js"))
  || !fs.existsSync(path.join(root, "scripts", "refresh-preview.ps1"))
  || !fs.existsSync(path.join(root, "一键刷新预览.cmd"))
) {
  throw new Error("故障排查报告、真机跳转兜底或一键刷新预览功能不完整。");
}
if (
  !appJs.includes("configureRemoteReporting")
  || !appJs.includes("reportDiagnosticLogs")
  || !clientCloudJs.includes('action: "reportDiagnosticLogs"')
  || !clientCloudJs.includes('action: "getAdminDiagnosticLogs"')
  || !diagnosticLogJs.includes("72 * 60 * 60 * 1000")
  || !diagnosticLogJs.includes("pruneExpiredState")
  || !diagnosticLogJs.includes("flushRemote")
  || !cloudJs.includes('USER_DIAGNOSTIC_LOG_COLLECTION = "user_diagnostic_logs"')
  || !cloudJs.includes("USER_DIAGNOSTIC_LOG_RETENTION_HOURS = 72")
  || !cloudJs.includes("cleanupDiagnosticLogs")
  || !cloudJs.includes("reportDiagnosticLogs")
  || !cloudJs.includes("getAdminDiagnosticLogs")
  || !adminJs.includes('"diagnosticLogs"')
  || !adminJs.includes("refreshDiagnosticLogs")
  || !adminJs.includes("copyDiagnosticLog")
  || !adminWxml.includes("用户端日志")
  || !adminWxml.includes("超过72小时自动删除")
  || !adminWxml.includes("diagnostic-admin-filter-chip")
  || !adminWxss.includes(".diagnostic-admin-summary")
  || !adminWxss.includes(".diagnostic-admin-log")
  || !adminWxml.includes("diagnostic-log-action-button")
  || !adminWxss.includes(".diagnostic-log-action-button.is-split")
  || !adminWxss.includes(".diagnostic-log-action-button.is-single")
  || !adminWxss.includes("text-overflow: ellipsis")
) {
  throw new Error("管理员用户端日志、分类筛选、脱敏上报或72小时自动清理功能不完整。");
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
  !workbenchWxml.includes("降低AI识别率再导出")
  || !workbenchWxml.includes('bindtap="openPublishExport"')
  || !workbenchJs.includes('"/pages/publish-export/publish-export"')
  || !workbenchJs.includes("openPublishExport()")
  || !workbenchWxss.includes(".publish-export-entry")
  || workbenchWxml.indexOf("降低AI识别率再导出") < workbenchWxml.indexOf("制作记录")
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
   || !publishExportWxml.includes("降低AI识别率再导出")
   || publishExportWxml.includes("高级处理后再导出照片")
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
if (
  !publishExportJs.includes("publishExportCore.normalizeOptions")
  || !publishExportJs.includes("confirmCloudExport")
  || !publishExportJs.includes("本地处理失败，可以改用云端继续")
  || !publishExportJs.includes("cloud.publishExport")
  || !publishExportJs.includes("cloud.cleanupPublishExportResult")
  || publishExportJs.includes("SIZE_OPTIONS")
  || publishExportJs.includes("changeMaxEdge")
  || publishExportJs.includes("maxEdge:")
  || !publishExportWxml.includes("基础色彩校正")
  || !publishExportWxml.includes("轻度降噪")
  || !publishExportWxml.includes("清晰补偿")
  || !publishExportWxml.includes("固定相机颗粒")
  || !publishExportWxml.includes("频域扰动")
  || !publishExportWxml.includes("反向重采样")
  || !publishExportWxml.includes("可见标记淡化")
  || publishExportWxml.includes("最长边")
  || publishExportWxml.includes("小图优先在手机处理，大图或失败时经你确认后使用云端")
  || !publishExportJs.includes("cameraNoiseStrength: 3")
  || !publishExportJs.includes("frequencyStrength: 3")
  || !publishExportJs.includes("denoise: true")
  || !publishExportJs.includes("watermarkStrength: 3")
  || !publishExportJs.includes("removeVisibleMarks: true")
  || !publishExportWxml.includes('data-key="removeVisibleMarks"')
  || !publishExportWxml.includes('checked="{{removeVisibleMarks}}"')
  || !publishExportJs.includes('"removeVisibleMarks"')
  || !publishExportWxml.includes("scheme6-actions")
  || publishExportWxml.includes("scheme6-fixed-actions")
  || !publishExportWxml.includes("scheme6-export-button")
  || !publishExportWxml.includes("scheme6-back-button")
  || !publishExportWxss.includes(".scheme6-actions")
  || publishExportWxss.includes(".scheme6-fixed-actions")
  || /\.scheme6-actions\s*\{[^}]*position\s*:\s*fixed/i.test(publishExportWxss)
  || !/position:\s*fixed/.test(publishExportWxss)
  || !publishExportCoreJs.includes("function processRgba")
  || !publishExportCoreJs.includes("function applyFrequencyPerturb")
  || !publishExportCoreJs.includes("function applyVisibleMarkFade")
  || !publishExportCoreJs.includes("function resizeRgba")
  || !publishExportWorkerJs.includes("publish-export-core")
  || !cloudPublishExportCoreJs.includes("function processRgba")
  || !cloudJs.includes('action === "publishExport"')
  || !cloudJs.includes('action === "cleanupPublishExportResult"')
  || !cloudJs.includes("PUBLISH_EXPORT_JOB_COLLECTION")
  || !cloudJs.includes("jpeg-js")
  || !cloudJs.includes("PNG.sync.read")
  || !clientCloudJs.includes('action: "publishExport"')
  || !clientCloudJs.includes('action: "cleanupPublishExportResult"')
  || !clientCloudJs.includes("temporaryInput")
) {
  throw new Error("高级导出参数、本地/Worker/云端共用算法、云端兜底或临时文件清理链路不完整。");
}
const publishExportButtonRule = getCssRule(publishExportWxss, ".export-button");
const photoToVideoButtonRule = getCssRule(photoToVideoWxss, ".export-button");
const publishBackButtonRule = getCssRule(publishExportWxss, ".back-button");
const photoBackButtonRule = getCssRule(photoToVideoWxss, ".back-button");
const actionButtonProperties = [
  "display",
  "width",
  "height",
  "min-height",
  "margin-top",
  "padding",
  "max-width",
  "align-items",
  "justify-content",
  "border-radius",
  "font-size",
  "line-height",
  "text-align",
  "white-space"
];
if (
  !actionButtonProperties.every((property) => (
    getCssProperty(publishExportButtonRule, property)
    && getCssProperty(publishExportButtonRule, property)
      === getCssProperty(photoToVideoButtonRule, property)
  ))
  || !actionButtonProperties.every((property) => (
    getCssProperty(publishBackButtonRule, property)
    && getCssProperty(publishBackButtonRule, property)
      === getCssProperty(photoBackButtonRule, property)
  ))
) {
  throw new Error("照片转实况图底部两个按钮没有和降低AI痕迹页面统一尺寸、字号、间距或上下居中规则。");
}
if (
  getCssProperty(publishExportButtonRule, "width") !== "52% !important"
  || getCssProperty(photoToVideoButtonRule, "width") !== "52% !important"
  || getCssProperty(publishBackButtonRule, "width") !== "52% !important"
  || getCssProperty(photoBackButtonRule, "width") !== "52% !important"
  || getCssProperty(publishExportButtonRule, "margin-left") !== "auto"
  || getCssProperty(photoToVideoButtonRule, "margin-left") !== "auto"
  || getCssProperty(publishBackButtonRule, "margin-left") !== "auto"
  || getCssProperty(photoBackButtonRule, "margin-left") !== "auto"
) {
  throw new Error("底部按钮宽度没有按截图3收窄到52%并居中。");
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
  || !workbenchWxml.includes("安卓直接保存实况")
  || !workbenchWxml.includes("失败自动保留视频")
  || !workbenchWxml.includes('bindtap="openPhotoToVideo"')
  || !workbenchJs.includes("openPhotoToVideo()")
  || !workbenchJs.includes('"/pages/photo-to-video/photo-to-video"')
  || !workbenchWxss.includes(".photo-to-video-entry")
  || !photoToVideoJs.includes("cloud.getVideoProviderStatus()")
  || !photoToVideoJs.includes("cloud.createVideoTask")
  || !photoToVideoJs.includes("cloud.queryVideoTask")
  || !photoToVideoJs.includes("wx.saveImageToPhotosAlbum")
  || !photoToVideoJs.includes("wx.saveVideoToPhotosAlbum")
  || !photoToVideoJs.includes("wx.shareFileMessage")
  || !photoToVideoJs.includes("wx.setClipboardData")
  || !photoToVideoJs.includes("buildAndSaveAndroidMotionPhoto")
  || !photoToVideoJs.includes("buildAndShareAppleLivePhoto")
  || !photoToVideoJs.includes("onPreviewTouchStart()")
  || !photoToVideoJs.includes("retryOne(event = {})")
  || !photoToVideoWxml.includes("照片转实况照片")
  || !photoToVideoWxml.includes("苹果导入方法")
  || !photoToVideoWxml.includes("百度网盘")
  || !photoToVideoWxml.includes('class="live-preview-touch-layer"')
  || !photoToVideoWxml.includes('id="photo-to-video-preview"')
  || !photoToVideoWxss.includes(".live-preview-image")
  || !photoToVideoWxss.includes(".live-preview-video-visible")
  || !cloudJs.includes('action === "videoProviderStatus"')
  || !cloudJs.includes('action === "createVideoTask"')
  || !cloudJs.includes('action === "queryVideoTask"')
  || !cloudJs.includes('action === "buildAndroidMotionPhoto"')
  || !cloudJs.includes('action === "buildAppleLivePhoto"')
  || !cloudJs.includes("VIDEO_PROVIDER_NOT_CONFIGURED")
  || !cloudJs.includes("buildVideoGenerationPayload")
  || !cloudJs.includes("normalizeVideoCreateResponse")
  || !cloudJs.includes("normalizeVideoQueryResponse")
  || !cloudJs.includes("APPLE_LIVE_PHOTO_WORKER_URL")
  || !cloudJs.includes("appleLivePhotoCloudPath")
  || !cloudJs.includes("AI_VIDEO_BASE_URL")
  || cloudJs.includes("VIDEO_PROVIDER_PROTOCOL_PENDING")
  || !photoToVideoJs.includes("maxConcurrent")
  || !photoToVideoJs.includes("PHOTO_TO_VIDEO_CANCELLED")
  || !photoToVideoJs.includes("resultFileID")
  || !photoToVideoJs.includes("flushPhotoToVideoCleanup")
  || !photoToVideoJs.includes("enqueuePhotoToVideoCleanup")
  || !photoToVideoJs.includes("resultPath")
  || !photoToVideoJs.includes("displayURL")
  || !storageJs.includes("loadPhotoToVideoCleanup")
  || !storageJs.includes("savePhotoToVideoCleanup")
  || !storageJs.includes("loadPhotoToVideoSession")
  || !storageJs.includes("removeRecordsByIds")
  || !clientCloudJs.includes("function deleteFile")
  || !clientCloudJs.includes("registerPhotoToVideoTempAsset")
  || !clientCloudJs.includes("registerPhotoToVideoRecord")
  || !clientCloudJs.includes("closePhotoToVideoSession")
  || !cloudJs.includes("PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION")
  || !cloudJs.includes("cleanupPhotoToVideoTempAssets")
  || !cloudJs.includes("photoToVideoCleanupState")
  || !cloudJs.includes("removeGenerationRecord")
  || !cloudJs.includes("isPhotoToVideoCleanupTrigger")
  || !cleanupSmokeJs.includes("2 * 60 * 60 * 1000")
  || !cleanupSmokeJs.includes("3 * 24 * 60 * 60 * 1000")
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
  || (
    indexJs.includes("wx.pageScrollTo")
    && !indexJs.includes('query.select("#generation-results")')
  )
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
  || (indexWxml.match(/<textarea class="asset-note"/g) || []).length !== 3
  || (indexWxml.match(/class="asset-card-main"/g) || []).length !== 3
  || !indexWxml.includes('class="asset-actions face-actions"')
  || !indexWxml.includes('class="kind-switch"')
) {
  throw new Error("第 3 步参考素材卡片仍显示文件名，或三组备注框结构不完整。");
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
  || !indexWxml.includes("AI分析主图会填充五段描述，")
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
  throw new Error("桌面端五段完整填写说明没有全部迁移到第 4 步。");
}
if (
  !indexWxml.includes("背景参考")
  || !indexWxml.includes('bindtap="chooseBackgroundImages"')
  || !indexWxml.includes('bindtap="removeBackground"')
  || !indexWxml.includes('bindinput="onBackgroundNoteInput"')
  || !indexWxml.includes("没有背景参考也可以继续")
  || !indexWxml.includes("backgroundRefs.length")
  || !indexWxml.includes('<view class="field-label">背景</view>')
  || !indexWxml.includes('data-field="backgroundDescription"')
  || !indexJs.includes("backgroundRefs: []")
  || !indexJs.includes('this.appendAssets("backgroundRefs"')
  || !indexJs.includes("backgroundDescription: analysis.backgroundDescription")
  || !indexJs.includes('this.ensureUploaded(item, "references/background")')
  || !indexJs.includes("backgroundFileIDs:")
  || !promptJs.includes("project.backgroundRefs")
  || !promptJs.includes("project.backgroundDescription")
  || !promptJs.includes("【背景参考】")
  || !promptJs.includes("忽略背景参考图中的人物")
  || !cloudJs.includes('role: "background"')
  || !cloudJs.includes("backgroundFileIDs")
  || !cloudJs.includes('findUserAsset(openid, fileID, "background")')
  || !cloudJs.includes('kind: "background"')
) {
  throw new Error("背景参考上传、背景描述、提示词或云端素材链路不完整。");
}
if (
  !repairJs.includes("backgroundRefs")
  || !repairJs.includes("backgroundFileIDs")
  || !repairJs.includes("chooseBackgroundImages")
  || !repairWxml.includes("背景参考")
  || !repairWxml.includes("补选背景参考")
  || !repairWxml.includes("legacyBackgroundPending")
  || !repairWxss.includes("flex-wrap: wrap")
) {
  throw new Error("局部修正页没有完整继承背景参考，或窄屏按钮没有换行。");
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
  || !cloudJs.includes("async function analyzeWebPoses(event, context)")
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
  || !indexWxml.includes('class="generation-checklist"')
  || !indexWxml.includes('class="generation-check-row {{phaseIndex < generationPhaseIndex ? \'is-done\' : \'\'}')
  || !indexWxml.includes("等待上一项完成")
  || !indexWxml.includes("generation-waiting-footer")
  || !indexWxml.includes('id="generation-results"')
  || !indexWxml.includes("generationElapsedSeconds")
  || !/startGenerationTimer\s*\(/.test(indexJs)
  || !indexJs.includes("stopGenerationTimer()")
  || !indexJs.includes("generationWaitText")
  || indexJs.includes("scrollToGenerationResults()")
  || indexJs.includes("wx.pageScrollTo")
  || !indexWxss.includes(".generation-waiting")
  || !indexWxss.includes(".generation-checklist")
  || !indexWxss.includes(".generation-check-row.is-current")
  || !indexWxss.includes(".generation-check-row.is-done")
  || !indexWxss.includes("@keyframes generation-check-current-pulse")
  || !indexWxss.includes(".generation-waiting-footer")
) {
  throw new Error("第 5 步生成任务清单或操作卡结构不完整。");
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
  !indexWxml.includes("选择要保持不变的部分")
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
