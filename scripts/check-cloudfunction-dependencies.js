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

function displayPath(apiRoot, filePath) {
  const relative = path.relative(apiRoot, filePath).replace(/\\/g, "/");
  if (!relative || relative === ".") return ".";
  if (relative === ".." || relative.startsWith("../")) return "<outside-api>";
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

function validateSourceRequires(apiRoot, errors) {
  const files = collectJavaScriptFiles(apiRoot).sort();
  let relativeModuleCount = 0;
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const calls = findRequireCalls(source);
    for (const call of calls.dynamicCalls) {
      errors.push({
        code: "DYNAMIC_REQUIRE_UNSUPPORTED",
        subject: `${displayPath(apiRoot, filePath)}:${call.line}`,
        message: `无法静态检查动态 require：${displayPath(apiRoot, filePath)}:${call.line}。`,
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
        if (!isInside(apiRoot, resolved)) {
          errors.push({
            code: "RELATIVE_REQUIRE_OUTSIDE_API",
            subject: `${displayPath(apiRoot, filePath)}:${call.line}`,
            message: `相对模块越出云函数目录：${displayPath(apiRoot, filePath)}:${call.line} → ${specifier}。`,
          });
        }
      } catch (_error) {
        errors.push({
          code: "RELATIVE_REQUIRE_MISSING",
          subject: `${displayPath(apiRoot, filePath)}:${call.line}`,
          message: `相对模块缺失：${displayPath(apiRoot, filePath)}:${call.line} → ${specifier}。`,
        });
      }
    }
  }
  return {
    scannedFiles: files.length,
    relativeModuleCount,
  };
}

function runDependencyCheck(apiRootInput) {
  const apiRoot = path.resolve(apiRootInput);
  const errors = [];
  if (!fs.existsSync(apiRoot) || !fs.statSync(apiRoot).isDirectory()) {
    return {
      healthy: false,
      packageDependencies: [],
      relativeModules: 0,
      scannedFiles: 0,
      errors: [{
        code: "API_ROOT_MISSING",
        subject: "cloudfunctions/api",
        message: "云函数目录不存在。",
      }],
    };
  }
  const packageJson = readJson(
    path.join(apiRoot, "package.json"),
    "cloudfunctions/api/package.json",
    errors
  );
  const packageLock = readJson(
    path.join(apiRoot, "package-lock.json"),
    "cloudfunctions/api/package-lock.json",
    errors
  );
  validateLockDependencies(packageJson, packageLock, errors);
  const packageDependencies = validatePackageDependencies(
    apiRoot,
    packageJson,
    errors
  );
  const source = validateSourceRequires(apiRoot, errors);
  return {
    healthy: errors.length === 0,
    packageDependencies,
    relativeModules: source.relativeModuleCount,
    scannedFiles: source.scannedFiles,
    errors,
  };
}

function parseApiRoot(argv) {
  const index = argv.indexOf("--api-root");
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return path.resolve(__dirname, "..", "cloudfunctions", "api");
}

if (require.main === module) {
  const result = runDependencyCheck(parseApiRoot(process.argv.slice(2)));
  if (!result.healthy) {
    for (const error of result.errors) {
      console.error(`❌ [${error.code}] ${error.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `云函数依赖检查通过：${result.packageDependencies.length} 个 npm 依赖、`
      + `${result.relativeModules} 个相对模块、${result.scannedFiles} 个源码文件。`
    );
  }
}

module.exports = {
  findRequireCalls,
  runDependencyCheck,
};
