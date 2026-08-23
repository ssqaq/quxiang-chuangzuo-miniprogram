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
  appVersion: "0.20.0",
  points: {
    dailyFreeLimit: 3,
    imageCost: 10,
    videoCost: 10,
    checkinPoints: 5,
    streakBonus: 20,
    streakDays: 7,
    promoStartDate: "2026-08-23",
    promoEndDate: "2026-08-24",
    copy: {
      cardTitle: "每日签到",
      streakPrefix: "连续签到",
      streakSuffix: "天有额外奖励",
      notCheckedIn: "今天还没签到",
      checkedIn: "今天已签到",
      freePrefix: "今天还可免费用",
      freeSuffix: "次",
      promoActive: "活动期间免费",
      checkIn: "签到",
      checkedInButton: "已签到",
      checkInWithRewardPrefix: "今日签到 +",
      checkInWithRewardSuffix: " 积分",
      bindAndCheckIn: "微信授权并签到",
      checkInSuccessPrefix: "签到成功，+",
      checkInSuccessSuffix: " 积分",
      checkInDuplicate: "今天已经签到过了",
      pointsTitle: "连续签到，攒积分",
      pointsSectionTitle: "连续签到进度",
      pointsPromo: "活动期间生图和视频不限次数免费，不扣积分。",
      checkInHintPrefix: "每日签到",
      checkInHintSuffix: "积分；积分永久有效。"
    }
  },
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


