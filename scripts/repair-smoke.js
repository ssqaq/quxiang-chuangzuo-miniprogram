const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";

const {
  createIssueOptions,
  createSelectableIssueOptions,
  normalizeIssueKeys,
  canRepairRecord,
  buildRepairPrompt
} = require("../utils/repair");
const api = require("../cloudfunctions/api/index.js");

async function main() {
  const noWardrobe = createIssueOptions(false);
  const noWardrobeKeys = noWardrobe
    .reduce((all, group) => all.concat(group.items.map((item) => item.key)), []);
  assert.ok(noWardrobeKeys.includes("outsideChanged"));
  assert.ok(!noWardrobeKeys.includes("garment"));
  assert.ok(!noWardrobeKeys.includes("accessories"));
  assert.ok(!noWardrobeKeys.includes("穿模"));

  const normalized = normalizeIssueKeys(["identity"], false);
  assert.deepStrictEqual(normalized, ["outsideChanged", "identity"]);
  const selectable = createSelectableIssueOptions(false, ["identity"]);
  const identityItem = selectable
    .flatMap((group) => group.items)
    .find((item) => item.key === "identity");
  const outsideItem = selectable
    .flatMap((group) => group.items)
    .find((item) => item.key === "outsideChanged");
  assert.strictEqual(identityItem.checked, true);
  assert.strictEqual(outsideItem.checked, true);
  assert.strictEqual(
    canRepairRecord({ id: "local-1", fileID: "cloud://local" }, true),
    false
  );
  assert.strictEqual(
    canRepairRecord({ id: "record-1", fileID: "cloud://result", revisionNumber: 9 }, true),
    true
  );
  assert.strictEqual(
    canRepairRecord({ id: "record-1", fileID: "cloud://result", revisionNumber: 10 }, true),
    false
  );

  const prompt = buildRepairPrompt({
    projectName: "smoke",
    issues: ["identity"],
    hasFaceReferences: true,
    hasWardrobeReferences: false,
    maskGeometry: { x: 100, y: 80, width: 120, height: 140 }
  });
  assert.ok(prompt.includes("红圈外内容被改动"));
  assert.ok(prompt.includes("身份"));
  assert.ok(prompt.includes("x=100"));

  await assert.rejects(
    () => api.__test.requestImageEdits(
      { mainFileID: "main-only" },
      "test-key",
      "repair-missing-mask"
    ),
    /主图和 mask/
  );
  assert.strictEqual(
    api.__test.assetPathMatches(
      "cloud://env/assets/user/mask/demo.png",
      "assets/user/mask/demo.png"
    ),
    true
  );
  assert.strictEqual(
    api.__test.normalizeAssetKind("wardrobe"),
    "wardrobe"
  );
  console.log("repair smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
