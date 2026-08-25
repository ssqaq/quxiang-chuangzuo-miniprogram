const assert = require("assert");
const fs = require("fs");
const path = require("path");

const adminPath = path.join(__dirname, "..", "pages", "admin", "admin.js");
const source = fs.readFileSync(adminPath, "utf8");

assert.ok(source.includes("function pickModelName()"), "pickModelName 不应使用剩余参数");
assert.ok(!/function\s+pickModelName\s*\([^)]*\.\.\./.test(source), "管理员页仍包含函数剩余参数");
assert.ok(!/Math\.max\([^;\n]*\.\.\./.test(source), "管理员页仍包含数组 spread 传给 Math.max");
assert.ok(
  !/\b(?:const|let|var)\s*\[[^\]]*\.\.\.[^\]]*\]\s*=/.test(source),
  "管理员页仍包含数组剩余解构"
);
assert.ok(
  !/Promise\.all\(\[[^\]]*\.\.\./s.test(source),
  "管理员页仍包含 Promise.all 数组 spread"
);
assert.ok(
  source.includes("const allTasks = moduleTasks.slice();")
    && source.includes("const parts = results.slice(1);"),
  "管理员页批量加载没有使用兼容写法"
);

console.log("admin runtime compatibility smoke: OK");
