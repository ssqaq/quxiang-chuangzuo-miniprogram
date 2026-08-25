function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getImagePath(image) {
  if (typeof image === "string") return image;
  const source = image && typeof image === "object" ? image : {};
  return String(
    source.path
      || source.tempFilePath
      || source.displayURL
      || source.sourcePath
      || source.tempFileURL
      || source.url
      || ""
  ).trim();
}

function getImageDimensions(image, fallbackWidth = 1, fallbackHeight = 1) {
  const source = image && typeof image === "object" ? image : {};
  const width = finite(source.width, 0);
  const height = finite(source.height, 0);
  return {
    width: width > 0 ? width : fallbackWidth,
    height: height > 0 ? height : fallbackHeight
  };
}

function fitImageIntoViewport(
  naturalWidth,
  naturalHeight,
  maxWidth,
  maxHeight
) {
  const width = finite(naturalWidth, 0);
  const height = finite(naturalHeight, 0);
  const availableWidth = Math.max(1, finite(maxWidth, 1));
  const availableHeight = Math.max(1, finite(maxHeight, 1));

  if (width <= 0 || height <= 0) {
    return {
      width: 1,
      height: 1,
      scale: 0
    };
  }

  const scale = Math.min(
    availableWidth / width,
    availableHeight / height
  );
  let renderedWidth = Math.max(1, Math.round(width * scale));
  let renderedHeight = Math.max(1, Math.round(height * scale));

  if (renderedWidth > availableWidth) {
    renderedWidth = Math.floor(availableWidth);
    renderedHeight = Math.max(1, Math.round(renderedWidth * height / width));
  }
  if (renderedHeight > availableHeight) {
    renderedHeight = Math.floor(availableHeight);
    renderedWidth = Math.max(1, Math.round(renderedHeight * width / height));
  }

  return {
    width: renderedWidth,
    height: renderedHeight,
    scale
  };
}

module.exports = {
  finite,
  getImagePath,
  getImageDimensions,
  fitImageIntoViewport
};
