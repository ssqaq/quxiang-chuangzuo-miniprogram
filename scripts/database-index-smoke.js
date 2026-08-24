/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const manifestPath = path.join(__dirname, "database-indexes.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function assertNonBlankString(value, label) {
  assert.strictEqual(typeof value, "string", `${label} 必须是字符串`);
  assert.notStrictEqual(value.trim(), "", `${label} trim 后不能为空`);
}

assert.strictEqual(manifest.version, 1, "manifest.version 必须为 1");
assert.ok(Array.isArray(manifest.indexes), "manifest.indexes 必须是数组");
assert.strictEqual(manifest.indexes.length, 11, "manifest.indexes.length 必须为 11");

const identities = new Set();

manifest.indexes.forEach((index, indexPosition) => {
  const indexPath = `indexes[${indexPosition}]`;

  assert.ok(
    index && typeof index === "object" && !Array.isArray(index),
    `${indexPath} 必须是对象`
  );
  assertNonBlankString(index.collection, `${indexPath}.collection`);
  assertNonBlankString(index.name, `${indexPath}.name`);
  assert.ok(Array.isArray(index.keys), `${indexPath}.keys 必须是数组`);
  assert.ok(index.keys.length > 0, `${indexPath}.keys 不能为空`);
  assert.strictEqual(index.unique, false, `${indexPath}.unique 必须为 false`);
  assertNonBlankString(index.reason, `${indexPath}.reason`);

  const identity = `${index.collection}\u0000${index.name}`;
  assert.strictEqual(
    identities.has(identity),
    false,
    `${indexPath} 的 collection + name 不能重复`
  );
  identities.add(identity);

  const keyNames = new Set();

  index.keys.forEach((key, keyPosition) => {
    const keyPath = `${indexPath}.keys[${keyPosition}]`;

    assert.ok(
      key && typeof key === "object" && !Array.isArray(key),
      `${keyPath} 必须是对象`
    );
    assertNonBlankString(key.name, `${keyPath}.name`);
    assert.strictEqual(
      keyNames.has(key.name),
      false,
      `${keyPath}.name 不能与同一索引中的其他字段重复`
    );
    keyNames.add(key.name);
    assert.ok(
      key.direction === 1 || key.direction === -1,
      `${keyPath}.direction 必须为 1 或 -1`
    );
  });
});

console.log("database index manifest smoke: OK");
