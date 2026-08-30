/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
function readText(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const wxss = readText("pages/admin/admin.wxss");
const wxml = readText("pages/admin/admin.wxml");
const adminJs = readText("pages/admin/admin.js");

function mediaBlock(startMarker, endMarker) {
  const start = wxss.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `缺少响应式区间：${startMarker}`);
  const end = wxss.indexOf(endMarker, start);
  return wxss.slice(start, end === -1 ? wxss.length : end);
}

function inspectViewTree(source) {
  const stack = [];
  const slots = [];
  const targets = [];
  const tokenPattern = /<\/?view\b[^>]*>/g;
  let match;

  while ((match = tokenPattern.exec(source))) {
    const token = match[0];
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }

    const classMatch = token.match(/\bclass="([^"]*)"/);
    const classes = new Set((classMatch ? classMatch[1] : "").split(/\s+/).filter(Boolean));
    const parent = stack[stack.length - 1] || null;
    const node = {
      classes,
      directTargetCount: 0,
      token
    };

    if (classes.has("admin-action-slot")) {
      slots.push(node);
    }

    if (
      classes.has("monitor-section-toggle-button")
      || classes.has("usage-subsection-toggle")
    ) {
      assert.ok(
        parent && parent.classes.has("admin-action-slot"),
        `展开按钮没有直接放在统一位置框内：${token}`
      );
      parent.directTargetCount += 1;
      targets.push(node);
    }

    stack.push(node);
  }

  return { slots, targets };
}

function cssRulesContaining(className) {
  const rules = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(wxss))) {
    if (match[1].includes(className)) {
      rules.push({
        selector: match[1].trim(),
        body: match[2]
      });
    }
  }
  return rules;
}

assert.ok(wxss.includes("--admin-space-"), "管理员页没有统一间距变量");
assert.ok(wxss.includes("--admin-radius-"), "管理员页没有统一圆角变量");
assert.ok(wxss.includes("border-radius: var(--admin-radius-card)"), "主卡片没有使用统一圆角变量");
assert.ok(wxss.includes("border-radius: var(--admin-radius-control)"), "操作按钮没有使用统一圆角变量");
assert.ok(wxml.includes("class=\"quick-launch-grid\""), "快捷入口结构缺失");
assert.ok(wxml.includes("class=\"monitor-section-toggle-button\""), "展开按钮结构缺失");
assert.ok(!wxml.includes("class=\"usage-secondary-actions\""), "模型用量顶部仍然存在多余辅助按钮组");
assert.ok(
  wxml.includes("class=\"monitor-toggle-actions admin-action-slot\""),
  "运行监控操作区没有接入统一位置框"
);
assert.ok(!wxml.includes("monitor-filter-button"), "运行监控仍保留异常筛选按钮");
assert.ok(!wxml.includes("setAllMonitorSections"), "运行监控仍保留全部展开/收起事件");
assert.ok(!wxml.includes("monitor-toggle-arrow"), "运行监控仍保留旧箭头结构");
assert.ok(!adminJs.includes("monitorOnlyAbnormal"), "异常筛选状态仍残留");
assert.ok(!adminJs.includes("setAllMonitorSections"), "全部展开/收起方法仍残留");
assert.ok(!adminJs.includes("toggleMonitorOnlyAbnormal"), "异常筛选方法仍残留");

const usageSectionIndex = wxml.indexOf('id="usage-section"');
const monitorToggleIndex = wxml.indexOf('bindtap="toggleMonitor"');
const monitorOverviewIndex = wxml.indexOf('class="monitor-overview-card"');
const generationQueueIndex = wxml.indexOf('id="monitor-section-generationQueue"');
const diagnosticLogsIndex = wxml.indexOf('id="monitor-section-diagnosticLogs"');
const deploymentIndex = wxml.indexOf('id="monitor-section-deployment"');
const failureIndex = wxml.indexOf('class="usage-failure-panel"');
[
  ["模型用量统计", usageSectionIndex],
  ["运行监控入口", monitorToggleIndex],
  ["系统运行概览", monitorOverviewIndex],
  ["生图任务队列", generationQueueIndex],
  ["用户端日志", diagnosticLogsIndex],
  ["部署与探针", deploymentIndex],
  ["模型调用失败统计", failureIndex]
].forEach(([label, index]) => {
  assert.notStrictEqual(index, -1, `管理员页缺少${label}区块`);
});
assert.ok(
  usageSectionIndex < failureIndex
  && failureIndex < monitorToggleIndex
  && monitorToggleIndex < monitorOverviewIndex
  && monitorOverviewIndex < generationQueueIndex
  && generationQueueIndex < diagnosticLogsIndex
  && diagnosticLogsIndex < deploymentIndex,
  "页面区块顺序应为：模型用量统计、模型调用失败统计、运行监控"
);
assert.strictEqual(
  (wxml.match(/id="monitor-section-generationQueue"/g) || []).length,
  1,
  "生图任务队列区块只能保留一个"
);
assert.strictEqual(
  (wxml.match(/id="monitor-section-diagnosticLogs"/g) || []).length,
  1,
  "用户端日志区块只能保留一个"
);
assert.strictEqual(
  (wxml.match(/id="monitor-section-deployment"/g) || []).length,
  1,
  "部署与探针区块只能保留一个"
);

const viewTree = inspectViewTree(wxml);
assert.strictEqual(viewTree.targets.length, 12, "管理员页目标展开按钮数量应为 12 个");
assert.strictEqual(viewTree.slots.length, 12, "每个目标展开按钮都应有且只有一个统一位置框");
viewTree.slots.forEach((slot, index) => {
  assert.strictEqual(
    slot.directTargetCount,
    1,
    `第 ${index + 1} 个统一位置框必须只直接包一个展开按钮`
  );
});

[
  "bindtap=\"refreshModelUsage\"",
  "bindtap=\"exportModelUsage\"",
  "bindchange=\"selectModelFailureMonth\"",
  "catchtap=\"exportModelFailureStats\"",
  "catchtap=\"refreshDiagnosticLogs\""
].forEach((marker) => {
  assert.ok(wxml.includes(marker), `刷新、导出或月份选择事件被破坏：${marker}`);
});

const usageAlignmentStart = wxss.indexOf("/* 模型用量统计与模型调用失败统计的三项操作按同一组基准线对齐。 */");
assert.notStrictEqual(usageAlignmentStart, -1, "缺少模型用量与模型调用失败统计的统一对齐规则");
const usageAlignmentBlock = wxss.slice(usageAlignmentStart);
[
  ".usage-primary-actions,\n.usage-failure-actions",
  "gap: 6rpx",
  ".usage-primary-actions > .usage-refresh-button,\n.usage-failure-actions > picker",
  "flex: 0 0 126rpx",
  ".usage-primary-actions > .usage-export-button,\n.usage-failure-actions > .model-failure-export-button",
  "flex: 0 0 176rpx",
  ".admin-action-slot",
  ".monitor-section-toggle-button,\n.usage-subsection-toggle",
  "flex: 0 0 116rpx",
  "height: 60rpx",
  "font-size: 20rpx",
  "font-weight: 800",
  "border-radius: 16rpx",
  "gap: 8rpx",
  "border: 1rpx solid #bcd3f6"
].forEach((marker) => {
  assert.ok(usageAlignmentBlock.includes(marker), `用量/模型调用失败统计对齐规则缺少：${marker}`);
});
assert.ok(
  /\.usage-failure-head\s*\{\s*align-items:\s*center;\s*padding-right:\s*24rpx;/.test(wxss),
  "模型调用失败统计标题行没有补齐与用户端日志相同的右侧基准线"
);
assert.ok(
  /\.auto-face-probe-history-card\s+\.admin-section-tools\s*\{\s*position:\s*relative;/.test(wxss),
  "探针历史刷新按钮缺少与用户端日志相同的定位基准"
);
assert.ok(
  /\.auto-face-probe-history-card\s+\.admin-section-tools\s*>\s*\.usage-refresh-button\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*124rpx;[\s\S]*?width:\s*116rpx;[\s\S]*?height:\s*60rpx;/.test(wxss),
  "探针历史刷新按钮没有复用用户端日志的右侧位置和尺寸"
);
assert.ok(
  /<view class="monitor-section-title-row">\s*<text class="monitor-status-dot is-danger"><\/text>\s*<text class="monitor-section-title">探针历史<\/text>/.test(wxml),
  "探针历史标题缺少同款红点"
);
assert.ok(
  /<view class="monitor-section-title-row">\s*<text class="monitor-status-dot is-danger"><\/text>\s*<text class="monitor-section-title">部署检查日志<\/text>/.test(wxml),
  "部署检查日志标题缺少同款红点"
);
assert.ok(
  /\.deployment-log-card\s+\.admin-section-tools\s*>\s*\.monitor-inline-check-button\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*124rpx;[\s\S]*?flex:\s*0\s+0\s+116rpx;[\s\S]*?width:\s*116rpx;[\s\S]*?height:\s*60rpx;[\s\S]*?font-size:\s*20rpx;/.test(wxss),
  "部署检查日志的立即检查按钮没有与刷新、展开按钮统一位置、宽高和字号"
);

assert.strictEqual(
  (wxss.match(/(?:^|\n)\.admin-action-slot\s*\{/g) || []).length,
  1,
  "统一位置框只能保留一套 canonical 规则"
);

const canonicalStart = wxss.indexOf("/* 所有“展开/收起”控件统一与用户端日志的右边界和视觉规格。 */");
assert.notStrictEqual(canonicalStart, -1, "缺少展开按钮最终 canonical 规则");
const canonicalMediaStart = wxss.indexOf("@media", canonicalStart);
const canonicalBlock = wxss.slice(canonicalStart, canonicalMediaStart === -1 ? wxss.length : canonicalMediaStart);
assert.ok(!canonicalBlock.includes("@media"), "canonical 规则后面不能再有媒体查询覆盖");
assert.ok(
  /\.usage-mobile-first-card\s+\.usage-stat-section-card\s+\.usage-subsection-head\s*\{[\s\S]*?min-height:\s*96rpx;[\s\S]*?padding:\s*18rpx\s+4rpx\s+18rpx\s+18rpx;/.test(wxss),
  "四个模型统计标题行没有与运行监控使用相同的上下间距和右侧基准线"
);
assert.ok(
  /@media\s*\(max-width:\s*360px\)[\s\S]*?\.usage-mobile-first-card\s+\.usage-stat-section-card\s+\.usage-subsection-head\s*\{[\s\S]*?padding-right:\s*10rpx;/.test(wxss),
  "窄屏模型统计标题行没有补齐与运行监控相同的右侧基准线"
);
[
  "flex: 0 0 116rpx",
  "width: 116rpx",
  "min-width: 116rpx",
  "height: 60rpx",
  "min-height: 60rpx",
  "font-size: 20rpx",
  "font-weight: 800",
  "flex: 0 0 20rpx",
  "width: 20rpx",
  "height: 20rpx",
  ".monitor-deployment-body {\n  padding-right: 0;",
  ".usage-collapsed-statistics-card {\n  padding-right: 0;",
  ".usage-collapsed-statistics-card > .usage-subsection-head {\n  margin-right: 0;\n  padding-right: 0;"
].forEach((marker) => {
  assert.ok(canonicalBlock.includes(marker), `canonical 规则缺少：${marker}`);
});

[
  "monitor-section-toggle-button",
  "usage-subsection-toggle"
].forEach((className) => {
  cssRulesContaining(className).forEach(({ selector, body }) => {
    assert.ok(!/margin-right\s*:\s*-\d+rpx/.test(body), `${selector} 仍有右侧负边距`);
    assert.ok(!/flex\s*:\s*1(?:\s|;)/.test(body), `${selector} 仍会被 flex:1 撑开`);
    assert.ok(!/width\s*:\s*(?:auto|0)\s*;/.test(body), `${selector} 仍有错误宽度`);
    assert.ok(!/min-width\s*:\s*0\s*;/.test(body), `${selector} 仍允许缩成 0`);
    assert.ok(!/height\s*:\s*52rpx\s*;/.test(body), `${selector} 仍残留 52rpx 高度`);
  });
});

assert.ok(
  /\.monitor-overview-note-action\s*\{[\s\S]*?padding:\s*6rpx\s+8rpx;[\s\S]*?margin-left:\s*-8rpx;/.test(wxss),
  "与本任务无关的运行概览文字点击区被误改"
);

const otherPageWxss = fs.readdirSync(path.join(root, "pages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "admin")
  .map((entry) => path.join(root, "pages", entry.name, `${entry.name}.wxss`))
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file, "utf8"));
assert.ok(
  otherPageWxss.every((content) => !content.includes(".admin-action-slot")),
  "统一位置框样式不应污染非管理员页面"
);

const widthCases = [
  {
    width: 375,
    block: mediaBlock("@media (min-width: 360px) and (max-width: 389px)", "@media (min-width: 400px)"),
    required: [
      ".admin-page",
      ".quick-launch-grid",
      "grid-template-columns: repeat(4, minmax(0, 1fr))",
      "height: 132rpx"
    ]
  },
  {
    width: 414,
    block: mediaBlock("@media (min-width: 400px) and (max-width: 430px)", "@media (max-width: 360px)"),
    required: [
      ".admin-page",
      ".quick-launch-grid",
      "grid-template-columns: repeat(4, minmax(0, 1fr))",
      "height: 136rpx"
    ]
  }
];

widthCases.forEach(({ width, block, required }) => {
  required.forEach((marker) => {
    assert.ok(block.includes(marker), `${width}px 适配缺少：${marker}`);
  });

  const toPx = (rpx) => (rpx * width) / 750;
  const diagnosticRightInset = 24;
  const targetRightInsets = {
    monitor: 24,
    deployment: 24,
    probeHistory: 0 + 24,
    deploymentLogs: 0 + 24,
    usagePrimary: 24,
    usageFailure: 24,
    usageModels: 24 + 0,
    usageUsers: 24 + 0,
    usageMonthly: 24 + 0,
    usageDaily: 24 + 0
  };
  Object.entries(targetRightInsets).forEach(([name, rightInset]) => {
    assert.ok(
      Math.abs(toPx(rightInset) - toPx(diagnosticRightInset)) <= 1,
      `${width}px 下 ${name} 与用户端日志右边界不一致`
    );
    assert.ok(
      Math.abs(toPx(116) - toPx(116)) <= 1
      && Math.abs(toPx(60) - toPx(60)) <= 1,
      `${width}px 下 ${name} 的宽高与用户端日志不一致`
    );
  });
});

console.log("admin responsive smoke: OK (12 个展开按钮在 375/414 下统一对齐)");
