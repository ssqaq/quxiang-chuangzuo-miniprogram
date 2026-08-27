const XINGJU_VIDEO_DEFAULTS = Object.freeze({
  // 星炬视频接口的路径本身已经包含 /v1，所以地址只保留域名。
  baseUrl: "https://newapi.akiyo.fun",
  model: "grok-imagine-video-1.5",
  createPath: "/v1/videos/generations",
  queryPath: "/v1/videos/{taskId}",
  resolution: "720p",
  timeoutMs: "90000"
});

function isXingjuProvider(value) {
  const text = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  return text === "xingju" || text === "星炬";
}

function applyAdminVideoProviderDefaults(form) {
  const source = form && typeof form === "object" ? form : {};
  const video = source.video && typeof source.video === "object"
    ? source.video
    : {};
  if (!isXingjuProvider(video.provider)) return source;

  const nextVideo = Object.assign({}, video);
  ["baseUrl", "model", "createPath", "queryPath", "resolution"].forEach((key) => {
    if (!String(nextVideo[key] || "").trim()) {
      nextVideo[key] = XINGJU_VIDEO_DEFAULTS[key];
    }
  });
  const timeoutMs = Number(nextVideo.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10000) {
    nextVideo.timeoutMs = XINGJU_VIDEO_DEFAULTS.timeoutMs;
  } else {
    nextVideo.timeoutMs = String(nextVideo.timeoutMs);
  }
  return Object.assign({}, source, {
    video: nextVideo
  });
}

module.exports = {
  XINGJU_VIDEO_DEFAULTS,
  isXingjuProvider,
  applyAdminVideoProviderDefaults
};
