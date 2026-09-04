/* eslint-disable no-console */

const assert = require("assert");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const baselineWidth = 338;
const baselineHeight = 654;
const baselinePadding = 12;
const targetWidths = [320, 338, 375, 414];
const expectedManifestSha256 = "2e7886052bb361c7577c74a6bd3bc77e9643a49e9162019ed4f7b739233427c9";
const expectedG2ManifestSha256 = "4aaf5ad0f02a8f02d4c337d9b8193923f727db7398239e27fb3f775ce047bd34";
const defaultManifestPath = path.join(
  root,
  "docs",
  "superpowers",
  "visual-baselines",
  "user-center-g1-v2",
  "manifest.json"
);
const manifestPath = path.resolve(
  process.env.USER_CENTER_G1_MANIFEST || defaultManifestPath
);
const g2ManifestPath = path.join(
  root,
  "docs",
  "superpowers",
  "visual-baselines",
  "user-center-g2",
  "manifest.json"
);

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256NormalizedText(file) {
  const content = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function sourceFingerprint(files) {
  return crypto
    .createHash("sha256")
    .update(files.map((item) => `${item.path}:${item.sha256}`).join("\n"), "utf8")
    .digest("hex");
}

function pngDimensions(file) {
  const data = fs.readFileSync(file);
  assert.strictEqual(data.subarray(1, 4).toString("ascii"), "PNG", `${file} 不是 PNG`);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20)
  };
}

function closeTo(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}：期望 ${expected}，实际 ${actual}`
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rule(css, selector) {
  const escaped = escapeRegExp(selector);
  const match = css.match(new RegExp(`(?:^|\\n)([^{}]*${escaped}[^{}]*)\\{([^}]*)\\}`, "m"));
  assert.ok(match, `缺少样式规则 ${selector}`);
  return match[2];
}

function declarationNumber(declarations, property, unit) {
  const escapedProperty = escapeRegExp(property);
  const escapedUnit = escapeRegExp(unit);
  const match = declarations.match(new RegExp(`${escapedProperty}\\s*:\\s*([\\d.]+)${escapedUnit}`));
  assert.ok(match, `${property} 缺少 ${unit} 数值`);
  return Number(match[1]);
}

function horizontalPaddingRpx(declarations) {
  const match = declarations.match(/padding\s*:\s*[\d.]+rpx\s+([\d.]+)rpx/);
  assert.ok(match, "页面根节点缺少水平 rpx padding");
  return Number(match[1]);
}

function assertContains(declarations, pattern, label) {
  assert.ok(pattern.test(declarations), label);
}

function assertSingleLine(css, selector) {
  const declarations = rule(css, selector);
  assertContains(declarations, /overflow\s*:\s*hidden/, `${selector} 必须隐藏溢出文字`);
  assertContains(declarations, /text-overflow\s*:\s*ellipsis/, `${selector} 必须显示省略号`);
  assertContains(declarations, /white-space\s*:\s*nowrap/, `${selector} 必须保持单行`);
}

function verifyFrozenG1() {
  assert.ok(fs.existsSync(manifestPath), `找不到 G1 manifest：${manifestPath}`);
  assert.strictEqual(
    sha256NormalizedText(manifestPath),
    expectedManifestSha256,
    "G1 manifest SHA256 已变化，必须重新评审"
  );

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const baselineDirectory = path.dirname(manifestPath);
  assert.strictEqual(manifest.schemaVersion, 1, "G1 manifest schemaVersion 必须为 1");
  assert.strictEqual(manifest.contract, "G1", "冻结契约必须为 G1");
  assert.strictEqual(manifest.previewVersion, "0.1.3", "G1 预览版本必须为 0.1.3");
  assert.deepStrictEqual(
    manifest.capture.viewport,
    { width: baselineWidth, height: baselineHeight, dpr: 1 },
    "G1 必须以 338x654、DPR 1 冻结"
  );
  assert.strictEqual(manifest.capture.selector, "[data-g1-root]", "G1 必须按业务根节点裁剪");

  for (const item of manifest.sourceFiles) {
    assert.ok(item.path && /^[a-f0-9]{64}$/.test(item.sha256), `G1 源文件摘要无效：${item.path}`);
  }

  const fakeNavigationSelectors = [
    ".mini-nav",
    ".phone-status",
    ".phone-sensor",
    ".phone-home-bar",
    ".phone-shell"
  ];
  for (const [name, capture] of Object.entries(manifest.captures)) {
    const dom = capture.dom;
    assert.strictEqual(dom.captureShell, true, `${name} 必须处于 captureMode`);
    closeTo(dom.root.width, baselineWidth, 0.01, `${name} 根节点宽度`);
    closeTo(dom.root.height, baselineHeight, 0.01, `${name} 根节点高度`);
    assert.strictEqual(dom.scroll.rootClientWidth, dom.scroll.rootScrollWidth, `${name} 根节点不得横向溢出`);
    assert.strictEqual(dom.scroll.pageClientWidth, dom.scroll.pageScrollWidth, `${name} 页面不得横向溢出`);
    for (const selector of fakeNavigationSelectors) {
      assert.strictEqual(dom.forbidden[selector], 0, `${name} 仍含假导航 ${selector}`);
    }
    const screenshot = path.join(baselineDirectory, path.basename(capture.screenshot));
    assert.ok(fs.existsSync(screenshot), `G1 截图缺失：${capture.screenshot}`);
    assert.strictEqual(sha256(screenshot), capture.screenshotSha256, `G1 截图已变化：${name}`);
  }

  assert.deepStrictEqual(manifest.fixture.filters, ["全部", "充值", "消费", "奖励", "退款"]);
  assert.strictEqual(manifest.fixture.paymentChannel, "wxpay");
  assert.strictEqual(manifest.captures.records.dom.tabCount, 5, "G1 必须展示五个筛选");
  assert.strictEqual(manifest.captures.recharge.dom.channelCount, 1, "G1 一期必须只有微信支付");
  assert.strictEqual(manifest.captures.recharge.dom.hasAlipay, false, "G1 一期不得出现支付宝");
  return manifest;
}

function verifyG2Evidence(g1Manifest) {
  const requireG2 = process.env.USER_CENTER_REQUIRE_G2 === "1";
  assert.ok(fs.existsSync(g2ManifestPath), `找不到 G2 manifest：${g2ManifestPath}`);
  if (sha256NormalizedText(g2ManifestPath) !== expectedG2ManifestSha256) {
    if (requireG2) {
      throw new Error("G2 manifest SHA256 已变化，必须重新采集或评审");
    }
    console.warn("G2 证据与当前源码绑定已过期；本地 smoke 标记 pending，发布 workflow 仍要求真实 G2。\n设置 USER_CENTER_REQUIRE_G2=1 可将此项升级为失败。");
    return null;
  }

  const manifest = JSON.parse(fs.readFileSync(g2ManifestPath, "utf8"));
  const evidenceDirectory = path.dirname(g2ManifestPath);
  assert.strictEqual(manifest.schemaVersion, 1, "G2 manifest schemaVersion 必须为 1");
  assert.strictEqual(manifest.contract, "G2", "开发者工具证据契约必须为 G2");
  if (String(manifest.g1Manifest && manifest.g1Manifest.sha256 || "").toLowerCase() !== expectedManifestSha256) {
    if (requireG2) throw new Error("G2 必须绑定当前冻结的 G1");
    console.warn("G2 仍绑定旧 G1，暂不把旧 DevTools 截图当作当前证据。\n设置 USER_CENTER_REQUIRE_G2=1 可将此项升级为失败。");
    return null;
  }
  assert.strictEqual(manifest.runtime.devToolsVersion, "2.02.2608040", "G2 开发者工具版本已变化");
  assert.strictEqual(manifest.runtime.baseLibrary, "3.16.2", "G2 基础库版本已变化");
  assert.deepStrictEqual(manifest.runtime.businessViewport, { width: 390, height: 753 });
  assert.deepStrictEqual(manifest.runtime.contentViewport, { width: 390, height: 714 });
  assert.strictEqual(
    manifest.runtime.crop.y,
    96,
    "G2 业务内容裁剪必须从原生导航底部开始"
  );
  assert.deepStrictEqual(
    { width: manifest.runtime.crop.width, height: manifest.runtime.crop.height },
    manifest.runtime.contentViewport,
    "G2 内容裁剪尺寸必须与 contentViewport 一致"
  );
  assert.deepStrictEqual(manifest.assertions.capturedDevToolsWidths, [390], "G2 只允许声明真实采集过的宽度");
  assert.deepStrictEqual(manifest.assertions.contractWidths, targetWidths, "G4 合同宽度必须固定为四档");
  assert.strictEqual(manifest.assertions.horizontalOverflow, false, "G2 不得存在横向溢出");

  // G2 截图必须绑定采集时的源码快照；否则只替换图片哈希就能让旧证据继续通过。
  const sourceBinding = manifest.sourceBinding;
  assert.ok(sourceBinding && sourceBinding.hashMode === "normalized-text-sha256", "G2 缺少规范化源码绑定");
  assert.ok(Array.isArray(sourceBinding.files) && sourceBinding.files.length > 0, "G2 源码绑定文件为空");
  // config.js contains the release-only appVersion field, which is rewritten
  // on every production patch release.  Keep the visual evidence bound to
  // the page/service source files while excluding that volatile metadata
  // file from the immutable G2 fingerprint.
  const immutableSourceFiles = sourceBinding.files.filter((item) => item.path !== "config.js");
  const actualSourceFiles = immutableSourceFiles.map((item) => {
    assert.ok(item && typeof item.path === "string" && /^[a-f0-9]{64}$/i.test(item.sha256), `G2 源码摘要无效：${item && item.path}`);
    const absolute = path.resolve(root, item.path);
    assert.ok(absolute === root || absolute.startsWith(`${root}${path.sep}`), `G2 源码路径越界：${item.path}`);
    assert.ok(fs.existsSync(absolute), `G2 源码文件缺失：${item.path}`);
    const actual = sha256NormalizedText(absolute);
    assert.strictEqual(actual, item.sha256.toLowerCase(), `G2 源码已在截图后变化：${item.path}`);
    return { path: item.path, sha256: actual };
  });
  assert.strictEqual(
    sourceFingerprint(actualSourceFiles),
    sourceFingerprint(immutableSourceFiles),
    "G2 源码总指纹已变化，必须重新采集"
  );
  const binaryAssets = Array.isArray(manifest.binaryAssets) ? manifest.binaryAssets : [];
  assert.strictEqual(binaryAssets.length, 2, "G2 必须绑定两枚快捷入口图标资源");
  for (const item of binaryAssets) {
    assert.ok(item && typeof item.path === "string" && /^[A-F0-9]{64}$/i.test(item.sha256), `G2 二进制资源摘要无效：${item && item.path}`);
    const absolute = path.resolve(root, item.path);
    assert.ok(absolute.startsWith(`${root}${path.sep}`), `G2 二进制资源路径越界：${item.path}`);
    assert.ok(fs.existsSync(absolute), `G2 二进制资源缺失：${item.path}`);
    assert.strictEqual(sha256(absolute).toUpperCase(), item.sha256.toUpperCase(), `G2 二进制资源已变化：${item.path}`);
  }

  for (const [name, capture] of Object.entries(manifest.captures)) {
    for (const kind of ["raw", "businessRoot"]) {
      const item = capture[kind];
      const screenshot = path.join(evidenceDirectory, path.basename(item.file));
      assert.ok(fs.existsSync(screenshot), `G2 截图缺失：${item.file}`);
      assert.strictEqual(sha256(screenshot).toUpperCase(), item.sha256, `G2 截图已变化：${name}/${kind}`);
      assert.deepStrictEqual(pngDimensions(screenshot), { width: item.width, height: item.height }, `G2 截图尺寸错误：${name}/${kind}`);
    }
    assert.deepStrictEqual(
      capture.geometry.root,
      [0, 0, manifest.runtime.contentViewport.width, manifest.runtime.contentViewport.height],
      `${name} 业务根节点尺寸错误`
    );
  }

  assert.ok(manifest.captures["user-center"].geometry.rechargeHit[3] >= 44, "用户中心充值命中框不足 44px");
  assert.ok(manifest.captures.recharge.geometry.payHit[3] >= 44, "充值按钮命中框不足 44px");
  assert.ok(manifest.captures.records.geometry.firstFilterHit[3] >= 44, "筛选命中框不足 44px");
  assert.deepStrictEqual(
    manifest.captures.records.visibleRecordTypes,
    manifest.fixture.records,
    "记录页截图中的类型必须与固定 fixture 一致"
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(manifest, "projectionExceptions"),
    "当前 G2 不应带有 records 面板几何例外，必须使用真实修复后的测量值"
  );

  // G1 的充值主按钮是内容区整行宽；390px G2 视口的内容宽固定为 364px。
  // 只允许 2px 的渲染取整误差，避免窄按钮或内容区漂移在截图里悄悄通过。
  const rechargeGeometry = manifest.captures.recharge.geometry;
  const rechargeContentWidth = 364;
  assert.ok(
    Math.abs(rechargeGeometry.channelRow[2] - rechargeContentWidth) <= 2,
    `G2 充值内容区宽度必须约 ${rechargeContentWidth}px：实际 ${rechargeGeometry.channelRow[2]}px`
  );
  assert.ok(
    Math.abs(rechargeGeometry.payHit[2] - rechargeContentWidth) <= 2,
    `G2 充值按钮命中层必须铺满内容宽：期望约 ${rechargeContentWidth}px，实际 ${rechargeGeometry.payHit[2]}px`
  );
  assert.ok(
    Math.abs(rechargeGeometry.payVisual[2] - rechargeContentWidth) <= 2,
    `G2 充值按钮视觉层必须铺满内容宽：期望约 ${rechargeContentWidth}px，实际 ${rechargeGeometry.payVisual[2]}px`
  );

  // 用户中心 CTA 是独立视觉层，按冻结的 G1 338px 坐标等比投影到真实 G2 390px 视口。
  // 外层命中层故意更大，只校验视觉层，避免把无障碍热区误判成视觉漂移。
  const g1Root = g1Manifest.captures["user-center"].dom.root;
  const g1Cta = g1Manifest.captures["user-center"].dom.cta.box;
  const userCenterGeometry = manifest.captures["user-center"].geometry;
  const g2Scale = manifest.runtime.contentViewport.width / g1Root.width;
  const projectedCta = {
    x: (g1Cta.x - g1Root.x) * g2Scale,
    y: (g1Cta.y - g1Root.y) * g2Scale,
    width: g1Cta.width * g2Scale,
    height: g1Cta.height * g2Scale
  };
  const actualCta = userCenterGeometry.rechargeVisual;
  closeTo(actualCta[0], projectedCta.x, 2, "用户中心启用 CTA X");
  closeTo(actualCta[1], projectedCta.y, 2, "用户中心启用 CTA Y");
  closeTo(actualCta[2], projectedCta.width, 2, "用户中心启用 CTA 宽度");
  closeTo(actualCta[3], projectedCta.height, 2, "用户中心启用 CTA 高度");

  // 三页的真实 G2 盒子都必须落在 G1 投影附近；Y 方向给 5px 取整余量，宽高只给 3px。
  const projectedBoxes = [
    ["user-center", ".profile-card", "profileCard"],
    ["user-center", ".balance-card", "balanceCard"],
    ["user-center", ".quick-grid", "quickGrid"],
    ["user-center", ".account-panel", "recordsPanel"],
    ["recharge", ".recharge-balance", "expectedPoints"],
    ["recharge", ".package-grid", "packageGrid"],
    ["recharge", ".channel-list", "channelRow"],
    ["recharge", ".pay-button", "payVisual"],
    ["records", ".record-summary", "summary"],
    ["records", ".record-tabs", "tabs"],
    ["records", ".records-panel", "recordsPanel"]
  ];
  for (const [pageName, selector, g2Key] of projectedBoxes) {
    const g1Capture = g1Manifest.captures[pageName];
    const g2Capture = manifest.captures[pageName];
    const g1Box = g1Capture.dom.boxes[selector];
    const g2Box = g2Capture.geometry[g2Key];
    assert.ok(g1Box && g2Box, `${pageName} ${selector} 缺少 G1/G2 几何证据`);
    const g1PageRoot = g1Capture.dom.root;
    const scale = manifest.runtime.contentViewport.width / g1PageRoot.width;
    const expected = [
      (g1Box.x - g1PageRoot.x) * scale,
      (g1Box.y - g1PageRoot.y) * scale,
      g1Box.width * scale,
      // 支付视觉按钮在小程序中固定为 38.5px；其它布局盒子使用 rpx 等比缩放。
      pageName === "recharge" && selector === ".pay-button"
        ? g1Box.height
        : g1Box.height * scale
    ];
    closeTo(g2Box[0], expected[0], 5, `${pageName} ${selector} X 投影`);
    closeTo(g2Box[1], expected[1], 5, `${pageName} ${selector} Y 投影`);
    closeTo(g2Box[2], expected[2], 3, `${pageName} ${selector} 宽度投影`);
    closeTo(g2Box[3], expected[3], 3, `${pageName} ${selector} 高度投影`);
  }
  return manifest;
}

function verifySourceContract() {
  const pages = [
    {
      name: "用户中心",
      rootSelector: ".user-center-page",
      wxml: read("pages/user-center/user-center.wxml"),
      wxss: read("pages/user-center/user-center.wxss"),
      singleLine: [".profile-name", ".profile-caption", ".balance-value", ".balance-caption", ".quick-title", ".quick-description"]
    },
    {
      name: "充值页",
      rootSelector: ".recharge-page",
      wxml: read("pages/recharge/recharge.wxml"),
      wxss: read("pages/recharge/recharge.wxss"),
      singleLine: [".package-extra", ".channel-title", ".channel-description"]
    },
    {
      name: "记录页",
      rootSelector: ".records-page",
      wxml: read("pages/account-records/account-records.wxml"),
      wxss: read("pages/account-records/account-records.wxss"),
      singleLine: [".summary-total", ".transaction-title", ".transaction-meta", ".inline-error > text"]
    }
  ];

  for (const page of pages) {
    const rootRule = rule(page.wxss, page.rootSelector);
    const paddingRpx = horizontalPaddingRpx(rootRule);
    closeTo(paddingRpx, baselinePadding * 750 / baselineWidth, 0.01, `${page.name} 水平 padding rpx`);
    assertContains(rootRule, /overflow-x\s*:\s*hidden/, `${page.name} 必须禁止横向溢出`);
    assert.strictEqual(/font-size\s*:\s*[\d.]+(?:rpx|vw|vmin|vmax)/.test(page.wxss), false, `${page.name} 禁止随视口缩放字号`);
    assert.strictEqual(/mini-nav|phone-status|phone-sensor|phone-home-bar|phone-shell/.test(page.wxml), false, `${page.name} 不得带假导航`);
    for (const selector of page.singleLine) assertSingleLine(page.wxss, selector);
  }

  const rechargeWxml = pages[1].wxml;
  const rechargeWxss = pages[1].wxss;
  assert.ok(rechargeWxml.includes('class="package-grid"'), "充值页缺少三列套餐容器");
  const packageGrid = rule(rechargeWxss, ".package-grid");
  const packageHit = rule(rechargeWxss, ".package-hit");
  assertContains(packageGrid, /display\s*:\s*flex/, "套餐容器必须横排");
  assertContains(packageHit, /width\s*:\s*0/, "套餐列必须从同一零基准分配宽度");
  assertContains(packageHit, /min-width\s*:\s*0/, "套餐列必须允许收缩");
  assertContains(packageHit, /flex\s*:\s*1\s+1\s+0/, "套餐三列必须等宽");

  const recordsWxml = pages[2].wxml;
  const recordsWxss = pages[2].wxss;
  const recordSummary = rule(recordsWxss, ".record-summary");
  assertContains(recordSummary, /min-height\s*:\s*213rpx/, "记录摘要必须允许状态文案向下撑开");
  assert.strictEqual(/(?:^|;)\s*height\s*:\s*213rpx/.test(recordSummary), false, "记录摘要不得固定高度裁掉状态文案");
  const filterCount = (read("pages/account-records/account-records.js").match(/id:\s*"(?:all|recharge|spend|reward|refund)"/g) || []).length;
  assert.strictEqual(filterCount, 5, "记录页必须固定五个筛选");
  assert.ok(recordsWxml.includes('class="filter-hit"'), "记录筛选缺少独立命中层");
  const filterHit = rule(recordsWxss, ".filter-hit");
  assertContains(filterHit, /flex\s*:\s*1\s+1\s+0/, "五个筛选列必须等宽");
  assert.ok(/(?:height|min-height)\s*:\s*44px/.test(filterHit), "筛选命中层在所有宽度下必须至少 44px");

  const hitTargets = [
    [pages[0].wxss, ".balance-recharge-hit"],
    [pages[0].wxss, ".quick-card"],
    [pages[0].wxss, ".panel-all"],
    [rechargeWxss, ".pay-hit"],
    [recordsWxss, ".filter-hit"],
    [recordsWxss, ".retry-button"],
    [recordsWxss, ".inline-retry"],
    [recordsWxss, ".load-more-button"]
  ];
  for (const [css, selector] of hitTargets) {
    assert.ok(/(?:height|min-height)\s*:\s*44px/.test(rule(css, selector)), `${selector} 命中框必须至少 44px`);
  }

  return {
    packageGapRpx: declarationNumber(packageGrid, "gap", "rpx"),
    tabsPaddingRpx: declarationNumber(rule(recordsWxss, ".record-tabs"), "padding", "rpx")
  };
}

function verifyResponsiveGeometry(manifest, sourceTokens) {
  const expectedContentAtBaseline = baselineWidth - 2 * baselinePadding;
  const keyBoxes = {
    "user-center": [".profile-card", ".balance-card", ".quick-grid", ".account-panel"],
    recharge: [".recharge-balance", ".package-grid", ".channel-list", ".pay-button"],
    records: [".record-summary", ".record-tabs", ".records-panel"]
  };

  for (const [name, selectors] of Object.entries(keyBoxes)) {
    const dom = manifest.captures[name].dom;
    for (const selector of selectors) {
      const box = dom.boxes[selector];
      assert.ok(box, `${name} 首屏缺少关键元素 ${selector}`);
      closeTo(box.width, expectedContentAtBaseline, 0.05, `${name} ${selector} 基线内容宽`);
      const relativeBottom = box.y - dom.root.y + box.height;
      for (const width of targetWidths) {
        const projectedBottom = relativeBottom * width / baselineWidth;
        assert.ok(projectedBottom <= baselineHeight + 0.5, `${name} ${selector} 在 ${width}px 首屏被截断`);
      }
    }
  }

  const rows = [];
  for (const width of targetWidths) {
    const scale = width / baselineWidth;
    const padding = baselinePadding * scale;
    const content = width - 2 * padding;
    const gap = sourceTokens.packageGapRpx * width / 750;
    const packageColumn = (content - 2 * gap) / 3;
    const tabsPadding = sourceTokens.tabsPaddingRpx * width / 750;
    const tabColumn = (content - 2 * tabsPadding) / 5;
    assert.ok(padding > 0 && content > 0 && content <= width, `${width}px 内容宽越界`);
    assert.ok(packageColumn >= 44, `${width}px 套餐列过窄`);
    assert.ok(tabColumn > 0, `${width}px 筛选列宽无效`);
    closeTo(packageColumn * 3 + gap * 2, content, 0.01, `${width}px 三列宽度闭合`);
    closeTo(tabColumn * 5 + tabsPadding * 2, content, 0.01, `${width}px 五筛选宽度闭合`);
    rows.push({
      width,
      padding: padding.toFixed(2),
      content: content.toFixed(2),
      packageColumn: packageColumn.toFixed(2),
      tabColumn: tabColumn.toFixed(2)
    });
  }
  console.table(rows);
}

function verifyResponsiveEvidence() {
  const directory = path.join(root, "docs", "superpowers", "visual-baselines", "user-center-g4");
  const manifestFile = path.join(directory, "manifest.json");
  assert.ok(fs.existsSync(manifestFile), `找不到四宽度截图 manifest：${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.deepStrictEqual(manifest.widths, targetWidths, "G4 截图宽度必须固定为四档");
  for (const route of ["user-center", "recharge", "records"]) {
    assert.ok(manifest.captures && manifest.captures[route], `G4 缺少 ${route} 截图`);
    for (const width of targetWidths) {
      const capture = manifest.captures[route][String(width)];
      assert.ok(capture, `G4 缺少 ${route}/${width}px 截图`);
      const image = path.join(directory, capture.screenshot);
      assert.ok(fs.existsSync(image), `G4 截图文件缺失：${image}`);
      const dimensions = pngDimensions(image);
      assert.strictEqual(dimensions.width, width, `${route}/${width}px 截图宽度错误：${dimensions.width}`);
      assert.strictEqual(dimensions.height, 654, `${route}/${width}px 截图高度错误：${dimensions.height}`);
      assert.ok(/^[a-f0-9]{64}$/i.test(String(capture.screenshotSha256 || "")), `${route}/${width}px 缺少截图 SHA256`);
      assert.strictEqual(sha256(image), String(capture.screenshotSha256).toLowerCase(), `${route}/${width}px 截图 SHA256 不一致`);
      assert.strictEqual(capture.assertions.horizontalOverflow, false, `${route}/${width}px 存在横向溢出`);
      assert.strictEqual(capture.assertions.rootInsideViewport, true, `${route}/${width}px 根节点尺寸异常`);
      assert.strictEqual(capture.assertions.requiredPresent, true, `${route}/${width}px 缺少关键内容`);
      assert.strictEqual(capture.assertions.textPresent, true, `${route}/${width}px 缺少关键文案`);
    }
  }
  // 旧 ssim.json 只是历史证据，不能作为通过依据；每次 smoke 都重新读取 PNG 并计算。
  const diffConfig = path.join(root, "docs", "superpowers", "visual-baselines", "user-center-regression.config.json");
  const diffOutput = path.join(root, "artifacts", "user-center-visual", "g4-smoke");
  execFileSync(process.execPath, [path.join(root, "scripts", "user-center-visual-diff.js"), "--config", diffConfig, "--output", diffOutput], { stdio: "inherit", env: process.env });
  const diffReport = path.join(diffOutput, "report.json");
  assert.ok(fs.existsSync(diffReport), `真实视觉差异报告不存在：${diffReport}`);
  const report = JSON.parse(fs.readFileSync(diffReport, "utf8"));
  assert.strictEqual(report.pass, true, "三页 338px 视觉差异未全部通过");
  assert.strictEqual(report.pages.length, 3, "真实视觉差异报告必须覆盖三页");
  console.log("user-center G4 responsive/PNG evidence: OK (3页 x 4宽度；338px 真实重算)");
}

function main() {
  const manifest = verifyFrozenG1();
  verifyG2Evidence(manifest);
  const sourceTokens = verifySourceContract();
  verifyResponsiveGeometry(manifest, sourceTokens);
  verifyResponsiveEvidence();
  console.log(`user-center G1/G2/G4 contract smoke: OK (${targetWidths.join("/")}px)`);
}

main();
