/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const BUILTIN_MODULES = new Set(
  Module.builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")])
);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "vendor",
]);

function readJson(filePath, label, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    errors.push({
      code: "INVALID_JSON",
      subject: label,
      message: `${label} 不存在或不是有效 JSON。`,
    });
    return null;
  }
}

function isInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative))
  );
}

function displayPath(functionRoot, filePath) {
  const relative = path.relative(functionRoot, filePath).replace(/\\/g, "/");
  if (!relative || relative === ".") return ".";
  if (relative === ".." || relative.startsWith("../")) return "<outside-function>";
  return relative;
}

function collectJavaScriptFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(fullPath, output);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      output.push(fullPath);
    }
  }
  return output;
}

function isIdentifierCharacter(character) {
  return Boolean(character && /[A-Za-z0-9_$]/.test(character));
}

function skipQuoted(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function readQuotedValue(source, start, quote) {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      if (index + 1 >= source.length) break;
      value += source[index + 1];
      index += 2;
      continue;
    }
    if (character === quote) {
      return {
        value,
        end: index + 1,
        closed: true,
      };
    }
    value += character;
    index += 1;
  }
  return {
    value,
    end: source.length,
    closed: false,
  };
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

function findRequireCalls(source) {
  const staticCalls = [];
  const dynamicCalls = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end >= 0 ? end + 1 : source.length;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end >= 0 ? end + 2 : source.length;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (
      source.startsWith("require", index)
      && !isIdentifierCharacter(source[index - 1])
      && source[index - 1] !== "."
      && !isIdentifierCharacter(source[index + 7])
    ) {
      let cursor = index + 7;
      while (/\s/.test(source[cursor] || "")) cursor += 1;
      if (source[cursor] !== "(") {
        index += 7;
        continue;
      }
      cursor += 1;
      while (/\s/.test(source[cursor] || "")) cursor += 1;
      const quote = source[cursor];
      if (quote !== "'" && quote !== '"') {
        dynamicCalls.push({ index, line: lineNumberAt(source, index) });
        index = cursor + 1;
        continue;
      }
      const literal = readQuotedValue(source, cursor, quote);
      let closeCursor = literal.end;
      while (/\s/.test(source[closeCursor] || "")) closeCursor += 1;
      if (!literal.closed || source[closeCursor] !== ")") {
        dynamicCalls.push({ index, line: lineNumberAt(source, index) });
      } else {
        staticCalls.push({
          specifier: literal.value,
          index,
          line: lineNumberAt(source, index),
        });
      }
      index = Math.max(closeCursor + 1, index + 7);
      continue;
    }
    index += 1;
  }
  return { staticCalls, dynamicCalls };
}

function resolveModule(specifier, parentDirectory) {
  return require.resolve(specifier, { paths: [parentDirectory] });
}

function validateLockDependencies(packageJson, packageLock, errors) {
  if (!packageJson || !packageLock) return;
  const declared = packageJson.dependencies || {};
  const lockedRoot = packageLock.packages && packageLock.packages[""];
  const locked = (lockedRoot && lockedRoot.dependencies) || {};
  for (const [name, expected] of Object.entries(declared)) {
    if (locked[name] !== expected) {
      errors.push({
        code: "LOCK_DEPENDENCY_MISMATCH",
        subject: name,
        message: `package-lock.json 的根依赖与 package.json 不一致：${name}。`,
      });
    }
  }
}

function validateFileDependency(apiRoot, name, value, errors) {
  const relativeTarget = String(value).slice("file:".length).trim();
  const target = path.resolve(apiRoot, relativeTarget);
  if (!isInside(apiRoot, target)) {
    errors.push({
      code: "FILE_DEPENDENCY_OUTSIDE_API",
      subject: name,
      message: `本地依赖不能位于云函数目录外：${name}。`,
    });
    return;
  }
  const packagePath = path.join(target, "package.json");
  const localPackage = readJson(
    packagePath,
    `本地依赖 ${name} 的 package.json`,
    errors
  );
  if (!localPackage) return;
  const entry = String(localPackage.main || "index.js");
  try {
    resolveModule(path.resolve(target, entry), target);
  } catch (_error) {
    errors.push({
      code: "FILE_DEPENDENCY_ENTRY_MISSING",
      subject: name,
      message: `本地依赖入口缺失：${name}/${entry.replace(/\\/g, "/")}。`,
    });
  }
}

function validatePackageDependencies(apiRoot, packageJson, errors) {
  const dependencies = (packageJson && packageJson.dependencies) || {};
  const verified = [];
  for (const [name, value] of Object.entries(dependencies)) {
    if (String(value).startsWith("file:")) {
      validateFileDependency(apiRoot, name, value, errors);
    }
    let resolved;
    try {
      resolved = resolveModule(name, apiRoot);
    } catch (_error) {
      errors.push({
        code: "PACKAGE_RESOLVE_FAILED",
        subject: name,
        message: `npm 依赖无法解析：${name}。`,
      });
      continue;
    }
    try {
      delete require.cache[resolved];
      require(resolved);
      verified.push(name);
    } catch (_error) {
      errors.push({
        code: "PACKAGE_LOAD_FAILED",
        subject: name,
        message: `npm 依赖无法加载：${name}。`,
      });
    }
  }
  return verified;
}

function validateSourceRequires(functionRoot, errors, allowedRelativeRoots = []) {
  const files = collectJavaScriptFiles(functionRoot).sort();
  const allowedRoots = [functionRoot, ...allowedRelativeRoots].map((item) => path.resolve(item));
  let relativeModuleCount = 0;
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const calls = findRequireCalls(source);
    for (const call of calls.dynamicCalls) {
      errors.push({
        code: "DYNAMIC_REQUIRE_UNSUPPORTED",
        subject: `${displayPath(functionRoot, filePath)}:${call.line}`,
        message: `无法静态检查动态 require：${displayPath(functionRoot, filePath)}:${call.line}。`,
      });
    }
    for (const call of calls.staticCalls) {
      const specifier = call.specifier;
      if (
        BUILTIN_MODULES.has(specifier)
        || BUILTIN_MODULES.has(specifier.replace(/^node:/, ""))
      ) {
        continue;
      }
      if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) continue;
      relativeModuleCount += 1;
      try {
        const resolved = resolveModule(specifier, path.dirname(filePath));
        if (!allowedRoots.some((root) => isInside(root, resolved))) {
          errors.push({
            code: "RELATIVE_REQUIRE_OUTSIDE_FUNCTION",
            subject: `${displayPath(functionRoot, filePath)}:${call.line}`,
            message: `相对模块越出云函数及清单允许的共享目录：${displayPath(functionRoot, filePath)}:${call.line} → ${specifier}。`,
          });
        }
      } catch (_error) {
        errors.push({
          code: "RELATIVE_REQUIRE_MISSING",
          subject: `${displayPath(functionRoot, filePath)}:${call.line}`,
          message: `相对模块缺失：${displayPath(functionRoot, filePath)}:${call.line} → ${specifier}。`,
        });
      }
    }
  }
  return {
    scannedFiles: files.length,
    relativeModuleCount,
  };
}

function runDependencyCheck(apiRootInput, options = {}) {
  const apiRoot = path.resolve(apiRootInput);
  const subject = String(options.subject || "cloudfunctions/api");
  const lockRequired = options.lockRequired !== false;
  const allowedRelativeRoots = Array.isArray(options.allowedRelativeRoots)
    ? options.allowedRelativeRoots.map((item) => path.resolve(item))
    : [];
  const errors = [];
  if (!fs.existsSync(apiRoot) || !fs.statSync(apiRoot).isDirectory()) {
    return {
      healthy: false,
      packageDependencies: [],
      relativeModules: 0,
      scannedFiles: 0,
      errors: [{
        code: "API_ROOT_MISSING",
        subject,
        message: `云函数或共享核心目录不存在：${subject}。`,
      }],
    };
  }
  const packageJson = readJson(
    path.join(apiRoot, "package.json"),
    `${subject}/package.json`,
    errors
  );
  const packageLock = lockRequired
    ? readJson(
      path.join(apiRoot, "package-lock.json"),
      `${subject}/package-lock.json`,
      errors
    )
    : null;
  validateLockDependencies(packageJson, packageLock, errors);
  const packageDependencies = validatePackageDependencies(
    apiRoot,
    packageJson,
    errors
  );
  const source = validateSourceRequires(apiRoot, errors, allowedRelativeRoots);
  return {
    subject,
    healthy: errors.length === 0,
    packageDependencies,
    relativeModules: source.relativeModuleCount,
    scannedFiles: source.scannedFiles,
    errors,
  };
}

function parseOption(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return "";
}

function parseApiRoot(argv) {
  const index = argv.indexOf("--api-root");
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return path.resolve(__dirname, "..", "cloudfunctions", "api");
}

function runManifestDependencyCheck(manifestInput) {
  const manifestPath = path.resolve(manifestInput);
  const errors = [];
  const manifest = readJson(manifestPath, "scripts/payment-cloudfunctions.json", errors);
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.functions)) {
    if (manifest) {
      errors.push({
        code: "PAYMENT_MANIFEST_INVALID",
        subject: "scripts/payment-cloudfunctions.json",
        message: "支付云函数清单版本或 functions 数组无效。",
      });
    }
    return { healthy: false, targets: [], errors };
  }
  const projectRoot = path.resolve(path.dirname(manifestPath), "..");
  const core = manifest.sharedCore || {};
  const coreRoot = path.resolve(projectRoot, String(core.root || ""));
  const functionRoots = manifest.functions.map((item) => (
    path.resolve(projectRoot, String((item && item.root) || ""))
  ));
  const targets = [];
  const coreResult = runDependencyCheck(coreRoot, {
    subject: String(core.root || "cloudfunctions/payment-core"),
    lockRequired: core.lockRequired === true,
    // payment-core/tests contains cross-entry integration tests.  Runtime
    // modules remain self-contained; only the canonical test scan may resolve
    // the three explicitly declared function roots.
    allowedRelativeRoots: functionRoots,
  });
  targets.push(coreResult);
  const corePackage = fs.existsSync(path.join(coreRoot, "package.json"))
    ? readJson(path.join(coreRoot, "package.json"), `${core.root}/package.json`, errors)
    : null;
  if (corePackage && corePackage.name !== core.name) {
    errors.push({
      code: "PAYMENT_CORE_PACKAGE_NAME_MISMATCH",
      subject: String(core.root || "cloudfunctions/payment-core"),
      message: "payment-core package name 与清单不一致。",
    });
  }

  for (const item of manifest.functions) {
    const functionRoot = path.resolve(projectRoot, String(item.root || ""));
    const result = runDependencyCheck(functionRoot, {
      subject: String(item.root || item.name || "payment-function"),
      lockRequired: true,
    });
    targets.push(result);
    const packageJson = result.healthy || fs.existsSync(path.join(functionRoot, "package.json"))
      ? readJson(path.join(functionRoot, "package.json"), `${item.root}/package.json`, errors)
      : null;
    if (packageJson && packageJson.name !== item.packageName) {
      errors.push({
        code: "PAYMENT_PACKAGE_NAME_MISMATCH",
        subject: String(item.name || item.root),
        message: `支付云函数 package name 与清单不一致：${item.name}。`,
      });
    }
    if (
      packageJson
      && (!packageJson.dependencies
        || packageJson.dependencies[core.name] !== "file:vendor/payment-core")
    ) {
      errors.push({
        code: "PAYMENT_CORE_DEPENDENCY_MISSING",
        subject: String(item.name || item.root),
        message: `${item.name} 必须通过 file:vendor/payment-core 打包共享核心。`,
      });
    }
  }
  for (const result of targets) errors.push(...result.errors);
  return {
    healthy: errors.length === 0,
    targets,
    errors,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const manifestPath = parseOption(argv, "--manifest");
  const result = manifestPath
    ? runManifestDependencyCheck(manifestPath)
    : runDependencyCheck(parseApiRoot(argv));
  if (!result.healthy) {
    for (const error of result.errors) {
      console.error(`❌ [${error.code}] ${error.message}`);
    }
    process.exitCode = 1;
  } else {
    if (manifestPath) {
      const packageCount = result.targets.reduce(
        (total, item) => total + item.packageDependencies.length,
        0
      );
      const sourceCount = result.targets.reduce((total, item) => total + item.scannedFiles, 0);
      console.log(
        `支付云函数依赖检查通过：${result.targets.length} 个目标、`
        + `${packageCount} 个 npm 依赖、${sourceCount} 个源码文件。`
      );
    } else {
      console.log(
        `云函数依赖检查通过：${result.packageDependencies.length} 个 npm 依赖、`
        + `${result.relativeModules} 个相对模块、${result.scannedFiles} 个源码文件。`
      );
    }
  }
}

module.exports = {
  findRequireCalls,
  runDependencyCheck,
  runManifestDependencyCheck,
};
