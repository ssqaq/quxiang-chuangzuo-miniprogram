const fs = require("fs");
const path = require("path");

const rootArg = process.argv[2] || process.cwd();
const root = path.resolve(rootArg);
const includeExtensions = new Set([
  ".js", ".wxml", ".wxss", ".json", ".cmd", ".ps1", ".md", ".html"
]);
const ignoredDirectories = new Set([
  ".git", "node_modules", ".superpowers", ".worktrees", "dist", "release", "vendor"
]);
const mojibakePattern = /\uFFFD|锟|Ã.|Â.|ï¿½|�/u;
const decoder = new TextDecoder("utf-8", { fatal: true });
const failures = [];
let scanned = 0;

function visit(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    failures.push({ file: directory, reason: `目录读取失败：${error.message}` });
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) visit(path.join(directory, entry.name));
      continue;
    }
    const file = path.join(directory, entry.name);
    if (!includeExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    if (path.basename(file) === "check-utf8.js") continue;
    scanned += 1;
    let text;
    try {
      text = decoder.decode(fs.readFileSync(file));
    } catch (error) {
      failures.push({ file, reason: `不是有效 UTF-8：${error.message}` });
      continue;
    }
    if (mojibakePattern.test(text)) {
      failures.push({ file, reason: "发现替换字符或疑似乱码序列" });
    }
  }
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  failures.push({ file: root, reason: "检查目录不存在" });
} else {
  visit(root);
}

const result = {
  status: failures.length ? "failed" : "succeeded",
  root,
  scanned,
  failures,
  checkedAt: new Date().toISOString()
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = failures.length ? 1 : 0;
