const assert = require("assert");

let callCount = 0;

global.getApp = () => ({
  globalData: {
    cloudReady: true
  }
});

global.wx = {
  cloud: {
    callFunction(options) {
      callCount += 1;
      options.success({
        result: {
          ok: false,
          errorCode: "upstream-unavailable",
          message: "视觉服务暂时不可用",
          status: 503,
          retryable: true,
          requestId: "req-cloud-propagation"
        }
      });
    }
  }
};

const cloud = require("../services/cloud");

async function main() {
  let capturedError = null;
  try {
    await cloud.detectFaceCircle({
      mainFileID: "cloud://main.jpg"
    });
  } catch (error) {
    capturedError = error;
  }

  assert.ok(capturedError, "云函数失败应该向页面抛出错误");
  assert.strictEqual(callCount, 3, "可重试的云函数失败应按默认策略调用三次");
  assert.strictEqual(capturedError.status, 503);
  assert.strictEqual(capturedError.retryable, true);
  assert.strictEqual(capturedError.requestId, "req-cloud-propagation");
  assert.strictEqual(capturedError.payload.errorCode, "upstream-unavailable");
  assert.strictEqual(capturedError.payload.message, "视觉服务暂时不可用");

  console.log("cloud error propagation smoke: OK");
  console.log(JSON.stringify({
    status: capturedError.status,
    retryable: capturedError.retryable,
    requestId: capturedError.requestId,
    calls: callCount
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
