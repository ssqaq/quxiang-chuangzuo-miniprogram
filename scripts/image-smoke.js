const assert = require("assert");

const infoByPath = {
  "original.jpg": { width: 2400, height: 1600, type: "image/jpeg" },
  "compressed.jpg": { width: 2400, height: 1600, type: "image/jpeg" },
  "larger.jpg": { width: 2400, height: 1600, type: "image/jpeg" },
  "small.jpg": { width: 800, height: 800, type: "image/jpeg" }
};
const sizeByPath = {
  "original.jpg": 1024 * 1024,
  "compressed.jpg": 180 * 1024,
  "larger.jpg": 2 * 1024 * 1024,
  "small.jpg": 80 * 1024
};
const compressedPathBySource = {
  "original.jpg": "compressed.jpg",
  "larger.jpg": "larger.jpg",
  "small.jpg": "small.jpg"
};
let compressCalls = 0;

global.wx = {
  getImageInfo({ src, success, fail }) {
    if (infoByPath[src]) success(infoByPath[src]);
    else fail(new Error(`unknown image: ${src}`));
  },
  getFileInfo({ filePath, success, fail }) {
    if (sizeByPath[filePath]) success({ size: sizeByPath[filePath] });
    else fail(new Error(`unknown file: ${filePath}`));
  },
  compressImage({ src, success, fail }) {
    compressCalls += 1;
    const target = compressedPathBySource[src];
    if (target) success({ tempFilePath: target });
    else fail(new Error(`cannot compress: ${src}`));
  }
};

const { prepareImageAsset } = require("../utils/image");

async function main() {
  const compressed = await prepareImageAsset({
    tempFilePath: "original.jpg",
    size: sizeByPath["original.jpg"],
    fileType: "jpeg"
  }, {
    compression: { enabled: true, quality: 82, minBytes: 256 * 1024 }
  });
  assert.strictEqual(compressed.path, "compressed.jpg");
  assert.strictEqual(compressed.compressed, true);
  assert.strictEqual(compressed.width, 2400);
  assert.strictEqual(compressed.height, 1600);
  assert.strictEqual(compressed.originalSize, 1024 * 1024);
  assert.strictEqual(compressed.compressedSize, 180 * 1024);
  assert.strictEqual(compressed.type, "image/jpeg");

  const callsBeforeSmall = compressCalls;
  const small = await prepareImageAsset({
    tempFilePath: "small.jpg",
    size: sizeByPath["small.jpg"],
    fileType: "jpeg"
  }, {
    compression: { enabled: true, quality: 82, minBytes: 256 * 1024 }
  });
  assert.strictEqual(small.path, "small.jpg");
  assert.strictEqual(small.compressed, false);
  assert.strictEqual(compressCalls, callsBeforeSmall);

  const larger = await prepareImageAsset({
    tempFilePath: "larger.jpg",
    size: sizeByPath["larger.jpg"],
    fileType: "jpeg"
  }, {
    compression: { enabled: true, quality: 82, minBytes: 256 * 1024 }
  });
  assert.strictEqual(larger.path, "larger.jpg");
  assert.strictEqual(larger.compressed, false);

  const disabled = await prepareImageAsset({
    tempFilePath: "original.jpg",
    size: sizeByPath["original.jpg"],
    fileType: "jpeg"
  }, {
    compression: { enabled: false, quality: 82, minBytes: 0 }
  });
  assert.strictEqual(disabled.path, "original.jpg");
  assert.strictEqual(disabled.compressed, false);

  console.log("image smoke: OK");
  console.log(JSON.stringify({
    compressedPath: compressed.path,
    originalSize: compressed.originalSize,
    compressedSize: compressed.compressedSize,
    compressCalls
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
