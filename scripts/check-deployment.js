const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const strict = process.argv.includes("--strict");
const config = require(path.join(root, "config.js"));
const projectConfig = JSON.parse(
  fs.readFileSync(path.join(root, "project.config.json"), "utf8")
);
const apiIndexPath = path.join(root, "cloudfunctions", "api", "index.js");
const apiIndex = fs.readFileSync(apiIndexPath, "utf8");
const envExamplePath = path.join(root, "cloudfunctions", "api", ".env.example");
const envExample = fs.readFileSync(envExamplePath, "utf8");
function readEnvTemplateValue(name) {
  const match = envExample.match(new RegExp(`^${name}=([^\\r\\n]*)`, "m"));
  return match ? String(match[1] || "").trim() : "";
}

const requiredEnv = [
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_VISION_MODEL",
  "AI_FACE_MODEL",
  "AI_IMAGE_PRIMARY_MODEL",
  "AI_IMAGE_BACKUP_MODEL",
  "AI_IMAGE_MODE",
  "AI_IMAGE_EDIT_MAX_ASSET_BYTES",
  "AI_IMAGE_EDIT_MAX_TOTAL_ASSET_BYTES",
  "AI_IMAGE_EDIT_MAX_REQUEST_BYTES",
  "AI_MAX_RETRIES",
  "AI_IMAGE_RETRY_ENABLED",
  "ADMIN_OPENIDS"
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
const frontendImageMode = String(config.imageMode || "").trim().toLowerCase();
const templateImageMode = readEnvTemplateValue("AI_IMAGE_MODE").toLowerCase();
if (frontendImageMode !== "edits") {
  errors.push(`制作页必须使用 edits 多图编辑模式，当前是：${frontendImageMode || "空"}`);
}
if (templateImageMode !== frontendImageMode) {
  errors.push(
    `前端与环境模板的生图模式不一致：config.js=${frontendImageMode || "空"}，.env.example=${templateImageMode || "空"}`
  );
}
const cloudDefaultImageModeMatch = apiIndex.match(
  /const DEFAULT_IMAGE_MODE = "([^"]+)"/
);
const cloudDefaultImageMode = cloudDefaultImageModeMatch
  ? cloudDefaultImageModeMatch[1].toLowerCase()
  : "";
if (cloudDefaultImageMode !== frontendImageMode) {
  errors.push(
    `前端与云函数默认生图模式不一致：config.js=${frontendImageMode || "空"}，云函数=${cloudDefaultImageMode || "空"}`
  );
}
if (
  !apiIndex.includes("function hasImageEditAssets")
  || !apiIndex.includes("if (hasImageEditAssets(payload)) return \"edits\";")
  || !apiIndex.includes("missing-edit-asset")
) {
  errors.push("云函数缺少带素材强制走 edits 的安全兜底。");
}
const apiBuildVersionMatch = apiIndex.match(
  /const API_BUILD_VERSION = "([^"]+)"/
);
const apiBuildMarkerMatch = apiIndex.match(
  /const API_BUILD_MARKER = "([^"]+)"/
);
if (!apiBuildVersionMatch) {
  errors.push("云函数 index.js 缺少 API_BUILD_VERSION。");
} else if (apiBuildVersionMatch[1] !== config.appVersion) {
  errors.push(
    `版本不一致：config.js=${config.appVersion || "空"}，云函数代码=${apiBuildVersionMatch[1]}`
  );
}
if (!apiBuildMarkerMatch || !apiBuildMarkerMatch[1]) {
  errors.push("云函数 index.js 缺少 API_BUILD_MARKER。");
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
console.log(`本地云函数版本：${apiBuildVersionMatch ? apiBuildVersionMatch[1] : "空"}`);
console.log(`前端生图模式：${frontendImageMode || "空"}`);
console.log(`环境模板生图模式：${templateImageMode || "空"}`);
console.log(`云函数默认生图模式：${cloudDefaultImageMode || "空"}`);
console.log(`AI 变量模板：${missingEnvTemplate.length ? "不完整" : "完整"}`);
warnings.forEach((item) => console.log(`⚠️ ${item}`));
errors.forEach((item) => console.log(`❌ ${item}`));

if (errors.length || (strict && warnings.length)) {
  process.exitCode = 1;
} else {
  console.log(strict ? "部署检查通过。" : "本地部署检查完成。");
}
