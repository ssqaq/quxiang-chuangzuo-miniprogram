/* eslint-disable no-console */

// Release QR verification is deliberately self-contained.  The image codecs
// are already part of the API cloud-function dependency set; the QR detector
// is vendored under scripts/vendor so a fresh CI checkout does not download a
// second, unpinned dependency tree.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function requireFromCandidates(name, candidates) {
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error && error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`${name} 不可用；请先安装 cloudfunctions/api 依赖。`);
}

function parseArgs(argv) {
  const options = { image: "", expect: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--image") options.image = argv[++index] || "";
    else if (token === "--expect") options.expect = argv[++index] || "";
    else if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  return options;
}

function decodeImage(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  if (buffer.length < 8) throw new Error("二维码图片为空或内容过短。");
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (!isPng && !isJpeg) throw new Error("二维码文件不是 PNG 或 JPEG。");

  if (isPng) {
    const { PNG } = requireFromCandidates("pngjs", [
      path.join(root, "cloudfunctions", "api", "node_modules", "pngjs"),
      "pngjs",
    ]);
    return { bitmap: PNG.sync.read(buffer), format: "png" };
  }

  const jpeg = requireFromCandidates("jpeg-js", [
    path.join(root, "cloudfunctions", "api", "node_modules", "jpeg-js"),
    "jpeg-js",
  ]);
  return { bitmap: jpeg.decode(buffer, { useTArray: true }), format: "jpeg" };
}

function decodeQr(imagePath) {
  const image = decodeImage(imagePath);
  const QrCode = require(path.join(__dirname, "vendor", "qrcode-reader.js"));
  const qr = new QrCode();
  let callbackResult;
  qr.callback = (error, result) => {
    callbackResult = { error, result };
  };
  try {
    qr.decode(image.bitmap);
  } catch (error) {
    throw new Error(`二维码解码失败：${error && error.message ? error.message : String(error)}`);
  }
  if (!callbackResult) throw new Error("二维码解码器没有返回结果。");
  if (callbackResult.error) {
    throw new Error(`二维码解码失败：${callbackResult.error.message || String(callbackResult.error)}`);
  }
  const payload = callbackResult.result && String(callbackResult.result.result || "").trim();
  if (!payload) throw new Error("二维码解码成功但 payload 为空。");
  return {
    ok: true,
    image: path.resolve(imagePath),
    format: image.format,
    width: image.bitmap.width,
    height: image.bitmap.height,
    payload,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("用法：node scripts/qr-decode.js --image <二维码.png|jpg> [--expect <文本>] [--json]");
    return 0;
  }
  if (!options.image) throw new Error("缺少 --image 参数。");
  const result = decodeQr(options.image);
  if (options.expect && !result.payload.includes(options.expect)) {
    throw new Error(`二维码 payload 不包含期望文本：${options.expect}`);
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`二维码解码通过：${result.format} ${result.width}x${result.height} payload=${result.payload}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`qr-decode 失败：${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = { decodeImage, decodeQr, main, parseArgs };
