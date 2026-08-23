const MIN_SCALE = 1;
const MAX_SCALE = 3.5;
const PINCH_SCALE_THRESHOLD = 0.04;
const PINCH_PAN_THRESHOLD = 10;
const TOUCH_COORDINATE_PAGE = "page";
const TOUCH_COORDINATE_CLIENT = "client";

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

function normalizeCoordinateLayout(layout) {
  const source = layout && typeof layout === "object" ? layout : {};
  const viewportLeft = finite(
    source.viewportLeft !== undefined ? source.viewportLeft : source.left
  );
  const viewportTop = finite(
    source.viewportTop !== undefined ? source.viewportTop : source.top
  );
  return {
    documentLeft: finite(
      source.documentLeft !== undefined ? source.documentLeft : viewportLeft
    ),
    documentTop: finite(
      source.documentTop !== undefined ? source.documentTop : viewportTop
    ),
    viewportLeft,
    viewportTop
  };
}

function hasFinitePair(source, xKey, yKey) {
  return Boolean(source)
    && Number.isFinite(Number(source[xKey]))
    && Number.isFinite(Number(source[yKey]));
}

function isSuspiciousAbsoluteZero(x, y, originX, originY) {
  return Number(x) === 0
    && Number(y) === 0
    && (Math.abs(finite(originX)) > 1 || Math.abs(finite(originY)) > 1);
}

function hasReliablePair(source, xKey, yKey, originX, originY) {
  if (!hasFinitePair(source, xKey, yKey)) return false;
  return !isSuspiciousAbsoluteZero(
    source[xKey],
    source[yKey],
    originX,
    originY
  );
}

function selectTouchCoordinateMode(touches, layout) {
  const list = Array.isArray(touches) ? touches.filter(Boolean) : [];
  if (!list.length) return null;
  const normalized = normalizeCoordinateLayout(layout);
  if (list.every((touch) => hasReliablePair(
    touch,
    "pageX",
    "pageY",
    normalized.documentLeft,
    normalized.documentTop
  ))) {
    return TOUCH_COORDINATE_PAGE;
  }
  if (list.every((touch) => hasReliablePair(
    touch,
    "clientX",
    "clientY",
    normalized.viewportLeft,
    normalized.viewportTop
  ))) {
    return TOUCH_COORDINATE_CLIENT;
  }
  return null;
}

function createTouchCoordinateContext(touches, layout) {
  const normalized = normalizeCoordinateLayout(layout);
  const mode = selectTouchCoordinateMode(touches, normalized);
  if (!mode) return null;
  return Object.assign({ mode }, normalized);
}

function resolveTouchPoint(touch, context, width, height) {
  if (!touch || !context) return null;
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  let pointX;
  let pointY;
  let originX;
  let originY;
  if (context.mode === TOUCH_COORDINATE_PAGE) {
    if (!hasReliablePair(
      touch,
      "pageX",
      "pageY",
      context.documentLeft,
      context.documentTop
    )) {
      return null;
    }
    pointX = Number(touch.pageX);
    pointY = Number(touch.pageY);
    originX = finite(context.documentLeft);
    originY = finite(context.documentTop);
  } else if (context.mode === TOUCH_COORDINATE_CLIENT) {
    if (!hasReliablePair(
      touch,
      "clientX",
      "clientY",
      context.viewportLeft,
      context.viewportTop
    )) {
      return null;
    }
    pointX = Number(touch.clientX);
    pointY = Number(touch.clientY);
    originX = finite(context.viewportLeft);
    originY = finite(context.viewportTop);
  } else {
    return null;
  }
  return {
    x: clamp(pointX - originX, 0, safeWidth),
    y: clamp(pointY - originY, 0, safeHeight)
  };
}

function resolveTouchPoints(touchesOrEvent, context, width, height) {
  const touches = Array.isArray(touchesOrEvent)
    ? touchesOrEvent
    : (
      touchesOrEvent
      && Array.isArray(touchesOrEvent.touches)
      && touchesOrEvent.touches.length
        ? touchesOrEvent.touches
        : (
          touchesOrEvent && Array.isArray(touchesOrEvent.changedTouches)
            ? touchesOrEvent.changedTouches
            : []
        )
    );
  return touches
    .map((touch) => resolveTouchPoint(touch, context, width, height))
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
  if (!first || !second) return null;
  const normalizedView = normalizeView(view);
  const startMidpoint = midpoint(first, second);
  return {
    mode: "pending",
    startDistance: distance(first, second),
    startMidpoint,
    startScale: normalizedView.scale,
    startOffsetX: normalizedView.offsetX,
    startOffsetY: normalizedView.offsetY,
    focus: mapViewportPointToCanvas(
      startMidpoint,
      normalizedView,
      width,
      height
    )
  };
}

function unchangedPinchView(state) {
  return {
    mode: state && state.mode ? state.mode : "pending",
    changed: false,
    scale: finite(state && state.startScale, MIN_SCALE),
    offsetX: finite(state && state.startOffsetX),
    offsetY: finite(state && state.startOffsetY)
  };
}

function updatePinchView(state, first, second, width, height) {
  if (!state || !first || !second) return null;
  if (finite(state.startDistance) < 1) return unchangedPinchView(state);
  const currentDistance = distance(first, second);
  if (currentDistance < 1) return unchangedPinchView(state);
  const currentMidpoint = midpoint(first, second);
  const scaleChangeRatio = Math.abs(
    currentDistance - state.startDistance
  ) / state.startDistance;
  const midpointDistance = distance(state.startMidpoint, currentMidpoint);
  if (state.mode === "pending") {
    if (scaleChangeRatio >= PINCH_SCALE_THRESHOLD) {
      state.mode = "scale";
    } else if (midpointDistance >= PINCH_PAN_THRESHOLD) {
      state.mode = "pan";
    } else {
      return unchangedPinchView(state);
    }
  }

  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  if (state.mode === "pan") {
    const offset = clampOffset(
      state.startScale,
      safeWidth,
      safeHeight,
      state.startOffsetX + currentMidpoint.x - state.startMidpoint.x,
      state.startOffsetY + currentMidpoint.y - state.startMidpoint.y
    );
    return {
      mode: state.mode,
      changed: true,
      scale: state.startScale,
      offsetX: offset.x,
      offsetY: offset.y
    };
  }

  if (state.mode !== "scale") return unchangedPinchView(state);
  const scale = clamp(
    state.startScale * currentDistance / state.startDistance,
    MIN_SCALE,
    MAX_SCALE
  );
  const centerX = safeWidth / 2;
  const centerY = safeHeight / 2;
  const rawOffsetX = state.startMidpoint.x - centerX -
    scale * (state.focus.x - centerX);
  const rawOffsetY = state.startMidpoint.y - centerY -
    scale * (state.focus.y - centerY);
  const offset = clampOffset(
    scale,
    safeWidth,
    safeHeight,
    rawOffsetX,
    rawOffsetY
  );
  return {
    mode: state.mode,
    changed: true,
    scale,
    offsetX: offset.x,
    offsetY: offset.y
  };
}

module.exports = {
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
  selectTouchCoordinateMode,
  updatePinchView
};
