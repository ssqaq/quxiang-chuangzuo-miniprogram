const {
  finite,
  getImageDimensions,
  fitImageIntoViewport
} = require("../../utils/image-preview");

const DEFAULT_WIDTH = 999;
const DEFAULT_HEIGHT = 1278;
const PANEL_MAX_WIDTH_RPX = 680;
const OUTER_MARGIN_PX = 16;
const PANEL_PADDING_RPX = 48;
const IMAGE_CHROME_RPX = 44 + 18 + 34 + 20 + 72 + 48;

function getSystemInfo() {
  if (typeof wx.getSystemInfoSync === "function") {
    return wx.getSystemInfoSync() || {};
  }
  return {
    windowWidth: 375,
    windowHeight: 667
  };
}

Component({
  properties: {
    src: {
      type: String,
      value: "",
      observer() {
        this.prepareImage();
      }
    },
    visible: {
      type: Boolean,
      value: false,
      observer() {
        this.prepareImage();
      }
    },
    title: {
      type: String,
      value: "图片预览"
    },
    hintText: {
      type: String,
      value: "长按图片可保存或识别"
    }
  },

  data: {
    panelWidth: 1,
    renderedWidth: 1,
    renderedHeight: 1,
    loadError: false
  },

  lifetimes: {
    attached() {
      this._prepareToken = 0;
      this.prepareImage();
    },

    detached() {
      this._prepareToken += 1;
    }
  },

  methods: {
    prepareImage() {
      const token = ++this._prepareToken;
      const src = String(this.properties.src || "").trim();
      if (!this.properties.visible || !src) {
        this.setData({
          panelWidth: 1,
          renderedWidth: 1,
          renderedHeight: 1,
          loadError: false
        });
        return;
      }

      // 先用兜底尺寸同步撑开弹窗，避免模拟器或本地资源的
      // getImageInfo 回调较慢时，弹窗保持 1px 而只剩下遮罩层。
      this.layoutImage(DEFAULT_WIDTH, DEFAULT_HEIGHT);

      const ready = (width, height) => {
        if (token !== this._prepareToken) return;
        this.layoutImage(width, height);
      };

      if (typeof wx.getImageInfo !== "function") {
        ready(DEFAULT_WIDTH, DEFAULT_HEIGHT);
        return;
      }

      wx.getImageInfo({
        src,
        success: (result = {}) => {
          const size = getImageDimensions(
            result,
            DEFAULT_WIDTH,
            DEFAULT_HEIGHT
          );
          ready(size.width, size.height);
        },
        fail: () => ready(DEFAULT_WIDTH, DEFAULT_HEIGHT)
      });
    },

    layoutImage(naturalWidth, naturalHeight) {
      const info = getSystemInfo();
      const windowWidth = Math.max(
        320,
        finite(info.windowWidth, 375)
      );
      const windowHeight = Math.max(
        480,
        finite(info.windowHeight, 667)
      );
      const rpx = windowWidth / 750;
      const panelWidth = Math.max(
        240,
        Math.min(
          windowWidth - OUTER_MARGIN_PX * 2,
          PANEL_MAX_WIDTH_RPX * rpx
        )
      );
      const panelPadding = PANEL_PADDING_RPX * rpx;
      const maxWidth = Math.max(1, panelWidth - panelPadding * 2);
      const maxHeight = Math.max(
        160,
        windowHeight - IMAGE_CHROME_RPX * rpx
      );
      const rendered = fitImageIntoViewport(
        naturalWidth,
        naturalHeight,
        maxWidth,
        maxHeight
      );

      this.setData({
        panelWidth: Math.round(panelWidth),
        renderedWidth: rendered.width,
        renderedHeight: rendered.height,
        loadError: false
      });
    },

    close() {
      this.triggerEvent("close");
    },

    noop() {},

    onImageError(event) {
      this.setData({ loadError: true });
      this.triggerEvent("error", {
        src: this.properties.src,
        error: event && event.detail ? event.detail : null
      });
    }
  }
});
