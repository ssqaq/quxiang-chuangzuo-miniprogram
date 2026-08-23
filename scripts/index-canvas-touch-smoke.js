const assert = require("assert");

let pageDefinition = null;
global.getApp = () => ({ globalData: {} });
global.Page = (definition) => {
  pageDefinition = definition;
};
global.wx = {};

require("../pages/index/index");
assert.ok(pageDefinition, "制作页没有成功注册");

const page = Object.assign({}, pageDefinition, {
  data: JSON.parse(JSON.stringify(pageDefinition.data))
});
page.data.project.mainImage = {
  path: "mock-main-image.jpg",
  width: 400,
  height: 300
};
page.data.canvasWidth = 400;
page.data.canvasHeight = 300;
page.data.imageWidth = 400;
page.data.imageHeight = 300;
page._pageDestroyed = false;
page._pageScrollTop = 200;
page._canvasViewportRect = {
  left: 30,
  top: 100,
  width: 400,
  height: 300
};
page._canvasDocumentRect = {
  left: 30,
  top: 300,
  width: 400,
  height: 300
};
page._canvasView = {
  scale: 1,
  offsetX: 0,
  offsetY: 0
};
page._gestureMode = null;
page._pinchState = null;
page._pinchAwaitingRelease = false;
page._gestureCoordinateContext = null;
page._drawingStart = null;
page._drawingCurrent = null;
page._drawingTouchId = null;
page.setData = function setData(patch, callback) {
  Object.assign(this.data, patch);
  if (typeof callback === "function") callback();
};
page.clearCanvasDrawTimer = function clearCanvasDrawTimer() {
  this._pendingCanvasCircle = null;
};
page.scheduleCanvasDraw = function scheduleCanvasDraw(circle) {
  this._pendingCanvasCircle = circle;
};
page.drawCanvas = function drawCanvas(circle) {
  this._lastDrawnCircle = circle;
};
page.updateProject = function updateProject(patch) {
  this.data.project = Object.assign({}, this.data.project, patch);
  return this.data.project;
};

function touch(identifier, localX, localY) {
  return {
    identifier,
    pageX: page._canvasDocumentRect.left + localX,
    pageY: page._canvasDocumentRect.top + localY,
    clientX: page._canvasViewportRect.left + localX,
    clientY: page._canvasViewportRect.top + localY
  };
}

const pinchStart = {
  touches: [
    touch(1, 100, 150),
    touch(2, 300, 150)
  ],
  changedTouches: []
};
page.onCanvasTouchStart(pinchStart);
assert.strictEqual(page._gestureMode, "pinch");
assert.strictEqual(page._pinchState.mode, "pending");
assert.strictEqual(page._gestureCoordinateContext.mode, "page");

page.onCanvasTouchMove({
  touches: [
    touch(1, 80, 150),
    touch(2, 360, 150)
  ],
  changedTouches: []
});
assert.strictEqual(page._pinchState.mode, "scale");
assert.strictEqual(page.data.canvasScale, 1.4);
assert.strictEqual(page.data.canvasOffsetX, 0);
assert.strictEqual(page.data.canvasOffsetY, 0);

page.onCanvasTouchEnd({
  touches: [touch(2, 360, 150)],
  changedTouches: [touch(1, 80, 150)]
});
assert.strictEqual(page._gestureMode, "pinch");
assert.strictEqual(page._pinchAwaitingRelease, true);
assert.strictEqual(page.data.drawing, false);
assert.strictEqual(page.data.project.maskCircle, null);

page.onCanvasTouchStart({
  touches: [touch(2, 360, 150)],
  changedTouches: []
});
assert.strictEqual(
  page._gestureMode,
  "pinch",
  "双指手势抬起一根手指后不得转成单指画圈"
);
assert.strictEqual(page.data.drawing, false);

page.onCanvasTouchEnd({
  touches: [],
  changedTouches: [touch(2, 360, 150)]
});
assert.strictEqual(page._gestureMode, null);
assert.strictEqual(page._pinchAwaitingRelease, false);

page.onCanvasTouchStart({
  touches: [touch(3, 100, 100)],
  changedTouches: []
});
assert.strictEqual(page._gestureMode, "draw");
assert.strictEqual(page.data.drawing, true);

page.onCanvasTouchMove({
  touches: [touch(3, 200, 180)],
  changedTouches: []
});
assert.ok(page._pendingCanvasCircle, "单指移动没有生成红圈预览");

page.onCanvasTouchEnd({
  touches: [],
  changedTouches: [touch(3, 200, 180)]
});
assert.strictEqual(page._gestureMode, null);
assert.strictEqual(page.data.drawing, false);
assert.strictEqual(page.data.step, 1);
assert.ok(page.data.project.maskCircle, "单指手势结束后没有保存红圈");

console.log("index canvas touch smoke: OK");
console.log(JSON.stringify({
  pinchScale: 1.4,
  pinchOffset: [0, 0],
  drawCircle: page.data.project.maskCircle
}));
