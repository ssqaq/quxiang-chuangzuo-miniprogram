const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";

const {
  appendWebPosePromptBlock,
  buildWebPosePromptBlock,
  normalizeWebPoseSuggestions
} = require("../utils/web-pose");
const cloudApi = require("../cloudfunctions/api/index");

function createSuggestions() {
  const categories = ["侧身", "回头", "手部", "肩颈", "坐姿", "全身", "其他", "其他"];
  return Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    title: `姿势建议${index + 1}`,
    description: `这是第${index + 1}条具体姿势说明，包含身体朝向、肩颈、眼神和手部动作。`,
    category: categories[index],
    tags: ["自然", categories[index]],
    unsuitableReason: ""
  }));
}

const source = createSuggestions();
const normalized = normalizeWebPoseSuggestions(source);
assert.strictEqual(normalized.length, 8);
assert.strictEqual(normalized[0].id, 1);
assert.strictEqual(normalized[7].id, 8);

const cloudNormalized = cloudApi.__test.normalizeWebPoseSuggestions({ poses: source });
assert.strictEqual(cloudNormalized.length, 8);
assert.strictEqual(cloudNormalized[0].direction, "自然");

const aliasSource = source.map((item) => ({
  index: item.id,
  name: item.title,
  text: item.description,
  type: item.category,
  keywords: item.tags,
  reason: item.unsuitableReason
}));
const aliasNormalized = cloudApi.__test.normalizeWebPoseSuggestions({
  data: { suggestions: aliasSource }
});
assert.strictEqual(aliasNormalized.length, 8);
assert.strictEqual(aliasNormalized[0].id, 1);
assert.strictEqual(aliasNormalized[0].title, source[0].title);

const positionalSource = aliasSource.map((item) => {
  const copy = Object.assign({}, item);
  delete copy.index;
  return copy;
});
const positionalNormalized = cloudApi.__test.normalizeWebPoseSuggestions({
  suggestions: positionalSource
});
assert.strictEqual(positionalNormalized.length, 8);
assert.deepStrictEqual(
  positionalNormalized.map((item) => item.id),
  [1, 2, 3, 4, 5, 6, 7, 8]
);

assert.deepStrictEqual(normalizeWebPoseSuggestions(source.slice(0, 7)), []);
assert.strictEqual(cloudApi.__test.normalizeWebPoseSuggestions({ poses: source.slice(0, 7) }), null);

const duplicated = createSuggestions();
duplicated[7].id = 1;
assert.deepStrictEqual(normalizeWebPoseSuggestions(duplicated), []);
assert.strictEqual(cloudApi.__test.normalizeWebPoseSuggestions({ poses: duplicated }), null);

const invalid = createSuggestions();
invalid[2].description = "";
assert.deepStrictEqual(normalizeWebPoseSuggestions(invalid), []);
assert.strictEqual(cloudApi.__test.normalizeWebPoseSuggestions({ poses: invalid }), null);

const basePrompt = "这是用户手工提示词。";
const block = buildWebPosePromptBlock(normalized[0]);
assert.ok(block.includes("【网感姿势授权开始】"));
assert.ok(block.includes(normalized[0].title));
const appended = appendWebPosePromptBlock(basePrompt, normalized[0]);
assert.ok(appended.startsWith(basePrompt));
assert.strictEqual((appended.match(/【网感姿势授权开始】/g) || []).length, 1);
assert.strictEqual(
  (appendWebPosePromptBlock(appended, normalized[0]).match(/【网感姿势授权开始】/g) || []).length,
  1
);
assert.strictEqual(basePrompt, "这是用户手工提示词。");

console.log("web pose smoke: OK");
console.log(JSON.stringify({
  suggestions: normalized.length,
  promptBytes: Buffer.byteLength(appended),
  duplicateBlocked: true,
  invalidBlocked: true
}));
