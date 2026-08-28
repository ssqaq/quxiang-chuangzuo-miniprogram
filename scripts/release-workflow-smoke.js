/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "release-gate.yml");

function readWorkflow() {
  assert.ok(fs.existsSync(workflowPath), "release-gate workflow 不存在");
  return fs.readFileSync(workflowPath, "utf8");
}

function testStaticWorkflowContract() {
  const workflow = readWorkflow();
  assert.match(workflow, /^name:\s*release-gate\s*$/m, "workflow 名称错误");
  assert.match(workflow, /pull_request:[\s\S]*?branches:\s*[\s\S]*?-\s*main/m, "必须只接收 main 的 PR 检查");
  assert.match(workflow, /concurrency:\s*[\s\S]*?group:\s*release-gate-\$\{\{\s*github\.repository\s*\}\}-/m, "缺少发布检查并发组");
  assert.match(workflow, /cancel-in-progress:\s*false/m, "发布检查不能取消正在运行的旧任务");
  assert.match(workflow, /run:\s*node\s+scripts\/release-workflow-smoke\.js\s+--runtime/m, "缺少 workflow 运行时预检");
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/m, "workflow 权限必须保持只读");
}

function env(name) {
  return String(process.env[name] || "").trim();
}

function testRuntimeWorkflowContract() {
  const event = env("RELEASE_WORKFLOW_EVENT_NAME");
  const ref = env("RELEASE_WORKFLOW_REF");
  const refName = env("RELEASE_WORKFLOW_REF_NAME");
  const baseRef = env("RELEASE_WORKFLOW_BASE_REF");
  const headRef = env("RELEASE_WORKFLOW_HEAD_REF");

  assert.ok(event === "pull_request" || event === "workflow_dispatch", `不支持的 workflow 事件：${event || "<empty>"}`);
  if (event === "pull_request") {
    assert.match(ref, /^refs\/pull\/\d+\/(?:merge|head)$/, `PR ref 格式错误：${ref}`);
    assert.match(refName, /^\d+\/(?:merge|head)$/, `PR ref_name 格式错误：${refName}`);
    assert.strictEqual(baseRef, "main", `PR 基线必须是 main：${baseRef}`);
    assert.ok(headRef && headRef !== "main", "PR head 分支不能为空或直接使用 main");
    return;
  }

  // 手动运行可能选择任意分支，但必须是 heads ref，不能拿 tag/裸 SHA 做发布检查。
  assert.match(ref, /^refs\/heads\/[^/]+(?:\/[^/]+)*$/, `手动运行 ref 格式错误：${ref}`);
  assert.ok(refName && refName !== "HEAD", "手动运行 ref_name 不能为空");
}

function main() {
  testStaticWorkflowContract();
  if (process.argv.includes("--runtime")) testRuntimeWorkflowContract();
  console.log("release workflow smoke: OK");
}

main();
