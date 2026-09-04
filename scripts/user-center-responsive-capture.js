/* eslint-disable no-console */

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const root = path.resolve(__dirname, "..");
const previewRoot = process.env.USER_CENTER_PREVIEW_ROOT || path.join(root, "tools", "user-center-preview");
const outputDirectory = path.resolve(
  process.env.USER_CENTER_RESPONSIVE_OUTPUT
    || path.join(root, "docs", "superpowers", "visual-baselines", "user-center-g4")
);
const widths = [320, 338, 375, 414];
const configuredPreviewOrigin = process.env.USER_CENTER_PREVIEW_ORIGIN || "";
const routes = [
  { id: "user-center", view: "center", hash: "#user-center", required: [".profile-card", ".balance-card", ".quick-grid", ".account-panel"], text: ["立即充值", "收支记录"] },
  { id: "recharge", view: "recharge", hash: "#recharge", required: [".recharge-balance", ".package-grid", ".channel-list", ".pay-button"], text: ["本次预计到账", "仅支持微信支付", "微信支付"] },
  { id: "records", view: "records", hash: "#records", required: [".record-summary", ".record-tabs", ".records-panel"], text: ["全部", "充值", "消费", "奖励", "退款"] }
];
const playwrightCandidates = [
  process.env.PLAYWRIGHT_CORE,
  path.join(previewRoot, "node_modules", "playwright-core")
].filter(Boolean);

function loadPlaywright() {
  for (const candidate of playwrightCandidates) {
    try { return require(candidate); } catch (_error) { /* try the next known local install */ }
  }
  throw new Error("找不到 playwright-core；请设置 PLAYWRIGHT_CORE 或先安装预览项目依赖。");
}

function edgeExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  ].filter(Boolean);
  const found = candidates.find((item) => fs.existsSync(item));
  if (!found) throw new Error("找不到 Edge/Chrome 可执行文件；请设置 BROWSER_EXECUTABLE。");
  return found;
}

function number(value) {
  return Number(Number(value).toFixed(3));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function stableScreenshot(page, clip) {
  let previousHash = null;
  let previousBuffer = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const buffer = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
    const currentHash = sha256Buffer(buffer);
    if (currentHash === previousHash) return buffer;
    previousHash = currentHash;
    previousBuffer = buffer;
    await page.waitForTimeout(100);
  }
  throw new Error(`截图在 6 次采样后仍不稳定：${clip.width}x${clip.height}；最后 hash=${sha256Buffer(previousBuffer)}`);
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForPreview(origin, child) {
  const deadline = Date.now() + 45000;
  let output = "";
  if (child) {
    child.stdout?.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12000); });
    child.stderr?.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12000); });
  }
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`预览服务提前退出（${child.exitCode}）：\n${output}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch (_error) {
      // 服务启动期间连接失败是正常的，继续轮询。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`预览服务 45 秒内未启动：${origin}\n${output}`);
}

async function startPreview() {
  if (configuredPreviewOrigin) {
    await waitForPreview(configuredPreviewOrigin, null);
    return { origin: configuredPreviewOrigin, child: null };
  }
  const port = await getFreePort();
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `npm run dev -- --host localhost --port ${port}`]
    : ["run", "dev", "--", "--host", "localhost", "--port", String(port)];
  const child = spawn(command, args, {
    cwd: previewRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const origin = `http://localhost:${port}/?payState=enabled`;
  try {
    await waitForPreview(origin, child);
    return { origin, child };
  } catch (error) {
    await stopPreview(child);
    throw error;
  }
}

async function stopPreview(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolveKill) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("error", resolveKill);
      killer.once("exit", resolveKill);
    });
  } else {
    child.kill("SIGTERM");
  }
}

function routeUrl(origin, hash) {
  const url = new URL(origin);
  url.searchParams.set("payState", "enabled");
  url.searchParams.set("capture", "1");
  url.hash = hash;
  return url.toString();
}

async function capture() {
  const { chromium } = loadPlaywright();
  const preview = await startPreview();
  fs.mkdirSync(outputDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: edgeExecutable(), args: ["--force-color-profile=srgb"] });
  try {
    const captures = {};
    for (const route of routes) {
      captures[route.id] = {};
    }
    for (const route of routes) for (const width of widths) {
      // 外层工作台在窄屏会限制手机壳宽度；测试需锁定业务根节点宽度，
      // 因此在独立截图页注入临时壳尺寸，源码本身不被修改。
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "light", locale: "zh-CN", reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(routeUrl(preview.origin, route.hash), { waitUntil: "networkidle" });
      await page.locator("[data-g1-root]").waitFor({ state: "visible" });
      await page.addStyleTag({ content: `.phone-shell.g1-capture-shell { width: ${width + 16}px !important; min-width: ${width + 16}px !important; max-width: ${width + 16}px !important; height: 708px !important; } .phone-screen[data-g1-root] { width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; height: 654px !important; }` });
      await page.evaluate(() => document.fonts?.ready);
      await page.locator(`[data-g1-root][data-g1-page="${route.view}"]`).waitFor({ state: "visible" });
      await page.locator('[data-g1-root][data-g1-pay-state="enabled"]').waitFor({ state: "visible" });
      const state = await page.locator("[data-g1-root]").evaluate((rootNode) => {
        const rect = rootNode.getBoundingClientRect();
        const box = (selector) => {
          const element = rootNode.querySelector(selector);
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return {
            x: value.x - rect.x,
            y: value.y - rect.y,
            width: value.width,
            height: value.height,
            right: value.right - rect.x,
            bottom: value.bottom - rect.y
          };
        };
        const rootStyle = getComputedStyle(rootNode);
        return {
          root: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          page: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
          rootScroll: { clientWidth: rootNode.clientWidth, scrollWidth: rootNode.scrollWidth },
          boxes: {
            profile: box(".profile-card"),
            balance: box(".balance-card"),
            quick: box(".quick-grid"),
            records: box(".account-panel"),
            recharge: box(".recharge-balance"),
            packages: box(".package-grid"),
            channel: box(".channel-list"),
            pay: box(".pay-button"),
            tabs: box(".record-tabs"),
            tabHit: box(".record-tabs button"),
            cta: box("[data-g1-cta]")
          },
          text: rootNode.textContent.replace(/\s+/g, " ").trim(),
          background: rootStyle.backgroundColor
        };
      });
      const filename = `${route.id}-${width}.png`;
      const screenshotPath = path.join(outputDirectory, filename);
      const rootRect = await page.locator("[data-g1-root]").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y) };
      });
      const clip = { ...rootRect, width, height: 654 };
      const png = await stableScreenshot(page, clip);
      fs.writeFileSync(screenshotPath, png);
      if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== 654) throw new Error(`${route.id}/${width}px PNG 画布不是精确 ${width}x654`);
      const requiredPresent = route.required.every((selector) => Boolean(state.boxes[
        selector === ".profile-card" ? "profile" :
        selector === ".balance-card" ? "balance" :
        selector === ".quick-grid" ? "quick" :
        selector === ".account-panel" ? "records" :
        selector === ".recharge-balance" ? "recharge" :
        selector === ".package-grid" ? "packages" :
        selector === ".channel-list" ? "channel" :
        selector === ".pay-button" ? "pay" :
        selector === ".record-tabs" ? "tabs" : "records"
      ]));
      const textPresent = route.text.every((item) => state.text.includes(item));
      captures[route.id][String(width)] = {
        viewport: { width, height: 654, dpr: 1 },
          browserViewport: { width: 1440, height: 1000, dpr: 1 },
          screenshot: filename,
          screenshotSha256: sha256(screenshotPath),
        geometry: JSON.parse(JSON.stringify(state), (_, value) => typeof value === "number" ? number(value) : value),
        assertions: {
          horizontalOverflow: state.page.clientWidth < state.page.scrollWidth || state.rootScroll.clientWidth < state.rootScroll.scrollWidth,
          rootInsideViewport: Math.abs(state.root.width - width) <= 0.01 && Math.abs(state.root.height - 654) <= 0.01,
          requiredPresent,
          textPresent,
          ctaVisible: route.id === "user-center" ? Boolean(state.boxes.cta) : true,
          hasFiveFilters: route.id === "records" ? route.text.every((item) => state.text.includes(item)) : true
        }
      };
      await context.close();
    }
    const manifest = {
      schemaVersion: 1,
      contract: "G4",
      source: {
        root: path.relative(root, previewRoot).replaceAll(path.sep, "/"),
        mode: configuredPreviewOrigin ? "explicit-origin" : "versioned-package",
        selector: "[data-g1-root]",
        baseline: "G1"
      },
      widths,
      captures
    };
    // 默认保持 manifest 可重复，避免每次重拍仅因时间戳变化就失去哈希绑定。
    if (process.env.USER_CENTER_CAPTURE_INCLUDE_TIMESTAMP === "1") manifest.capturedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const route of routes) for (const width of widths) {
      const capture = captures[route.id][String(width)];
      if (capture.assertions.horizontalOverflow) throw new Error(`${route.id}/${width}px 存在横向溢出`);
      if (!capture.assertions.rootInsideViewport) throw new Error(`${route.id}/${width}px 根节点超出视口`);
      if (!capture.assertions.requiredPresent || !capture.assertions.textPresent) throw new Error(`${route.id}/${width}px 首屏内容不完整`);
    }
    console.log(`user-center responsive capture: OK (${routes.length}页 x ${widths.join("/")}px)`);
    console.table(routes.flatMap((route) => widths.map((width) => ({ route: route.id, width, rootWidth: captures[route.id][String(width)].geometry.root.width, overflow: captures[route.id][String(width)].assertions.horizontalOverflow }))));
  } finally {
    await browser.close();
    await stopPreview(preview.child);
  }
}

capture().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
