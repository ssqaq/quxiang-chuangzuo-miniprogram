const assert = require("assert");
const {
  MAX_SCALE,
  MIN_SCALE,
  PINCH_PAN_THRESHOLD,
  PINCH_SCALE_THRESHOLD,
  TOUCH_COORDINATE_CLIENT,
  TOUCH_COORDINATE_PAGE,
  clampOffset,
  createPinchState,
  createTouchCoordinateContext,
  distance,
  mapViewportPointToCanvas,
  midpoint,
  resolveTouchPoint,
  resolveTouchPoints,
  updatePinchView
} = require("../utils/canvas-gesture");

const width = 400;
const height = 300;
const first = { x: 100, y: 150 };
const second = { x: 300, y: 150 };
const initialView = { scale: MIN_SCALE, offsetX: 0, offsetY: 0 };

assert.strictEqual(PINCH_SCALE_THRESHOLD, 0.04);
assert.strictEqual(PINCH_PAN_THRESHOLD, 10);
assert.strictEqual(distance(first, second), 200);
assert.deepStrictEqual(midpoint(first, second), { x: 200, y: 150 });

const pendingState = createPinchState(first, second, initialView, width, height);
const pendingView = updatePinchView(
  pendingState,
  { x: 98, y: 150 },
  { x: 302, y: 150 },
  width,
  height
);
assert.strictEqual(pendingState.mode, "pending");
assert.strictEqual(pendingView.changed, false);
assert.deepStrictEqual(
  {
    scale: pendingView.scale,
    offsetX: pendingView.offsetX,
    offsetY: pendingView.offsetY
  },
  initialView
);

const scaleState = createPinchState(first, second, initialView, width, height);
const scaledView = updatePinchView(
  scaleState,
  { x: 80, y: 150 },
  { x: 360, y: 150 },
  width,
  height
);
assert.strictEqual(scaleState.mode, "scale");
assert.strictEqual(scaledView.changed, true);
assert.strictEqual(scaledView.scale, 1.4);
assert.strictEqual(scaledView.offsetX, 0);
assert.strictEqual(scaledView.offsetY, 0);

const offCenterState = createPinchState(
  { x: 50, y: 150 },
  { x: 150, y: 150 },
  initialView,
  width,
  height
);
const offCenterScaled = updatePinchView(
  offCenterState,
  { x: 20, y: 150 },
  { x: 220, y: 150 },
  width,
  height
);
assert.strictEqual(offCenterScaled.scale, 2);
assert.strictEqual(offCenterScaled.offsetX, 100);
assert.strictEqual(offCenterScaled.offsetY, 0);
assert.deepStrictEqual(
  mapViewportPointToCanvas(
    offCenterState.startMidpoint,
    offCenterScaled,
    width,
    height
  ),
  offCenterState.focus
);

const panStartView = { scale: 2, offsetX: 20, offsetY: -10 };
const panState = createPinchState(first, second, panStartView, width, height);
const pannedView = updatePinchView(
  panState,
  { x: 115, y: 162 },
  { x: 315, y: 162 },
  width,
  height
);
assert.strictEqual(panState.mode, "pan");
assert.strictEqual(pannedView.scale, 2);
assert.strictEqual(pannedView.offsetX, 35);
assert.strictEqual(pannedView.offsetY, 2);

const panLocked = updatePinchView(
  panState,
  { x: 50, y: 150 },
  { x: 350, y: 150 },
  width,
  height
);
assert.strictEqual(panState.mode, "pan");
assert.strictEqual(panLocked.scale, 2);
assert.strictEqual(panLocked.offsetX, 20);
assert.strictEqual(panLocked.offsetY, -10);

const simultaneousState = createPinchState(first, second, initialView, width, height);
const simultaneousView = updatePinchView(
  simultaneousState,
  { x: 96, y: 150 },
  { x: 324, y: 150 },
  width,
  height
);
assert.strictEqual(simultaneousState.mode, "scale");
assert.strictEqual(simultaneousView.scale, 1.14);

const scaleLocked = updatePinchView(
  simultaneousState,
  { x: 120, y: 170 },
  { x: 320, y: 170 },
  width,
  height
);
assert.strictEqual(simultaneousState.mode, "scale");
assert.strictEqual(scaleLocked.scale, 1);
assert.strictEqual(scaleLocked.offsetX, 0);
assert.strictEqual(scaleLocked.offsetY, 0);

const zeroDistanceState = createPinchState(
  { x: 100, y: 100 },
  { x: 100, y: 100 },
  initialView,
  width,
  height
);
const zeroDistanceView = updatePinchView(
  zeroDistanceState,
  { x: 120, y: 120 },
  { x: 120, y: 120 },
  width,
  height
);
assert.strictEqual(zeroDistanceState.mode, "pending");
assert.strictEqual(zeroDistanceView.changed, false);

const limited = clampOffset(MAX_SCALE, width, height, 9999, -9999);
assert.strictEqual(limited.x, width * (MAX_SCALE - 1) / 2);
assert.strictEqual(limited.y, -height * (MAX_SCALE - 1) / 2);

const mapped = mapViewportPointToCanvas(
  { x: 300, y: 175 },
  { scale: 2, offsetX: 50, offsetY: -25 },
  width,
  height
);
assert.deepStrictEqual(mapped, { x: 225, y: 175 });

const coordinateLayout = {
  documentLeft: 30,
  documentTop: 300,
  viewportLeft: 30,
  viewportTop: 100
};
const pageTouches = [
  { pageX: 180, pageY: 450, clientX: 180, clientY: 250 },
  { pageX: 280, pageY: 500, clientX: 280, clientY: 300 }
];
const pageContext = createTouchCoordinateContext(pageTouches, coordinateLayout);
assert.strictEqual(pageContext.mode, TOUCH_COORDINATE_PAGE);
assert.deepStrictEqual(
  resolveTouchPoint(pageTouches[0], pageContext, width, height),
  { x: 150, y: 150 }
);
assert.deepStrictEqual(
  resolveTouchPoints(pageTouches, pageContext, width, height),
  [{ x: 150, y: 150 }, { x: 250, y: 200 }]
);
assert.strictEqual(
  resolveTouchPoint(
    { clientX: 180, clientY: 250 },
    pageContext,
    width,
    height
  ),
  null,
  "page 模式选定后不得逐帧切换到 client"
);

const clientTouches = [
  { clientX: 180, clientY: 250 },
  { clientX: 280, clientY: 300 }
];
const clientContext = createTouchCoordinateContext(clientTouches, coordinateLayout);
assert.strictEqual(clientContext.mode, TOUCH_COORDINATE_CLIENT);
assert.deepStrictEqual(
  resolveTouchPoint(clientTouches[0], clientContext, width, height),
  { x: 150, y: 150 }
);
assert.strictEqual(
  resolveTouchPoint(
    { pageX: 180, pageY: 450 },
    clientContext,
    width,
    height
  ),
  null,
  "client 模式选定后不得逐帧切换到 page"
);

const falseZeroContext = createTouchCoordinateContext(
  [{
    pageX: 0,
    pageY: 0,
    clientX: 180,
    clientY: 250
  }],
  coordinateLayout
);
assert.strictEqual(falseZeroContext.mode, TOUCH_COORDINATE_CLIENT);
assert.strictEqual(
  createTouchCoordinateContext(
    [{ offsetX: 150, offsetY: 150, x: 150, y: 150 }],
    coordinateLayout
  ),
  null,
  "活动手势不得回退到 offset/x 坐标"
);

console.log("canvas gesture smoke: OK");
console.log(JSON.stringify({
  thresholds: {
    scale: PINCH_SCALE_THRESHOLD,
    pan: PINCH_PAN_THRESHOLD
  },
  modes: {
    pending: pendingState.mode,
    scale: scaleState.mode,
    pan: panState.mode
  },
  fixedFocusOffset: offCenterScaled.offsetX,
  coordinateModes: [pageContext.mode, clientContext.mode]
}));
