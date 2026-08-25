const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const gateway = require("../cloudfunctions/watermark-gateway");
const ENV_KEYS = [
  "WATERMARK_PROVIDER",
  "WATERMARK_GATEWAY_MOCK",
  "ZHUCEKA_API_BASE",
  "ZHUCEKA_UID",
  "ZHUCEKA_KEY",
  "ZHUCEKA_TIMEOUT_MS"
];

async function withProviderEnv(values, callback) {
  const previous = {};
  ENV_KEYS.forEach((key) => {
    previous[key] = process.env[key];
    delete process.env[key];
  });
  Object.entries(values || {}).forEach(([key, value]) => {
    process.env[key] = String(value);
  });
  try {
    return await callback();
  } finally {
    ENV_KEYS.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

function parseEvent(text = "平台分享文本 https://example.com/share/123") {
  return {
    action: "parse",
    text,
    requestId: "smoke-request"
  };
}

async function testMockProvider() {
  await withProviderEnv({ WATERMARK_PROVIDER: "mock" }, async () => {
    const health = await gateway.main({ action: "health", requestId: "health-mock" });
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.mode, "mock");
    assert.strictEqual(health.configured, true);

    const video = await gateway.main(parseEvent());
    assert.strictEqual(video.ok, true);
    assert.strictEqual(video.provider, "mock");
    assert.strictEqual(video.contentType, "video");
    assert.strictEqual(video.demo, true);

    const image = await gateway.main(Object.assign(parseEvent(), {
      demoContentType: "image"
    }));
    assert.strictEqual(image.ok, true);
    assert.strictEqual(image.contentType, "image");
    assert.strictEqual(image.primaryMedia.mimeType, "image/jpeg");
  });
}

async function testMissingConfiguration() {
  await withProviderEnv({ WATERMARK_PROVIDER: "zhuceka" }, async () => {
    const health = await gateway.main({ action: "health", requestId: "health-real" });
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.mode, "real");
    assert.strictEqual(health.configured, false);

    const result = await gateway.main(parseEvent());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "PROVIDER_NOT_CONFIGURED");
  });
}

async function runRealProviderCase(payload, options = {}) {
  const fakeUid = "smoke-user";
  const fakeKey = "smoke-key-never-commit";
  let inspectedEndpoint = null;
  const result = await withProviderEnv({
    WATERMARK_PROVIDER: "zhuceka",
    ZHUCEKA_UID: fakeUid,
    ZHUCEKA_KEY: fakeKey,
    ZHUCEKA_TIMEOUT_MS: "20000"
  }, () => gateway.main(
    parseEvent(options.text),
    {},
    {
      requestJson: async (endpoint, requestOptions) => {
        inspectedEndpoint = endpoint;
        assert.strictEqual(endpoint.protocol, "https:");
        assert.strictEqual(endpoint.searchParams.get("type"), "dsp");
        assert.strictEqual(endpoint.searchParams.get("uid"), fakeUid);
        assert.strictEqual(endpoint.searchParams.get("key"), fakeKey);
        assert.ok(endpoint.searchParams.get("url").startsWith("https://example.com/"));
        assert.strictEqual(requestOptions.timeoutMs, 20000);
        assert.strictEqual(requestOptions.allowedOrigin, endpoint.origin);
        if (options.throwError) throw options.throwError;
        return payload;
      }
    }
  ));
  if (!options.skipEndpointCheck) assert.ok(inspectedEndpoint);
  assert.ok(!JSON.stringify(result).includes(fakeKey));
  return result;
}

async function testRealProviderMappings() {
  const video = await runRealProviderCase({
    code: 200,
    msg: "解析成功",
    data: {
      title: "真实视频",
      description: "这是服务商返回的真实作品文案。",
      tags: ["旅行", "短视频"],
      author: "作者",
      platform: "douyin",
      cover: "https://cdn.example.com/cover.jpg",
      video: "https://cdn.example.com/video.mp4",
      images: ["https://cdn.example.com/ignored.jpg"]
    }
  });
  assert.strictEqual(video.ok, true);
  assert.strictEqual(video.provider, "zhuceka");
  assert.strictEqual(video.contentType, "video");
  assert.strictEqual(video.mediaUrl, "https://cdn.example.com/video.mp4");
  assert.strictEqual(video.copywriting, "这是服务商返回的真实作品文案。");
  assert.deepStrictEqual(video.copywritingTags, ["旅行", "短视频"]);
  assert.strictEqual(video.copywritingSource, "description");
  assert.strictEqual(video.demo, false);

  const image = await runRealProviderCase({
    code: 200,
    msg: "解析成功",
    data: {
      title: "真实图片",
      images: [
        "https://cdn.example.com/first.jpg",
        "https://cdn.example.com/second.jpg"
      ]
    }
  });
  assert.strictEqual(image.ok, true);
  assert.strictEqual(image.contentType, "image");
  assert.strictEqual(image.mediaUrl, "https://cdn.example.com/first.jpg");
  assert.strictEqual(image.mediaCount, 2);
  assert.strictEqual(image.mediaItems.length, 2);
  assert.strictEqual(image.mediaItems[1].url, "https://cdn.example.com/second.jpg");
}

async function testRealProviderFailures() {
  const quota = await runRealProviderCase({
    code: 500,
    msg: "调用次数不足，请充值",
    data: {}
  });
  assert.strictEqual(quota.ok, false);
  assert.strictEqual(quota.errorCode, "QUOTA_EXCEEDED");

  const empty = await runRealProviderCase({
    code: 200,
    msg: "解析成功",
    data: {}
  });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.errorCode, "PROVIDER_FAILED");

  const livePhoto = await runRealProviderCase({
    code: 200,
    msg: "解析成功",
    data: {
      live_photo: [
        {
          image: "https://cdn.example.com/live-1.jpg",
          video: "https://cdn.example.com/live-1.mp4"
        },
        {
          image: "https://cdn.example.com/live-2.jpg",
          video: "https://cdn.example.com/live-2.mp4"
        }
      ]
    }
  });
  assert.strictEqual(livePhoto.ok, true);
  assert.strictEqual(livePhoto.contentType, "live_photo");
  assert.strictEqual(livePhoto.mediaCount, 2);
  assert.strictEqual(livePhoto.livePhotoItems.length, 2);
  assert.strictEqual(livePhoto.livePhotoItems[1].imageUrl, "https://cdn.example.com/live-2.jpg");
  assert.strictEqual(livePhoto.livePhotoItems[1].videoUrl, "https://cdn.example.com/live-2.mp4");

  const timeout = new Error("timeout");
  timeout.code = "PROVIDER_TIMEOUT";
  const timedOut = await runRealProviderCase(null, { throwError: timeout });
  assert.strictEqual(timedOut.ok, false);
  assert.strictEqual(timedOut.errorCode, "PROVIDER_TIMEOUT");

  await withProviderEnv({
    WATERMARK_PROVIDER: "zhuceka",
    ZHUCEKA_UID: "smoke-user",
    ZHUCEKA_KEY: "smoke-key"
  }, async () => {
    const invalid = await gateway.main(parseEvent("没有链接的分享文本"));
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.errorCode, "INVALID_URL");

    const privateAddress = await gateway.main(parseEvent("http://127.0.0.1/internal"));
    assert.strictEqual(privateAddress.ok, false);
    assert.strictEqual(privateAddress.errorCode, "INVALID_URL");
  });
}

function testProviderRedirectSafety() {
  const endpoint = new URL("https://api.zhuceka.cn/home/api?uid=hidden&key=hidden");
  const relative = gateway.resolveProviderRedirect(
    endpoint,
    "/home/redirected",
    endpoint.origin
  );
  assert.strictEqual(relative.origin, endpoint.origin);
  assert.strictEqual(relative.pathname, "/home/redirected");

  assert.throws(
    () => gateway.resolveProviderRedirect(
      endpoint,
      "https://attacker.example/collect",
      endpoint.origin
    ),
    (error) => error && error.code === "PROVIDER_REDIRECT_FORBIDDEN"
  );
  assert.throws(
    () => gateway.resolveProviderRedirect(
      endpoint,
      "http://api.zhuceka.cn/home/api",
      endpoint.origin
    ),
    (error) => error && error.code === "PROVIDER_REDIRECT_FORBIDDEN"
  );
  assert.throws(
    () => gateway.resolveProviderRedirect(
      endpoint,
      "https://user:pass@api.zhuceka.cn/home/api",
      endpoint.origin
    ),
    (error) => error && error.code === "PROVIDER_REDIRECT_FORBIDDEN"
  );
}

function createPageHarness(handler) {
  const events = [];
  let page = null;
  let cloudHandler = handler;

  global.wx = {
    cloud: {
      callFunction(options) {
        Promise.resolve()
          .then(() => cloudHandler(options.data))
          .then(
            (result) => options.success({ result }),
            (error) => options.fail(error)
          );
      }
    },
    showToast(options) {
      events.push({ type: "toast", options });
    },
    showModal(options) {
      events.push({ type: "modal", options });
    },
    downloadFile(options) {
      events.push({ type: "download", options });
      const suffix = /\.jpe?g(?:$|\?)/i.test(options.url) ? ".jpg" : ".mp4";
      options.success({ statusCode: 200, tempFilePath: `/tmp/downloaded${suffix}` });
    },
    saveVideoToPhotosAlbum(options) {
      events.push({ type: "save-video", options });
      options.success();
    },
    saveImageToPhotosAlbum(options) {
      events.push({ type: "save-image", options });
      options.success();
    },
    getClipboardData(options) {
      events.push({ type: "get-clipboard", options });
      options.success({ data: "https://example.com/from-clipboard" });
    },
    setClipboardData(options) {
      events.push({ type: "set-clipboard", options });
      options.success();
    },
    getImageInfo(options) {
      events.push({ type: "get-image-info", options });
      options.success({ path: "/tmp/local-image.jpg" });
    },
    navigateBack(options) {
      if (options && options.fail) options.fail();
    },
    reLaunch(options) {
      events.push({ type: "reLaunch", options });
    }
  };
  global.Page = (definition) => {
    page = definition;
  };

  const pagePath = require.resolve("../pages/watermark-remover/watermark-remover.js");
  delete require.cache[pagePath];
  const helpers = require(pagePath);
  assert.ok(page);
  page.setData = (next) => {
    page.data = Object.assign({}, page.data, next);
  };

  return {
    page,
    helpers,
    events,
    setHandler(nextHandler) {
      cloudHandler = nextHandler;
    }
  };
}

async function testRealPageFlow() {
  let resultType = "video";
  const harness = createPageHarness((data) => {
    if (data.action === "health") {
      return {
        ok: true,
        provider: "zhuceka",
        mode: "real",
        configured: true,
        supports: ["video", "image"]
      };
    }
    if (resultType === "video") {
      return {
        ok: true,
        provider: "zhuceka",
        platform: "douyin",
        contentType: "video",
        title: "真实视频",
        copywriting: "这是一段可复制的真实文案。",
        copywritingTags: ["真实结果"],
        coverUrl: "https://cdn.example.com/cover.jpg",
        mediaUrl: "https://cdn.example.com/video.mp4",
        demo: false
      };
    }
    return {
      ok: true,
      provider: "zhuceka",
      platform: "xiaohongshu",
      contentType: "image",
      title: "真实图片",
      mediaUrl: "https://cdn.example.com/image.jpg",
      demo: false
    };
  });

  await harness.page.onLoad();
  assert.strictEqual(harness.page.data.providerReady, true);
  assert.strictEqual(harness.page.data.providerTitle, "真实解析服务已就绪");

  harness.page.onInput({ detail: { value: "分享 https://example.com/item" } });
  await harness.page.parseMedia();
  assert.strictEqual(harness.page.data.status, "success");
  assert.strictEqual(harness.page.data.result.contentType, "video");
  assert.strictEqual(harness.page.data.result.demo, false);
  assert.strictEqual(harness.page.data.result.isReal, true);
  assert.strictEqual(harness.page.data.result.platformLabel, "抖音");
  assert.strictEqual(harness.page.data.result.copywriting, "这是一段可复制的真实文案。");
  assert.strictEqual(harness.page.data.result.copywritingLength, 13);
  harness.page.copyCopywriting();
  assert.ok(harness.events.some((item) => item.type === "set-clipboard"));
  await harness.page.saveMedia();
  assert.ok(harness.events.some((item) => item.type === "save-video"));

  resultType = "image";
  await harness.page.parseMedia();
  assert.strictEqual(harness.page.data.status, "success");
  assert.strictEqual(harness.page.data.result.contentType, "image");
  assert.strictEqual(harness.page.data.result.platformLabel, "小红书");
  await harness.page.saveMedia();
  assert.ok(harness.events.some((item) => item.type === "save-image"));

  harness.setHandler(() => Promise.reject(new Error("cloud unavailable")));
  await harness.page.parseMedia();
  assert.strictEqual(harness.page.data.status, "error");
  assert.strictEqual(harness.page.data.result, null);
}

async function testExplicitMockPageFlow() {
  const harness = createPageHarness((data) => {
    if (data.action === "health") {
      return {
        ok: true,
        provider: "mock",
        mode: "mock",
        configured: true,
        supports: ["video", "image"]
      };
    }
    return gateway.buildDemoResult("page-mock", "image");
  });
  await harness.page.onLoad();
  harness.page.onInput({ detail: { value: "分享 https://example.com/mock" } });
  await harness.page.parseMedia();
  assert.strictEqual(harness.page.data.status, "success");
  assert.strictEqual(harness.page.data.result.demo, true);
  assert.strictEqual(harness.page.data.result.contentType, "image");
  assert.ok(harness.page.data.result.copywriting);
  assert.ok(harness.page.data.result.mediaUrl.endsWith("media-parser-demo.jpg"));
}

function testPageMarkup() {
  const pageJs = fs.readFileSync(
    path.join(root, "pages/watermark-remover/watermark-remover.js"),
    "utf8"
  );
  const wxml = fs.readFileSync(
    path.join(root, "pages/watermark-remover/watermark-remover.wxml"),
    "utf8"
  );
  const wxss = fs.readFileSync(
    path.join(root, "pages/watermark-remover/watermark-remover.wxss"),
    "utf8"
  );
  assert.ok(pageJs.includes('action: "health"'));
  assert.ok(pageJs.includes('action: "parse"'));
  assert.ok(!pageJs.includes("localFallback"));
  assert.ok(!pageJs.includes("selectDemoType"));
  assert.ok(!pageJs.includes("response = buildLocalDemoResult"));
  assert.ok(wxml.includes('wx:if="{{result.demo}}"'));
  assert.ok(wxml.includes("真实结果"));
  assert.ok(wxml.includes("一键解析并提取"));
  assert.ok(wxml.includes("copyCopywriting"));
  assert.ok(wxml.includes("copywriting-card"));
  assert.ok(wxml.includes("保存媒体"));
  assert.ok(!wxml.includes("选择演示类型"));
  assert.ok(!wxml.includes("真实平台解析服务尚未接入"));
  assert.ok(!wxml.includes("MEDIA PARSER · M0"));
  assert.ok(!wxml.includes("MEDIA PARSER"));
  assert.ok(!wxml.includes("provider-card"));
  assert.ok(!wxml.includes("仅处理本人发布或已获授权的内容"));
  assert.ok(!wxss.includes(".media-parser-kicker"));
  assert.ok(!wxss.includes(".provider-card"));
  assert.ok(!wxss.includes(".compliance-note"));
  assert.ok(wxss.includes(".feature-option"));
  assert.ok(wxss.includes(".copywriting-card"));
}

async function main() {
  await testMockProvider();
  await testMissingConfiguration();
  await testRealProviderMappings();
  await testRealProviderFailures();
  testProviderRedirectSafety();
  await testRealPageFlow();
  await testExplicitMockPageFlow();
  testPageMarkup();
  console.log("watermark provider smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
