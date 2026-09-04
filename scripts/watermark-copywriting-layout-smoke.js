const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const wxml = fs.readFileSync(
  path.join(root, "pages/watermark-remover/watermark-remover.wxml"),
  "utf8"
);
const wxss = fs.readFileSync(
  path.join(root, "pages/watermark-remover/watermark-remover.wxss"),
  "utf8"
);
const pageJs = fs.readFileSync(
  path.join(root, "pages/watermark-remover/watermark-remover.js"),
  "utf8"
);

assert.ok(wxml.includes("copywriting-section-head copywriting-title-head"));
assert.ok(wxml.includes("copywriting-head-action"));
assert.ok(wxml.includes("copywriting-action copywriting-title-action"));
assert.ok(wxml.includes("saveFeedbackTone === 'partial'"));
assert.ok(wxml.includes("saveFeedbackTone === 'error'"));
assert.ok(wxml.includes("saveFeedbackTone === 'success'"));
assert.ok(
  wxml.includes('class="secondary-btn reset-button" bindtap="resetResult" disabled="{{saving}}"')
);

const copyControl = wxss.match(
  /\.copy-button,\s*\.copywriting-title-action\s*\{([^}]*)\}/
);
assert.ok(copyControl, "复制文案和复制标题必须共用布局规则");
assert.match(copyControl[1], /display:\s*flex/);
assert.match(copyControl[1], /align-items:\s*center/);
assert.match(copyControl[1], /justify-content:\s*center/);
assert.match(copyControl[1], /width:\s*100%/);
assert.match(copyControl[1], /min-width:\s*0/);
assert.match(copyControl[1], /height:\s*60rpx/);
assert.match(copyControl[1], /font-size:\s*20rpx/);
assert.match(copyControl[1], /line-height:\s*normal/);

const copyActions = wxss.match(/\.copywriting-action\s*\{([^}]*)\}/);
assert.ok(copyActions, "正文和标签复制按钮必须使用统一文字规格");
assert.match(copyActions[1], /display:\s*flex/);
assert.match(copyActions[1], /align-items:\s*center/);
assert.match(copyActions[1], /justify-content:\s*center/);
assert.match(copyActions[1], /font-size:\s*20rpx/);
assert.match(copyActions[1], /line-height:\s*normal/);

const titleHead = wxss.match(/\.copywriting-title-head\s*\{([^}]*)\}/);
assert.ok(titleHead);
assert.match(titleHead[1], /min-height:\s*60rpx/);

const actionSlot = wxss.match(/\.copywriting-head-action\s*\{([^}]*)\}/);
assert.ok(actionSlot, "两个复制按钮必须共用右侧操作列");
assert.match(actionSlot[1], /flex:\s*0 0 58%/);
assert.match(actionSlot[1], /width:\s*58%/);

const actionControls = wxss.match(
  /\.save-button,\s*\.reset-button\s*\{([^}]*)\}/
);
assert.ok(actionControls, "保存和重解析按钮必须共用居中规则");
assert.match(actionControls[1], /display:\s*flex/);
assert.match(actionControls[1], /align-items:\s*center/);
assert.match(actionControls[1], /justify-content:\s*center/);
assert.match(actionControls[1], /line-height:\s*normal/);
assert.match(actionControls[1], /font-size:\s*26rpx/);

const finalActionOverride = wxss.match(
  /\.media-parser-page \.save-button,\s*\.media-parser-page \.reset-button\s*\{([^}]*)\}/
);
assert.ok(finalActionOverride, "底部按钮必须有页面级最终覆盖");
assert.ok(
  wxss.indexOf(".secondary-btn") < wxss.indexOf(".media-parser-page .save-button"),
  "底部按钮最终覆盖必须位于 secondary-btn 之后"
);
assert.match(finalActionOverride[1], /line-height:\s*normal/);
assert.match(finalActionOverride[1], /font-size:\s*26rpx/);

assert.match(wxss, /--media-button-primary-bg:\s*#2d7ff2/);
assert.match(wxss, /--media-button-secondary-bg:\s*#f2f6fb/);
assert.match(wxss, /--media-button-copy-bg:\s*#e9f3ff/);
assert.match(wxss, /--media-button-copy-success-bg:\s*#dff6e9/);
assert.match(wxss, /--media-button-success-bg:\s*#16835a/);
assert.match(wxss, /color:\s*var\(--media-button-primary-color\)/);
assert.match(wxss, /background:\s*var\(--media-button-primary-bg\)/);
assert.match(wxss, /color:\s*var\(--media-button-secondary-color\)/);
assert.match(wxss, /background:\s*var\(--media-button-secondary-bg\)/);
assert.match(wxss, /color:\s*var\(--media-button-copy-color\)/);
assert.match(wxss, /background:\s*var\(--media-button-copy-bg\)/);
assert.match(wxss, /\.save-button\.save-feedback-active\s*\{/);
assert.match(wxss, /\.save-button\.save-feedback-partial\s*\{/);
assert.match(wxss, /\.save-button\.save-feedback-error\s*\{/);
assert.match(pageJs, /showSaveFeedback\("已保存"\)/);
assert.match(pageJs, /showSaveFeedback\("部分保存",\s*"partial"\)/);
assert.match(pageJs, /showSaveFeedback\("保存失败",\s*"error"\)/);
assert.match(pageJs, /showSaveFeedback\("无可保存媒体",\s*"error"\)/);
assert.match(pageJs, /beginSaveOperation\(\)/);
assert.match(pageJs, /invalidateSaveOperation\(\)/);
assert.match(pageJs, /isSaveOperationCurrent\(saveToken\)/);
assert.match(pageJs, /fail:\s*\(\)\s*=>\s*\{/);
assert.match(pageJs, /this\.clearCopyFeedbackTimer\(\);\s*this\.setData\(\{ copiedTarget: "" \}\)/);
assert.match(pageJs, /clearSaveFeedbackTimer\(\)/);
assert.match(pageJs, /saveFeedbackTimer\s*=\s*setTimeout/);
assert.ok(
  pageJs.includes("saveFeedback: \"\"")
  && pageJs.includes("saveFeedbackTone: \"\"")
);

assert.ok(
  wxss.includes(".copywriting-kicker")
  && wxss.includes(".copywriting-title")
  && wxss.includes(".copywriting-label")
);
assert.ok(!wxss.includes(".copywriting-kicker {\n  font-size: 18rpx"));
assert.ok(!wxss.includes(".copywriting-title {\n  margin-top: 3rpx;\n  font-size: 24rpx"));

console.log("watermark copywriting layout smoke: OK");
