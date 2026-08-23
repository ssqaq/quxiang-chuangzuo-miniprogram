const assert = require("assert");
const {
  MAX_SCALE,
  MIN_SCALE,
  clampOffset,
  createPinchState,
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

assert.strictEqual(distance(first, second), 200);
assert.deepStrictEqual(midpoint(first, second), { x: 200, y: 150 });

const initialView = { scale: MIN_SCALE, offsetX: 0, offsetY: 0 };
const pinch = createPinchState(first, second, initialView, width, height);
assert.ok(pinch);
assert.deepStrictEqual(pinch.focus, { x: 200, y: 150 });

const zoomed = updatePinchView(
  pinch,
  { x: 0, y: 150 },
  { x: 400, y: 150 },
  width,
  height
);
assert.ok(zoomed);
assert.strictEqual(zoomed.scale, 2);
assert.strictEqual(zoomed.offsetX, 0);
assert.strictEqual(zoomed.offsetY, 0);

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

const touchRect = { left: 30, top: 100 };
const touchScroll = { scrollLeft: 4, scrollTop: 200 };
assert.deepStrictEqual(
  resolveTouchPoint(
    { pageX: 184, pageY: 450 },
    touchRect,
    touchScroll,
    width,
    height
  ),
  { x: 150, y: 150 }
);
assert.deepStrictEqual(
  resolveTouchPoint(
    { clientX: 180, clientY: 250 },
    touchRect,
    touchScroll,
    width,
    height
  ),
  { x: 150, y: 150 }
);
assert.deepStrictEqual(
  resolveTouchPoint({ offsetX: 225, offsetY: 175 }, touchRect, null, width, height),
  { x: 225, y: 175 }
);
assert.deepStrictEqual(
  resolveTouchPoint({ x: 75, y: 125 }, null, null, width, height),
  { x: 75, y: 125 }
);
assert.strictEqual(
  resolveTouchPoint(
    {
      touches: [{
        identifier: 1,
        clientX: 0,
        clientY: 0,
        pageX: 0,
        pageY: 0,
        screenX: 0,
        screenY: 0
      }]
    },
    { left: 34, top: 462.8 },
    null,
    width,
    height
  ),
  null
);
assert.deepStrictEqual(
  resolveTouchPoint(
    {
      touches: [{ clientX: 0, clientY: 0 }]
    },
    { left: 0, top: 0 },
    null,
    width,
    height
  ),
  { x: 0, y: 0 }
);
assert.deepStrictEqual(
  resolveTouchPoint(
    {
      touches: [{ clientX: 0, clientY: 250 }]
    },
    { left: 30, top: 100 },
    null,
    width,
    height
  ),
  { x: 0, y: 150 }
);
assert.deepStrictEqual(
  resolveTouchPoint(
    {
      touches: [{ offsetX: 0, offsetY: 0, clientX: 0, clientY: 0 }]
    },
    { left: 30, top: 100 },
    null,
    width,
    height
  ),
  { x: 0, y: 0 }
);
assert.deepStrictEqual(
  resolveTouchPoint(
    {
      touches: [],
      changedTouches: [{ pageX: 184, pageY: 450 }]
    },
    touchRect,
    touchScroll,
    width,
    height
  ),
  { x: 150, y: 150 }
);
assert.deepStrictEqual(
  resolveTouchPoint(
    { detail: { x: 70, y: 80 } },
    null,
    null,
    width,
    height
  ),
  { x: 70, y: 80 }
);
assert.deepStrictEqual(
  resolveTouchPoints(
    {
      touches: [
        { offsetX: 50, offsetY: 60 },
        { offsetX: 250, offsetY: 160 }
      ]
    },
    touchRect,
    touchScroll,
    width,
    height
  ),
  [{ x: 50, y: 60 }, { x: 250, y: 160 }]
);
assert.strictEqual(
  resolveTouchPoint({ identifier: 1 }, touchRect, null, width, height),
  null
);

console.log("canvas gesture smoke: OK");
console.log(JSON.stringify({
  maxScale: MAX_SCALE,
  mapped,
  touchPoint: { x: 150, y: 150 },
  pinchScale: zoomed.scale,
  offsetLimit: limited
}));

