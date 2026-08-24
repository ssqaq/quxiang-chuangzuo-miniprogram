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

const core = require("./database-index-core");

function managerIndex(name, keys, unique = false) {
  return {
    Name: name,
    Keys: keys.map((item) => ({
      Name: item.name,
      Direction: String(item.direction)
    })),
    Unique: unique
  };
}

async function inspectOne(spec, responseOrError) {
  return core.inspectDatabaseIndexes([spec], async () => {
    if (responseOrError instanceof Error) {
      throw responseOrError;
    }
    return responseOrError;
  });
}

async function runCoreTests() {
  const baseSpec = {
    collection: "smoke_records",
    name: "idx_user_created_at",
    keys: [
      { name: "userId", direction: 1 },
      { name: "createdAt", direction: -1 }
    ],
    unique: false,
    reason: "smoke"
  };

  assert.deepStrictEqual(
    core.normalizeKeys([
      { Name: "createdAt", Direction: "-1" },
      { name: "userId", direction: -1 },
      { name: "fallback", direction: "descending" }
    ]),
    [
      { name: "createdAt", direction: -1 },
      { name: "userId", direction: -1 },
      { name: "fallback", direction: 1 }
    ]
  );
  assert.deepStrictEqual(
    core.normalizeKeys({ userId: 1, createdAt: "-1" }),
    [
      { name: "userId", direction: 1 },
      { name: "createdAt", direction: -1 }
    ]
  );
  assert.deepStrictEqual(
    core.normalizeIndex({
      IndexName: "idx_normalized",
      keys: { userId: 1 },
      unique: "false"
    }),
    {
      name: "idx_normalized",
      keys: [{ name: "userId", direction: 1 }],
      unique: false
    }
  );
  assert.strictEqual(
    core.normalizeIndex({ name: "idx_unique", keys: {}, unique: "1" }).unique,
    true
  );

  const responseVariants = [
    { Indexes: [managerIndex("idx_response", baseSpec.keys)] },
    { indexes: [managerIndex("idx_response", baseSpec.keys)] },
    { Data: { Indexes: [managerIndex("idx_response", baseSpec.keys)] } },
    { data: { indexes: [managerIndex("idx_response", baseSpec.keys)] } }
  ];
  responseVariants.forEach((response) => {
    assert.strictEqual(core.responseIndexes(response)[0].name, "idx_response");
  });

  const existing = await inspectOne(baseSpec, {
    Indexes: [managerIndex(baseSpec.name, baseSpec.keys)]
  });
  assert.strictEqual(existing.results[0].status, "existing");
  assert.strictEqual(existing.summary.existing, 1);

  const equivalent = await inspectOne(baseSpec, {
    Indexes: [managerIndex("idx_legacy_equivalent", baseSpec.keys)]
  });
  assert.strictEqual(equivalent.results[0].status, "equivalent");
  assert.strictEqual(equivalent.extras.length, 0);

  const missing = await inspectOne(baseSpec, { Indexes: [] });
  assert.strictEqual(missing.results[0].status, "missing");
  assert.strictEqual(missing.summary.missing, 1);

  const directionMismatch = await inspectOne(baseSpec, {
    Indexes: [
      managerIndex(baseSpec.name, [
        { name: "userId", direction: 1 },
        { name: "createdAt", direction: 1 }
      ])
    ]
  });
  assert.strictEqual(directionMismatch.results[0].status, "mismatched");

  const orderMismatch = await inspectOne(baseSpec, {
    Indexes: [
      managerIndex(baseSpec.name, [
        { name: "createdAt", direction: -1 },
        { name: "userId", direction: 1 }
      ])
    ]
  });
  assert.strictEqual(orderMismatch.results[0].status, "mismatched");

  const stringFalseExisting = await inspectOne(baseSpec, {
    Indexes: [managerIndex(baseSpec.name, baseSpec.keys, "false")]
  });
  assert.strictEqual(stringFalseExisting.results[0].status, "existing");

  const uniqueMismatch = await inspectOne(
    { ...baseSpec, unique: true },
    { Indexes: [managerIndex(baseSpec.name, baseSpec.keys, "false")] }
  );
  assert.strictEqual(uniqueMismatch.results[0].status, "mismatched");

  const collectionMissingError = new Error("collection smoke_records not exist");
  collectionMissingError.code = "ResourceNotFound.Collection";
  const collectionMissing = await inspectOne(baseSpec, collectionMissingError);
  assert.strictEqual(collectionMissing.results[0].status, "collection-missing");
  assert.strictEqual(collectionMissing.summary.collectionMissing, 1);
  assert.strictEqual(collectionMissing.ok, false);

  const secretNames = [
    "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY",
    "TENCENTCLOUD_SESSION_TOKEN"
  ];
  const originalSecrets = {};
  secretNames.forEach((name) => {
    originalSecrets[name] = process.env[name];
  });
  try {
    process.env.TENCENTCLOUD_SECRET_ID = "smoke-secret-id";
    process.env.TENCENTCLOUD_SECRET_KEY = "smoke-secret-key";
    process.env.TENCENTCLOUD_SESSION_TOKEN = "smoke-session-token";

    const sdkError = new Error(
      "failed smoke-secret-id smoke-secret-key smoke-session-token"
    );
    sdkError.code = "InternalError";
    sdkError.requestId = "must-not-leak";
    const failed = await inspectOne(baseSpec, sdkError);
    assert.strictEqual(failed.results[0].status, "check-failed");
    assert.strictEqual(failed.summary.failed, 1);
    assert.deepStrictEqual(failed.results[0].error, {
      code: "InternalError",
      message: "failed [REDACTED] [REDACTED] [REDACTED]"
    });
  } finally {
    secretNames.forEach((name) => {
      if (originalSecrets[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalSecrets[name];
      }
    });
  }

  const withExtras = await inspectOne(baseSpec, {
    Indexes: [
      managerIndex(baseSpec.name, baseSpec.keys),
      managerIndex("idx_extra", [{ name: "status", direction: 1 }]),
      managerIndex("_id_", [{ name: "_id", direction: 1 }], true),
      managerIndex("_id", [{ name: "_id", direction: 1 }], true)
    ]
  });
  assert.strictEqual(withExtras.extras.length, 1);
  assert.strictEqual(withExtras.extras[0].name, "idx_extra");
  assert.strictEqual(withExtras.extras[0].status, "extra");
  assert.strictEqual(withExtras.summary.extra, 1);

  assert.deepStrictEqual(core.buildCreateOptions(baseSpec), {
    CreateIndexes: [{
      IndexName: "idx_user_created_at",
      MgoKeySchema: {
        MgoIndexKeys: [
          { Name: "userId", Direction: "1" },
          { Name: "createdAt", Direction: "-1" }
        ],
        MgoIsUnique: "false"
      }
    }]
  });
}

runCoreTests().then(() => {
  console.log("database index core smoke: OK");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
