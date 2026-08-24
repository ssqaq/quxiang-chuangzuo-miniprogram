/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const manifestPath = path.join(__dirname, "database-indexes.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

assert.strictEqual(manifest.version, 1);
assert.ok(Array.isArray(manifest.indexes));
assert.strictEqual(manifest.indexes.length, 11);

const identities = new Set();

manifest.indexes.forEach((index) => {
  assert.ok(index.collection);
  assert.ok(index.name);
  assert.ok(Array.isArray(index.keys));
  assert.ok(index.keys.length > 0);
  assert.strictEqual(index.unique, false);
  assert.ok(index.reason);

  const identity = `${index.collection}\u0000${index.name}`;
  assert.strictEqual(identities.has(identity), false);
  identities.add(identity);

  index.keys.forEach((key) => {
    assert.ok(key.name);
    assert.ok(key.direction === 1 || key.direction === -1);
  });
});

console.log("database index manifest smoke: OK");
