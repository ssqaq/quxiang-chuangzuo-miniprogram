/* eslint-disable no-console */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const strict = process.argv.includes("--strict");

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (_error) {
    return "";
  }
}

const adbOutput = commandOutput("D:\\ADB\\platform-tools\\adb.exe", ["devices", "-l"]);
const androidDevices = adbOutput
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("*") && /\sdevice\s/.test(` ${line} `));

const status = {
  checkedAt: new Date().toISOString(),
  contract: "G3",
  android: {
    adbPath: "D:\\ADB\\platform-tools\\adb.exe",
    connectedDevices: androidDevices,
    ready: androidDevices.length > 0
  },
  ios: {
    ready: false,
    reason: "当前 Windows 工作站未连接可供微信开发者工具使用的 iOS 真机。"
  },
  releaseGate: androidDevices.length > 0 ? "ios-device-required" : "real-devices-required"
};

const output = path.join(root, "docs", "superpowers", "visual-baselines", "user-center-g3", "device-status.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(status, null, 2)}\n`, "utf8");
console.log(JSON.stringify(status, null, 2));

if (strict && status.releaseGate !== "passed") process.exitCode = 2;
else console.log("user-center G3 device preflight: PENDING (本地没有伪造真机通过)");
