/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");
const { decodeQr } = require("./qr-decode");

const root = path.resolve(__dirname, "..");
const sourceQr = path.resolve(root, "assets", "contact", "author-wechat-qr.jpg");

function runCli(image) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, "qr-decode.js"), "--image", image, "--json"],
    { cwd: root, encoding: "utf8" }
  );
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qr-decode-smoke-"));
try {
  assert.ok(fs.existsSync(sourceQr), "仓库内二维码样本不存在");
  const decoded = decodeQr(sourceQr);
  assert.strictEqual(decoded.ok, true);
  assert.ok(decoded.payload.startsWith("https://u.wechat.com/"), "二维码样本 payload 不是微信地址");
  const cli = runCli(sourceQr);
  assert.strictEqual(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
  assert.strictEqual(JSON.parse(cli.stdout).payload, decoded.payload);

  const invalid = path.join(tempRoot, "invalid.png");
  fs.writeFileSync(invalid, Buffer.from("not a QR image"));
  assert.throws(() => decodeQr(invalid), /不是 PNG 或 JPEG|过短/);
  const invalidCli = runCli(invalid);
  assert.notStrictEqual(invalidCli.status, 0, "无效图片不应通过 CLI");

  const empty = path.join(tempRoot, "empty.png");
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.throws(() => decodeQr(empty), /为空或内容过短/);

  const blank = path.join(tempRoot, "blank.png");
  const image = new PNG({ width: 32, height: 32 });
  image.data.fill(255);
  fs.writeFileSync(blank, PNG.sync.write(image));
  assert.throws(() => decodeQr(blank), /二维码解码失败|payload 为空/);
  console.log("qr-decode-smoke: PASS (valid/invalid/empty/blank/cli)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
