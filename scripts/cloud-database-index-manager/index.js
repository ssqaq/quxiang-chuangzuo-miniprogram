/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");
const core = require("../database-index-core");

const VALUE_ARGUMENTS = new Set([
  "manifest",
  "environment",
  "collection",
  "index"
]);
const CREDENTIAL_ARGUMENTS = new Set([
  "secret-id",
  "secret-key",
  "secretid",
  "secretkey",
  "token",
  "session-token",
  "sessiontoken"
]);

function createError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizedArgumentName(value) {
  return String(value || "")
    .replace(/^--/, "")
    .replace(/_/g, "-")
    .toLowerCase();
}

function parseArgs(argv) {
  const values = Array.isArray(argv) ? argv : [];
  const seenArguments = new Set();
  const args = {
    command: String(values[2] || "")
  };

  for (let index = 3; index < values.length; index += 1) {
    const rawKey = values[index];
    if (typeof rawKey !== "string" || !rawKey.startsWith("--")) {
      throw createError("ARGUMENT_INVALID");
    }

    const name = normalizedArgumentName(rawKey);
    if (CREDENTIAL_ARGUMENTS.has(name)) {
      throw createError("CREDENTIAL_ARGUMENT_FORBIDDEN");
    }
    if (name === "allow-rebuild") {
      if (seenArguments.has(name)) {
        throw createError("ARGUMENT_DUPLICATE");
      }
      seenArguments.add(name);
      args.allowRebuild = true;
      continue;
    }
    if (!VALUE_ARGUMENTS.has(name)) {
      throw createError("ARGUMENT_INVALID");
    }
    if (seenArguments.has(name)) {
      throw createError("ARGUMENT_DUPLICATE");
    }

    const value = values[index + 1];
    if (
      typeof value !== "string"
      || !value.trim()
      || value.startsWith("--")
    ) {
      throw createError("ARGUMENT_VALUE_MISSING");
    }
    seenArguments.add(name);
    args[name] = value;
    index += 1;
  }

  return args;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateManifest(manifest) {
  if (
    !isPlainObject(manifest)
    || manifest.version !== 1
    || !Array.isArray(manifest.indexes)
    || manifest.indexes.length !== 15
  ) {
    throw createError("INDEX_MANIFEST_INVALID");
  }

  const identities = new Set();
  manifest.indexes.forEach((index) => {
    if (
      !isPlainObject(index)
      || !isNonBlankString(index.collection)
      || !isNonBlankString(index.name)
      || !isNonBlankString(index.reason)
      || !Array.isArray(index.keys)
      || index.keys.length === 0
      || index.unique !== false
    ) {
      throw createError("INDEX_MANIFEST_INVALID");
    }

    const identity = `${index.collection.trim()}\u0000${index.name.trim()}`;
    if (identities.has(identity)) {
      throw createError("INDEX_MANIFEST_INVALID");
    }
    identities.add(identity);

    const keyNames = new Set();
    index.keys.forEach((key) => {
      if (
        !isPlainObject(key)
        || !isNonBlankString(key.name)
        || (key.direction !== 1 && key.direction !== -1)
      ) {
        throw createError("INDEX_MANIFEST_INVALID");
      }

      const keyName = key.name.trim();
      if (keyNames.has(keyName)) {
        throw createError("INDEX_MANIFEST_INVALID");
      }
      keyNames.add(keyName);
    });
  });

  return manifest;
}

function loadManifest(manifestPath) {
  if (typeof manifestPath !== "string" || !manifestPath.trim()) {
    throw createError("INDEX_MANIFEST_PATH_MISSING");
  }

  let content;
  try {
    content = fs.readFileSync(path.resolve(manifestPath), "utf8");
  } catch {
    throw createError("INDEX_MANIFEST_READ_FAILED");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw createError("INDEX_MANIFEST_INVALID");
  }
  return validateManifest(parsed);
}

function createDatabase(environmentId) {
  const envId = String(environmentId || "").trim();
  if (!envId) {
    throw createError("TENCENT_CLOUD_ENVIRONMENT_MISSING");
  }

  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  const token = process.env.TENCENTCLOUD_SESSION_TOKEN || undefined;
  if (!secretId || !secretKey) {
    throw createError("TENCENT_CLOUD_CREDENTIALS_MISSING");
  }

  const CloudBase = require("@cloudbase/manager-node");
  const app = CloudBase.init({
    secretId,
    secretKey,
    token,
    envId
  });
  const database = app && app.database;
  if (!database) {
    throw createError("CLOUD_DATABASE_UNAVAILABLE");
  }
  return database;
}

function assertManagerInputs(database, manifest, needsUpdate) {
  validateManifest(manifest);
  if (
    !database
    || typeof database.describeCollection !== "function"
    || (
      needsUpdate
      && typeof database.updateCollection !== "function"
    )
  ) {
    throw createError("DATABASE_ADAPTER_INVALID");
  }
}

async function checkIndexes({ database, manifest }) {
  assertManagerInputs(database, manifest, false);
  return core.inspectDatabaseIndexes(
    manifest.indexes,
    (collectionName) => database.describeCollection(collectionName)
  );
}

function findSpec(manifest, collection, indexName) {
  return manifest.indexes.find((item) => (
    item
    && item.collection === collection
    && item.name === indexName
  ));
}

function rebuildOptions(spec) {
  return {
    DropIndexes: [{ IndexName: spec.name }],
    ...core.buildCreateOptions(spec)
  };
}

async function applyIndex({
  database,
  manifest,
  collection,
  indexName,
  allowRebuild = false
}) {
  assertManagerInputs(database, manifest, true);
  const spec = findSpec(manifest, collection, indexName);
  if (!spec) {
    throw createError("INDEX_SPEC_NOT_FOUND");
  }

  const inspected = await core.inspectDatabaseIndexes(
    [spec],
    (collectionName) => database.describeCollection(collectionName)
  );
  const current = inspected.results[0];
  if (!current) {
    throw createError("INDEX_CHECK_FAILED");
  }
  if (current.status === "existing" || current.status === "equivalent") {
    return {
      ok: true,
      status: current.status,
      collection: spec.collection,
      indexName: spec.name
    };
  }
  if (current.status === "collection-missing") {
    throw createError("COLLECTION_MISSING");
  }
  if (current.status === "check-failed") {
    throw createError("INDEX_CHECK_FAILED");
  }
  if (current.status === "mismatched" && allowRebuild !== true) {
    throw createError("REBUILD_CONFIRMATION_REQUIRED");
  }
  if (
    current.status !== "missing"
    && current.status !== "mismatched"
  ) {
    throw createError("INDEX_STATUS_UNSUPPORTED");
  }

  const options = current.status === "mismatched"
    ? rebuildOptions(spec)
    : core.buildCreateOptions(spec);
  const response = await database.updateCollection(
    spec.collection,
    options
  );

  return {
    ok: true,
    status: current.status === "mismatched" ? "rebuilt" : "created",
    collection: spec.collection,
    indexName: spec.name,
    requestId: String(
      response && (response.RequestId || response.requestId) || ""
    )
  };
}

function requiredArgument(value, code) {
  if (typeof value !== "string" || !value.trim()) {
    throw createError(code);
  }
  return value;
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.command !== "check" && args.command !== "apply") {
    throw createError("INDEX_COMMAND_INVALID");
  }

  const manifestPath = requiredArgument(
    args.manifest,
    "INDEX_MANIFEST_PATH_MISSING"
  );
  const environmentId = requiredArgument(
    args.environment,
    "TENCENT_CLOUD_ENVIRONMENT_MISSING"
  );
  const manifest = loadManifest(manifestPath);
  const database = createDatabase(environmentId);

  if (args.command === "check") {
    return checkIndexes({ database, manifest });
  }

  return applyIndex({
    database,
    manifest,
    collection: requiredArgument(
      args.collection,
      "INDEX_COLLECTION_MISSING"
    ),
    indexName: requiredArgument(args.index, "INDEX_NAME_MISSING"),
    allowRebuild: Boolean(args.allowRebuild)
  });
}

function cliErrorPayload(error) {
  return {
    ok: false,
    error: core.safeError(error)
  };
}

async function runCli(argv = process.argv, io = process) {
  try {
    const result = await main(argv);
    io.stdout.write(JSON.stringify(result));
    return 0;
  } catch (error) {
    io.stderr.write(JSON.stringify(cliErrorPayload(error)));
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  parseArgs,
  validateManifest,
  loadManifest,
  createDatabase,
  checkIndexes,
  applyIndex,
  main,
  cliErrorPayload,
  runCli
};
