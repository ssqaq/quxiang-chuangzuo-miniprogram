const assert = require("assert");
const {
  circleFromPoints,
  findTouchByIdentifier,
  getTouchIdentifier
} = require("../utils/circle-gesture");

const imageWidth = 1000;
const imageHeight = 800;
const expected = {
  x: 500,
  y: 400,
  width: 400,
  height: 300
};

const directions = [
  ["左上到右下", { x: 300, y: 250 }, { x: 700, y: 550 }],
  ["右下到左上", { x: 700, y: 550 }, { x: 300, y: 250 }],
  ["左下到右上", { x: 300, y: 550 }, { x: 700, y: 250 }],
  ["右上到左下", { x: 700, y: 250 }, { x: 300, y: 550 }]
];

for (const [label, start, end] of directions) {
  assert.deepStrictEqual(
    circleFromPoints(start, end, imageWidth, imageHeight),
    expected,
    `${label} 应得到同一个外接框`
  );
}

const clipped = circleFromPoints(
  { x: -100, y: 900 },
  { x: 1200, y: -200 },
  imageWidth,
  imageHeight
);
assert.deepStrictEqual(clipped, {
  x: 500,
  y: 400,
  width: 1000,
  height: 800
});

const minimum = circleFromPoints(
  { x: 10, y: 10 },
  { x: 10, y: 10 },
  imageWidth,
  imageHeight
);
assert.deepStrictEqual(minimum, {
  x: 10,
  y: 10,
  width: 20,
  height: 20
});

const touches = [
  { identifier: 3, x: 10, y: 20 },
  { identifier: 8, x: 80, y: 90 }
];
assert.strictEqual(getTouchIdentifier(touches[1]), 8);
assert.strictEqual(findTouchByIdentifier(touches, 8), touches[1]);
assert.strictEqual(findTouchByIdentifier(touches, 99), null);
assert.strictEqual(findTouchByIdentifier(touches, null), touches[0]);

console.log("circle gesture smoke: OK");
console.log(JSON.stringify({
  directions: directions.length,
  expected,
  clipped,
  minimum
}));
