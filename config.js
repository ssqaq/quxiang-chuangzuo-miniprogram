/**
 * 小程序本地配置。
 *
 * 1. 在微信开发者工具里创建云开发环境；
 * 2. 把环境 ID 填到 cloudEnvId；
 * 3. 重新编译小程序。
 *
 * 不要把 API Key、AppSecret 写进这里。
 */
module.exports = {
  cloudEnvId: "cloud1-d4g05zdxc94d17112",
  cloudFunctionName: "api",
  imageMode: "generations",
  imageCompression: {
    enabled: true,
    quality: 82,
    minBytes: 262144
  },
  appVersion: "0.15.3",
  photoToVideo: {
    durationSeconds: 3,
    resolution: "720p",
    prompt: "让照片中的人物自然轻微运动，保持人物身份、脸部、发型、服装和背景不变，镜头稳定，动作连贯，不要新增人物，不要变形。",
    maxBatch: 9,
    maxConcurrent: 2,
    pollIntervalMs: 2500,
    maxPolls: 120,
    cleanup: {
      enabled: true,
      gracePeriodMs: 24 * 60 * 60 * 1000,
      maxQueueItems: 100
    }
  }
};
