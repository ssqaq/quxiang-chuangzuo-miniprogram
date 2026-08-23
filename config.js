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
  appVersion: "0.11.1",
  photoToVideo: {
    durationSeconds: 3,
    maxBatch: 9,
    maxConcurrent: 2,
    pollIntervalMs: 2500,
    maxPolls: 120
  }
};

