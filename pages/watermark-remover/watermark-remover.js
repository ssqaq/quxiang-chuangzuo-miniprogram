const DEMO_MEDIA_PATH = "/assets/media/media-parser-demo.mp4";
const DEMO_IMAGE_PATH = "/assets/media/media-parser-demo.jpg";
const MAX_INPUT_LENGTH = 4096;

function createRequestId() {
  return `media-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function normalizeContentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["video", "image", "live_photo"].includes(normalized) ? normalized : "";
}

function normalizeCopywritingText(value) {
  if (Array.isArray(value)) {
    return value
      .map(normalizeCopywritingText)
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(0, 2000);
  }
  if (value && typeof value === "object") {
    return normalizeCopywritingText(
      value.text
      || value.content
      || value.value
      || value.title
      || value.description
    );
  }
  return String(value || "").trim().slice(0, 2000);
}

function normalizeCopywritingTags(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,，、#]+/u);
  return Array.from(new Set(
    values
      .map((item) => String(item || "").trim().replace(/^#+/u, ""))
      .filter(Boolean)
  )).slice(0, 8);
}

function getCopywritingFields(response = {}) {
  const candidates = [
    ["copywriting", response.copywriting],
    ["description", response.description],
    ["desc", response.desc],
    ["caption", response.caption],
    ["content", response.content],
    ["text", response.text],
    ["title", response.title]
  ];
  let copywriting = "";
  let source = "";
  for (const [candidateSource, candidateValue] of candidates) {
    const text = normalizeCopywritingText(candidateValue);
    if (text) {
      copywriting = text;
      source = candidateSource;
      break;
    }
  }
  return {
    copywriting,
    copywritingTags: normalizeCopywritingTags(
      response.copywritingTags || response.hashtags || response.tags
    ),
    copywritingLength: Array.from(copywriting).length,
    copywritingSource: source
  };
}

function buildLocalDemoResult(contentType, requestId) {
  const normalizedType = normalizeContentType(contentType) || "video";
  const isImage = normalizedType === "image";
  const copywriting = getCopywritingFields({
    copywriting: isImage
      ? "这是一条用于联调的图片文案，真实 Provider 接入后会直接展示服务商返回的作品文案。"
      : "这是一条用于联调的视频文案，解析媒体的同时自动整理标题、描述和标签。",
    tags: ["媒体解析", "文案提取"]
  });
  return {
    ok: true,
    provider: "mock-local",
    platform: "demo",
    contentType: normalizedType,
    title: isImage ? "演示图片" : "演示视频",
    ...copywriting,
    copywritingSource: "mock",
    mediaUrl: isImage ? DEMO_IMAGE_PATH : DEMO_MEDIA_PATH,
    mimeType: isImage ? "image/jpeg" : "video/mp4",
    size: 0,
    expiresAt: 0,
    demo: true,
    requestId
  };
}

function platformLabel(value) {
  const platform = String(value || "").trim().toLowerCase();
  const labels = {
    demo: "Mock 演示",
    douyin: "抖音",
    kuaishou: "快手",
    xiaohongshu: "小红书",
    weishi: "微视",
    bilibili: "哔哩哔哩",
    kesong: "可颂",
    croissant: "可颂"
  };
  return labels[platform] || (platform && platform !== "unknown" ? platform : "多平台媒体");
}

function safeMessage(value, fallback) {
  return String(value || fallback || "").trim().slice(0, 180);
}

function errorView(errorCode, message) {
  const code = String(errorCode || "PROVIDER_FAILED").trim();
  const titles = {
    INVALID_INPUT: "还没有可解析的内容",
    INVALID_URL: "分享链接无效",
    UNSUPPORTED_PLATFORM: "暂不支持这个平台",
    PROVIDER_NOT_CONFIGURED: "真实解析服务未配置",
    PROVIDER_TIMEOUT: "解析服务响应超时",
    PROVIDER_FAILED: "解析没有完成",
    CONTENT_TYPE_NOT_SUPPORTED: "暂不支持该内容类型",
    RATE_LIMITED: "请求太频繁",
    QUOTA_EXCEEDED: "解析次数不足"
  };
  const fallbacks = {
    INVALID_INPUT: "请粘贴分享链接或分享文本后重试。",
    INVALID_URL: "没有识别到有效的 HTTP 或 HTTPS 分享链接。",
    UNSUPPORTED_PLATFORM: "当前服务商暂时无法识别这个平台。",
    PROVIDER_NOT_CONFIGURED: "请先在 watermark-gateway 云函数中配置真实 Provider。",
    PROVIDER_TIMEOUT: "第三方服务响应太慢，请稍后重试。",
    PROVIDER_FAILED: "第三方服务没有返回可用的视频或图片。",
  CONTENT_TYPE_NOT_SUPPORTED: "当前返回的内容类型暂不支持。",
    RATE_LIMITED: "请稍等一会儿再试。",
    QUOTA_EXCEEDED: "第三方解析服务的余额或调用次数不足。"
  };
  return {
    code,
    title: titles[code] || "解析失败",
    message: safeMessage(message, fallbacks[code] || "请稍后重试。")
  };
}

function invokeGateway(data) {
  if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
    return Promise.reject(new Error("当前环境无法调用媒体解析云函数"));
  }
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: "watermark-gateway",
      data,
      success(response) {
        resolve(response && response.result ? response.result : response);
      },
      fail: reject
    });
  });
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success(response) {
        if (!response || !response.tempFilePath || Number(response.statusCode) >= 400) {
          reject(new Error("媒体下载失败"));
          return;
        }
        resolve(response.tempFilePath);
      },
      fail: reject
    });
  });
}

function saveVideoToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof wx.saveVideoToPhotosAlbum !== "function") {
      reject(new Error("当前环境不支持保存视频到相册"));
      return;
    }
    wx.saveVideoToPhotosAlbum({
      filePath,
      success: resolve,
      fail: reject
    });
  });
}

function saveImageToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof wx.saveImageToPhotosAlbum !== "function") {
      reject(new Error("当前环境不支持保存图片到相册"));
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath,
      success: resolve,
      fail: reject
    });
  });
}

function resolveImagePath(filePath) {
  if (isHttpUrl(filePath)) return downloadUrl(filePath);
  if (typeof wx.getImageInfo !== "function") return Promise.resolve(filePath);
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: filePath,
      success(response) {
        resolve(response && response.path ? response.path : filePath);
      },
      fail: reject
    });
  });
}

function saveMediaItem(item, contentType) {
  const rawUrl = contentType === "image"
    ? (item && (item.url || item.imageUrl))
    : (item && (item.url || item.videoUrl));
  const url = String(rawUrl || "").trim();
  if (!url) return Promise.reject(new Error("媒体地址为空"));

  if (contentType === "image") {
    return resolveImagePath(url).then(saveImageToAlbum);
  }
  const localPath = isHttpUrl(url) ? downloadUrl(url) : Promise.resolve(url);
  return localPath.then(saveVideoToAlbum);
}

async function saveMediaBatch(items, contentType) {
  let saved = 0;
  let failed = 0;
  let firstError = null;
  for (const item of items) {
    try {
      await saveMediaItem(item, contentType);
      saved += 1;
    } catch (error) {
      if (!firstError) firstError = error;
      failed += 1;
      const raw = String(error && (error.errMsg || error.message) || "");
      if (/auth deny|authorize|permission|domain|downloadfile:fail|url not in domain list/i.test(raw)) {
        break;
      }
    }
  }
  return { saved, failed, firstError };
}

Page({
  data: {
    inputText: "",
    parsing: false,
    parseStage: 0,
    saving: false,
    status: "idle",
    errorTitle: "",
    errorMessage: "",
    result: null,
    providerReady: false,
    providerTitle: "正在检查解析服务",
    providerMessage: "正在连接独立媒体解析网关..."
  },

  onLoad() {
    return this.checkProviderHealth();
  },

  async checkProviderHealth() {
    try {
      const health = await invokeGateway({
        action: "health",
        requestId: createRequestId()
      });
      const isMock = health && health.mode === "mock";
      const configured = Boolean(health && health.ok !== false && health.configured);
      this.setData({
        providerReady: configured,
        providerTitle: isMock
          ? "测试模式已开启"
          : (configured ? "真实解析服务已就绪" : "真实解析服务未配置"),
        providerMessage: isMock
        ? "云函数当前显式启用了 Mock，只用于联调，不代表真实平台解析。"
          : (configured
            ? "可解析视频、图片、多图和实况素材。"
            : "请先在 watermark-gateway 云函数中配置 Provider 环境变量。")
      });
      return health;
    } catch (_error) {
      this.setData({
        providerReady: false,
        providerTitle: "媒体解析网关不可用",
        providerMessage: "请确认 watermark-gateway 云函数已经部署。"
      });
      return null;
    }
  },

  onInput(event) {
    this.setData({
      inputText: String(event && event.detail && event.detail.value || "").slice(0, MAX_INPUT_LENGTH)
    });
  },

  pasteFromClipboard() {
    if (typeof wx.getClipboardData !== "function") {
      wx.showToast({ title: "当前环境不支持一键粘贴", icon: "none" });
      return;
    }
    wx.getClipboardData({
      success: (response) => {
        const text = String(response && response.data || "").trim().slice(0, MAX_INPUT_LENGTH);
        if (!text) {
          wx.showToast({ title: "剪贴板里没有可用文本", icon: "none" });
          return;
        }
        this.setData({ inputText: text });
        wx.showToast({ title: "已粘贴", icon: "success" });
      },
      fail: () => wx.showToast({ title: "读取剪贴板失败", icon: "none" })
    });
  },

  async parseMedia() {
    if (this.data.parsing) return;
    const text = String(this.data.inputText || "").trim();
    if (!text) {
      wx.showToast({ title: "先粘贴分享链接或文本", icon: "none" });
      return;
    }

    this.setData({
      parsing: true,
      parseStage: 0,
      status: "parsing",
      errorTitle: "",
      errorMessage: "",
      result: null
    });

    try {
      const response = await invokeGateway({
        action: "parse",
        text: text.slice(0, MAX_INPUT_LENGTH),
        requestId: createRequestId()
      });
      if (!response || response.ok === false) {
        const view = errorView(
          response && (response.errorCode || response.code),
          response && response.message
        );
        this.showError(view.title, view.message, view.code);
        return;
      }

      this.setData({ parseStage: 1 });

      const contentType = normalizeContentType(response.contentType);
      if (!contentType) {
        const view = errorView(
          "CONTENT_TYPE_NOT_SUPPORTED",
          "当前返回的内容类型暂不支持。"
        );
        this.showError(view.title, view.message, view.code);
        return;
      }

      const isImage = contentType === "image";
      const isLivePhoto = contentType === "live_photo";
      const providerMediaUrl = String(
        response.mediaUrl
        || (response.primaryMedia && response.primaryMedia.url)
        || ""
      ).trim();
      const demoResult = response.demo
        ? buildLocalDemoResult(contentType, response.requestId)
        : null;
      const mediaUrl = providerMediaUrl || (demoResult && demoResult.mediaUrl) || "";
      if (!mediaUrl) {
        const view = errorView("PROVIDER_FAILED", "解析结果中没有可用的媒体地址。");
        this.showError(view.title, view.message, view.code);
        return;
      }

      const mediaItems = Array.isArray(response.mediaItems)
        ? response.mediaItems.filter(Boolean)
        : (isImage && mediaUrl ? [{ type: "image", url: mediaUrl }] : []);
      const livePhotoItems = Array.isArray(response.livePhotoItems)
        ? response.livePhotoItems.filter(Boolean)
        : (isLivePhoto ? mediaItems : []);
      const mediaCount = Number(response.mediaCount)
        || (isLivePhoto ? livePhotoItems.length : mediaItems.length || 1);
      const copywriting = demoResult
        ? getCopywritingFields(demoResult)
        : getCopywritingFields(response);
      this.setData({ parseStage: 2 });
      const result = Object.assign({}, response, {
        contentType,
        title: safeMessage(
          response.title,
          isLivePhoto ? "解析实况图片" : (isImage ? "解析图片" : "解析视频")
        ),
        typeLabel: isLivePhoto
          ? `实况图片（${mediaCount}组）`
          : (isImage && mediaCount > 1 ? `图片（${mediaCount}张）` : (isImage ? "图片" : "视频")),
        platformLabel: platformLabel(response.platform),
        mediaUrl,
        mediaItems,
        livePhotoItems,
        mediaCount,
        ...copywriting,
        demo: Boolean(response.demo),
        isReal: !response.demo
      });
      this.setData({
        parsing: false,
        parseStage: 3,
        status: "success",
        result,
        providerReady: true,
        providerTitle: result.demo ? "测试模式已返回结果" : "真实解析成功",
        providerMessage: result.demo
          ? "当前结果来自显式 Mock，仅用于联调。"
          : "第三方服务已返回媒体地址，可直接预览并尝试保存。"
      });
    } catch (error) {
      const view = errorView(
        "PROVIDER_FAILED",
        error && (error.message || error.errMsg)
      );
      this.showError(view.title, view.message, view.code);
    } finally {
      if (this.data.status === "parsing") {
        this.setData({ parsing: false });
      }
    }
  },

  showError(title, message, errorCode = "PROVIDER_FAILED") {
    const configurationError = errorCode === "PROVIDER_NOT_CONFIGURED";
    this.setData({
      parsing: false,
      parseStage: 0,
      status: "error",
      errorTitle: title,
      errorMessage: message,
      result: null,
      providerReady: configurationError ? false : this.data.providerReady,
      providerTitle: configurationError ? "真实解析服务未配置" : this.data.providerTitle,
      providerMessage: configurationError
        ? "请先在 watermark-gateway 云函数中配置 Provider 环境变量。"
        : this.data.providerMessage
    });
  },

  async saveMedia() {
    if (this.data.saving || !this.data.result) return;
    const result = this.data.result;
    const contentType = result.contentType;
    const mediaUrl = String(result.mediaUrl || "").trim();
    if (!mediaUrl && !result.mediaItems.length && !result.livePhotoItems.length) {
      wx.showToast({ title: "当前没有可保存的媒体", icon: "none" });
      return;
    }

    this.setData({ saving: true });
    try {
      let saved = 0;
      let failed = 0;
      let firstError = null;
      if (contentType === "live_photo") {
        const liveItems = result.livePhotoItems.length
          ? result.livePhotoItems
          : result.mediaItems;
        const imageBatch = await saveMediaBatch(liveItems, "image");
        saved += imageBatch.saved;
        failed += imageBatch.failed;
        firstError = firstError || imageBatch.firstError;
        const videoBatch = await saveMediaBatch(liveItems, "video");
        saved += videoBatch.saved;
        failed += videoBatch.failed;
        firstError = firstError || videoBatch.firstError;
      } else {
        const items = result.mediaItems.length
          ? result.mediaItems
          : [{ url: mediaUrl }];
        const batch = await saveMediaBatch(items, contentType);
        saved = batch.saved;
        failed = batch.failed;
        firstError = batch.firstError;
      }
      if (firstError && saved === 0) {
        throw firstError;
      }
      if (failed > 0) {
        wx.showModal({
          title: "部分保存成功",
          content: `已保存 ${saved} 个文件，还有 ${failed} 个文件保存失败。`,
          showCancel: false
        });
      } else {
        wx.showToast({
          title: contentType === "live_photo" ? "图片和动态视频已保存" : "已保存到相册",
          icon: "success"
        });
      }
    } catch (error) {
      const raw = String(error && (error.errMsg || error.message) || "");
      const typeLabel = contentType === "live_photo"
        ? "图片和动态视频"
        : (contentType === "image" ? "图片" : "视频");
      if (/auth deny|authorize|permission/i.test(raw)) {
        wx.showModal({
          title: "没有相册权限",
          content: `请在微信设置中允许保存${typeLabel}到相册，然后再试。`,
          showCancel: false
        });
      } else if (/domain|downloadfile:fail|url not in domain list/i.test(raw)) {
        wx.showModal({
          title: "下载域名受限",
          content: "第三方媒体域名未通过微信下载校验。需要把媒体转存到 CloudBase 后再保存。",
          showCancel: false
        });
      } else if (this.data.result.demo) {
        wx.showModal({
          title: "Mock 保存链路已接入",
          content: `当前是本地演示${typeLabel}，部分开发者工具或手机环境不允许把包内资源直接保存到相册。`,
          showCancel: false
        });
      } else {
        wx.showToast({ title: safeMessage(raw, "保存失败，请稍后重试"), icon: "none" });
      }
    } finally {
      this.setData({ saving: false });
    }
  },

  copyCopywriting() {
    const text = String(this.data.result && this.data.result.copywriting || "").trim();
    if (!text) {
      wx.showToast({ title: "当前没有可复制的文案", icon: "none" });
      return;
    }
    if (typeof wx.setClipboardData !== "function") {
      wx.showToast({ title: "当前环境不支持复制", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: "文案已复制", icon: "success" }),
      fail: () => wx.showToast({ title: "复制失败，请重试", icon: "none" })
    });
  },

  saveVideo() {
    return this.saveMedia();
  },

  resetResult() {
    this.setData({
      status: "idle",
      parseStage: 0,
      result: null,
      errorTitle: "",
      errorMessage: ""
    });
  },

  backToWorkbench() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
    });
  }
});

module.exports = {
  buildLocalDemoResult,
  normalizeContentType,
  normalizeCopywritingText,
  normalizeCopywritingTags,
  getCopywritingFields,
  errorView,
  platformLabel
};
