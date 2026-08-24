"use strict";

function createError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeDirection(value) {
  if (value === -1 || value === "-1") {
    return -1;
  }
  if (value === 1 || value === "1") {
    return 1;
  }
  throw createError("INDEX_DIRECTION_INVALID");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!isPlainObject(item)) {
        throw createError("INDEX_KEY_INVALID");
      }
      const hasUpperName = Object.prototype.hasOwnProperty.call(item, "Name");
      const name = hasUpperName ? item.Name : item.name;
      if (typeof name !== "string" || !name.trim()) {
        throw createError("INDEX_KEY_INVALID");
      }
      const hasUpperDirection = Object.prototype.hasOwnProperty.call(
        item,
        "Direction"
      );
      return {
        name,
        direction: normalizeDirection(
          hasUpperDirection ? item.Direction : item.direction
        )
      };
    });
  }

  if (isPlainObject(value)) {
    return Object.entries(value).map(([name, direction]) => {
      if (!name.trim()) {
        throw createError("INDEX_KEY_INVALID");
      }
      return {
        name,
        direction: normalizeDirection(direction)
      };
    });
  }

  if (value && typeof value === "object") {
    throw createError("INDEX_KEY_INVALID");
  }

  return [];
}

function normalizeUnique(value) {
  if (value === true || value === false) {
    return value;
  }
  if (value === 1 || value === "1") {
    return true;
  }
  if (
    typeof value === "string"
    && value.trim().toLowerCase() === "true"
  ) {
    return true;
  }
  if (
    typeof value === "string"
    && value.trim().toLowerCase() === "false"
  ) {
    return false;
  }
  throw createError("INDEX_UNIQUE_INVALID");
}

function indexParts(value) {
  const item = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const keySchema = item.MgoKeySchema
    && typeof item.MgoKeySchema === "object"
    && !Array.isArray(item.MgoKeySchema)
    ? item.MgoKeySchema
    : {};

  return {
    nameValue: item.Name ?? item.name ?? item.IndexName,
    keysValue: item.Keys
      ?? item.keys
      ?? item.Key
      ?? item.key
      ?? item.MgoIndexKeys
      ?? keySchema.MgoIndexKeys,
    uniqueValue: item.Unique
      ?? item.unique
      ?? item.MgoIsUnique
      ?? keySchema.MgoIsUnique
  };
}

function normalizeIndex(value) {
  const parts = indexParts(value);

  return {
    name: String(parts.nameValue ?? ""),
    keys: normalizeKeys(parts.keysValue),
    unique: normalizeUnique(parts.uniqueValue)
  };
}

function definitionKey(value) {
  const normalized = normalizeIndex(value);
  return JSON.stringify({
    keys: normalized.keys,
    unique: normalized.unique
  });
}

function responseIndexes(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw createError("INDEX_RESPONSE_INVALID");
  }

  const candidates = [
    response.Indexes,
    response.indexes,
    response.Data
      && typeof response.Data === "object"
      && response.Data.Indexes,
    response.data
      && typeof response.data === "object"
      && response.data.indexes
  ];
  const indexes = candidates.find((candidate) => Array.isArray(candidate));
  if (!indexes) {
    throw createError("INDEX_RESPONSE_INVALID");
  }

  try {
    return indexes.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw createError("INDEX_RESPONSE_INVALID");
      }

      const normalized = normalizeIndex(value);
      const names = new Set();
      if (!normalized.name.trim() || normalized.keys.length === 0) {
        throw createError("INDEX_RESPONSE_INVALID");
      }
      normalized.keys.forEach((key) => {
        if (!key.name.trim() || names.has(key.name)) {
          throw createError("INDEX_RESPONSE_INVALID");
        }
        names.add(key.name);
      });
      return normalized;
    });
  } catch (error) {
    if (error && error.code === "INDEX_RESPONSE_INVALID") {
      throw error;
    }
    throw createError("INDEX_RESPONSE_INVALID");
  }
}

function safeError(error) {
  const rawCode = error && (error.code ?? error.Code);
  const rawMessage = error && (error.message ?? error.Message);
  let code = String(rawCode ?? "UNKNOWN");
  let message = String(
    rawMessage ?? error ?? "unknown error"
  );
  const secrets = [...new Set([
    process.env.TENCENTCLOUD_SECRET_ID,
    process.env.TENCENTCLOUD_SECRET_KEY,
    process.env.TENCENTCLOUD_SESSION_TOKEN
  ].filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);

  secrets.forEach((secret) => {
    code = code.split(secret).join("[REDACTED]");
    message = message.split(secret).join("[REDACTED]");
  });

  return {
    code,
    message
  };
}

function isCollectionMissing(error) {
  const code = String((error && (error.code ?? error.Code)) ?? "");
  const message = String(
    (error && (error.message ?? error.Message)) ?? ""
  );

  if (
    /^ResourceNotFound\.Collection$/i.test(code)
    || /^DATABASE_COLLECTION_NOT_EXIST$/i.test(code)
  ) {
    return true;
  }
  return /^ResourceNotFound$/i.test(code)
    && /collection|table/i.test(message);
}

function normalizeCreateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw createError("INDEX_SPEC_INVALID");
  }

  const parts = indexParts(spec);
  if (
    typeof parts.nameValue !== "string"
    || !parts.nameValue.trim()
    || typeof parts.uniqueValue !== "boolean"
  ) {
    throw createError("INDEX_SPEC_INVALID");
  }

  let keys;
  try {
    keys = normalizeKeys(parts.keysValue);
  } catch {
    throw createError("INDEX_SPEC_INVALID");
  }
  if (keys.length === 0) {
    throw createError("INDEX_SPEC_INVALID");
  }

  const names = new Set();
  keys.forEach((key) => {
    if (!key.name.trim() || names.has(key.name)) {
      throw createError("INDEX_SPEC_INVALID");
    }
    names.add(key.name);
  });

  return {
    name: parts.nameValue,
    keys,
    unique: parts.uniqueValue
  };
}

function buildCreateOptions(spec) {
  const normalized = normalizeCreateSpec(spec);

  return {
    CreateIndexes: [{
      IndexName: normalized.name,
      MgoKeySchema: {
        MgoIndexKeys: normalized.keys.map((item) => ({
          Name: item.name,
          Direction: String(item.direction)
        })),
        MgoIsUnique: normalized.unique
      }
    }]
  };
}

function isSystemIndex(index) {
  return index.name === "_id_" || index.name === "_id";
}

function summarize(results, extras) {
  return {
    total: results.length,
    existing: results.filter((item) => item.status === "existing").length,
    equivalent: results.filter((item) => item.status === "equivalent").length,
    missing: results.filter((item) => item.status === "missing").length,
    mismatched: results.filter((item) => item.status === "mismatched").length,
    collectionMissing: results.filter(
      (item) => item.status === "collection-missing"
    ).length,
    failed: results.filter((item) => item.status === "check-failed").length,
    extra: extras.length
  };
}

async function inspectDatabaseIndexes(specs, describeCollection) {
  const grouped = new Map();

  (Array.isArray(specs) ? specs : []).forEach((spec) => {
    const collection = String(spec && spec.collection || "");
    if (!grouped.has(collection)) {
      grouped.set(collection, []);
    }
    grouped.get(collection).push(spec);
  });

  const results = [];
  const extras = [];

  for (const [collection, collectionSpecs] of grouped) {
    let actualIndexes;

    try {
      actualIndexes = responseIndexes(
        await describeCollection(collection)
      );
    } catch (error) {
      const status = isCollectionMissing(error)
        ? "collection-missing"
        : "check-failed";
      const sanitizedError = safeError(error);

      collectionSpecs.forEach((spec) => {
        results.push({
          ...spec,
          status,
          error: sanitizedError
        });
      });
      continue;
    }

    collectionSpecs.forEach((spec) => {
      const expectedDefinition = definitionKey(spec);
      const sameName = actualIndexes.find(
        (index) => index.name === spec.name
      );

      if (sameName && definitionKey(sameName) === expectedDefinition) {
        results.push({
          ...spec,
          status: "existing",
          actual: sameName
        });
        return;
      }

      const equivalent = actualIndexes.find((index) => (
        index.name !== spec.name
        && definitionKey(index) === expectedDefinition
      ));
      if (equivalent) {
        results.push({
          ...spec,
          status: "equivalent",
          actual: equivalent
        });
        return;
      }

      if (sameName) {
        results.push({
          ...spec,
          status: "mismatched",
          actual: sameName
        });
        return;
      }

      results.push({
        ...spec,
        status: "missing"
      });
    });

    actualIndexes.forEach((index) => {
      if (isSystemIndex(index)) {
        return;
      }

      const managed = collectionSpecs.some((spec) => (
        index.name === spec.name
        || definitionKey(index) === definitionKey(spec)
      ));
      if (!managed) {
        extras.push({
          collection,
          ...index,
          status: "extra"
        });
      }
    });
  }

  const summary = summarize(results, extras);

  return {
    ok: summary.collectionMissing === 0 && summary.failed === 0,
    results,
    extras,
    summary
  };
}

module.exports = {
  normalizeKeys,
  normalizeIndex,
  definitionKey,
  responseIndexes,
  safeError,
  isCollectionMissing,
  buildCreateOptions,
  inspectDatabaseIndexes
};
