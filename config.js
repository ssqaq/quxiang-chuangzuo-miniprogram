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
  paymentCloudFunctionName: "payment-api",
  imageMode: "edits",
  adminPreviewDemo: false,
  // 正常页面保持和设计稿一致；调试时可用 ?demoControl=1 显示页内开关。
  adminPreviewDemoControl: false,
  imageCompression: {
    enabled: true,
    quality: 82,
    minBytes: 262144
  },
  appVersion: "0.57.107",
  points: {
    dailyFreeLimit: 3,
    imageCost: 10,
    videoCost: 10,
    checkinPoints: 5,
    streakBonus: 20,
    streakDays: 7,
    promoStartDate: "2026-08-24",
    promoEndDate: "2026-08-25",
    copy: {
      cardTitle: "每日签到",
      streakPrefix: "连续签到",
      streakSuffix: "天有额外奖励",
      notCheckedIn: "今天还没签到",
      checkedIn: "今天已签到",
      freePrefix: "今天还可免费用",
      freeSuffix: "次",
      promoActive: "活动期间限时全功能不扣积分",
      checkIn: "签到",
      checkedInButton: "已签到",
      checkInWithRewardPrefix: "今日签到 +",
      checkInWithRewardSuffix: " 积分",
      bindAndCheckIn: "微信授权并签到",
      checkInSuccessPrefix: "签到成功，+",
      checkInSuccessSuffix: " 积分",
      checkInDuplicate: "今天已经签到过了",
      pointsKicker: "POINTS CENTER",
      pointsTitle: "连续签到，攒积分",
      pointsSectionTitle: "连续签到进度",
      pointsPromo: "活动期间限时全功能不扣积分",
      checkInHintPrefix: "每日签到",
      checkInHintSuffix: "积分；积分永久有效。",
      pointsUnit: "积分",
      dayUnit: "天",
      streakStatusPrefix: "已连续",
      currentPointsLabel: "当前积分",
      streakRewardPrefix: "连续满",
      streakRewardMiddle: "天，额外奖励",
      progressPrefix: "本轮已连续",
      targetPrefix: "目标",
      usageTitle: "使用说明",
      todayFreeLabel: "今日免费",
      imageCostLabel: "生图扣除",
      videoCostLabel: "视频扣除",
      usageNote: "每日免费次数用完后，提交时会提示并自动从积分中扣除。",
      ledgerTitle: "积分明细",
      ledgerTotalPrefix: "累计获得",
      emptyLedger: "还没有积分记录，今天先签到吧。",
      defaultBoundMessage: "点击签到后绑定微信身份",
      localPreviewMessage: "当前是本地预览，连接云端后可以签到和使用积分。",
      loadFailedMessage: "积分信息读取失败，先检查云函数是否已部署。",
      cloudRequired: "连接云端后才能签到",
      checkInFailedTitle: "签到失败",
      checkInFailedFallback: "签到失败，请稍后再试",
      ledgerDefaultDescription: "积分记录",
      justNow: "刚刚",
      backToWorkbench: "返回工作台"
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
      idlePeriodMs: 2 * 60 * 60 * 1000,
      gracePeriodMs: 3 * 24 * 60 * 60 * 1000,
      maxQueueItems: 100
    }
  }
};
