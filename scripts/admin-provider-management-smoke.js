/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const adminJs = fs.readFileSync(path.join(root, "pages", "admin", "admin.js"), "utf8");
const adminWxml = fs.readFileSync(path.join(root, "pages", "admin", "admin.wxml"), "utf8");
const adminWxss = fs.readFileSync(path.join(root, "pages", "admin", "admin.wxss"), "utf8");

[
  "mergeAdminProviderLabels",
  "setActiveAdminProviderLabels",
  "providerIdFromDisplay",
  "adminProviderIdsFromForm",
  "adminProviderSortLabel",
  "sortAdminProviderIds",
  "buildAdminProviderLabelRows",
  "validateAdminProviderLabelRows",
  "buildAdminProviderFilterState",
  "filterAdminModelProbeResults",
  "buildAdminProviderManagementState"
].forEach((functionName) => {
  assert.ok(
    adminJs.includes(`function ${functionName}`),
    `管理员页面缺少 ${functionName}`
  );
});

assert.ok(
  adminJs.includes('providers: "服务商中文名称"')
    && adminJs.includes("providerLabelRows:")
    && adminJs.includes("providerLabelErrors:")
    && adminJs.includes("providerFilterOptions:")
    && adminJs.includes("providerFilterValue:")
    && adminJs.includes("providerFilterIndex:")
    && adminJs.includes("providerSectionVisibility:"),
  "管理员页面没有完整声明服务商中文名和筛选状态"
);

assert.ok(
  adminJs.includes("onProviderLabelInput(event)")
    && adminJs.includes("onProviderFilterChange(event)")
    && adminJs.includes("ADMIN_BUILT_IN_PROVIDER_ORDER")
    && adminJs.includes("providerFilterValue: storedProviderFilterValue")
    && adminJs.includes("providerFilterValue: String(this.data.providerFilterValue")
    && adminJs.includes("ADMIN_PROVIDER_LABEL_REQUIRED")
    && adminJs.includes("还没有中文名称，请先填写")
    && adminJs.includes("providerLabels: providerLabelsFromForm(form)"),
  "服务商中文名编辑、筛选或保存前校验没有接入"
);

assert.ok(
  adminJs.includes("providerId: providerIdFromDisplay(item.provider)")
    && adminJs.includes("filteredResults")
    && adminWxml.includes('wx:for="{{modelProbes.filteredResults}}"'),
  "模型探测结果没有保留英文服务商标识或接入筛选"
);

assert.ok(
  adminWxml.includes('class="provider-filter-panel"')
    && adminWxml.includes('bindchange="onProviderFilterChange"')
    && adminWxml.includes('class="quick-launch quick-providers')
    && adminWxml.includes('data-section="providers"')
    && adminWxml.includes("activeConfigSection === 'providers'")
    && adminWxml.includes("下次打开会保留这次选择")
    && adminWxml.includes('wx:for="{{providerLabelRows}}"')
    && adminWxml.includes('bindinput="onProviderLabelInput"')
    && adminWxml.includes('data-provider-id="{{item.providerId}}"'),
  "服务商筛选器、快捷入口或中文名编辑表单缺失"
);

["face", "analysis", "image", "video"].forEach((section) => {
  assert.ok(
    adminWxml.includes(`wx:if="{{providerSectionVisibility.${section}}}"`),
    `${section} 模型配置没有按服务商控制显示`
  );
});

[
  ".provider-filter-panel {",
  ".provider-filter-picker {",
  ".provider-label-list {",
  ".provider-label-row {",
  ".provider-label-id {",
  ".provider-label-input {",
  ".quick-providers .quick-launch-icon {"
].forEach((selector) => {
  assert.ok(adminWxss.includes(selector), `管理员页面缺少样式 ${selector}`);
});

console.log("admin provider management smoke: OK (中文名可改、配置可筛选、保存前会拦截漏填)");
