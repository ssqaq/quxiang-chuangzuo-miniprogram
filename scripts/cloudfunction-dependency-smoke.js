/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  findRequireCalls,
  runDependencyCheck,
} = require("./check-cloudfunction-dependencies");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-deps-"));
  const apiRoot = path.join(root, "api");
  const packageName = `fixture-package-${path.basename(root).toLowerCase()}`;
  const dependencies = options.dependencies || {
    [packageName]: "1.0.0",
  };
  writeJson(path.join(apiRoot, "package.json"), {
    name: "fixture-api",
    version: "1.0.0",
    main: "index.js",
    dependencies,
  });
  writeJson(path.join(apiRoot, "package-lock.json"), {
    name: "fixture-api",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture-api",
        version: "1.0.0",
        dependencies,
      },
    },
  });
  writeFile(
    path.join(apiRoot, "index.js"),
    options.indexSource || 'module.exports = require("./lib/value");\n'
  );
  writeFile(path.join(apiRoot, "lib", "value.js"), "module.exports = 1;\n");
  for (const [name, value] of Object.entries(dependencies)) {
    if (String(value).startsWith("file:")) {
      const localRoot = path.resolve(apiRoot, String(value).slice(5));
      if (options.createFileDependencies !== false) {
        writeJson(path.join(localRoot, "package.json"), {
          name,
          version: "1.0.0",
          main: options.localMain || "index.js",
        });
        if (!options.missingLocalEntry) {
          writeFile(path.join(localRoot, options.localMain || "index.js"), "module.exports = 2;\n");
        }
      }
    }
    if (options.createInstalledDependencies !== false) {
      const installed = path.join(apiRoot, "node_modules", name);
      writeJson(path.join(installed, "package.json"), {
        name,
        version: "1.0.0",
        main: "index.js",
      });
      writeFile(path.join(installed, "index.js"), "module.exports = 3;\n");
    }
  }
  return { root, apiRoot, packageName };
}

function errorCodes(result) {
  return result.errors.map((item) => item.code);
}

const parsed = findRequireCalls(`
  // require("./comment")
  const a = require("./a");
  const b = require(
    "./b"
  );
  const text = "require('./string')";
  require(variableName);
`);
assert.deepStrictEqual(
  parsed.staticCalls.map((item) => item.specifier),
  ["./a", "./b"]
);
assert.strictEqual(parsed.dynamicCalls.length, 1);

const good = createFixture();
try {
  const result = runDependencyCheck(good.apiRoot);
  assert.strictEqual(result.healthy, true, JSON.stringify(result.errors));
  assert.strictEqual(result.packageDependencies.length, 1);
  assert.strictEqual(result.relativeModules, 1);
} finally {
  fs.rmSync(good.root, { recursive: true, force: true });
}

const missingPackage = createFixture({ createInstalledDependencies: false });
try {
  const result = runDependencyCheck(missingPackage.apiRoot);
  assert.strictEqual(result.healthy, false);
  assert.ok(errorCodes(result).includes("PACKAGE_RESOLVE_FAILED"));
} finally {
  fs.rmSync(missingPackage.root, { recursive: true, force: true });
}

const missingRelative = createFixture({
  indexSource: 'module.exports = require("./lib/missing");\n',
});
try {
  const result = runDependencyCheck(missingRelative.apiRoot);
  assert.strictEqual(result.healthy, false);
  assert.ok(errorCodes(result).includes("RELATIVE_REQUIRE_MISSING"));
  assert.ok(
    result.errors.every((item) => !item.message.includes(missingRelative.root)),
    "错误输出不能泄露临时目录绝对路径"
  );
} finally {
  fs.rmSync(missingRelative.root, { recursive: true, force: true });
}

const localDependency = createFixture({
  dependencies: { local_fixture: "file:vendor/local_fixture" },
});
try {
  const result = runDependencyCheck(localDependency.apiRoot);
  assert.strictEqual(result.healthy, true, JSON.stringify(result.errors));
} finally {
  fs.rmSync(localDependency.root, { recursive: true, force: true });
}

const missingLocal = createFixture({
  dependencies: { local_missing: "file:vendor/local_missing" },
  createFileDependencies: false,
});
try {
  const result = runDependencyCheck(missingLocal.apiRoot);
  assert.strictEqual(result.healthy, false);
  assert.ok(errorCodes(result).includes("INVALID_JSON"));
} finally {
  fs.rmSync(missingLocal.root, { recursive: true, force: true });
}

const missingLocalEntry = createFixture({
  dependencies: { local_entry: "file:vendor/local_entry" },
  missingLocalEntry: true,
});
try {
  const result = runDependencyCheck(missingLocalEntry.apiRoot);
  assert.strictEqual(result.healthy, false);
  assert.ok(errorCodes(result).includes("FILE_DEPENDENCY_ENTRY_MISSING"));
} finally {
  fs.rmSync(missingLocalEntry.root, { recursive: true, force: true });
}

const outsideLocal = createFixture({
  dependencies: { outside_fixture: "file:../outside_fixture" },
});
try {
  const result = runDependencyCheck(outsideLocal.apiRoot);
  assert.strictEqual(result.healthy, false);
  assert.ok(errorCodes(result).includes("FILE_DEPENDENCY_OUTSIDE_API"));
} finally {
  fs.rmSync(outsideLocal.root, { recursive: true, force: true });
}

const directoryAndJson = createFixture({
  indexSource: [
    'const directory = require("./feature");',
    'const data = require("./data.json");',
    "module.exports = { directory, data };",
    "",
  ].join("\n"),
});
try {
  writeFile(
    path.join(directoryAndJson.apiRoot, "feature", "index.js"),
    "module.exports = 4;\n"
  );
  writeJson(path.join(directoryAndJson.apiRoot, "data.json"), { ok: true });
  const result = runDependencyCheck(directoryAndJson.apiRoot);
  assert.strictEqual(result.healthy, true, JSON.stringify(result.errors));
  assert.strictEqual(result.relativeModules, 2);
} finally {
  fs.rmSync(directoryAndJson.root, { recursive: true, force: true });
}

const dynamicRequire = createFixture({
  indexSource: "module.exports = require(process.env.MODULE_NAME);\n",
});
try {
  const result = runDependencyCheck(dynamicRequire.apiRoot);
  assert.strictEqual(result.healthy, false);
  assert.ok(errorCodes(result).includes("DYNAMIC_REQUIRE_UNSUPPORTED"));
} finally {
  fs.rmSync(dynamicRequire.root, { recursive: true, force: true });
}

const realRoot = path.resolve(__dirname, "..", "cloudfunctions", "api");
const realResult = runDependencyCheck(realRoot);
assert.strictEqual(realResult.healthy, true, JSON.stringify(realResult.errors));
assert.deepStrictEqual(
  realResult.packageDependencies.slice().sort(),
  ["jpeg-js", "pngjs", "wx-server-sdk", "xlsx"]
);

console.log("cloudfunction dependency smoke: OK");
