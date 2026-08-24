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
const managerCli = require("./cloud-database-index-manager/index");

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

function assertErrorCode(callback, expectedCode) {
  assert.throws(callback, (error) => (
    error
    && error.code === expectedCode
    && error.message === expectedCode
  ));
}

async function assertRejectsCode(callback, expectedCode) {
  await assert.rejects(callback, (error) => (
    error
    && error.code === expectedCode
    && error.message === expectedCode
  ));
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
      { name: "score", direction: "1" },
      { name: "rank", direction: 1 }
    ]),
    [
      { name: "createdAt", direction: -1 },
      { name: "userId", direction: -1 },
      { name: "score", direction: 1 },
      { name: "rank", direction: 1 }
    ]
  );
  assertErrorCode(
    () => core.normalizeKeys([{ name: "missingDirection" }]),
    "INDEX_DIRECTION_INVALID"
  );
  assertErrorCode(
    () => core.normalizeKeys([{ name: "invalid", direction: "descending" }]),
    "INDEX_DIRECTION_INVALID"
  );
  const invalidArrayKeys = [
    [{ name: "", direction: 1 }],
    [{ name: "   ", direction: 1 }],
    [{ name: 123, direction: 1 }],
    [{ Name: true, Direction: 1 }],
    [{ name: ["userId"], direction: 1 }],
    [null],
    [["userId", 1]]
  ];
  invalidArrayKeys.forEach((keys) => {
    assertErrorCode(
      () => core.normalizeKeys(keys),
      "INDEX_KEY_INVALID"
    );
  });
  assert.deepStrictEqual(
    core.normalizeKeys({ userId: 1, createdAt: "-1" }),
    [
      { name: "userId", direction: 1 },
      { name: "createdAt", direction: -1 }
    ]
  );
  assertErrorCode(
    () => core.normalizeKeys({ "   ": 1 }),
    "INDEX_KEY_INVALID"
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
  assert.deepStrictEqual(
    core.responseIndexes({
      Indexes: [{
        IndexName: "idx_official_response",
        MgoKeySchema: {
          MgoIndexKeys: [
            { Name: "userId", Direction: "1" },
            { Name: "createdAt", Direction: "-1" }
          ],
          MgoIsUnique: false
        }
      }]
    })[0],
    {
      name: "idx_official_response",
      keys: baseSpec.keys,
      unique: false
    }
  );
  responseVariants.forEach((response) => {
    const emptyKey = Object.keys(response)[0];
    if (emptyKey === "Data" || emptyKey === "data") {
      const nestedKey = Object.keys(response[emptyKey])[0];
      response[emptyKey][nestedKey] = [];
    } else {
      response[emptyKey] = [];
    }
    assert.deepStrictEqual(core.responseIndexes(response), []);
  });
  [undefined, null, {}, { Result: { Indexes: [] } }].forEach((response) => {
    assertErrorCode(
      () => core.responseIndexes(response),
      "INDEX_RESPONSE_INVALID"
    );
  });

  const existing = await inspectOne(baseSpec, {
    Indexes: [managerIndex(baseSpec.name, baseSpec.keys)]
  });
  assert.strictEqual(existing.results[0].status, "existing");
  assert.strictEqual(existing.summary.existing, 1);

  const existingBeforeEquivalent = await inspectOne(baseSpec, {
    Indexes: [
      managerIndex(baseSpec.name, baseSpec.keys),
      managerIndex("idx_legacy_equivalent", baseSpec.keys)
    ]
  });
  assert.strictEqual(
    existingBeforeEquivalent.results[0].status,
    "existing"
  );
  assert.strictEqual(
    existingBeforeEquivalent.results[0].actual.name,
    baseSpec.name
  );

  const equivalent = await inspectOne(baseSpec, {
    Indexes: [managerIndex("idx_legacy_equivalent", baseSpec.keys)]
  });
  assert.strictEqual(equivalent.results[0].status, "equivalent");
  assert.strictEqual(equivalent.extras.length, 0);

  const equivalentBeforeMismatch = await inspectOne(baseSpec, {
    Indexes: [
      managerIndex(baseSpec.name, [
        { name: "userId", direction: 1 },
        { name: "createdAt", direction: 1 }
      ]),
      managerIndex("idx_legacy_equivalent", baseSpec.keys)
    ]
  });
  assert.strictEqual(
    equivalentBeforeMismatch.results[0].status,
    "equivalent"
  );
  assert.strictEqual(
    equivalentBeforeMismatch.results[0].actual.name,
    "idx_legacy_equivalent"
  );
  assert.strictEqual(equivalentBeforeMismatch.extras.length, 0);

  const missing = await inspectOne(baseSpec, { Indexes: [] });
  assert.strictEqual(missing.results[0].status, "missing");
  assert.strictEqual(missing.summary.missing, 1);

  const invalidDirection = await inspectOne(baseSpec, {
    Indexes: [{
      Name: baseSpec.name,
      Keys: [
        { Name: "userId", Direction: "ascending" },
        { Name: "createdAt", Direction: "-1" }
      ],
      Unique: false
    }]
  });
  assert.strictEqual(invalidDirection.results[0].status, "check-failed");
  assert.strictEqual(
    invalidDirection.results[0].error.code,
    "INDEX_RESPONSE_INVALID"
  );
  const secondSpec = {
    ...baseSpec,
    name: "idx_status",
    keys: [{ name: "status", direction: 1 }]
  };
  const invalidCollection = await core.inspectDatabaseIndexes(
    [baseSpec, secondSpec],
    async () => ({
      Indexes: [{
        Name: baseSpec.name,
        Keys: [{ Name: "userId", Direction: "ascending" }],
        Unique: false
      }]
    })
  );
  assert.deepStrictEqual(
    invalidCollection.results.map((item) => item.status),
    ["check-failed", "check-failed"]
  );
  assert.strictEqual(invalidCollection.summary.failed, 2);

  const missingDirection = await inspectOne(baseSpec, {
    Indexes: [{
      Name: baseSpec.name,
      Keys: [
        { Name: "userId" },
        { Name: "createdAt", Direction: "-1" }
      ],
      Unique: false
    }]
  });
  assert.strictEqual(missingDirection.results[0].status, "check-failed");
  assert.strictEqual(
    missingDirection.results[0].error.code,
    "INDEX_RESPONSE_INVALID"
  );

  const invalidResponseKeyNames = [
    "",
    123,
    true,
    ["userId"]
  ];
  for (const invalidName of invalidResponseKeyNames) {
    const invalidKeyResponse = await inspectOne(baseSpec, {
      Indexes: [{
        Name: baseSpec.name,
        Keys: [
          { Name: "createdAt", Direction: "-1" },
          { Name: invalidName, Direction: "1" }
        ],
        Unique: false
      }]
    });
    assert.strictEqual(
      invalidKeyResponse.results[0].status,
      "check-failed"
    );
    assert.strictEqual(
      invalidKeyResponse.results[0].error.code,
      "INDEX_RESPONSE_INVALID"
    );
    assert.strictEqual(invalidKeyResponse.ok, false);
  }

  for (const invalidResponse of [
    undefined,
    null,
    {},
    { Result: { Indexes: [] } }
  ]) {
    const invalidResponseResult = await inspectOne(
      baseSpec,
      invalidResponse
    );
    assert.strictEqual(
      invalidResponseResult.results[0].status,
      "check-failed"
    );
    assert.strictEqual(
      invalidResponseResult.results[0].error.code,
      "INDEX_RESPONSE_INVALID"
    );
    assert.strictEqual(invalidResponseResult.ok, false);
  }

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

  assert.strictEqual(
    core.isCollectionMissing({ code: "ResourceNotFound.Collection" }),
    true
  );
  assert.strictEqual(
    core.isCollectionMissing({ code: "DATABASE_COLLECTION_NOT_EXIST" }),
    true
  );
  assert.strictEqual(
    core.isCollectionMissing({
      code: "ResourceNotFound",
      message: "database collection smoke_records was not found"
    }),
    true
  );
  assert.strictEqual(
    core.isCollectionMissing({
      code: "ResourceNotFound",
      message: "table smoke_records was not found"
    }),
    true
  );
  assert.strictEqual(
    core.isCollectionMissing({
      code: "ResourceNotFound.Environment",
      message: "environment was not found"
    }),
    false
  );
  assert.strictEqual(
    core.isCollectionMissing({
      code: "ResourceNotFound",
      message: "environment was not found"
    }),
    false
  );
  const environmentMissingError = new Error("environment was not found");
  environmentMissingError.code = "ResourceNotFound.Environment";
  const environmentMissing = await inspectOne(
    baseSpec,
    environmentMissingError
  );
  assert.strictEqual(environmentMissing.results[0].status, "check-failed");

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
    process.env.TENCENTCLOUD_SECRET_ID = "smoke-secret";
    process.env.TENCENTCLOUD_SECRET_KEY = "smoke-secret-long";
    process.env.TENCENTCLOUD_SESSION_TOKEN = "smoke-secret";

    const sdkError = new Error("failed smoke-secret-long smoke-secret");
    sdkError.code = "Auth-smoke-secret-long-smoke-secret";
    sdkError.requestId = "must-not-leak";
    const failed = await inspectOne(baseSpec, sdkError);
    assert.strictEqual(failed.results[0].status, "check-failed");
    assert.strictEqual(failed.summary.failed, 1);
    assert.deepStrictEqual(failed.results[0].error, {
      code: "Auth-[REDACTED]-[REDACTED]",
      message: "failed [REDACTED] [REDACTED]"
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

  const createOptions = core.buildCreateOptions(baseSpec);
  assert.deepStrictEqual(createOptions, {
    CreateIndexes: [{
      IndexName: "idx_user_created_at",
      MgoKeySchema: {
        MgoIndexKeys: [
          { Name: "userId", Direction: "1" },
          { Name: "createdAt", Direction: "-1" }
        ],
        MgoIsUnique: false
      }
    }]
  });
  assert.strictEqual(
    typeof createOptions.CreateIndexes[0].MgoKeySchema.MgoIsUnique,
    "boolean"
  );

  const invalidCreateSpecs = [
    null,
    { ...baseSpec, name: "" },
    { ...baseSpec, name: "   " },
    { ...baseSpec, keys: [] },
    {
      ...baseSpec,
      keys: [{ name: "", direction: 1 }]
    },
    {
      ...baseSpec,
      keys: [
        { name: "userId", direction: 1 },
        { name: "", direction: -1 }
      ]
    },
    {
      ...baseSpec,
      keys: [
        { name: "userId", direction: 1 },
        { name: 123, direction: -1 }
      ]
    },
    {
      ...baseSpec,
      keys: [
        { name: "userId", direction: 1 },
        { name: true, direction: -1 }
      ]
    },
    {
      ...baseSpec,
      keys: [
        { name: "userId", direction: 1 },
        { name: ["createdAt"], direction: -1 }
      ]
    },
    {
      ...baseSpec,
      keys: { "   ": 1 }
    },
    {
      ...baseSpec,
      keys: [
        { name: "userId", direction: 1 },
        { name: "userId", direction: -1 }
      ]
    },
    {
      ...baseSpec,
      keys: [{ name: "userId", direction: "descending" }]
    },
    {
      ...baseSpec,
      keys: [{ name: "userId" }]
    },
    { ...baseSpec, unique: "false" },
    {
      collection: baseSpec.collection,
      name: baseSpec.name,
      keys: baseSpec.keys
    }
  ];
  invalidCreateSpecs.forEach((spec) => {
    assertErrorCode(
      () => core.buildCreateOptions(spec),
      "INDEX_SPEC_INVALID"
    );
  });
}

async function runManagerTests() {
  const targetSpec = manifest.indexes[0];

  function createFakeDatabase(indexesOrError) {
    const calls = {
      describeCollection: [],
      updateCollection: []
    };
    const database = {
      async describeCollection(collectionName) {
        calls.describeCollection.push(collectionName);
        if (indexesOrError instanceof Error) {
          throw indexesOrError;
        }
        return { Indexes: indexesOrError };
      },
      async updateCollection(collectionName, options) {
        calls.updateCollection.push({ collectionName, options });
        return { RequestId: "manager-smoke" };
      }
    };
    return { database, calls };
  }

  const parsedCheck = managerCli.parseArgs([
    "node",
    "index.js",
    "check",
    "--manifest",
    "database-indexes.json",
    "--environment",
    "env-smoke"
  ]);
  assert.deepStrictEqual(parsedCheck, {
    command: "check",
    manifest: "database-indexes.json",
    environment: "env-smoke"
  });

  const parsedApply = managerCli.parseArgs([
    "node",
    "index.js",
    "apply",
    "--manifest",
    "database-indexes.json",
    "--environment",
    "env-smoke",
    "--collection",
    targetSpec.collection,
    "--index",
    targetSpec.name,
    "--allow-rebuild"
  ]);
  assert.strictEqual(parsedApply.command, "apply");
  assert.strictEqual(parsedApply.allowRebuild, true);

  [
    "--secret-id",
    "--secret-key",
    "--token",
    "--session-token"
  ].forEach((credentialArgument) => {
    assertErrorCode(
      () => managerCli.parseArgs([
        "node",
        "index.js",
        "check",
        credentialArgument,
        "must-not-be-accepted"
      ]),
      "CREDENTIAL_ARGUMENT_FORBIDDEN"
    );
  });

  const missing = createFakeDatabase([]);
  const created = await managerCli.applyIndex({
    database: missing.database,
    manifest,
    collection: targetSpec.collection,
    indexName: targetSpec.name,
    allowRebuild: false
  });
  assert.strictEqual(created.status, "created");
  assert.strictEqual(created.requestId, "manager-smoke");
  assert.strictEqual(missing.calls.describeCollection.length, 1);
  assert.strictEqual(missing.calls.updateCollection.length, 1);
  assert.deepStrictEqual(missing.calls.updateCollection[0], {
    collectionName: targetSpec.collection,
    options: core.buildCreateOptions(targetSpec)
  });
  assert.strictEqual(
    typeof missing.calls.updateCollection[0]
      .options.CreateIndexes[0].MgoKeySchema.MgoIsUnique,
    "boolean"
  );

  const existing = createFakeDatabase([
    managerIndex(targetSpec.name, targetSpec.keys, targetSpec.unique)
  ]);
  const existingResult = await managerCli.applyIndex({
    database: existing.database,
    manifest,
    collection: targetSpec.collection,
    indexName: targetSpec.name
  });
  assert.strictEqual(existingResult.status, "existing");
  assert.strictEqual(existing.calls.updateCollection.length, 0);

  const equivalent = createFakeDatabase([
    managerIndex(
      `${targetSpec.name}_legacy`,
      targetSpec.keys,
      targetSpec.unique
    )
  ]);
  const equivalentResult = await managerCli.applyIndex({
    database: equivalent.database,
    manifest,
    collection: targetSpec.collection,
    indexName: targetSpec.name
  });
  assert.strictEqual(equivalentResult.status, "equivalent");
  assert.strictEqual(equivalent.calls.updateCollection.length, 0);

  const mismatchedIndexes = [
    managerIndex(
      targetSpec.name,
      [{
        name: targetSpec.keys[0].name,
        direction: -targetSpec.keys[0].direction
      }],
      targetSpec.unique
    )
  ];
  const mismatchedWithoutConfirmation = createFakeDatabase(
    mismatchedIndexes
  );
  await assertRejectsCode(
    () => managerCli.applyIndex({
      database: mismatchedWithoutConfirmation.database,
      manifest,
      collection: targetSpec.collection,
      indexName: targetSpec.name,
      allowRebuild: false
    }),
    "REBUILD_CONFIRMATION_REQUIRED"
  );
  assert.strictEqual(
    mismatchedWithoutConfirmation.calls.updateCollection.length,
    0
  );

  const mismatchedWithConfirmation = createFakeDatabase(mismatchedIndexes);
  const rebuilt = await managerCli.applyIndex({
    database: mismatchedWithConfirmation.database,
    manifest,
    collection: targetSpec.collection,
    indexName: targetSpec.name,
    allowRebuild: true
  });
  assert.strictEqual(rebuilt.status, "rebuilt");
  assert.strictEqual(
    mismatchedWithConfirmation.calls.updateCollection.length,
    1
  );
  assert.deepStrictEqual(
    mismatchedWithConfirmation.calls.updateCollection[0].options.DropIndexes,
    [{ IndexName: targetSpec.name }]
  );
  assert.strictEqual(
    typeof mismatchedWithConfirmation.calls.updateCollection[0]
      .options.CreateIndexes[0].MgoKeySchema.MgoIsUnique,
    "boolean"
  );

  const missingCollectionError = new Error("collection not found");
  missingCollectionError.code = "ResourceNotFound.Collection";
  const missingCollection = createFakeDatabase(missingCollectionError);
  await assertRejectsCode(
    () => managerCli.applyIndex({
      database: missingCollection.database,
      manifest,
      collection: targetSpec.collection,
      indexName: targetSpec.name
    }),
    "COLLECTION_MISSING"
  );
  assert.strictEqual(missingCollection.calls.updateCollection.length, 0);

  const checkError = new Error("describe failed");
  checkError.code = "InternalError";
  const failedCheck = createFakeDatabase(checkError);
  await assertRejectsCode(
    () => managerCli.applyIndex({
      database: failedCheck.database,
      manifest,
      collection: targetSpec.collection,
      indexName: targetSpec.name
    }),
    "INDEX_CHECK_FAILED"
  );
  assert.strictEqual(failedCheck.calls.updateCollection.length, 0);

  const checked = await managerCli.checkIndexes({
    database: missing.database,
    manifest
  });
  assert.strictEqual(checked.results.length, manifest.indexes.length);

  const secretNames = [
    "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY",
    "TENCENTCLOUD_SESSION_TOKEN"
  ];
  const originalSecrets = Object.fromEntries(
    secretNames.map((name) => [name, process.env[name]])
  );
  const secretValues = [
    "manager-secret-id-smoke",
    "manager-secret-key-smoke",
    "manager-token-smoke"
  ];
  try {
    secretNames.forEach((name, index) => {
      process.env[name] = secretValues[index];
    });
    const output = JSON.stringify(
      managerCli.cliErrorPayload(
        new Error(`failed ${secretValues.join(" ")}`)
      )
    );
    secretValues.forEach((secret) => {
      assert.strictEqual(output.includes(secret), false);
    });
    assert.ok(output.includes("[REDACTED]"));
  } finally {
    secretNames.forEach((name) => {
      if (originalSecrets[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalSecrets[name];
      }
    });
  }
}

runCoreTests().then(() => {
  console.log("database index core smoke: OK");
  return runManagerTests();
}).then(() => {
  console.log("database index manager smoke: OK");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
