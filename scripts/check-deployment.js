const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const strict = process.argv.includes("--strict");
const config = require(path.join(root, "config.js"));
const projectConfig = JSON.parse(
  fs.readFileSync(path.join(root, "project.config.json"), "utf8")
);
const envExamplePath = path.join(root, "cloudfunctions", "api", ".env.example");
const envExample = fs.readFileSync(envExamplePath, "utf8");

const requiredEnv = [
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_VISION_MODEL",
  "AI_FACE_MODEL",
  "AI_IMAGE_MODEL",
  "AI_IMAGE_MODE",
  "AI_MAX_RETRIES",
  "AI_IMAGE_RETRY_ENABLED"
];
const missingEnvTemplate = requiredEnv.filter(
  (name) => !new RegExp(`^${name}=`, "m").test(envExample)
);
const warnings = [];
const errors = [];

if (!projectConfig.appid) errors.push("project.config.json 缺少 AppID。");
if (projectConfig.appid !== "wxa5aaf3392cbeb39a") {
  errors.push(`AppID 不匹配：${projectConfig.appid || "空"}`);
}
if (!["generations", "edits"].includes(config.imageMode)) {
  errors.push(`config.js 的 imageMode 不支持：${config.imageMode || "空"}`);
}
if (!config.cloudEnvId || config.cloudEnvId === "YOUR_CLOUDBASE_ENV_ID") {
  warnings.push("config.js 尚未填写 cloudEnvId；当前只能运行本地预览。");
}
if (missingEnvTemplate.length) {
  errors.push(`.env.example 缺少变量：${missingEnvTemplate.join(", ")}`);
}
if (!fs.existsSync(path.join(root, "cloudfunctions", "api", "package-lock.json"))) {
  errors.push("云函数缺少 package-lock.json。");
}
for (const relative of [
  "cloudfunctions/api/lib/logger.js",
  "cloudfunctions/api/lib/multipart.js",
  "cloudfunctions/api/lib/retry.js",
  "cloudfunctions/api/lib/web-pose.js"
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    errors.push(`云函数缺少运行依赖文件：${relative}`);
  }
}
if (fs.existsSync(path.join(root, "cloudfunctions", "api", ".env"))) {
  warnings.push("发现 cloudfunctions/api/.env；正式部署请改用云函数控制台环境变量。");
}

const sensitivePattern = /sk-[A-Za-z0-9_-]{20,}/;
const sourceFiles = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else sourceFiles.push(fullPath);
  }
}
collect(root);
for (const filePath of sourceFiles) {
  if (filePath.endsWith(".zip")) continue;
  const text = fs.readFileSync(filePath, "utf8");
  if (sensitivePattern.test(text)) {
    errors.push(`疑似 API Key 出现在源码：${path.relative(root, filePath)}`);
  }
}

console.log(`工程：${root}`);
console.log(`AppID：${projectConfig.appid || "空"}`);
console.log(`CloudBase：${config.cloudEnvId ? "已填写" : "未填写"}`);
console.log(`AI 变量模板：${missingEnvTemplate.length ? "不完整" : "完整"}`);
warnings.forEach((item) => console.log(`⚠️ ${item}`));
errors.forEach((item) => console.log(`❌ ${item}`));

if (errors.length || (strict && warnings.length)) {
  process.exitCode = 1;
} else {
  console.log(strict ? "部署检查通过。" : "本地部署检查完成。");
}
