const {
  MIN_SCALE,
  clampOffset,
  createPinchState,
  createTouchCoordinateContext,
  resolveTouchPoint,
  resolveTouchPoints,
  updatePinchView
} = require("../../utils/canvas-gesture");
const {
  findTouchByIdentifier,
  getTouchIdentifier
} = require("../../utils/circle-gesture");

const DEFAULT_WIDTH = 1615;
const DEFAULT_HEIGHT = 2048;
const DEFAULT_HINT = "单指拖动图片查看，双指可放大";
const MAX_VIEWPORT_HEIGHT = 620;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getImagePath(image) {
  const source = image && typeof image === "object" ? image : {};
  return String(
    source.path
      || source.tempFilePath
      || source.displayURL
      || source.sourcePath
      || source.tempFileURL
      || ""
  );
}

function getImageDimension(image, key, fallback) {
  const value = finite(image && image[key], 0);
  return value > 0 ? value : fallback;
}

Component({
  properties: {
    image: {
      type: Object,
      value: null,
      observer() {
        this.prepareImage();
      }
    },
    hintText: {
      type: String,
      value: DEFAULT_HINT
    },
    previewEnabled: {
      type: Boolean,
      value: true
    }
  },

  data: {
    visible: false,
    imagePath: "",
    imageWidth: DEFAULT_WIDTH,
    imageHeight: DEFAULT_HEIGHT,
    viewportWidth: 1,
    viewportHeight: 1,
    scale: MIN_SCALE,
    offsetX: 0,
    offsetY: 0,
    loadError: false
  },

  lifetimes: {
    attached() {
      this._prepareToken = 0;
      this._pageScrollTop = 0;
      this._gestureMode = null;
      this._gestureCoordinateContext = null;
      this._pinchState = null;
      this._pinchAwaitingRelease = false;
      this._dragTouchId = null;
      this._dragStart = null;
      this._dragView = null;
      this._gestureMoved = false;
      this.prepareImage();
    },

    detached() {
      this._prepareToken += 1;
      this.resetGestureState();
    }
  },

  methods: {
    isActive(token) {
      return token === this._prepareToken;
    },

    getEventTouches(event, includeChanged = false) {
      if (!event) return [];
      const primary = includeChanged ? event.changedTouches : event.touches;
      const fallback = includeChanged ? event.touches : event.changedTouches;
      if (Array.isArray(primary) && primary.length) return primary;
      return Array.isArray(fallback) ? fallback : [];
    },

    prepareImage() {
      const image = this.properties.image;
      const imagePath = getImagePath(image);
      const token = ++this._prepareToken;
      if (!imagePath) {
        this.resetGestureState();
        this.setData({
          visible: false,
          imagePath: "",
          loadError: false
        });
        return;
      }

      const knownWidth = getImageDimension(image, "width", 0);
      const knownHeight = getImageDimension(image, "height", 0);
      const ready = (width, height) => {
        if (!this.isActive(token)) return;
        this.setData({
          visible: true,
          imagePath,
          imageWidth: width,
          imageHeight: height,
          loadError: false
        }, () => {
          if (!this.isActive(token)) return;
          this.resetGestureState();
          this.resetView();
          this.measureViewport(token);
        });
      };

      if (knownWidth > 0 && knownHeight > 0) {
        ready(knownWidth, knownHeight);
        return;
      }

      if (typeof wx.getImageInfo !== "function") {
        ready(DEFAULT_WIDTH, DEFAULT_HEIGHT);
        return;
      }

      wx.getImageInfo({
        src: imagePath,
        success: (result = {}) => {
          ready(
            getImageDimension(result, "width", DEFAULT_WIDTH),
            getImageDimension(result, "height", DEFAULT_HEIGHT)
          );
        },
        fail: () => ready(DEFAULT_WIDTH, DEFAULT_HEIGHT)
      });
    },

    measureViewport(token = this._prepareToken) {
      if (!this.isActive(token)) return;
      const query = this.createSelectorQuery();
      query.select(".main-image-preview-card").boundingClientRect();
      if (typeof query.selectViewport === "function") {
        query.selectViewport().scrollOffset();
      }
      query.exec((results = []) => {
        if (!this.isActive(token)) return;
        const rect = results[0];
        const scroll = results[1];
        if (scroll && Number.isFinite(Number(scroll.scrollTop))) {
          this._pageScrollTop = Math.max(0, Number(scroll.scrollTop));
        }
        const systemInfo = typeof wx.getSystemInfoSync === "function"
          ? wx.getSystemInfoSync()
          : {};
        const fallbackWidth = Math.max(
          280,
          finite(systemInfo.windowWidth, 375) - 56
        );
        let width = finite(rect && rect.width, fallbackWidth);
        width = Math.max(1, Math.round(width));
        let height = width * this.data.imageHeight / this.data.imageWidth;
        if (height > MAX_VIEWPORT_HEIGHT) {
          height = MAX_VIEWPORT_HEIGHT;
          width = height * this.data.imageWidth / this.data.imageHeight;
        }
        this.setData({
          viewportWidth: Math.max(1, Math.round(width)),
          viewportHeight: Math.max(1, Math.round(height))
        });
        this._viewportRect = {
          left: finite(rect && rect.left),
          top: finite(rect && rect.top),
          width: Math.max(1, Math.round(width)),
          height: Math.max(1, Math.round(height))
        };
      });
    },

    resetView() {
      this.setData({
        scale: MIN_SCALE,
        offsetX: 0,
        offsetY: 0
      });
    },

    resetGestureState() {
      this._gestureMode = null;
      this._gestureCoordinateContext = null;
      this._pinchState = null;
      this._pinchAwaitingRelease = false;
      this._dragTouchId = null;
      this._dragStart = null;
      this._dragView = null;
    },

    getViewportLayout() {
      const query = this.createSelectorQuery();
      query.select(".main-image-preview-viewport").boundingClientRect();
      if (typeof query.selectViewport === "function") {
        query.selectViewport().scrollOffset();
      }
      query.exec((results = []) => {
        const rect = results[0];
        const scroll = results[1];
        if (!rect) return;
        if (scroll && Number.isFinite(Number(scroll.scrollTop))) {
          this._pageScrollTop = Math.max(0, Number(scroll.scrollTop));
        }
        this._viewportRect = {
          left: finite(rect.left),
          top: finite(rect.top),
          width: Math.max(1, finite(rect.width, this.data.viewportWidth)),
          height: Math.max(1, finite(rect.height, this.data.viewportHeight))
        };
      });
    },

    beginGestureCoordinateContext(touches) {
      const rect = this._viewportRect;
      if (!rect) {
        this.getViewportLayout();
        return null;
      }
      const context = createTouchCoordinateContext(touches, {
        documentLeft: rect.left,
        documentTop: rect.top + this._pageScrollTop,
        viewportLeft: rect.left,
        viewportTop: rect.top
      });
      this._gestureCoordinateContext = context;
      return context;
    },

    getViewportTouches(event) {
      return resolveTouchPoints(
        this.getEventTouches(event),
        this._gestureCoordinateContext,
        this.data.viewportWidth,
        this.data.viewportHeight
      );
    },

    getViewportPoint(touch) {
      return resolveTouchPoint(
        touch,
        this._gestureCoordinateContext,
        this.data.viewportWidth,
        this.data.viewportHeight
      );
    },

    beginPinch(event) {
      const rawTouches = this.getEventTouches(event).slice(0, 2);
      if (rawTouches.length < 2) return false;
      if (!this.beginGestureCoordinateContext(rawTouches)) return false;
      const touches = resolveTouchPoints(
        rawTouches,
        this._gestureCoordinateContext,
        this.data.viewportWidth,
        this.data.viewportHeight
      );
      if (touches.length < 2) {
        this._gestureCoordinateContext = null;
        return false;
      }
      this._pinchState = createPinchState(
        touches[0],
        touches[1],
        {
          scale: this.data.scale,
          offsetX: this.data.offsetX,
          offsetY: this.data.offsetY
        },
        this.data.viewportWidth,
        this.data.viewportHeight
      );
      this._gestureMode = this._pinchState ? "pinch" : null;
      this._pinchAwaitingRelease = false;
      this._dragStart = null;
      this._dragView = null;
      this._gestureMoved = true;
      return Boolean(this._pinchState);
    },

    beginDrag(event) {
      const touch = this.getEventTouches(event)[0];
      if (!touch) return false;
      if (!this.beginGestureCoordinateContext([touch])) return false;
      const point = this.getViewportPoint(touch);
      if (!point) return false;
      this._gestureMode = "drag";
      this._dragTouchId = getTouchIdentifier(touch);
      this._dragStart = point;
      this._dragView = {
        scale: this.data.scale,
        offsetX: this.data.offsetX,
        offsetY: this.data.offsetY
      };
      this._gestureMoved = false;
      return true;
    },

    onTouchStart(event) {
      const touches = this.getEventTouches(event);
      if (this._pinchAwaitingRelease) return;
      if (touches.length >= 2) {
        this.beginPinch(event);
        return;
      }
      this.beginDrag(event);
    },

    onTouchMove(event) {
      const touches = this.getEventTouches(event);
      if (touches.length >= 2) {
        if (this._gestureMode !== "pinch" && !this.beginPinch(event)) return;
        const points = this.getViewportTouches(event);
        if (points.length < 2) return;
        const nextView = updatePinchView(
          this._pinchState,
          points[0],
          points[1],
          this.data.viewportWidth,
          this.data.viewportHeight
        );
        if (nextView && nextView.changed) {
          this._gestureMoved = true;
          this.setData({
            scale: nextView.scale,
            offsetX: nextView.offsetX,
            offsetY: nextView.offsetY
          });
        }
        return;
      }

      if (this._gestureMode !== "drag" || !this._dragStart) return;
      const touch = findTouchByIdentifier(
        touches,
        this._dragTouchId
      );
      if (!touch) return;
      const point = this.getViewportPoint(touch);
      if (!point) return;
      const deltaX = point.x - this._dragStart.x;
      const deltaY = point.y - this._dragStart.y;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 6) {
        this._gestureMoved = true;
      }
      const offset = clampOffset(
        this._dragView.scale,
        this.data.viewportWidth,
        this.data.viewportHeight,
        this._dragView.offsetX + deltaX,
        this._dragView.offsetY + deltaY
      );
      this.setData({
        offsetX: offset.x,
        offsetY: offset.y
      });
    },

    onTouchEnd(event) {
      const gestureMoved = this._gestureMoved;
      if (this._gestureMode === "pinch") {
        if (this.getEventTouches(event).length > 0) {
          this._pinchState = null;
          this._pinchAwaitingRelease = true;
          this._gestureCoordinateContext = null;
          return;
        }
        this.resetGestureState();
        this._gestureMoved = gestureMoved;
        return;
      }
      if (this._pinchAwaitingRelease) {
        if (!this.getEventTouches(event).length) {
          this.resetGestureState();
          this._gestureMoved = gestureMoved;
        }
        return;
      }
      this.resetGestureState();
      this._gestureMoved = gestureMoved;
    },

    onTouchCancel() {
      const gestureMoved = this._gestureMoved;
      this.resetGestureState();
      this._gestureMoved = gestureMoved;
    },

    onPreviewTap() {
      if (
        !this.properties.previewEnabled
        || this._gestureMoved
        || !this.data.imagePath
        || this.data.loadError
      ) {
        return;
      }
      this.triggerEvent("preview", {
        path: this.data.imagePath,
        width: this.data.imageWidth,
        height: this.data.imageHeight
      });
    },

    onImageError() {
      this.setData({ loadError: true });
    }
  }
});
