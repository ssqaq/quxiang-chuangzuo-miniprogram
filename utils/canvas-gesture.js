const MIN_SCALE = 1;
const MAX_SCALE = 3.5;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function distance(first, second) {
  if (!first || !second) return 0;
  const deltaX = finite(second.x) - finite(first.x);
  const deltaY = finite(second.y) - finite(first.y);
  return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
}

function midpoint(first, second) {
  return {
    x: (finite(first && first.x) + finite(second && second.x)) / 2,
    y: (finite(first && first.y) + finite(second && second.y)) / 2
  };
}

function normalizeView(view) {
  return {
    scale: clamp(view && view.scale, MIN_SCALE, MAX_SCALE),
    offsetX: finite(view && view.offsetX),
    offsetY: finite(view && view.offsetY)
  };
}

function clampOffset(scale, width, height, offsetX, offsetY) {
  const safeScale = clamp(scale, MIN_SCALE, MAX_SCALE);
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const maxOffsetX = safeWidth * (safeScale - 1) / 2;
  const maxOffsetY = safeHeight * (safeScale - 1) / 2;
  return {
    x: clamp(offsetX, -maxOffsetX, maxOffsetX),
    y: clamp(offsetY, -maxOffsetY, maxOffsetY)
  };
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isEventLike(value) {
  return isObject(value)
    && (Array.isArray(value.touches) || Array.isArray(value.changedTouches));
}

function isNearZero(value) {
  return Math.abs(Number(value) || 0) <= 1;
}

function isViewportAtOrigin(rect) {
  return !rect || (isNearZero(rect.left) && isNearZero(rect.top));
}

function isSuspiciousAbsoluteZero(x, y, rect) {
  return Number(x) === 0
    && Number(y) === 0
    && rect
    && !isViewportAtOrigin(rect);
}

function appendSource(sources, value) {
  if (!isObject(value)) return;
  sources.push(value);
  if (isObject(value.detail)) sources.push(value.detail);
  if (isObject(value._userTap)) sources.push(value._userTap);
}

function resolveTouchPoint(eventOrTouch, rect, scrollOffset, width, height, eventContext) {
  if (!eventOrTouch && !eventContext) return null;
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const hasRect = rect
    && Number.isFinite(Number(rect.left))
    && Number.isFinite(Number(rect.top));
  const left = hasRect ? Number(rect.left) : 0;
  const top = hasRect ? Number(rect.top) : 0;
  const scrollLeft = finite(scrollOffset && (
    scrollOffset.scrollLeft !== undefined
      ? scrollOffset.scrollLeft
      : scrollOffset.left
  ));
  const scrollTop = finite(scrollOffset && (
    scrollOffset.scrollTop !== undefined
      ? scrollOffset.scrollTop
      : scrollOffset.top
  ));
  const localPair = (x, y) => {
    const pointX = Number(x);
    const pointY = Number(y);
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return null;
    return {
      x: clamp(pointX, 0, safeWidth),
      y: clamp(pointY, 0, safeHeight)
    };
  };

  const absolutePair = (x, y, offsetX, offsetY) => {
    const pointX = Number(x);
    const pointY = Number(y);
    if (
      !Number.isFinite(pointX)
      || !Number.isFinite(pointY)
      || isSuspiciousAbsoluteZero(pointX, pointY, rect)
    ) {
      return null;
    }
    return {
      x: clamp(pointX - offsetX, 0, safeWidth),
      y: clamp(pointY - offsetY, 0, safeHeight)
    };
  };

  const resolveSource = (source) => {
    if (!isObject(source)) return null;

    // 局部坐标不参与“伪零”判断：(0, 0) 在局部坐标系里是合法左上角。
    const offsetPoint = localPair(
      source.offsetX,
      source.offsetY
    );
    if (offsetPoint) return offsetPoint;
    const localPoint = localPair(source.x, source.y);
    if (localPoint) return localPoint;

    if (!hasRect) return null;

    const clientPoint = absolutePair(
      source.clientX,
      source.clientY,
      left,
      top
    );
    if (clientPoint) return clientPoint;

    const pagePoint = absolutePair(
      source.pageX,
      source.pageY,
      left + scrollLeft,
      top + scrollTop
    );
    if (pagePoint) return pagePoint;

    // screen 坐标只有在前两种绝对坐标不可用时作为最后兜底。
    // 不把它当局部坐标，仍按页面矩形和滚动量换算。
    return absolutePair(
      source.screenX,
      source.screenY,
      left + scrollLeft,
      top + scrollTop
    );
  };

  const event = isEventLike(eventOrTouch) ? eventOrTouch : eventContext;
  const touchSources = [];
  if (isEventLike(eventOrTouch)) {
    (eventOrTouch.touches || []).forEach((touch) => appendSource(touchSources, touch));
    (eventOrTouch.changedTouches || []).forEach((touch) => appendSource(touchSources, touch));
  } else {
    appendSource(touchSources, eventOrTouch);
  }
  if (event && event !== eventOrTouch) {
    (event.touches || []).forEach((touch) => appendSource(touchSources, touch));
    (event.changedTouches || []).forEach((touch) => appendSource(touchSources, touch));
  }

  for (const source of touchSources) {
    const point = resolveSource(source);
    if (point) return point;
  }

  // 触摸对象没有可用坐标时，再检查事件级、detail 和 _userTap 字段。
  const eventSources = [];
  if (event) {
    appendSource(eventSources, event.detail);
    appendSource(eventSources, event._userTap);
    appendSource(eventSources, event);
  }
  for (const source of eventSources) {
    const point = resolveSource(source);
    if (point) return point;
  }

  return null;
}

function resolveTouchPoints(event, rect, scrollOffset, width, height) {
  if (!event) return [];
  const touches = Array.isArray(event.touches) && event.touches.length
    ? event.touches
    : (Array.isArray(event.changedTouches) ? event.changedTouches : []);
  return touches
    .map((touch) => resolveTouchPoint(touch, rect, scrollOffset, width, height))
    .filter((point) => point);
}

function mapViewportPointToCanvas(point, view, width, height) {
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const normalizedView = normalizeView(view);
  const centerX = safeWidth / 2;
  const centerY = safeHeight / 2;
  return {
    x: clamp(
      (finite(point && point.x) - centerX - normalizedView.offsetX) /
        normalizedView.scale + centerX,
      0,
      safeWidth
    ),
    y: clamp(
      (finite(point && point.y) - centerY - normalizedView.offsetY) /
        normalizedView.scale + centerY,
      0,
      safeHeight
    )
  };
}

function createPinchState(first, second, view, width, height) {
  const startDistance = distance(first, second);
  if (startDistance < 1) return null;
  const normalizedView = normalizeView(view);
  return {
    startDistance,
    startScale: normalizedView.scale,
    focus: mapViewportPointToCanvas(
      midpoint(first, second),
      normalizedView,
      width,
      height
    )
  };
}

function updatePinchView(state, first, second, width, height) {
  if (!state || !first || !second || state.startDistance < 1) return null;
  const currentDistance = distance(first, second);
  if (currentDistance < 1) return null;
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const scale = clamp(
    state.startScale * currentDistance / state.startDistance,
    MIN_SCALE,
    MAX_SCALE
  );
  const currentMidpoint = midpoint(first, second);
  const centerX = safeWidth / 2;
  const centerY = safeHeight / 2;
  const rawOffsetX = currentMidpoint.x - centerX -
    scale * (state.focus.x - centerX);
  const rawOffsetY = currentMidpoint.y - centerY -
    scale * (state.focus.y - centerY);
  const offset = clampOffset(
    scale,
    safeWidth,
    safeHeight,
    rawOffsetX,
    rawOffsetY
  );
  return {
    scale,
    offsetX: offset.x,
    offsetY: offset.y
  };
}

module.exports = {
  MIN_SCALE,
  MAX_SCALE,
  clampOffset,
  createPinchState,
  distance,
  mapViewportPointToCanvas,
  midpoint,
  resolveTouchPoint,
  resolveTouchPoints,
  updatePinchView
};
