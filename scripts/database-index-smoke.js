/* eslint-disable no-console */

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const manifestPath = path.join(__dirname, "database-indexes.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function assertNonBlankString(value, label) {
  assert.strictEqual(typeof value, "string", `${label} 必须是字符串`);
  assert.notStrictEqual(value.trim(), "", `${label} trim 后不能为空`);
}

assert.strictEqual(manifest.version, 1, "manifest.version 必须为 1");
assert.ok(Array.isArray(manifest.indexes), "manifest.indexes 必须是数组");
assert.strictEqual(manifest.indexes.length, 12, "manifest.indexes.length 必须为 12");

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

  const invalidRebuildConfirmations = [
    "false",
    "0",
    0,
    1,
    -1,
    {},
    [],
    null,
    undefined
  ];
  for (const allowRebuild of invalidRebuildConfirmations) {
    const rejectedRebuild = createFakeDatabase(mismatchedIndexes);
    await assertRejectsCode(
      () => managerCli.applyIndex({
        database: rejectedRebuild.database,
        manifest,
        collection: targetSpec.collection,
        indexName: targetSpec.name,
        allowRebuild
      }),
      "REBUILD_CONFIRMATION_REQUIRED"
    );
    assert.strictEqual(rejectedRebuild.calls.updateCollection.length, 0);
  }

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

  const duplicateArguments = [
    [
      "--manifest",
      "first.json",
      "--manifest",
      "second.json"
    ],
    [
      "--environment",
      "env-first",
      "--environment",
      "env-second"
    ],
    [
      "--collection",
      "first_collection",
      "--collection",
      "second_collection"
    ],
    [
      "--index",
      "first_index",
      "--index",
      "second_index"
    ],
    [
      "--allow-rebuild",
      "--allow-rebuild"
    ]
  ];
  duplicateArguments.forEach((argumentList) => {
    assertErrorCode(
      () => managerCli.parseArgs([
        "node",
        "index.js",
        "apply",
        ...argumentList
      ]),
      "ARGUMENT_DUPLICATE"
    );
  });

  function copyManifest(change) {
    const copied = JSON.parse(JSON.stringify(manifest));
    change(copied);
    return copied;
  }

  const invalidManifestCases = [
    {
      name: "version",
      value: copyManifest((value) => {
        value.version = 2;
      })
    },
    {
      name: "empty-indexes",
      value: copyManifest((value) => {
        value.indexes = [];
      })
    },
    {
      name: "truncated-indexes",
      value: copyManifest((value) => {
        value.indexes = value.indexes.slice(0, 10);
      })
    },
    {
      name: "extra-index",
      value: copyManifest((value) => {
        value.indexes.push({
          ...value.indexes[0],
          name: "idx_extra_smoke"
        });
      })
    },
    {
      name: "index-null",
      value: copyManifest((value) => {
        value.indexes[0] = null;
      })
    },
    {
      name: "index-array",
      value: copyManifest((value) => {
        value.indexes[0] = [];
      })
    },
    {
      name: "collection-empty",
      value: copyManifest((value) => {
        value.indexes[0].collection = "   ";
      })
    },
    {
      name: "collection-non-string",
      value: copyManifest((value) => {
        value.indexes[0].collection = 123;
      })
    },
    {
      name: "name-empty",
      value: copyManifest((value) => {
        value.indexes[0].name = "";
      })
    },
    {
      name: "name-non-string",
      value: copyManifest((value) => {
        value.indexes[0].name = ["idx_invalid"];
      })
    },
    {
      name: "reason-empty",
      value: copyManifest((value) => {
        value.indexes[0].reason = " ";
      })
    },
    {
      name: "reason-non-string",
      value: copyManifest((value) => {
        value.indexes[0].reason = true;
      })
    },
    {
      name: "keys-empty",
      value: copyManifest((value) => {
        value.indexes[0].keys = [];
      })
    },
    {
      name: "keys-non-array",
      value: copyManifest((value) => {
        value.indexes[0].keys = {};
      })
    },
    {
      name: "unique-true",
      value: copyManifest((value) => {
        value.indexes[0].unique = true;
      })
    },
    {
      name: "unique-non-boolean",
      value: copyManifest((value) => {
        value.indexes[0].unique = "false";
      })
    },
    {
      name: "duplicate-index",
      value: copyManifest((value) => {
        value.indexes[1].collection = value.indexes[0].collection;
        value.indexes[1].name = value.indexes[0].name;
      })
    },
    {
      name: "key-null",
      value: copyManifest((value) => {
        value.indexes[0].keys[0] = null;
      })
    },
    {
      name: "key-array",
      value: copyManifest((value) => {
        value.indexes[0].keys[0] = [];
      })
    },
    {
      name: "key-name-empty",
      value: copyManifest((value) => {
        value.indexes[0].keys[0].name = " ";
      })
    },
    {
      name: "key-name-non-string",
      value: copyManifest((value) => {
        value.indexes[0].keys[0].name = 123;
      })
    },
    {
      name: "key-direction-zero",
      value: copyManifest((value) => {
        value.indexes[0].keys[0].direction = 0;
      })
    },
    {
      name: "key-direction-string",
      value: copyManifest((value) => {
        value.indexes[0].keys[0].direction = "1";
      })
    },
    {
      name: "duplicate-key",
      value: copyManifest((value) => {
        value.indexes[0].keys.push({
          ...value.indexes[0].keys[0]
        });
      })
    }
  ];

  assert.strictEqual(managerCli.validateManifest(manifest), manifest);
  invalidManifestCases.forEach((testCase) => {
    assertErrorCode(
      () => managerCli.validateManifest(testCase.value),
      "INDEX_MANIFEST_INVALID"
    );
  });

  const entryInvalidManifests = invalidManifestCases.filter((testCase) => (
    testCase.name === "version"
    || testCase.name === "empty-indexes"
    || testCase.name === "truncated-indexes"
  ));
  for (const testCase of entryInvalidManifests) {
    const invalidCheckDatabase = createFakeDatabase([]);
    await assertRejectsCode(
      () => managerCli.checkIndexes({
        database: invalidCheckDatabase.database,
        manifest: testCase.value
      }),
      "INDEX_MANIFEST_INVALID"
    );
    assert.strictEqual(
      invalidCheckDatabase.calls.describeCollection.length,
      0
    );

    const invalidApplyDatabase = createFakeDatabase([]);
    await assertRejectsCode(
      () => managerCli.applyIndex({
        database: invalidApplyDatabase.database,
        manifest: testCase.value,
        collection: targetSpec.collection,
        indexName: targetSpec.name,
        allowRebuild: true
      }),
      "INDEX_MANIFEST_INVALID"
    );
    assert.strictEqual(
      invalidApplyDatabase.calls.describeCollection.length,
      0
    );
    assert.strictEqual(
      invalidApplyDatabase.calls.updateCollection.length,
      0
    );
  }

  const manifestTempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "database-index-manager-smoke-")
  );
  const manifestSecret = "manifest-file-secret-smoke";
  try {
    const validManifestPath = path.join(
      manifestTempDirectory,
      "valid.json"
    );
    fs.writeFileSync(
      validManifestPath,
      JSON.stringify(manifest),
      "utf8"
    );
    assert.deepStrictEqual(
      managerCli.loadManifest(validManifestPath),
      manifest
    );

    for (const testCase of entryInvalidManifests) {
      const invalidManifestPath = path.join(
        manifestTempDirectory,
        `${testCase.name}.json`
      );
      fs.writeFileSync(
        invalidManifestPath,
        JSON.stringify(testCase.value),
        "utf8"
      );
      assertErrorCode(
        () => managerCli.loadManifest(invalidManifestPath),
        "INDEX_MANIFEST_INVALID"
      );
    }

    const malformedManifestPath = path.join(
      manifestTempDirectory,
      "malformed.json"
    );
    fs.writeFileSync(
      malformedManifestPath,
      `{"secret":"${manifestSecret}",`,
      "utf8"
    );
    let malformedError;
    try {
      managerCli.loadManifest(malformedManifestPath);
    } catch (error) {
      malformedError = error;
    }
    assert.ok(malformedError);
    assert.strictEqual(malformedError.code, "INDEX_MANIFEST_INVALID");
    assert.strictEqual(malformedError.message, "INDEX_MANIFEST_INVALID");
    assert.strictEqual(
      JSON.stringify(managerCli.cliErrorPayload(malformedError))
        .includes(manifestSecret),
      false
    );

    const missingManifestPath = path.join(
      manifestTempDirectory,
      `${manifestSecret}-missing.json`
    );
    let readError;
    try {
      managerCli.loadManifest(missingManifestPath);
    } catch (error) {
      readError = error;
    }
    assert.ok(readError);
    assert.strictEqual(readError.code, "INDEX_MANIFEST_READ_FAILED");
    assert.strictEqual(readError.message, "INDEX_MANIFEST_READ_FAILED");
    assert.strictEqual(
      JSON.stringify(managerCli.cliErrorPayload(readError))
        .includes(manifestSecret),
      false
    );
  } finally {
    fs.rmSync(manifestTempDirectory, {
      recursive: true,
      force: true
    });
  }

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

function makePowerShellResult(name, status, collection = "smoke_records") {
  const result = {
    collection,
    name,
    keys: [{ name: "createdAt", direction: -1 }],
    unique: false,
    reason: "PowerShell smoke",
    status
  };
  if (status === "mismatched") {
    result.actual = {
      name,
      keys: [{ name: "createdAt", direction: 1 }],
      unique: false
    };
  }
  return result;
}

function makePowerShellCheck(results, extras = []) {
  const count = (status) => (
    results.filter((item) => item.status === status).length
  );
  return {
    ok: count("collection-missing") === 0 && count("check-failed") === 0,
    results,
    extras,
    summary: {
      total: results.length,
      existing: count("existing"),
      equivalent: count("equivalent"),
      missing: count("missing"),
      mismatched: count("mismatched"),
      collectionMissing: count("collection-missing"),
      failed: count("check-failed"),
      extra: extras.length
    }
  };
}

function runPowerShellCase(root, name, scenario, input = "", checkOnly = false) {
  const caseRoot = path.join(root, name);
  const scriptsRoot = path.join(caseRoot, "scripts");
  const managerRoot = path.join(
    scriptsRoot,
    "cloud-database-index-manager"
  );
  const packageRoot = path.join(
    managerRoot,
    "node_modules",
    "@cloudbase",
    "manager-node"
  );
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(caseRoot, "config.js"),
    "module.exports = { cloudEnvId: \"env-from-config\" };\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(scriptsRoot, "database-indexes.json"),
    JSON.stringify(manifest),
    "utf8"
  );
  fs.writeFileSync(
    path.join(managerRoot, "package-lock.json"),
    JSON.stringify({
      name: "fake-cloud-database-index-manager",
      lockfileVersion: 3
    }),
    "utf8"
  );

  const scenarioPath = path.join(caseRoot, "scenario.json");
  const statePath = path.join(caseRoot, "state.json");
  const logPath = path.join(caseRoot, "calls.json");
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");
  fs.writeFileSync(
    path.join(managerRoot, "index.js"),
    [
      "\"use strict\";",
      "const fs = require(\"fs\");",
      "const scenario = JSON.parse(fs.readFileSync(",
      "  process.env.FAKE_INDEX_SCENARIO_PATH, \"utf8\"",
      "));",
      "const statePath = process.env.FAKE_INDEX_STATE_PATH;",
      "const logPath = process.env.FAKE_INDEX_LOG_PATH;",
      "const state = fs.existsSync(statePath)",
      "  ? JSON.parse(fs.readFileSync(statePath, \"utf8\"))",
      "  : { checkCount: 0 };",
      "const calls = fs.existsSync(logPath)",
      "  ? JSON.parse(fs.readFileSync(logPath, \"utf8\"))",
      "  : [];",
      "const args = process.argv.slice(2);",
      "const command = args[0];",
      "calls.push({ command, args });",
      "fs.writeFileSync(logPath, JSON.stringify(calls));",
      "if (command === \"check\") {",
      "  const checks = scenario.checks || [];",
      "  const index = Math.min(state.checkCount, checks.length - 1);",
      "  const payload = checks[index];",
      "  state.checkCount += 1;",
      "  fs.writeFileSync(statePath, JSON.stringify(state));",
      "  process.stdout.write(JSON.stringify(payload));",
      "} else if (command === \"apply\") {",
      "  const indexPosition = args.indexOf(\"--index\");",
      "  const indexName = indexPosition >= 0 ? args[indexPosition + 1] : \"\";",
      "  if ((scenario.failIndexes || []).includes(indexName)) {",
      "    process.stderr.write(JSON.stringify({",
      "      ok: false,",
      "      error: { code: \"FAKE_APPLY_FAILED\", message: \"FAKE_APPLY_FAILED\" }",
      "    }));",
      "    process.exitCode = 1;",
      "  } else {",
      "    process.stdout.write(JSON.stringify({",
      "      ok: true,",
      "      status: args.includes(\"--allow-rebuild\") ? \"rebuilt\" : \"created\",",
      "      collection: \"smoke_records\",",
      "      indexName",
      "    }));",
      "  }",
      "} else {",
      "  process.stderr.write(JSON.stringify({",
      "    ok: false,",
      "    error: { code: \"FAKE_COMMAND_INVALID\", message: \"FAKE_COMMAND_INVALID\" }",
      "  }));",
      "  process.exitCode = 1;",
      "}"
    ].join("\n"),
    "utf8"
  );

  const scriptPath = path.join(__dirname, "check-cloud-database-indexes.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ProjectPath",
    caseRoot
  ];
  if (checkOnly) {
    args.push("-CheckOnly");
  }
  const secretValues = [
    `secret-id-${name}`,
    `secret-key-${name}`,
    `session-token-${name}`
  ];
  const result = childProcess.spawnSync("powershell.exe", args, {
    cwd: caseRoot,
    encoding: "utf8",
    input,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      TENCENTCLOUD_SECRET_ID: secretValues[0],
      TENCENTCLOUD_SECRET_KEY: secretValues[1],
      TENCENTCLOUD_SESSION_TOKEN: secretValues[2],
      FAKE_INDEX_SCENARIO_PATH: scenarioPath,
      FAKE_INDEX_STATE_PATH: statePath,
      FAKE_INDEX_LOG_PATH: logPath
    }
  });
  if (result.error) {
    throw result.error;
  }

  const calls = fs.existsSync(logPath)
    ? JSON.parse(fs.readFileSync(logPath, "utf8"))
    : [];
  const reportRoot = path.join(
    caseRoot,
    "_tmp_database-index-reports"
  );
  const reportFiles = fs.existsSync(reportRoot)
    ? fs.readdirSync(reportRoot)
      .filter((file) => file.endsWith(".json"))
      .map((file) => path.join(reportRoot, file))
    : [];
  const reports = reportFiles.map((file) => (
    JSON.parse(fs.readFileSync(file, "utf8"))
  ));
  const combinedOutput = `${result.stdout}\n${result.stderr}\n${JSON.stringify(reports)}`;
  secretValues.forEach((secret) => {
    assert.strictEqual(
      combinedOutput.includes(secret),
      false,
      `${name} 不得输出或写入凭据`
    );
  });

  return {
    ...result,
    calls,
    reports
  };
}

function assertApplyCalls(result) {
  return result.calls.filter((call) => call.command === "apply");
}

function assertCheckCalls(result) {
  return result.calls.filter((call) => call.command === "check");
}

function runPowerShellTests() {
  const scriptPath = path.join(__dirname, "check-cloud-database-indexes.ps1");
  assert.ok(
    fs.existsSync(scriptPath),
    "PowerShell database index entry must exist"
  );

  const script = fs.readFileSync(scriptPath, "utf8");
  [
    "[switch]$CheckOnly",
    "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY",
    "Create this index? [Y/N/A/Q]",
    "Type the full index name to rebuild",
    "DATABASE_INDEX_CHECK_INCOMPLETE",
    "Invoke-IndexManager",
    "verification"
  ].forEach((requiredText) => {
    assert.ok(
      script.includes(requiredText),
      `PowerShell entry must contain ${requiredText}`
    );
  });
  assert.strictEqual(
    script.includes("DropIndexes = @("),
    false,
    "PowerShell entry must not construct DropIndexes directly"
  );

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "database-index-powershell-smoke-")
  );
  try {
    const missingOne = makePowerShellResult("idx_missing_one", "missing");
    const missingTwo = makePowerShellResult("idx_missing_two", "missing");
    const mismatch = makePowerShellResult(
      "idx_rebuild_exact_name",
      "mismatched"
    );
    const allReady = makePowerShellCheck([
      makePowerShellResult("idx_missing_one", "existing"),
      makePowerShellResult("idx_missing_two", "existing"),
      makePowerShellResult("idx_rebuild_exact_name", "existing")
    ]);

    const checkOnly = runPowerShellCase(
      tempRoot,
      "check-only",
      { checks: [makePowerShellCheck([missingOne])] },
      "",
      true
    );
    assert.strictEqual(checkOnly.status, 2);
    assert.strictEqual(assertCheckCalls(checkOnly).length, 1);
    assert.strictEqual(assertApplyCalls(checkOnly).length, 0);
    assert.ok(checkOnly.stdout.includes("DATABASE_INDEX_CHECK_INCOMPLETE"));
    assert.strictEqual(
      checkOnly.stdout.includes("Create this index? [Y/N/A/Q]"),
      false
    );
    assert.ok(checkOnly.stdout.includes("results:"));
    assert.ok(checkOnly.stdout.includes("extras:"));
    assert.ok(checkOnly.stdout.includes("summary:"));
    assert.strictEqual(
      assertCheckCalls(checkOnly)[0].args.includes("env-from-config"),
      true
    );

    const extraOnly = runPowerShellCase(
      tempRoot,
      "extra-only",
      {
        checks: [makePowerShellCheck(
          [makePowerShellResult("idx_ready", "existing")],
          [{
            collection: "smoke_records",
            name: "idx_extra",
            keys: [{ name: "extra", direction: 1 }],
            unique: false,
            status: "extra"
          }]
        )]
      },
      "",
      true
    );
    assert.strictEqual(extraOnly.status, 0);
    assert.strictEqual(assertCheckCalls(extraOnly).length, 1);
    assert.strictEqual(assertApplyCalls(extraOnly).length, 0);

    const missingCollection = runPowerShellCase(
      tempRoot,
      "collection-missing",
      {
        checks: [makePowerShellCheck([
          makePowerShellResult(
            "idx_collection_missing",
            "collection-missing"
          )
        ])]
      }
    );
    assert.strictEqual(missingCollection.status, 2);
    assert.strictEqual(assertCheckCalls(missingCollection).length, 1);
    assert.strictEqual(assertApplyCalls(missingCollection).length, 0);
    assert.ok(
      missingCollection.stdout.includes(
        "scripts\\init-cloud-database.ps1"
      )
    );

    const skipped = runPowerShellCase(
      tempRoot,
      "skip-missing",
      {
        checks: [
          makePowerShellCheck([missingOne, missingTwo]),
          makePowerShellCheck([missingOne, missingTwo])
        ]
      },
      "N\r\n\r\n"
    );
    assert.strictEqual(skipped.status, 2);
    assert.strictEqual(assertApplyCalls(skipped).length, 0);
    assert.strictEqual(assertCheckCalls(skipped).length, 2);
    assert.deepStrictEqual(
      skipped.reports[0].operations.map((item) => item.status),
      ["skipped", "skipped"]
    );

    const quit = runPowerShellCase(
      tempRoot,
      "quit-missing",
      {
        checks: [
          makePowerShellCheck([missingOne, missingTwo]),
          makePowerShellCheck([missingOne, missingTwo])
        ]
      },
      "Q\r\n"
    );
    assert.strictEqual(quit.status, 2);
    assert.strictEqual(assertApplyCalls(quit).length, 0);
    assert.strictEqual(assertCheckCalls(quit).length, 2);
    assert.deepStrictEqual(
      quit.reports[0].operations.map((item) => item.reason),
      ["quit", "quit"]
    );

    const createdSuccessfully = runPowerShellCase(
      tempRoot,
      "create-success",
      {
        checks: [
          makePowerShellCheck([missingOne]),
          makePowerShellCheck([
            makePowerShellResult(missingOne.name, "existing")
          ])
        ]
      },
      "Y\r\n"
    );
    assert.strictEqual(createdSuccessfully.status, 0);
    assert.strictEqual(assertCheckCalls(createdSuccessfully).length, 2);
    assert.strictEqual(assertApplyCalls(createdSuccessfully).length, 1);
    assert.strictEqual(
      createdSuccessfully.reports[0].operations[0].status,
      "created"
    );

    const allMissingOnly = runPowerShellCase(
      tempRoot,
      "all-missing-only",
      {
        checks: [
          makePowerShellCheck([missingOne, missingTwo, mismatch]),
          makePowerShellCheck([mismatch])
        ]
      },
      "A\r\nwrong-name\r\n"
    );
    assert.strictEqual(
      allMissingOnly.status,
      2,
      `${allMissingOnly.stdout}\n${allMissingOnly.stderr}`
    );
    assert.strictEqual(assertCheckCalls(allMissingOnly).length, 2);
    const allMissingApplyCalls = assertApplyCalls(allMissingOnly);
    assert.strictEqual(allMissingApplyCalls.length, 2);
    allMissingApplyCalls.forEach((call) => {
      assert.strictEqual(call.args.includes("--allow-rebuild"), false);
    });
    assert.strictEqual(
      allMissingApplyCalls.some(
        (call) => call.args.includes(mismatch.name)
      ),
      false
    );

    const wrongRebuildName = runPowerShellCase(
      tempRoot,
      "wrong-rebuild-name",
      {
        checks: [
          makePowerShellCheck([mismatch]),
          makePowerShellCheck([mismatch])
        ]
      },
      `${mismatch.name.toUpperCase()}\r\n`
    );
    assert.strictEqual(wrongRebuildName.status, 2);
    assert.strictEqual(assertApplyCalls(wrongRebuildName).length, 0);
    assert.strictEqual(assertCheckCalls(wrongRebuildName).length, 2);

    const exactRebuildName = runPowerShellCase(
      tempRoot,
      "exact-rebuild-name",
      {
        checks: [
          makePowerShellCheck([mismatch]),
          allReady
        ]
      },
      `${mismatch.name}\r\n`
    );
    assert.strictEqual(exactRebuildName.status, 0);
    assert.strictEqual(assertCheckCalls(exactRebuildName).length, 2);
    const rebuildApplyCalls = assertApplyCalls(exactRebuildName);
    assert.strictEqual(rebuildApplyCalls.length, 1);
    assert.strictEqual(
      rebuildApplyCalls[0].args.includes("--allow-rebuild"),
      true
    );

    const continueAfterFailure = runPowerShellCase(
      tempRoot,
      "continue-after-failure",
      {
        checks: [
          makePowerShellCheck([missingOne, missingTwo]),
          allReady
        ],
        failIndexes: [missingOne.name]
      },
      "Y\r\nY\r\n"
    );
    assert.strictEqual(continueAfterFailure.status, 2);
    assert.strictEqual(assertCheckCalls(continueAfterFailure).length, 2);
    assert.strictEqual(assertApplyCalls(continueAfterFailure).length, 2);
    assert.deepStrictEqual(
      continueAfterFailure.reports[0].operations.map(
        (item) => item.status
      ),
      ["failed", "created"]
    );
    assert.ok(
      continueAfterFailure.stdout.includes(
        "DATABASE_INDEX_CHECK_INCOMPLETE"
      )
    );
  } finally {
    fs.rmSync(tempRoot, {
      recursive: true,
      force: true
    });
  }
}

runCoreTests().then(() => {
  console.log("database index core smoke: OK");
  return runManagerTests();
}).then(() => {
  console.log("database index manager smoke: OK");
  runPowerShellTests();
  console.log("database index PowerShell smoke: OK");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
