/* eslint-disable no-console */

const assert = require("assert");
const XLSX = require("../cloudfunctions/api/node_modules/xlsx");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露成本明细导出测试接口");

const event = {
  dateKey: "2026-08-26",
  createdAt: "2026-08-26T12:00:00.000Z",
  userHash: "=user-hash",
  requestId: "detail-request",
  usageType: "image",
  action: "generate",
  provider: "lingyun",
  model: "gpt-image-2",
  imageResolution: "1K",
  unitPrice: 0.06,
  estimatedCost: 0.06,
  billingSource: "estimated",
  status: 200,
  success: true,
  durationMs: 59000,
  costConfigVersion: "2026-08-26-v3",
  apiKey: "SHOULD_NOT_EXPORT",
  authorization: "SHOULD_NOT_EXPORT"
};
const rows = test.buildModelUsageDetailRows([
  event,
  {
    dateKey: "2026-08-26",
    createdAt: "2026-08-26T11:00:00.000Z",
    userHash: "user-old",
    requestId: "unpriced-request",
    usageType: "image",
    provider: "legacy",
    model: "legacy-image",
    imageResolution: "1K",
    billingSource: "unavailable",
    success: false,
    status: 503,
    durationMs: 3000
  }
]);

assert.strictEqual(rows[0][0], "日期");
assert.ok(rows[0].includes("请求编号"));
assert.ok(rows[0].includes("成本配置版本"));
assert.ok(rows[1].includes("gpt-image-2"));
assert.ok(rows[1].includes("'=user-hash"), "Excel 公式开头必须转成普通文本");
assert.ok(rows[2].includes("未计价"), "历史缺失成本时必须明确标记未计价");
assert.ok(!JSON.stringify(rows).includes("SHOULD_NOT_EXPORT"));

const stats = test.aggregateModelUsageEvents(
  [event],
  30,
  new Date("2026-08-26T13:00:00.000Z")
);
assert.strictEqual(stats.details.length, 1, "统计结果必须保留选定时间范围内的脱敏调用明细");
assert.strictEqual(stats.details[0].requestId, "detail-request");
assert.ok(!Object.prototype.hasOwnProperty.call(stats.details[0], "apiKey"));
assert.ok(!Object.prototype.hasOwnProperty.call(stats.details[0], "authorization"));

const workbookBuffer = test.buildModelUsageExportWorkbook(stats);
assert.ok(Buffer.isBuffer(workbookBuffer));
const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
assert.ok(workbook.SheetNames.includes("成本调用明细"));
const sheetRows = XLSX.utils.sheet_to_json(
  workbook.Sheets["成本调用明细"],
  { header: 1, defval: "" }
);
assert.strictEqual(sheetRows[0][0], "日期");
assert.ok(sheetRows[1].includes("gpt-image-2"));
assert.ok(!JSON.stringify(sheetRows).includes("SHOULD_NOT_EXPORT"));

console.log("model usage export detail smoke: OK");
