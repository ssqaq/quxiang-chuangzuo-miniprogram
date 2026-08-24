"use strict";

function normalizeDirection(value) {
  return String(value) === "-1" ? -1 : 1;
}

function normalizeKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const source = item && typeof item === "object" ? item : {};
      return {
        name: String(source.Name ?? source.name ?? ""),
        direction: normalizeDirection(
          source.Direction ?? source.direction
        )
      };
    }).filter((item) => item.name);
  }

  if (value && typeof value === "object") {
    return Object.entries(value).map(([name, direction]) => ({
      name,
      direction: normalizeDirection(direction)
    }));
  }

  return [];
}

function normalizeIndex(value) {
  const item = value && typeof value === "object" ? value : {};
  const keySchema = item.MgoKeySchema
    && typeof item.MgoKeySchema === "object"
    ? item.MgoKeySchema
    : {};
  const uniqueValue = item.Unique
    ?? item.unique
    ?? item.MgoIsUnique
    ?? keySchema.MgoIsUnique;
  const uniqueText = String(uniqueValue).toLowerCase();

  return {
    name: String(item.Name ?? item.name ?? item.IndexName ?? ""),
    keys: normalizeKeys(
      item.Keys
      ?? item.keys
      ?? item.Key
      ?? item.key
      ?? item.MgoIndexKeys
      ?? keySchema.MgoIndexKeys
    ),
    unique: uniqueValue === true
      || uniqueText === "true"
      || uniqueText === "1"
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
  const candidates = [
    response && response.Indexes,
    response && response.indexes,
    response && response.Data && response.Data.Indexes,
    response && response.data && response.data.indexes
  ];
  const indexes = candidates.find((candidate) => Array.isArray(candidate));

  return (indexes || [])
    .map(normalizeIndex)
    .filter((item) => item.name);
}

function safeError(error) {
  const rawCode = error && (error.code ?? error.Code);
  const rawMessage = error && (error.message ?? error.Message);
  let message = String(
    rawMessage ?? error ?? "unknown error"
  );
  const secrets = [
    process.env.TENCENTCLOUD_SECRET_ID,
    process.env.TENCENTCLOUD_SECRET_KEY,
    process.env.TENCENTCLOUD_SESSION_TOKEN
  ].filter((value) => typeof value === "string" && value.length > 0);

  secrets.forEach((secret) => {
    message = message.split(secret).join("[REDACTED]");
  });

  return {
    code: String(rawCode ?? "UNKNOWN"),
    message
  };
}

function isCollectionMissing(error) {
  const code = error && (error.code ?? error.Code);
  const message = error && (error.message ?? error.Message);
  const text = `${code ?? ""} ${message ?? ""}`;

  return /collection.*(?:not[ _-]*exist|missing)|(?:not[ _-]*exist|missing).*collection|ResourceNotFound|DATABASE_COLLECTION_NOT_EXIST/i
    .test(text);
}

function buildCreateOptions(spec) {
  const normalized = normalizeIndex(spec);

  return {
    CreateIndexes: [{
      IndexName: normalized.name,
      MgoKeySchema: {
        MgoIndexKeys: normalized.keys.map((item) => ({
          Name: item.name,
          Direction: String(item.direction)
        })),
        MgoIsUnique: String(normalized.unique)
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

      if (sameName) {
        results.push({
          ...spec,
          status: "mismatched",
          actual: sameName
        });
        return;
      }

      const equivalent = actualIndexes.find(
        (index) => definitionKey(index) === expectedDefinition
      );
      if (equivalent) {
        results.push({
          ...spec,
          status: "equivalent",
          actual: equivalent
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
