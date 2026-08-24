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
  ["入口明确安卓实况和视频兜底", workbenchWxml.includes("照片转实况图")
    && workbenchWxml.includes("安卓直接保存实况")
    && workbenchWxml.includes("失败自动保留视频")]
  ,["安卓 Motion Photo 云接口已接入", cloudJs.includes("buildAndroidMotionPhoto")
    && cloudApiJs.includes('action === "buildAndroidMotionPhoto"')
    && cloudApiJs.includes("requireOwnedVideoOperation")]
  ,["安卓成功只保存实况照片", pageJs.includes("buildAndSaveAndroidMotionPhoto")
    && pageJs.includes('deliveryMode: "android-motion-photo"')
    && pageJs.includes("saveImageToAlbum(motionPhotoPath)")]
  ,["安卓失败自动保存普通视频", pageJs.includes("saveOrdinaryVideoFallback")
    && pageJs.includes('deliveryMode: "ordinary-video-fallback"')
    && pageJs.includes("await saveVideoToAlbum(resultPath)")]
  ,["苹果 LIVP 独立接口已接入", cloudJs.includes("buildAppleLivePhoto")
    && cloudApiJs.includes('action === "buildAppleLivePhoto"')
    && cloudApiJs.includes("APPLE_LIVE_PHOTO_WORKER_URL")
    && cloudApiJs.includes("appleLivePhotoCloudPath")]
  ,["苹果不误走安卓接口", pageJs.includes("this.data.isAndroidDevice")
    && pageJs.includes("this.data.isIOSDevice")
    && pageJs.includes("buildAndShareAppleLivePhoto")
    && pageJs.includes('deliveryMode: "apple-livp-shared"')]
  ,["苹果分享和临时链接兜底已接入", pageJs.includes("wx.shareFileMessage")
    && pageJs.includes("wx.setClipboardData")
    && pageWxml.includes("苹果导入方法")
    && pageWxml.includes("百度网盘")]
  ,["预览区保留普通视频兜底按钮", pageWxml.includes('bindtap="savePreviewVideo"')
    && pageWxml.includes("保存普通视频")]
  ,["临时云文件进入延迟清理队列", pageJs.includes("enqueuePhotoToVideoCleanup")
    && pageJs.includes("flushPhotoToVideoCleanup")
    && configJs.includes("idlePeriodMs")
    && configJs.includes("gracePeriodMs")]
  ,["清理失败保留并重试", pageJs.includes("cleanup-failed")
    && pageJs.includes("retained.push")]
  ,["云文件清理 API 已接入", cloudJs.includes("function deleteFile")
    && storageJs.includes("PHOTO_TO_VIDEO_CLEANUP_KEY")
    && cloudJs.includes("registerPhotoToVideoTempAsset")]
  ,["关闭页面上报两小时清理", pageJs.includes("closePhotoToVideoCleanupSession")
    && cloudJs.includes("closePhotoToVideoSession")
    && cloudApiJs.includes("idleCleanupAfter")]
  ,["正式制作记录进入受限清理", pageJs.includes("registerPhotoToVideoRecord")
    && cloudApiJs.includes('kind === "record"')
    && cloudApiJs.includes("removeGenerationRecord")]
  ,["本地记录和文件缓存进入清理", storageJs.includes("removeRecordsByIds")
    && storageJs.includes("PHOTO_TO_VIDEO_SESSION_KEY")
    && pageJs.includes("removeLocalTempFile")]
  ,["云端登记照片转视频文件和记录", cloudApiJs.includes("PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION")
    && cloudApiJs.includes("cleanupPhotoToVideoTempAssets")
    && cloudApiJs.includes("photoToVideoCleanupState")]
  ,["云端每15分钟检查且保留三天兜底", configJs.includes("2 * 60 * 60 * 1000")
    && configJs.includes("3 * 24 * 60 * 60 * 1000")
    && cloudTriggerConfig.triggers.some((item) => (
      item.name === "photo-to-video-idle-cleanup"
      && item.type === "timer"
      && item.config === "0 */15 * * * * *"
    ))
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
