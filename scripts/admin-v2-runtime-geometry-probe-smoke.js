/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const probe = require("./admin-v2-runtime-geometry-probe");

const providerRects = {
  ".phone-screen": { left: 0, right: 390, width: 390, top: 0, bottom: 844, height: 844 },
  ".provider-layout": { left: 23, right: 367, width: 344, top: 193.25, bottom: 864, height: 670.75 },
  ".app-content": { left: 0, right: 390, width: 390, top: 96, bottom: 903, height: 807 },
  ".field-label": { left: 166, right: 348, width: 182, top: 256, bottom: 267, height: 11 },
  ".provider-card": { left: 12, right: 378, width: 366, top: 108, bottom: 875, height: 767 },
  ".directory": { left: 23, right: 149, width: 126, top: 193.25, bottom: 864, height: 670.75 },
  ".provider-list": { left: 31, right: 141, width: 110, top: 294.25, bottom: 856, height: 561.75 },
  ".editor": { left: 157, right: 367, width: 210, top: 193.25, bottom: 864, height: 670.75 },
  ".editor-note": { left: 157, right: 367, width: 210, top: 748.75, bottom: 814, height: 65.25 },
  ".provider-actions": { left: 157, right: 367, width: 210, top: 822, bottom: 864, height: 42 },
  "#endpointInput": { left: 166, right: 358, width: 192, top: 375.3125, bottom: 402.3125, height: 27, computed: { textAlign: "left" } },
  "#keyInput": { left: 166, right: 358, width: 192, top: 436.75, bottom: 463.75, height: 27, computed: { textAlign: "left" } },
};

const providerScroll = {
  scrollHeight: 704,
  clientHeight: 562,
  topScrollTop: 0,
  bottomScrollTop: 142,
  topFirstRowTop: 294.25,
  bottomLastRowBottom: 856,
};

function makeInput() {
  return {
    schemaVersion: 1,
    fixtureId: probe.EXPECTED_FIXTURE_ID,
    fontProfile: probe.EXPECTED_FONT_PROFILE,
    viewport: probe.EXPECTED_VIEWPORT,
    pages: probe.PAGE_NAMES.map(name => ({
      name,
      viewport: { width: 390, height: 844, dpr: 3, scrollWidth: 390, scrollHeight: 1600 },
      elements: probe.REQUIRED_SELECTORS[name].map(selector => ({
        selector,
        rect: name === "provider" && providerRects[selector]
          ? { ...providerRects[selector] }
          : { left: 8, right: 382, width: 374, height: 30, top: 10, bottom: 40 },
        ...(name === "provider" && selector === ".provider-list" ? { scroll: { ...providerScroll } } : {}),
      })),
    })),
  };
}

function providerPage(input) {
  return input.pages.find(page => page.name === "provider");
}

function providerElement(input, selector) {
  return providerPage(input).elements.find(element => element.selector === selector);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-runtime-geometry-"));
try {
  const input = makeInput();
  fs.writeFileSync(path.join(root, "input.json"), JSON.stringify(input), "utf8");
  const pass = probe.run({ root, input: "input.json", output: "report.json" });
  assert.strictEqual(pass.ok, true);
  const providerPass = pass.pages.find(page => page.name === "provider");
  assert.deepStrictEqual(providerPass.blankSpace.metrics, {
    noteToActions: 8,
    actionsToCardBottom: 11,
    listToDirectoryBottom: 8,
    columnHeightDelta: 0,
  });
  assert.deepStrictEqual(providerPass.inputAlignment, {
    pass: true,
    leftDelta: 0,
    textAlign: { endpoint: "left", key: "left" },
    errors: [],
  });
  assert.deepStrictEqual(providerPass.directoryScroll, {
    pass: true,
    metrics: { scrollHeight: 704, clientHeight: 562, maxScrollTop: 142, topScrollTop: 0, bottomScrollTop: 142 },
    errors: [],
  });

  const blankSpaceFailures = [
    [".provider-actions", { top: 831 }, /noteToActions=17px/],
    [".provider-card", { bottom: 881 }, /actionsToCardBottom=17px/],
    [".provider-list", { bottom: 847 }, /listToDirectoryBottom=17px/],
    [".editor", { height: 667.75 }, /columnHeightDelta=3px/],
    [".provider-actions", { top: 812 }, /noteToActions=-2px.*重叠/],
  ];
  blankSpaceFailures.forEach(([selector, change, expected], index) => {
    const badInput = makeInput();
    Object.assign(providerElement(badInput, selector).rect, change);
    fs.writeFileSync(path.join(root, `blank-${index}.json`), JSON.stringify(badInput), "utf8");
    const badReport = probe.run({ root, input: `blank-${index}.json`, output: false });
    assert.strictEqual(badReport.ok, false);
    assert.match(badReport.errors.join(";"), expected);
  });

  const misaligned = makeInput();
  Object.assign(providerElement(misaligned, "#keyInput").rect, { left: 179 });
  fs.writeFileSync(path.join(root, "misaligned.json"), JSON.stringify(misaligned), "utf8");
  const misalignedReport = probe.run({ root, input: "misaligned.json", output: false });
  assert.strictEqual(misalignedReport.ok, false);
  assert.match(misalignedReport.errors.join(";"), /左边界差 13px|text-align/);

  const missingInput = makeInput();
  providerPage(missingInput).elements = providerPage(missingInput).elements.filter(element => element.selector !== "#keyInput");
  fs.writeFileSync(path.join(root, "missing-input.json"), JSON.stringify(missingInput), "utf8");
  const missingInputReport = probe.run({ root, input: "missing-input.json", output: false });
  assert.strictEqual(missingInputReport.ok, false);
  assert.match(missingInputReport.errors.join(";"), /#keyInput.*未采集|左边界/);

  const badScroll = makeInput();
  providerElement(badScroll, ".provider-list").scroll.bottomScrollTop = 0;
  fs.writeFileSync(path.join(root, "bad-scroll.json"), JSON.stringify(badScroll), "utf8");
  const badScrollReport = probe.run({ root, input: "bad-scroll.json", output: false });
  assert.strictEqual(badScrollReport.ok, false);
  assert.match(badScrollReport.errors.join(";"), /末端 scrollTop/);

  const missing = makeInput();
  providerPage(missing).elements = providerPage(missing).elements.filter(element => element.selector !== ".provider-actions");
  fs.writeFileSync(path.join(root, "missing.json"), JSON.stringify(missing), "utf8");
  const missingReport = probe.run({ root, input: "missing.json", output: false });
  assert.strictEqual(missingReport.ok, false);
  assert.match(missingReport.errors.join(";"), /provider-actions.*未采集|provider-actions.*缺少/);

  input.pages[0].viewport.scrollWidth = 391;
  fs.writeFileSync(path.join(root, "bad.json"), JSON.stringify(input), "utf8");
  const fail = probe.run({ root, input: "bad.json", output: false });
  assert.strictEqual(fail.ok, false);
  assert.match(fail.errors.join(";"), /横向滚动宽度异常/);
  console.log("admin-v2-runtime-geometry-probe-smoke: PASS (viewport/overflow/blank-space thresholds/missing/overlap)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
