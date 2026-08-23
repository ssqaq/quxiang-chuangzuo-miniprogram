const assert = require("assert");
const diagnosticLog = require("../utils/diagnostic-log");

const storage = {};
global.wx = {
  getStorageSync(key) {
    return storage[key];
  },
  setStorageSync(key, value) {
    storage[key] = value;
  },
  removeStorageSync(key) {
    delete storage[key];
  },
  getSystemInfoSync() {
    return {
      platform: "devtools",
      brand: "smoke",
      model: "diagnostic-test"
    };
  },
  getAccountInfoSync() {
    return {
      miniProgram: {
        envVersion: "develop",
        version: "0.12.0"
      }
    };
  },
  getNetworkType(options) {
    options.success({ networkType: "wifi" });
  }
};

global.getCurrentPages = () => [{ route: "pages/index/index" }];

async function main() {
  diagnosticLog.startSession({
    reason: "smoke",
    appVersion: "0.12.0"
  });
  const session = diagnosticLog.getSession();
  assert.ok(session.id.startsWith("diag-"));
  assert.ok(session.startedAt);

  diagnosticLog.info("generation", "submit", "提交生图任务", {
    requestId: "req-smoke",
    prompt: "完整正向提示词",
    negativePrompt: "完整负向提示词",
  apiKey: "fake-key-for-redaction-test"
  });
  diagnosticLog.warn("cloud", "retry", "请求重试", {
    requestId: "req-smoke",
    attempt: 1
  });
  diagnosticLog.error("cloud", "failed", "请求失败", {
    requestId: "req-smoke",
    error: {
      code: "UPSTREAM_TIMEOUT",
      message: "上游超时",
      stack: "Error: 上游超时\n at smoke.js:1:1",
      payload: {
        token: "secret-token"
      }
    }
  });

  const events = diagnosticLog.read();
  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[0].details.prompt, "完整正向提示词");
  assert.strictEqual(events[0].details.negativePrompt, "完整负向提示词");
  assert.strictEqual(events[0].details.apiKey, "[redacted]");
  assert.strictEqual(events[2].requestId, "req-smoke");
  assert.strictEqual(events[2].error.code, "UPSTREAM_TIMEOUT");
  assert.strictEqual(events[2].error.payload.token, "[redacted]");

  for (let index = 0; index < diagnosticLog.MAX_ENTRIES + 25; index += 1) {
    diagnosticLog.info("test", "append", `第${index}条`);
  }
  assert.strictEqual(diagnosticLog.read().length, diagnosticLog.MAX_ENTRIES);

  const report = await diagnosticLog.buildReport({
    appVersion: "0.12.0",
    cloudEnvId: "cloud-test",
    cloudFunctionName: "api",
    cloudReady: true,
    projectSnapshot: {
      promptDraft: "报告里的提示词",
      mainImage: {
        path: "C:\\private\\main.jpg",
        fileID: "cloud://private"
      }
    }
  });
  assert.strictEqual(report.schemaVersion, "1.0");
  assert.ok(report.session.id);
  assert.strictEqual(report.app.appVersion, "0.12.0");
  assert.strictEqual(report.runtime.currentRoute, "pages/index/index");
  assert.ok(report.device.platform);
  assert.strictEqual(report.runtime.network.networkType, "wifi");
  assert.ok(Array.isArray(report.events));
  assert.strictEqual(report.projectSnapshot.mainImage.path, "[local]/main.jpg");

  diagnosticLog.clear();
  assert.strictEqual(diagnosticLog.read().length, 0);
  assert.strictEqual(diagnosticLog.getStats().eventCount, 0);
  console.log("diagnostic log smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
