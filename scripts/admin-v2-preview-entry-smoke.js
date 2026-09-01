/* eslint-disable no-console */

const assert = require("assert");
const entry = require("./admin-v2-preview-entry");

const result = entry.buildEntry("http://localhost:49713/", entry.FIXTURE_ID);
assert.strictEqual(result.pages.length, 4);
assert.strictEqual(result.viewport.width, 390);
assert.ok(result.pages.every(page => page.browserUrl.includes("demo=1") && page.browserUrl.includes(entry.FIXTURE_ID)));
assert.ok(result.pages.every(page => page.miniProgramRoute.includes("demo=1") && !page.miniProgramRoute.includes("apiKey")));
assert.ok(result.pages.find(page => page.name === "operations").miniProgramRoute.includes("view=usage&demo=1"));
assert.ok(!entry.renderHtml(result).includes("secretKey"));
console.log("admin-v2-preview-entry-smoke: PASS (four-pages/fixture/demo-routes/no-secret)" );
