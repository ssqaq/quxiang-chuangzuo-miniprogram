const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pageJs = fs.readFileSync(
  path.join(root, "pages/photo-to-video/photo-to-video.js"),
  "utf8"
);
const pageWxml = fs.readFileSync(
  path.join(root, "pages/photo-to-video/photo-to-video.wxml"),
  "utf8"
);
const workbenchWxml = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.wxml"),
  "utf8"
);
const configJs = fs.readFileSync(path.join(root, "config.js"), "utf8");
const cloudJs = fs.readFileSync(path.join(root, "services/cloud.js"), "utf8");
const cloudApiJs = fs.readFileSync(
  path.join(root, "cloudfunctions/api/index.js"),
  "utf8"
);
const cloudTriggerConfig = JSON.parse(
  fs.readFileSync(path.join(root, "cloudfunctions/api/config.json"), "utf8")
);
const storageJs = fs.readFileSync(path.join(root, "utils/storage.js"), "utf8");

const required = [
  ["页面隐藏取消当前批次", pageJs.includes("cancelActiveRun()") && pageJs.includes("PHOTO_TO_VIDEO_CANCELLED")],
  ["并发上限读取配置", pageJs.includes("config.photoToVideo.maxConcurrent")],
  ["并发池等待全部 worker", pageJs.includes("Promise.all(Array.from({ length: concurrency }")],
  ["云端结果保存前下载本地路径", pageJs.includes("cloud.downloadFile")],
  ["结果 fileID 单独记录", pageJs.includes("resultFileID")],
  ["结果使用统一 resultPath", pageJs.includes("resultPath") && pageJs.includes("displayURL")],
  ["本地预览失效按 fileID 回读", pageJs.includes("resolvePreviewSource")
    && pageJs.includes("resolveImageSource")],
  ["视频触摸事件由覆盖层独占", pageWxml.includes('class="live-preview-touch-layer"')
    && !pageWxml.includes('bindtouchstart="onPreviewTouchStart"')
    && !pageWxml.includes('bindtouchend="onPreviewTouchEnd"')],
  ["入口明确普通动态视频", workbenchWxml.includes("照片转实况图")
    && workbenchWxml.includes("生成动态视频，照片也会保留")]
  ,["临时云文件进入延迟清理队列", pageJs.includes("enqueuePhotoToVideoCleanup")
    && pageJs.includes("flushPhotoToVideoCleanup")
    && configJs.includes("gracePeriodMs")]
  ,["清理失败保留并重试", pageJs.includes("cleanup-failed")
    && pageJs.includes("retained.push")]
  ,["云文件清理 API 已接入", cloudJs.includes("function deleteFile")
    && storageJs.includes("PHOTO_TO_VIDEO_CLEANUP_KEY")
    && cloudJs.includes("registerPhotoToVideoTempAsset")]
  ,["云端只登记照片转视频临时文件", cloudApiJs.includes("PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION")
    && cloudApiJs.includes("cleanupPhotoToVideoTempAssets")]
  ,["云端每天定时清理且保留三天", configJs.includes("3 * 24 * 60 * 60 * 1000")
    && cloudTriggerConfig.triggers.some((item) => (
      item.name === "photo-to-video-temp-cleanup"
      && item.type === "timer"
      && item.config === "0 0 3 * * * *"
    ))]
];

const failed = required.filter((item) => !item[1]).map((item) => item[0]);
if (failed.length) {
  throw new Error(`photo-to-video smoke 失败：${failed.join("、")}`);
}

console.log(`photo-to-video smoke: OK (${required.length} checks)`);
