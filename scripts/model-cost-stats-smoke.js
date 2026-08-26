/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "cost-admin";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露成本统计测试接口");

const costs = test.resolveCostConfig({});
assert.strictEqual(costs.currency, "CNY");
assert.strictEqual(costs.version, "2026-08-26-v3");
assert.strictEqual(costs.face.inputPerMillionTokens, 0.15);
assert.strictEqual(costs.face.outputPerMillionTokens, 1.5);
assert.strictEqual(costs.image.primaryProvider, "xingju");
assert.deepStrictEqual(costs.image.perImage, {
  "1K": 0.07,
  "2K": 0.07,
  "4K": 0.07
});
assert.deepStrictEqual(costs.image.providers.xingju.perImage, {
  "1K": 0.07,
  "2K": 0.07,
  "4K": 0.07
});
assert.deepStrictEqual(costs.image.providers.lingyun.perImage, {
  "1K": 0.06,
  "2K": 0.1,
  "4K": 0.15
});
assert.strictEqual(costs.video.perSecond["480p"], 0.2);
assert.strictEqual(costs.video.perSecond["720p"], 0.3);
assert.strictEqual(costs.video.perSecond["1080p"], 1.8);

const lingyunPrimaryCosts = test.resolveCostConfig({}, {
  imageProvider: "lingyun"
});
assert.strictEqual(lingyunPrimaryCosts.image.primaryProvider, "lingyun");
assert.deepStrictEqual(lingyunPrimaryCosts.image.perImage, {
  "1K": 0.06,
  "2K": 0.1,
  "4K": 0.15
});
assert.strictEqual(test.normalizeImageCostProvider("https://newapi.akiyo.fun/v1"), "xingju");
assert.strictEqual(test.normalizeImageCostProvider("https://api.lingyunapi.xyz/v1"), "lingyun");

const providerAwareCosts = test.resolveCostConfig({
  image: {
    perImage: {
      "1K": 0.07,
      "2K": 0.07,
      "4K": 0.07
    },
    providers: {
      xingju: {
        perImage: {
          "1K": 0.07,
          "2K": 0.07,
          "4K": 0.07
        }
      }
    }
  }
});
assert.deepStrictEqual(
  providerAwareCosts.image.providers.lingyun.perImage,
  {
    "1K": 0.06,
    "2K": 0.1,
    "4K": 0.15
  },
  "已有 Provider 新结构时，兼容 perImage 不能误当成凌云旧价格"
);

const legacyImagePrices = {
  "1K": 0.015,
  "2K": 0.025,
  "4K": 0.035
};
const migratedLegacyCosts = test.migrateLegacyModelCostConfig(
  test.normalizeRuntimePatch({
    costs: {
      image: {
        perImage: Object.assign({}, legacyImagePrices)
      },
      video: {
        perSecond: {
          "480p": 0.2,
          "720p": 0.3,
          "1080p": 1.8
        }
      }
    }
  }),
  {
    costs: {
      image: {
        perImage: Object.assign({}, legacyImagePrices)
      },
      video: {
        perSecond: {
          "480p": 0.2,
          "720p": 0.3,
          "1080p": 1.8
        }
      }
    }
  }
);
assert.strictEqual(migratedLegacyCosts.migrated, true);
assert.deepStrictEqual(
  migratedLegacyCosts.value.costs.image.perImage,
  {
    "1K": 0.07,
    "2K": 0.07,
    "4K": 0.07
  },
  "旧版页面兼容价格必须返回当前星炬主模型价格"
);
assert.deepStrictEqual(
  migratedLegacyCosts.value.costs.image.providers.xingju.perImage,
  {
    "1K": 0.07,
    "2K": 0.07,
    "4K": 0.07
  }
);
assert.deepStrictEqual(
  migratedLegacyCosts.value.costs.image.providers.lingyun.perImage,
  {
    "1K": 0.06,
    "2K": 0.1,
    "4K": 0.15
  },
  "旧版默认图片价格必须升级成当前凌云价格"
);
assert.deepStrictEqual(
  migratedLegacyCosts.value.costs.video.perSecond,
  {
    "480p": 0.2,
    "720p": 0.3,
    "1080p": 1.8
  },
  "价格迁移不能改动视频成本"
);

const customCosts = test.migrateLegacyModelCostConfig(
  test.normalizeRuntimePatch({
    costs: {
      image: {
        perImage: {
          "1K": 0.08,
          "2K": 0.12,
          "4K": 0.18
        }
      }
    }
  }),
  {
    costs: {
      image: {
        perImage: {
          "1K": 0.08,
          "2K": 0.12,
          "4K": 0.18
        }
      }
    }
  }
);
assert.strictEqual(customCosts.migrated, true);
assert.deepStrictEqual(customCosts.value.costs.image.perImage, {
  "1K": 0.07,
  "2K": 0.07,
  "4K": 0.07
});
assert.deepStrictEqual(customCosts.value.costs.image.providers.xingju.perImage, {
  "1K": 0.07,
  "2K": 0.07,
  "4K": 0.07
});
assert.deepStrictEqual(customCosts.value.costs.image.providers.lingyun.perImage, {
  "1K": 0.08,
  "2K": 0.12,
  "4K": 0.18
});

const currentProviderConfig = {
  image: {
    provider: "xingju"
  },
  costs: {
    image: {
      perImage: {
        "1K": 0.07,
        "2K": 0.07,
        "4K": 0.07
      },
      providers: {
        xingju: {
          perImage: {
            "1K": 0.07,
            "2K": 0.07,
            "4K": 0.07
          }
        },
        lingyun: {
          perImage: {
            "1K": 0.06,
            "2K": 0.1,
            "4K": 0.15
          }
        }
      }
    }
  }
};
const currentProviderCosts = test.migrateLegacyModelCostConfig(
  test.normalizeRuntimePatch(currentProviderConfig),
  currentProviderConfig
);
assert.strictEqual(currentProviderCosts.migrated, false);
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(
    currentProviderCosts.value.costs.image,
    "primaryProvider"
  ),
  false,
  "主服务商由真实 image.provider 决定，不重复持久化到成本配置"
);

const faceBilling = test.buildUsageBilling(
  { action: "detectFaceCircle" },
  {
    json: {
      usage: {
        prompt_tokens: 1000000,
        completion_tokens: 2000000,
        total_tokens: 3000000
      }
    }
  },
  costs
);
assert.strictEqual(faceBilling.billingSource, "actual");
assert.strictEqual(faceBilling.inputTokens, 1000000);
assert.strictEqual(faceBilling.outputTokens, 2000000);
assert.strictEqual(faceBilling.estimatedCost, 3.15);

const imageBilling = test.buildUsageBilling(
  {
    action: "generate",
    provider: "xingju",
    imageResolution: "2048x2048",
    success: true
  },
  { json: {} },
  costs
);
assert.strictEqual(imageBilling.billingSource, "estimated");
assert.strictEqual(imageBilling.imageResolution, "2K");
assert.strictEqual(imageBilling.unitPrice, 0.07);
assert.strictEqual(imageBilling.estimatedCost, 0.07);
assert.strictEqual(imageBilling.costBreakdown.provider, "xingju");

const backupImageBilling = test.buildUsageBilling(
  {
    action: "generate",
    provider: "lingyun",
    imageResolution: "2048x2048",
    success: true
  },
  { json: {} },
  costs
);
assert.strictEqual(backupImageBilling.unitPrice, 0.1);
assert.strictEqual(backupImageBilling.estimatedCost, 0.1);
assert.strictEqual(backupImageBilling.costBreakdown.provider, "lingyun");

const failedImageBilling = test.buildUsageBilling(
  {
    action: "generate",
    provider: "xingju",
    imageResolution: "4096x4096",
    success: false
  },
  { json: {} },
  costs
);
assert.strictEqual(failedImageBilling.billingSource, "unavailable");
assert.strictEqual(failedImageBilling.unitPrice, 0);
assert.strictEqual(failedImageBilling.estimatedCost, 0);
assert.strictEqual(failedImageBilling.costBreakdown.quantity, 0);

const analysisBilling = test.buildUsageBilling(
  { action: "analyze" },
  {
    json: {
      usage: {
        prompt_tokens: 1000000,
        completion_tokens: 1000000,
        total_tokens: 2000000
      }
    }
  },
  costs
);
assert.strictEqual(analysisBilling.billingSource, "actual");
assert.strictEqual(analysisBilling.estimatedCost, 1.65);

const videoBilling = test.buildUsageBilling(
  {
    action: "video.create",
    videoResolution: "720p",
    videoDurationSeconds: 3
  },
  { json: {} },
  costs
);
assert.strictEqual(videoBilling.billingSource, "estimated");
assert.strictEqual(videoBilling.videoDurationSeconds, 3);
assert.strictEqual(videoBilling.estimatedCost, 0.9);

const baseDate = new Date("2026-08-23T12:00:00.000Z");
const events = [
  {
    requestId: "analysis-1",
    usageType: "analysis",
    action: "analyze",
    provider: "vision-provider",
    model: "analysis-model",
    userHash: "user-a",
    dateKey: "2026-08-23",
    success: true,
    billingSource: "actual",
    inputTokens: 1000000,
    outputTokens: 1000000,
    totalTokens: 2000000,
    estimatedCost: 1.65,
    costBreakdown: { inputCost: 0.15, outputCost: 1.5 }
  },
  {
    requestId: "face-1",
    usageType: "face",
    action: "detectFaceCircle",
    provider: "dashscope",
    model: "qwen3-vl-flash",
    userHash: "user-a",
    dateKey: "2026-08-23",
    success: true,
    billingSource: "actual",
    inputTokens: 1000000,
    outputTokens: 2000000,
    totalTokens: 3000000,
    estimatedCost: 3.15,
    costBreakdown: { inputCost: 0.15, outputCost: 3 }
  },
  {
    requestId: "image-1",
    usageType: "image",
    action: "generate",
    provider: "xingju",
    model: "jw-gpt-image-2",
    userHash: "user-a",
    dateKey: "2026-08-23",
    success: true,
    billingSource: "estimated",
    imageResolution: "2K",
    estimatedCost: 0.07
  },
  {
    requestId: "video-1",
    usageType: "video",
    action: "video.create",
    provider: "lingyun",
    model: "grok-imagine-video-1.5",
    userHash: "user-b",
    dateKey: "2026-08-22",
    success: true,
    billingSource: "estimated",
    videoResolution: "720p",
    videoDurationSeconds: 3,
    estimatedCost: 0.9
  },
  {
    requestId: "old-1",
    usageType: "image",
    action: "generate",
    provider: "old",
    model: "old-model",
    userHash: "user-c",
    dateKey: "2026-07-01",
    success: true
  }
];

const normalized = events.map((item) => test.normalizeModelUsageEvent(item));
const stats = test.aggregateModelUsageEvents(normalized, 30, baseDate);
assert.strictEqual(stats.today.total, 3);
assert.strictEqual(stats.today.estimatedCost, 4.87);
assert.strictEqual(stats.last30d.total, 4);
assert.strictEqual(stats.summary.analysis.total, 1);
assert.strictEqual(stats.summary.face.total, 1);
assert.strictEqual(stats.summary.image.total, 1);
assert.strictEqual(stats.summary.video.total, 1);
assert.strictEqual(stats.users[0].userHash, "user-a");
assert.strictEqual(stats.users[0].total, 3);
assert.strictEqual(stats.models.length, 4);
assert.ok(stats.monthly.some((item) => item.monthKey === "2026-08"));
assert.strictEqual(stats.daily[0].dateKey, "2026-08-23");
assert.strictEqual(stats.daily[0].image.imageResolutions["2K"].count, 1);
assert.strictEqual(stats.daily[0].face.totalTokens, 3000000);

const workbook = test.buildModelUsageExportWorkbook(stats);
assert.ok(Buffer.isBuffer(workbook));
assert.ok(workbook.length > 100);
assert.strictEqual(workbook.slice(0, 2).toString(), "PK");

console.log("model cost stats smoke: OK");
console.log(JSON.stringify({
  todayCost: stats.today.estimatedCost,
  userCount: stats.users.length,
  modelCount: stats.models.length,
  monthCount: stats.monthly.length,
  workbookBytes: workbook.length
}));
