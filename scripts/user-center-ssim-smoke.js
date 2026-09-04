/* eslint-disable no-console */

// 兼容旧命令入口，但所有计算都交给真实 PNG 比较器完成。
const { runCli } = require("./user-center-visual-diff");

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
