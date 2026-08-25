from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tempfile
from io import BytesIO
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent


def read_version(source_root: Path) -> str:
    config_text = (source_root / "config.js").read_text(encoding="utf-8")
    match = re.search(r'appVersion:\s*"([^"]+)"', config_text)
    if not match:
        raise RuntimeError("config.js 没有找到 appVersion。")
    return match.group(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="打包微信小程序发布包。")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="输出 ZIP 路径",
    )
    parser.add_argument(
        "--source-tree",
        default=None,
        help="从指定 Git commit/tree 打包，而不是读取当前工作区",
    )
    parser.add_argument(
        "--commit-sha",
        default="未提交",
        help="写入发布清单的最终提交 SHA",
    )
    parser.add_argument(
        "--tree-sha",
        default=None,
        help="写入发布清单的 Git tree SHA",
    )
    parser.add_argument(
        "--source-label",
        default=None,
        help="写入发布清单的源码来源说明",
    )
    return parser.parse_args()


def should_include(path: Path, source_root: Path) -> bool:
    relative = path.relative_to(source_root)
    if (
        "node_modules" in relative.parts
        or ".git" in relative.parts
        or ".superpowers" in relative.parts
        or ".worktrees" in relative.parts
        or ".githooks" in relative.parts
        or "__pycache__" in relative.parts
    ):
        return False
    if relative.as_posix() == "project.private.config.json":
        return False
    if path.suffix.lower() in {".zip", ".tgz", ".pyc"}:
        return False
    if any(part.startswith("_tmp_") for part in relative.parts):
        return False
    return path.is_file()


def git_output(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def extract_git_tree(treeish: str, destination: Path) -> None:
    archive = subprocess.run(
        ["git", "archive", "--format=tar", treeish],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    with tarfile.open(fileobj=BytesIO(archive.stdout), mode="r:") as tar:
        root = destination.resolve()
        for member in tar.getmembers():
            target = (root / member.name).resolve()
            if target != root and root not in target.parents:
                raise RuntimeError(f"Git tree 包含非法路径：{member.name}")
        try:
            tar.extractall(root, filter="data")
        except TypeError:
            # Python 3.11 及更早版本没有 filter 参数；上面的路径检查仍会兜底。
            tar.extractall(root)


def compute_source_sha256(source_root: Path) -> str:
    digest = hashlib.sha256()
    included = sorted(
        path
        for path in source_root.rglob("*")
        if should_include(path, source_root)
    )
    for path in included:
        digest.update(path.relative_to(source_root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    args = parse_args()
    temporary_source = None
    if args.source_tree:
        temporary_source = tempfile.TemporaryDirectory(prefix="wechat-miniapp-release-")
        source_root = Path(temporary_source.name)
        extract_git_tree(args.source_tree, source_root)
        source_label = args.source_label or f"Git tree：{args.source_tree}"
    else:
        source_root = ROOT
        source_label = args.source_label or f"工作区：{ROOT}"

    version = read_version(source_root)
    output = (
        args.output.resolve()
        if args.output
        else ROOT.parent / f"wechat-miniapp-release-v{version}.zip"
    )
    project_config = json.loads(
        (source_root / "project.config.json").read_text(encoding="utf-8")
    )
    packaged_wasm = [
        path.relative_to(source_root).as_posix()
        for path in source_root.rglob("*.wasm")
        if should_include(path, source_root)
    ]
    if packaged_wasm:
        raise RuntimeError(
            "上传前置检查失败，代码包不能包含 WASM："
            + ", ".join(packaged_wasm)
        )
    package_json = json.loads(
        (source_root / "cloudfunctions" / "api" / "package.json").read_text(encoding="utf-8")
    )
    if package_json.get("version") != version:
        raise RuntimeError(
            f"版本不一致：config.js={version}，cloud function={package_json.get('version')}"
        )
    api_source = (source_root / "cloudfunctions" / "api" / "index.js").read_text(
        encoding="utf-8"
    )
    api_version_match = re.search(
        r'const API_BUILD_VERSION = "([^"]+)"', api_source
    )
    api_marker_match = re.search(
        r'const API_BUILD_MARKER = "([^"]+)"', api_source
    )
    if not api_version_match or api_version_match.group(1) != version:
        raise RuntimeError(
            "版本不一致："
            f"config.js={version}，api index={api_version_match.group(1) if api_version_match else 'missing'}"
        )
    if not api_marker_match or not api_marker_match.group(1):
        raise RuntimeError("云函数 index.js 缺少 API_BUILD_MARKER")
    media_worker_package = json.loads(
        (source_root / "media-worker" / "package.json").read_text(encoding="utf-8")
    )
    if media_worker_package.get("version") != version:
        raise RuntimeError(
            "版本不一致："
            f"config.js={version}，media worker={media_worker_package.get('version')}"
        )

    source_sha256 = compute_source_sha256(source_root)
    tree_sha = args.tree_sha
    if not tree_sha and args.source_tree:
        tree_sha = git_output(f"{args.source_tree}^{{tree}}")
    tree_sha = tree_sha or "未提供"
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    manifest = "\n".join(
        [
            "圈像创作微信小程序发布包",
            f"版本：{version}",
            "AppID：wxa5aaf3392cbeb39a",
            f"源码来源：{source_label}",
            f"提交 SHA：{args.commit_sha}",
            f"Git tree SHA：{tree_sha}",
            f"源码内容 SHA256：{source_sha256}",
            f"构建时间：{datetime.now(timezone.utc).astimezone().isoformat()}",
            "静态检查：请在发布前执行 node scripts/validate.js",
            "上传前置检查：代码包禁止包含 .wasm",
            "云函数依赖：部署时可选择云端安装依赖",
            "CloudBase 环境 ID：需在 config.js 中填写后再部署",
            "云函数部署：执行 scripts/deploy-and-verify-api.ps1，部署后自动对比线上版本和构建标记",
            "数据库初始化：部署 api 后执行 scripts/init-cloud-database.ps1，自动补齐 17 个集合（含 user_profiles、user_diagnostic_logs、publish_export_jobs）",
            "数据库索引：执行 scripts/check-cloud-database-indexes.ps1，先检查再逐项确认创建 11 组必需索引",
            "用户资料：仅在首次签到时要求选择头像、填写昵称并选择男/女，保存后自动签到",
            "自动贴脸策略：直接调用云端 detectFaceCircle；云端失败保留手动圈选",
            "模型用量统计：部署前请创建 CloudBase 集合 model_usage_events，并设置为仅云函数读写",
            "自动贴脸失败日志：部署前请创建 auto_face_failure_logs，并设置为仅云函数读写",
            "自动贴脸失败日志保留 90 天，api 云函数按天懒清理，每次最多清理 100 条",
            "自动贴脸探针历史：部署前请创建 auto_face_probe_logs，并设置为仅云函数读写，保留 30 天",
            "照片转视频临时文件：只清理登记的 source/result，保留 3×24 小时后每天自动重试",
            "安卓实况：云函数生成标准 Motion Photo JPG，封装失败自动退回普通 MP4",
            "苹果实况：需独立部署 media-worker，并配置 APPLE_LIVE_PHOTO_WORKER_URL 和 APPLE_LIVE_PHOTO_WORKER_TOKEN",
            "苹果导入：小程序分享 LIVP 到文件传输助手，再通过百度网盘保存到 iPhone 相册",
            "微信开发者工具 CLI：若服务端口关闭，请在 设置 → 安全设置 中开启",
            "注意：发布包不含 node_modules、AppSecret、AI API Key",
        ]
    ) + "\n"

    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for path in source_root.rglob("*"):
            if should_include(path, source_root):
                archive.write(path, path.relative_to(source_root).as_posix())
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
        "scripts/admin-layout-state-smoke.js",
        "scripts/admin-usage-entry-smoke.js",
        "scripts/admin-responsive-smoke.js",
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
        "cloudfunctions/api/lib/publish-export-core.js",
        "cloudfunctions/api/lib/android-motion-photo.js",
        "cloudfunctions/api/package-lock.json",
        "services/cloud.js",
        "pages/photo-to-video/photo-to-video.js",
        "pages/photo-to-video/photo-to-video.json",
        "pages/photo-to-video/photo-to-video.wxml",
        "pages/photo-to-video/photo-to-video.wxss",
        "pages/publish-export/publish-export.js",
        "pages/publish-export/publish-export.wxml",
        "pages/publish-export/publish-export.wxss",
        "utils/publish-export-core.js",
        "utils/publish-export.js",
        "workers/publish-export-worker.js",
        "scripts/publish-export-advanced-smoke.js",
        "scripts/publish-export-cloud-smoke.js",
        "scripts/livp-smoke.js",
        "scripts/livp-api-smoke.js",
        "scripts/motion-photo-smoke.js",
        "scripts/motion-photo-api-smoke.js",
        "scripts/motion-photo-page-smoke.js",
        "media-worker/.dockerignore",
        "media-worker/Dockerfile",
        "media-worker/README.md",
        "media-worker/lib/apple-live-photo.js",
        "media-worker/package.json",
        "media-worker/package-lock.json",
        "media-worker/server.js",
        "scripts/database-init-smoke.js",
        "scripts/diagnostic-admin-logs-smoke.js",
        "scripts/user-profile-smoke.js",
        "scripts/init-cloud-database.ps1",
        "scripts/database-indexes.json",
        "scripts/database-index-core.js",
        "scripts/database-index-smoke.js",
        "scripts/deploy-and-verify-api.ps1",
        "scripts/check-cloud-database-indexes.ps1",
        "scripts/cloud-database-index-manager/package.json",
        "scripts/cloud-database-index-manager/package-lock.json",
        "scripts/cloud-database-index-manager/index.js",
        "scripts/auto-face-probe-history-smoke.js",
        "scripts/analysis-cost-probe-smoke.js",
        "scripts/admin-user-stats-option-d-smoke.js",
        "scripts/admin-user-filter-trend-smoke.js",
        "scripts/admin-user-gender-custom-date-detail-smoke.js",
        "scripts/release-safety-smoke.js",
        "RELEASE-MANIFEST.txt",
    }
    with ZipFile(output) as archive:
        if archive.testzip():
            raise RuntimeError("ZIP 完整性校验失败。")
        names = set(archive.namelist())
    missing = sorted(required - names)
    forbidden = sorted(
        name
        for name in names
        if "node_modules" in name
        or "project.private.config.json" in name
        or any(part.startswith("_tmp_") for part in Path(name).parts)
    )
    if missing:
        raise RuntimeError(f"发布包缺少文件：{', '.join(missing)}")
    if forbidden:
        raise RuntimeError("发布包包含 node_modules。")

    print(f"打包完成：{output}")
    print(f"版本：{version}")
    print(f"大小：{output.stat().st_size} bytes")
    print(f"文件数：{len(names)}")
    print(f"提交 SHA：{args.commit_sha}")
    print(f"Git tree SHA：{tree_sha}")
    print(f"源码内容 SHA256：{source_sha256}")
    print("ZIP 完整性：通过")
    if temporary_source is not None:
        temporary_source.cleanup()


if __name__ == "__main__":
    main()
