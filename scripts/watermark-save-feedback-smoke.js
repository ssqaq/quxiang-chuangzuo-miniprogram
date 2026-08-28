const assert = require("assert");

function loadPage(saveMode, config = {}) {
  let page = null;
  const events = [];
  let imageCalls = 0;
  let clipboardMode = config.clipboardMode || "success";
  const pendingSaves = [];

  global.Page = (definition) => {
    page = definition;
  };
  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {},
    showToast(options) {
      events.push({ type: "toast", options });
    },
    showModal(options) {
      events.push({ type: "modal", options });
      if (config.autoCloseModal && typeof options.success === "function") {
        options.success({ confirm: true, cancel: false });
      }
    },
    setClipboardData(options) {
      if (clipboardMode === "error") {
        options.fail(new Error("clipboard failed"));
        return;
      }
      options.success();
    },
    getImageInfo(options) {
      options.success({ path: options.src });
    },
    saveImageToPhotosAlbum(options) {
      imageCalls += 1;
      events.push({ type: "save-image", options });
      if (config.deferSave) {
        pendingSaves.push(options);
        return;
      }
      if (saveMode === "error" || (saveMode === "partial" && imageCalls > 1)) {
        options.fail(new Error("save failed"));
        return;
      }
      options.success();
    },
    saveVideoToPhotosAlbum(options) {
      events.push({ type: "save-video", options });
      if (config.deferSave) {
        pendingSaves.push(options);
        return;
      }
      if (saveMode === "error") {
        options.fail(new Error("save failed"));
        return;
      }
      options.success();
    }
  };

  const pagePath = require.resolve("../pages/watermark-remover/watermark-remover.js");
  delete require.cache[pagePath];
  require(pagePath);
  assert.ok(page);
  page.setData = (next) => {
    page.data = Object.assign({}, page.data, next);
  };
  return {
    page,
    events,
    pendingSaves,
    setClipboardMode(mode) {
      clipboardMode = mode;
    }
  };
}

function setResult(page, result) {
  page.data.result = Object.assign({
    contentType: "image",
    mediaUrl: "",
    mediaItems: [],
    livePhotoItems: [],
    demo: false
  }, result);
}

async function main() {
  const success = loadPage("success");
  setResult(success.page, {
    mediaItems: [{ url: "/assets/one.jpg" }]
  });
  await success.page.saveMedia();
  assert.strictEqual(success.page.data.saveFeedback, "已保存");
  assert.strictEqual(success.page.data.saveFeedbackTone, "success");
  success.page.clearSaveFeedbackTimer();

  const partial = loadPage("partial");
  setResult(partial.page, {
    mediaItems: [{ url: "/assets/one.jpg" }, { url: "/assets/two.jpg" }]
  });
  await partial.page.saveMedia();
  assert.strictEqual(partial.page.data.saveFeedback, "部分保存");
  assert.strictEqual(partial.page.data.saveFeedbackTone, "partial");
  assert.ok(partial.events.some((item) => item.type === "modal"));
  partial.page.clearSaveFeedbackTimer();

  const failed = loadPage("error");
  setResult(failed.page, {
    mediaItems: [{ url: "/assets/one.jpg" }]
  });
  await failed.page.saveMedia();
  assert.strictEqual(failed.page.data.saveFeedback, "保存失败");
  assert.strictEqual(failed.page.data.saveFeedbackTone, "error");
  failed.page.clearSaveFeedbackTimer();

  const empty = loadPage("success");
  setResult(empty.page, {});
  await empty.page.saveMedia();
  assert.strictEqual(empty.page.data.saveFeedback, "无可保存媒体");
  assert.strictEqual(empty.page.data.saveFeedbackTone, "error");
  empty.page.clearSaveFeedbackTimer();

  const race = loadPage("success", { deferSave: true });
  setResult(race.page, {
    mediaItems: [{ url: "/assets/race.jpg" }]
  });
  const racePromise = race.page.saveMedia();
  assert.strictEqual(race.page.data.saving, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  race.page.resetResult();
  assert.strictEqual(race.page.data.saving, false);
  assert.strictEqual(race.pendingSaves.length, 1);
  race.pendingSaves.shift().success();
  await racePromise;
  assert.strictEqual(race.page.data.result, null);
  assert.strictEqual(race.page.data.saveFeedback, "");
  assert.strictEqual(race.page.data.saveFeedbackTone, "");

  const copy = loadPage("success");
  setResult(copy.page, {
    copywritingTitle: "测试标题",
    copywritingBody: "测试正文"
  });
  copy.page.copyCopywritingTitle();
  assert.strictEqual(copy.page.data.copiedTarget, "title");
  copy.setClipboardMode("error");
  copy.page.copyCopywritingBody();
  assert.strictEqual(copy.page.data.copiedTarget, "");
  copy.page.clearCopyFeedbackTimer();

  console.log("watermark save feedback smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
