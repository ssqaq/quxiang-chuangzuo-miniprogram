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
assert.ok(
  (wxml.match(/class="media-button-label"/g) || []).length >= 7,
  "所有操作按钮都必须使用内层文字节点"
);
assert.match(wxml, /copy-button[\s\S]*media-button-label/);
assert.match(wxml, /copywriting-title-action[\s\S]*media-button-label/);
assert.match(wxml, /save-button[\s\S]*media-button-label/);
assert.match(wxml, /reset-button[\s\S]*media-button-label/);
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
assert.match(copyControl[1], /line-height:\s*1/);

const copyActions = wxss.match(/\.copywriting-action\s*\{([^}]*)\}/);
assert.ok(copyActions, "正文和标签复制按钮必须使用统一文字规格");
assert.match(copyActions[1], /display:\s*flex/);
assert.match(copyActions[1], /align-items:\s*center/);
assert.match(copyActions[1], /justify-content:\s*center/);
assert.match(copyActions[1], /font-size:\s*20rpx/);
assert.match(copyActions[1], /line-height:\s*1/);

const titleHead = wxss.match(/\.copywriting-title-head\s*\{([^}]*)\}/);
assert.ok(titleHead);
assert.match(titleHead[1], /min-height:\s*60rpx/);

const titleLabel = wxss.match(
  /\.copywriting-title-head\s+\.copywriting-label\s*\{([^}]*)\}/
);
assert.ok(titleLabel, "标题标签必须有独立字号规则");
assert.match(titleLabel[1], /font-size:\s*24rpx/);

assert.match(wxss, /\.copywriting-head\s*\{[\s\S]*width:\s*100%/);
assert.match(wxss, /\.copywriting-section-head\s*\{[\s\S]*width:\s*100%/);

const actionSlot = wxss.match(/\.copywriting-head-action\s*\{([^}]*)\}/);
assert.ok(actionSlot, "两个复制按钮必须共用右侧操作列");
assert.match(actionSlot[1], /flex:\s*0 0 58%/);
assert.match(actionSlot[1], /width:\s*58%/);
assert.match(actionSlot[1], /height:\s*60rpx/);
assert.match(actionSlot[1], /margin-left:\s*auto/);
assert.match(actionSlot[1], /flex-shrink:\s*0/);
assert.match(
  wxss,
  /\.copywriting-head-action\s*>\s*\.copy-button,[\s\S]*\.copywriting-head-action\s*>\s*\.copywriting-title-action/
);

const actionControls = wxss.match(
  /\.save-button,\s*\.reset-button\s*\{([^}]*)\}/
);
assert.ok(actionControls, "保存和重解析按钮必须共用居中规则");
assert.match(actionControls[1], /display:\s*flex/);
assert.match(actionControls[1], /align-items:\s*center/);
assert.match(actionControls[1], /justify-content:\s*center/);
assert.match(actionControls[1], /line-height:\s*1/);
assert.match(actionControls[1], /font-size:\s*26rpx/);

const finalActionOverride = wxss.match(
  /\.media-parser-page \.save-button,\s*\.media-parser-page \.reset-button\s*\{([^}]*)\}/
);
assert.ok(finalActionOverride, "底部按钮必须有页面级最终覆盖");
assert.ok(
  wxss.indexOf(".secondary-btn") < wxss.indexOf(".media-parser-page .save-button"),
  "底部按钮最终覆盖必须位于 secondary-btn 之后"
);
assert.match(finalActionOverride[1], /line-height:\s*1/);
assert.match(finalActionOverride[1], /font-size:\s*26rpx/);

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

console.log("watermark copywriting layout smoke: OK");
