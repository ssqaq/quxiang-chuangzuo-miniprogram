/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "cleanup-admin";

const root = path.resolve(__dirname, "..");
const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

async function main() {
  assert.ok(test, "云函数没有暴露测试接口");
  assert.ok(
    test.generationActionRegistry,
    "真实 Action Registry 没有暴露给专项测试"
  );

  const registry = test.generationActionRegistry;
  const cleanupEntry = registry.list().find((entry) => (
    entry.name === "cleanupGenerationOperationHistory"
  ));
  assert.deepStrictEqual(cleanupEntry, {
    name: "cleanupGenerationOperationHistory",
    triggerName: "generation-operation-history-cleanup",
    access: "timer-or-admin",
    metadata: { workflow: "generation-retention-v1" }
  });

  const exactTrigger = registry.resolve({
    triggerName: "generation-operation-history-cleanup"
  });
  assert.ok(exactTrigger, "精确定时器没有匹配清理 action");
  assert.strictEqual(exactTrigger.entry.name, "cleanupGenerationOperationHistory");
  assert.strictEqual(exactTrigger.matchedBy, "trigger");

  assert.strictEqual(
    registry.resolve({
      triggerName: "generation-operation-history-cleanup-copy"
    }),
    null,
    "近似定时器名称不应获得系统身份"
  );

  const denied = await registry.dispatch(
    {
      action: "cleanupGenerationOperationHistory",
      requestId: "cleanup-user-denied"
    },
    { OPENID: "ordinary-user" }
  );
  assert.strictEqual(denied.handled, true);
  assert.strictEqual(denied.denied, true);
  assert.strictEqual(denied.result.errorCode, "ADMIN_FORBIDDEN");

  const triggerConfig = JSON.parse(
    readText("cloudfunctions/api/config.json")
  );
  const cleanupTriggers = triggerConfig.triggers.filter((trigger) => (
    trigger.name === "generation-operation-history-cleanup"
  ));
  assert.strictEqual(cleanupTriggers.length, 1, "清理定时器必须且只能登记一次");
  assert.deepStrictEqual(cleanupTriggers[0], {
    name: "generation-operation-history-cleanup",
    type: "timer",
    config: "0 20 4 * * * *"
  });

  const indexManifest = JSON.parse(readText("scripts/database-indexes.json"));
  const cleanupIndex = indexManifest.indexes.find((index) => (
    index.collection === "generation_operations"
    && index.name === "idx_status_updated_at"
  ));
  assert.ok(cleanupIndex, "缺少旧任务清理索引");
  assert.deepStrictEqual(cleanupIndex.keys, [
    { name: "status", direction: 1 },
    { name: "updatedAt", direction: 1 }
  ]);
  assert.strictEqual(cleanupIndex.unique, false);

  const cloudService = readText("services/cloud.js");
  const adminJs = readText("pages/admin/admin.js");
  const adminWxml = readText("pages/admin/admin.wxml");
  const adminWxss = readText("pages/admin/admin.wxss");
  assert.ok(
    cloudService.includes("cleanupGenerationOperationHistory()"),
    "客户端云服务缺少管理员清理封装"
  );
  assert.ok(
    cloudService.includes('action: "cleanupGenerationOperationHistory"'),
    "客户端清理封装没有调用正确 action"
  );
  assert.ok(
    adminJs.includes("async cleanupOldGenerationOperations()"),
    "管理员页缺少手动清理方法"
  );
  assert.ok(
    adminJs.includes("只删除90天前已完成或已退款"),
    "管理员清理前缺少安全范围二次确认"
  );
  assert.ok(
    adminWxml.includes('bindtap="cleanupOldGenerationOperations"'),
    "管理员页缺少手动清理按钮"
  );
  assert.ok(
    adminWxml.includes("默认保留90天")
    && adminWxml.includes("单次最多50条"),
    "管理员页没有说明保留期和单次上限"
  );
  assert.ok(
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.generation-queue-card\s+\.generation-retention-panel\s*\{[\s\S]*?flex-direction:\s*column;[\s\S]*?align-items:\s*stretch;/.test(adminWxss),
    "旧任务清理面板没有适配小屏纵向布局"
  );
  assert.ok(
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.generation-queue-card\s+\.generation-retention-button\s*\{[\s\S]*?width:\s*100%;/.test(adminWxss),
    "旧任务清理按钮没有在小屏铺满"
  );

  const apiPackage = JSON.parse(readText("cloudfunctions/api/package.json"));
  const vendorPackage = JSON.parse(
    readText("cloudfunctions/api/vendor/xlsx/package.json")
  );
  assert.strictEqual(apiPackage.dependencies["wx-server-sdk"], "4.0.2");
  assert.strictEqual(apiPackage.dependencies.xlsx, "file:vendor/xlsx");
  assert.strictEqual(vendorPackage.name, "xlsx");
  assert.strictEqual(vendorPackage.version, "0.20.3");
  assert.strictEqual(
    require("../cloudfunctions/api/node_modules/xlsx/package.json").version,
    "0.20.3",
    "实际安装的 xlsx 版本不正确"
  );

  console.log(
    "generation operation cleanup smoke: OK "
    + "(registry/permission/exact-trigger/config/index/admin/vendor)"
  );
}

main().catch((error) => {
  console.error(
    `generation operation cleanup smoke 失败：${error.stack || error}`
  );
  process.exitCode = 1;
});
