function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function getTouchIdentifier(touch) {
  if (!touch || touch.identifier === undefined || touch.identifier === null) {
    return null;
  }
  return touch.identifier;
}

function findTouchByIdentifier(touches, identifier) {
  if (!Array.isArray(touches) || !touches.length) return null;
  if (identifier === null || identifier === undefined) return touches[0] || null;
  return touches.find((touch) => (
    touch
    && touch.identifier !== undefined
    && touch.identifier === identifier
  )) || null;
}

function normalizePoint(point, width, height) {
  return {
    x: clamp(point && point.x, 0, width),
    y: clamp(point && point.y, 0, height)
  };
}

/**
 * 将起点和终点视为椭圆外接框的两个对角点。
 * 不论拖动顺序如何，返回的数据格式都保持为中心点 + 宽高。
 */
function circleFromPoints(start, end, imageWidth, imageHeight, minSize = 20) {
  const widthLimit = Math.max(1, finite(imageWidth, 1));
  const heightLimit = Math.max(1, finite(imageHeight, 1));
  const first = normalizePoint(start, widthLimit, heightLimit);
  const second = normalizePoint(end || start, widthLimit, heightLimit);
  const minimum = Math.max(1, finite(minSize, 20));

  const rawWidth = Math.abs(second.x - first.x);
  const rawHeight = Math.abs(second.y - first.y);
  const width = Math.min(widthLimit, Math.max(minimum, rawWidth));
  const height = Math.min(heightLimit, Math.max(minimum, rawHeight));
  const centerX = (first.x + second.x) / 2;
  const centerY = (first.y + second.y) / 2;
  const left = clamp(centerX - width / 2, 0, widthLimit - width);
  const top = clamp(centerY - height / 2, 0, heightLimit - height);

  return {
    x: left + width / 2,
    y: top + height / 2,
    width,
    height
  };
}

module.exports = {
  circleFromPoints,
  findTouchByIdentifier,
  getTouchIdentifier
};
