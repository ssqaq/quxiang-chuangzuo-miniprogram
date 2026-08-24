from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent


def read_version() -> str:
    config_text = (ROOT / "config.js").read_text(encoding="utf-8")
    match = re.search(r'appVersion:\s*"([^"]+)"', config_text)
    if not match:
        raise RuntimeError("config.js 没有找到 appVersion。")
    return match.group(1)


def parse_args() -> argparse.Namespace:
    version = read_version()
    parser = argparse.ArgumentParser(description="打包微信小程序发布包。")
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT.parent / f"wechat-miniapp-release-v{version}.zip",
        help="输出 ZIP 路径",
    )
    return parser.parse_args()


def should_include(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    if (
        "node_modules" in relative.parts
        or ".git" in relative.parts
        or ".superpowers" in relative.parts
        or ".worktrees" in relative.parts
        or ".githooks" in relative.parts
        or "__pycache__" in relative.parts
    ):
        return False
    if path.suffix.lower() in {".zip", ".tgz", ".pyc"}:
        return False
    if any(part.startswith("_tmp_") for part in relative.parts):
        return False
    return path.is_file()


def main() -> None:
    args = parse_args()
    version = read_version()
    project_config = json.loads(
        (ROOT / "project.config.json").read_text(encoding="utf-8")
    )
    packaged_wasm = [
        path.relative_to(ROOT).as_posix()
        for path in ROOT.rglob("*.wasm")
        if should_include(path)
    ]
    if packaged_wasm:
        raise RuntimeError(
            "上传前置检查失败，代码包不能包含 WASM："
            + ", ".join(packaged_wasm)
        )
    package_json = json.loads(
        (ROOT / "cloudfunctions" / "api" / "package.json").read_text(encoding="utf-8")
    )
    if package_json.get("version") != version:
        raise RuntimeError(
            f"版本不一致：config.js={version}，cloud function={package_json.get('version')}"
        )

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    manifest = "\n".join(
        [
            "圈像创作微信小程序发布包",
            f"版本：{version}",
            "AppID：wxa5aaf3392cbeb39a",
            f"源码目录：{ROOT}",
            f"构建时间：{datetime.now(timezone.utc).astimezone().isoformat()}",
            "静态检查：请在发布前执行 node scripts/validate.js",
            "上传前置检查：代码包禁止包含 .wasm",
            "云函数依赖：部署时可选择云端安装依赖",
            "CloudBase 环境 ID：需在 config.js 中填写后再部署",
            "数据库初始化：部署 api 后执行 scripts/init-cloud-database.ps1，自动补齐 16 个集合（含 user_profiles、user_diagnostic_logs）",
            "用户资料：仅在首次签到时要求选择头像、填写昵称并选择男/女，保存后自动签到",
            "自动贴脸策略：直接调用云端 detectFaceCircle；云端失败保留手动圈选",
            "模型用量统计：部署前请创建 CloudBase 集合 model_usage_events，并设置为仅云函数读写",
            "自动贴脸失败日志：部署前请创建 auto_face_failure_logs，并设置为仅云函数读写",
            "自动贴脸失败日志保留 90 天，api 云函数按天懒清理，每次最多清理 100 条",
            "自动贴脸探针历史：部署前请创建 auto_face_probe_logs，并设置为仅云函数读写，保留 30 天",
            "照片转视频临时文件：只清理登记的 source/result，保留 3×24 小时后每天自动重试",
            "微信开发者工具 CLI：若服务端口关闭，请在 设置 → 安全设置 中开启",
            "注意：发布包不含 node_modules、AppSecret、AI API Key",
        ]
    ) + "\n"

    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for path in ROOT.rglob("*"):
            if should_include(path):
                archive.write(path, path.relative_to(ROOT).as_posix())
        archive.writestr("RELEASE-MANIFEST.txt", manifest)

    required = {
        "app.json",
        "app.js",
        "project.config.json",
        "config.js",
        "pages/index/index.wxml",
        "pages/profile/profile.js",
        "pages/profile/profile.json",
        "pages/profile/profile.wxml",
        "pages/profile/profile.wxss",
        "pages/admin/admin.js",
        "pages/admin/admin.json",
        "pages/admin/admin.wxml",
        "pages/admin/admin.wxss",
        "pages/repair/repair.js",
        "pages/repair/repair.json",
        "pages/repair/repair.wxml",
        "pages/repair/repair.wxss",
        "utils/repair.js",
        "cloudfunctions/api/index.js",
        "cloudfunctions/api/config.json",
        "cloudfunctions/api/lib/logger.js",
        "cloudfunctions/api/lib/multipart.js",
        "cloudfunctions/api/lib/retry.js",
        "cloudfunctions/api/lib/web-pose.js",
        "cloudfunctions/api/package-lock.json",
        "scripts/database-init-smoke.js",
        "scripts/diagnostic-admin-logs-smoke.js",
        "scripts/user-profile-smoke.js",
        "scripts/init-cloud-database.ps1",
        "scripts/auto-face-probe-history-smoke.js",
        "scripts/analysis-cost-probe-smoke.js",
        "scripts/admin-user-stats-option-d-smoke.js",
        "scripts/admin-user-filter-trend-smoke.js",
        "RELEASE-MANIFEST.txt",
    }
    with ZipFile(output) as archive:
        if archive.testzip():
            raise RuntimeError("ZIP 完整性校验失败。")
        names = set(archive.namelist())
    missing = sorted(required - names)
    forbidden = sorted(name for name in names if "node_modules" in name)
    if missing:
        raise RuntimeError(f"发布包缺少文件：{', '.join(missing)}")
    if forbidden:
        raise RuntimeError("发布包包含 node_modules。")

    print(f"打包完成：{output}")
    print(f"版本：{version}")
    print(f"大小：{output.stat().st_size} bytes")
    print(f"文件数：{len(names)}")
    print("ZIP 完整性：通过")


if __name__ == "__main__":
    main()
