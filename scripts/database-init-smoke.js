/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "database-admin";

const api = require("../cloudfunctions/api/index.js");
const helpers = api.__test;
const db = helpers.getTestDatabase();

function missingCollectionError(name) {
  const error = new Error(`database collection not exists: ${name}`);
  error.code = "-502005";
  return error;
}

function createCollectionStore(options = {}) {
  const existing = new Set(options.existing || []);
  const failures = new Set(options.failures || []);
  const raceExisting = new Set(options.raceExisting || []);
  const created = [];
  return {
    existing,
    created,
    collection(name) {
      return {
        limit() {
          return {
            async get() {
              if (!existing.has(name)) throw missingCollectionError(name);
              return { data: [] };
            }
          };
        }
      };
    },
    async createCollection(name) {
      if (failures.has(name)) {
        const error = new Error(`create failed: ${name}`);
        error.code = "DATABASE_CREATE_FAILED";
        throw error;
      }
      if (raceExisting.has(name)) {
        existing.add(name);
        const error = new Error(`collection already exists: ${name}`);
        error.code = "DATABASE_COLLECTION_ALREADY_EXISTS";
        throw error;
      }
      existing.add(name);
      created.push(name);
      return { requestId: `create-${name}` };
    }
  };
}

async function main() {
  assert.strictEqual(helpers.requiredDatabaseCollections.length, 22);
  assert.ok(helpers.requiredDatabaseCollections.includes("admin_config_audit_logs"));
  assert.ok(helpers.requiredDatabaseCollections.includes("image_provider_attempt_events"));
  assert.ok(helpers.requiredDatabaseCollections.includes("user_accounts"));
  assert.ok(helpers.requiredDatabaseCollections.includes("user_profiles"));
  assert.ok(helpers.requiredDatabaseCollections.includes("user_diagnostic_logs"));
  assert.ok(helpers.requiredDatabaseCollections.includes("point_ledger"));
  assert.ok(helpers.requiredDatabaseCollections.includes("generation_operations"));
  assert.ok(helpers.requiredDatabaseCollections.includes("tencent_facefusion_intermediate_assets"));
  assert.ok(helpers.requiredDatabaseCollections.includes("tencent_facefusion_status"));
  assert.ok(helpers.isCollectionMissingError(missingCollectionError("sample")));
  assert.strictEqual(
    helpers.isCollectionMissingError(new Error("network timeout")),
    false
  );

  const store = createCollectionStore({
    existing: ["already_there"],
    failures: ["cannot_create"],
    raceExisting: ["created_by_other_request"]
  });
  const summary = await helpers.initializeDatabaseCollections(store, [
    "already_there",
    "new_collection",
    "created_by_other_request",
    "cannot_create"
  ]);
  assert.strictEqual(summary.total, 4);
  assert.strictEqual(summary.created, 1);
  assert.strictEqual(summary.existing, 2);
  assert.strictEqual(summary.failed, 1);
  assert.deepStrictEqual(store.created, ["new_collection"]);
  assert.deepStrictEqual(
    summary.results.map((item) => [item.collection, item.status]),
    [
      ["already_there", "existing"],
      ["new_collection", "created"],
      ["created_by_other_request", "existing"],
      ["cannot_create", "failed"]
    ]
  );
  assert.strictEqual(summary.results[3].errorCode, "DATABASE_CREATE_FAILED");

  const forbidden = await api.main({
    action: "initializeDatabase",
    requestId: "database-init-forbidden"
  }, { OPENID: "normal-user" });
  assert.strictEqual(forbidden.ok, false);
  assert.strictEqual(forbidden.errorCode, "ADMIN_FORBIDDEN");

  const originalCollection = db.collection;
  const originalCreateCollection = db.createCollection;
  const allExistingStore = createCollectionStore({
    existing: helpers.requiredDatabaseCollections
  });
  db.collection = allExistingStore.collection;
  db.createCollection = allExistingStore.createCollection;
  try {
    const initialized = await api.main({
      action: "initializeDatabase",
      requestId: "database-init-admin"
    }, { OPENID: "database-admin" });
    assert.strictEqual(initialized.ok, true);
    assert.strictEqual(initialized.total, 22);
    assert.strictEqual(initialized.created, 0);
    assert.strictEqual(initialized.existing, 22);
    assert.strictEqual(initialized.failed, 0);
  } finally {
    db.collection = originalCollection;
    db.createCollection = originalCreateCollection;
  }

  console.log("database init smoke: OK (create/existing/race/failure/admin)");
}

main().catch((error) => {
  console.error(`database init smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
