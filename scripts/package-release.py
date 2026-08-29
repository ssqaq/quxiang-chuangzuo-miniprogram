from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from io import BytesIO
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def _configure_stdio() -> None:
    """Windows CI 默认可能是 cp1252，发布诊断必须稳定输出 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


_configure_stdio()
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
# v1 contexts remain readable for idempotent rechecks; v2 adds the durable
# queue/base-head/phase fields emitted by the unified release gate.
CONTEXT_SCHEMA_VERSION = 2
SUPPORTED_CONTEXT_SCHEMA_VERSIONS = {1, 2}
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{7,64}$", re.IGNORECASE)
ARTIFACT_PATTERN = re.compile(r"^wechat-miniapp-release-v(?P<version>[^/\\]+)-(?P<commit>[^/\\]+)\.zip$")


def _error(message: str) -> RuntimeError:
    """统一错误类型，方便闸门和 smoke 测试识别失败阶段。"""
    return RuntimeError(f"发布包检查失败：{message}")


def _read_json(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise _error(f"缺少 {label}：{path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise _error(f"无法读取 {label}：{path}（{exc}）") from exc
    if not isinstance(value, dict):
        raise _error(f"{label} 必须是 JSON 对象：{path}")
    return value


def load_release_context(path: Path) -> dict:
    """读取并校验闸门生成的 release context。"""
    context_path = path.expanduser().resolve()
    context = _read_json(context_path, "release context")
    required = (
        "schemaVersion",
        "operationId",
        "canonicalRepo",
        "version",
        "sourceCommit",
        "releaseCommit",
        "treeSha",
        "sourceSha256",
        "artifactPath",
        "expiresAt",
    )
    missing = [key for key in required if key not in context]
    if missing:
        raise _error(f"release context 缺少字段：{', '.join(missing)}")
    if context.get("schemaVersion") not in SUPPORTED_CONTEXT_SCHEMA_VERSIONS:
        raise _error(
            f"不支持的 release context schemaVersion：{context.get('schemaVersion')}"
        )
    if context.get("schemaVersion") == 2:
        for key in ("baseHead", "phase"):
            if not isinstance(context.get(key), str) or not context[key].strip():
                raise _error(f"release context v2 字段 {key} 必须是非空字符串")
        if not COMMIT_PATTERN.fullmatch(context["baseHead"].strip()):
            raise _error("release context v2 baseHead 必须是至少 7 位十六进制 SHA")
    required_strings = (
        "operationId", "canonicalRepo", "version", "sourceCommit",
        "releaseCommit", "treeSha", "sourceSha256", "artifactPath", "expiresAt",
    )
    for key in required_strings:
        if not isinstance(context.get(key), str) or not context[key].strip():
            raise _error(f"release context 字段 {key} 必须是非空字符串")

    canonical = Path(context["canonicalRepo"]).expanduser().resolve()
    if not _same_path(canonical, ROOT):
        raise _error(f"release context canonicalRepo 不是唯一发布源：{canonical}")

    version = context["version"].strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise _error(f"版本号不是三段 SemVer：{version}")
    if not SHA256_PATTERN.fullmatch(context["sourceSha256"].strip()):
        raise _error("sourceSha256 必须是 64 位十六进制 SHA256")
    for key in ("sourceCommit", "releaseCommit", "treeSha"):
        value = context[key].strip()
        if not COMMIT_PATTERN.fullmatch(value):
            raise _error(f"{key} 必须是至少 7 位十六进制提交/tree SHA")

    try:
        expiry_text = context["expiresAt"].strip().replace("Z", "+00:00")
        expires_at = datetime.fromisoformat(expiry_text)
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= datetime.now(timezone.utc):
            raise _error("release context 已过期")
    except ValueError as exc:
        raise _error(f"expiresAt 不是有效 ISO-8601 时间：{context['expiresAt']}") from exc

    artifact = Path(context["artifactPath"]).expanduser()
    if not artifact.is_absolute():
        raise _error("artifactPath 必须是绝对路径")
    artifact = artifact.resolve()
    context["artifactPath"] = str(artifact)
    _validate_artifact_name(artifact.name, version, context["releaseCommit"])
    context["_contextPath"] = str(context_path)
    return context


def load_release_context_from_file(path: Path) -> dict:
    """兼容闸门测试/调用方使用的显式别名。"""
    return load_release_context(path)


def _same_path(left: Path, right: Path) -> bool:
    if os.name == "nt":
        return os.path.normcase(str(left)) == os.path.normcase(str(right))
    return left == right


def _validate_artifact_name(name: str, version: str, release_commit: str) -> str:
    match = ARTIFACT_PATTERN.fullmatch(name)
    if not match or match.group("version") != version:
        raise _error(
            f"产物文件名必须为 wechat-miniapp-release-v{version}-<commit>.zip，实际为：{name}"
        )
    token = match.group("commit")
    commit = release_commit.lower()
    token_lower = token.lower()
    if not COMMIT_PATTERN.fullmatch(token_lower):
        raise _error(f"产物文件名中的 commit 必须是十六进制 SHA：{name}")
    if not (commit == token_lower or (len(token_lower) >= 7 and commit.startswith(token_lower))):
        raise _error(f"产物文件名 commit 与 releaseCommit 不一致：{name} / {release_commit}")
    return token


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
    parser.add_argument(
        "--release-context",
        type=Path,
        default=None,
        help="闸门生成的 release context JSON；正式写包必须提供",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="只执行全部发布包检查，不创建或修改 ZIP",
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


def _validate_lockfile_version(path: Path, version: str) -> None:
    lock = _read_json(path, "package-lock")
    if lock.get("version") != version:
        raise _error(
            f"package-lock 根版本不一致：{path}={lock.get('version')!r}，应为 {version}"
        )
    packages = lock.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
        raise _error(f"package-lock 缺少 packages[\"\"] 根包：{path}")
    root_version = packages[""].get("version")
    if root_version != version:
        raise _error(
            f"package-lock packages[\"\"] 版本不一致：{path}={root_version!r}，应为 {version}"
        )


def validate_source(source_root: Path) -> dict:
    """执行与正式包完全一致的源码检查并返回版本、标记和源码指纹。"""
    source_root = source_root.expanduser().resolve()
    if not source_root.is_dir():
        raise _error(f"源码目录不存在：{source_root}")
    try:
        version = read_version(source_root)
        project_config = _read_json(source_root / "project.config.json", "project.config.json")
        del project_config  # 读取本身就是结构校验；字段由微信开发者工具解释。
    except FileNotFoundError as exc:
        raise _error(f"源码缺少必要文件：{exc.filename}") from exc

    packaged_wasm = [
        path.relative_to(source_root).as_posix()
        for path in source_root.rglob("*.wasm")
        if should_include(path, source_root)
    ]
    if packaged_wasm:
        raise _error("代码包不能包含 WASM：" + ", ".join(packaged_wasm))

    api_root = source_root / "cloudfunctions" / "api"
    package_json = _read_json(api_root / "package.json", "api package.json")
    if package_json.get("version") != version:
        raise _error(
            f"版本不一致：config.js={version}，cloud function={package_json.get('version')}"
        )
    _validate_lockfile_version(api_root / "package-lock.json", version)

    api_source_path = api_root / "index.js"
    try:
        api_source = api_source_path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError) as exc:
        raise _error(f"无法读取 api index.js：{api_source_path}") from exc
    api_version_match = re.search(r'const API_BUILD_VERSION = "([^"]+)"', api_source)
    api_marker_match = re.search(r'const API_BUILD_MARKER = "([^"]+)"', api_source)
    if not api_version_match or api_version_match.group(1) != version:
        raise _error(
            "版本不一致："
            f"config.js={version}，api index={api_version_match.group(1) if api_version_match else 'missing'}"
        )
    if not api_marker_match or not api_marker_match.group(1).strip():
        raise _error("云函数 index.js 缺少 API_BUILD_MARKER")

    gateway_path = source_root / "cloudfunctions" / "watermark-gateway" / "package.json"
    gateway_package = _read_json(gateway_path, "watermark gateway package.json")
    if gateway_package.get("version") != version:
        raise _error(
            "版本不一致："
            f"config.js={version}，watermark gateway={gateway_package.get('version')}"
        )

    media_root = source_root / "media-worker"
    media_package = _read_json(media_root / "package.json", "media worker package.json")
    if media_package.get("version") != version:
        raise _error(
            f"版本不一致：config.js={version}，media worker={media_package.get('version')}"
        )
    _validate_lockfile_version(media_root / "package-lock.json", version)

    return {
        "version": version,
        "apiBuildVersion": api_version_match.group(1),
        "apiBuildMarker": api_marker_match.group(1),
        "sourceSha256": compute_source_sha256(source_root),
    }


def version_entries(source_root: Path) -> dict[str, str]:
    """返回发布包涉及的全部版本字段；字段不一致时直接抛错。"""
    source_root = source_root.expanduser().resolve()
    version = read_version(source_root)
    entries: dict[str, str] = {"config.js": version}
    json_paths = (
        "cloudfunctions/api/package.json",
        "cloudfunctions/api/package-lock.json",
        "media-worker/package.json",
        "media-worker/package-lock.json",
        "cloudfunctions/watermark-gateway/package.json",
    )
    for relative in json_paths:
        path = source_root / relative
        data = _read_json(path, relative)
        values = [data.get("version")]
        if relative.endswith("package-lock.json"):
            packages = data.get("packages")
            if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
                raise _error(f"package-lock 缺少 packages[\"\"] 根包：{path}")
            values.append(packages[""].get("version"))
        for value in values:
            if value != version:
                raise _error(
                    f"发布包版本自动比对失败：{relative}={value!r}，应为 {version!r}"
                )
        entries[relative] = version
    api_path = source_root / "cloudfunctions/api/index.js"
    api_text = api_path.read_text(encoding="utf-8")
    api_match = re.search(r'const API_BUILD_VERSION = "([^\"]+)"', api_text)
    if not api_match or api_match.group(1) != version:
        raise _error("发布包版本自动比对失败：api index.js 的 API_BUILD_VERSION 不一致")
    entries["cloudfunctions/api/index.js"] = api_match.group(1)
    return entries


def _context_source_value(context: dict) -> str | None:
    for key in ("sourcePath", "sourceRoot", "releaseTree", "sourceTree"):
        value = context.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _resolve_source(
    args: argparse.Namespace, context: dict | None
) -> tuple[Path, str, tempfile.TemporaryDirectory[str] | None]:
    """解析源码来源；正式 context 默认从 releaseCommit 的 Git tree 取干净快照。"""
    temporary_source = None
    requested = args.source_tree or (_context_source_value(context) if context else None)
    if requested:
        requested_path = Path(requested).expanduser()
        if requested_path.is_dir():
            return requested_path.resolve(), args.source_label or f"源码目录：{requested_path.resolve()}", None
        treeish = requested
    elif context and context.get("releaseCommit"):
        treeish = context["releaseCommit"]
    else:
        return ROOT, args.source_label or f"工作区：{ROOT}", None

    temporary_source = tempfile.TemporaryDirectory(prefix="wechat-miniapp-release-")
    source_root = Path(temporary_source.name)
    try:
        extract_git_tree(treeish, source_root)
    except (subprocess.CalledProcessError, OSError) as exc:
        temporary_source.cleanup()
        raise _error(f"无法从 Git tree 读取源码 {treeish}：{exc}") from exc
    label = args.source_label or f"Git tree：{treeish}"
    return source_root, label, temporary_source


def _git_tree_sha(treeish: str) -> str:
    try:
        return git_output("rev-parse", f"{treeish}^{{tree}}")
    except subprocess.CalledProcessError as exc:
        raise _error(f"无法读取 Git tree SHA：{treeish}") from exc


def _manifest_lines(
    *,
    version: str,
    source_label: str,
    source_commit: str,
    release_commit: str,
    tree_sha: str,
    source_sha256: str,
    operation_id: str,
    artifact_name: str,
    build_time: str,
) -> list[str]:
    return [
        "圈像创作微信小程序发布包",
        f"操作 ID：{operation_id}",
        f"版本：{version}",
        "AppID：wxa5aaf3392cbeb39a",
        f"源码来源：{source_label}",
        f"源提交 SHA：{source_commit}",
        f"提交 SHA：{release_commit}",
        f"Git tree SHA：{tree_sha}",
        f"源码内容 SHA256：{source_sha256}",
        f"产物文件名：{artifact_name}",
        f"构建时间：{build_time}",
        "静态检查：请在发布前执行 node scripts/validate.js",
        "上传前置检查：代码包禁止包含 .wasm",
        "云函数依赖：部署时可选择云端安装依赖",
        "CloudBase 环境 ID：需在 config.js 中填写后再部署",
        "云函数部署：必须通过 scripts/release.ps1 -DeployCloud 消费同一 release context，部署后自动对比线上版本和构建标记",
        "媒体解析网关：独立部署 cloudfunctions/watermark-gateway，并在云函数控制台配置 "
        "WATERMARK_PROVIDER、ZHUCEKA_API_BASE、ZHUCEKA_UID、ZHUCEKA_KEY、ZHUCEKA_TIMEOUT_MS",
        "媒体解析保存：点击保存后由 api 转存到 CloudBase 临时文件，小程序下载并保存到手机，成功立即删除，失败最多保留约 2 小时",
        "数据库初始化：部署 api 后执行 scripts/init-cloud-database.ps1，自动补齐 22 个集合（含配置审计和图片主备统计）",
        "数据库索引：执行 scripts/check-cloud-database-indexes.ps1，先检查再逐项确认创建 15 组必需索引",
        "旧任务历史：generation_operations 默认保留 90 天，每天 04:20 自动清理，单次最多 50 条，只删除已完成或已退款且没有 pending 标记的后台任务文档",
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


def _write_deterministic_zip(
    source_root: Path, destination: Path, manifest: str
) -> None:
    """写入稳定字节序 ZIP，避免重复执行因文件 mtime/构建时间产生不同 SHA。"""
    files = sorted(
        (
            path.relative_to(source_root).as_posix(),
            path,
        )
        for path in source_root.rglob("*")
        if should_include(path, source_root)
    )
    with ZipFile(destination, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for name, path in files:
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 0
            info.external_attr = 0
            archive.writestr(info, path.read_bytes())
        info = ZipInfo("RELEASE-MANIFEST.txt", date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.create_system = 0
        info.external_attr = 0
        archive.writestr(info, manifest.encode("utf-8"))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_map(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        if "：" in line:
            key, value = line.split("：", 1)
            result[key.strip()] = value.strip()
    return result


def _verify_zip(path: Path, expected: dict, required: set[str]) -> set[str]:
    try:
        with ZipFile(path) as archive:
            if archive.testzip():
                raise _error("ZIP 完整性校验失败")
            names = set(archive.namelist())
            manifest_text = archive.read("RELEASE-MANIFEST.txt").decode("utf-8")
    except (OSError, KeyError, ValueError) as exc:
        raise _error(f"无法读取 ZIP：{path}（{exc}）") from exc
    values = _manifest_map(manifest_text)
    checks = {
        "操作 ID": expected["operationId"],
        "版本": expected["version"],
        "源提交 SHA": expected["sourceCommit"],
        "提交 SHA": expected["releaseCommit"],
        "Git tree SHA": expected["treeSha"],
        "源码内容 SHA256": expected["sourceSha256"],
        "产物文件名": expected.get("artifactName", path.name),
    }
    for key, value in checks.items():
        if values.get(key) != value:
            raise _error(f"ZIP manifest {key} 不一致：{values.get(key)!r} / {value!r}")
    missing = sorted(required - names)
    forbidden = sorted(
        name
        for name in names
        if "node_modules" in name
        or "project.private.config.json" in name
        or any(part.startswith("_tmp_") for part in Path(name).parts)
    )
    if missing:
        raise _error(f"发布包缺少文件：{', '.join(missing)}")
    if forbidden:
        raise _error("发布包包含禁止文件：" + ", ".join(forbidden))
    return names


def assert_zip_version_consistency(path: Path, expected_version: str) -> None:
    """只读断言 ZIP 清单、不可变文件名和指定版本一致，供 CI/smoke 复用。"""
    try:
        with ZipFile(path) as archive:
            if archive.testzip():
                raise _error("ZIP 完整性校验失败")
            manifest_text = archive.read("RELEASE-MANIFEST.txt").decode("utf-8")
    except (OSError, KeyError, UnicodeDecodeError) as exc:
        raise _error(f"无法读取发布包清单：{path}（{exc}）") from exc
    values = _manifest_map(manifest_text)
    if values.get("版本") != expected_version:
        raise _error(
            f"发布包版本自动比对失败：manifest={values.get('版本')!r}，应为 {expected_version!r}"
        )
    for key in ("操作 ID", "源提交 SHA", "提交 SHA", "Git tree SHA", "源码内容 SHA256", "产物文件名"):
        if not values.get(key):
            raise _error(f"发布包清单缺少绑定字段：{key}")
    artifact_name = Path(path).name
    if values["产物文件名"] != artifact_name:
        raise _error(
            f"发布包清单文件名不一致：manifest={values['产物文件名']!r}，实际={artifact_name!r}"
        )
    _validate_artifact_name(artifact_name, expected_version, values["提交 SHA"])
    if not SHA256_PATTERN.fullmatch(values["源码内容 SHA256"]):
        raise _error("发布包清单源码 SHA256 无效")


def _publish_without_overwrite(temp_path: Path, output: Path) -> str:
    """原子发布临时文件；同 SHA 复用，异 SHA 拒绝覆盖。"""
    new_sha = _sha256_file(temp_path)
    try:
        os.link(temp_path, output)
    except FileExistsError:
        existing_sha = _sha256_file(output)
        temp_path.unlink(missing_ok=True)
        if existing_sha == new_sha:
            return "幂等复用"
        raise _error(
            f"产物已存在且 SHA 不同，禁止覆盖：{output}（已有 {existing_sha}，新 {new_sha}）"
        )
    except OSError as exc:
        temp_path.unlink(missing_ok=True)
        raise _error(f"无法原子创建产物（拒绝降级覆盖）：{output}（{exc}）") from exc
    else:
        temp_path.unlink(missing_ok=True)
        return "新建"


def _required_files(source_root: Path) -> set[str]:
    """确保写入 ZIP 的文件集合与检查时的源码快照完全一致。"""
    required = {
        path.relative_to(source_root).as_posix()
        for path in source_root.rglob("*")
        if should_include(path, source_root)
    }
    required.update(
        {
            "app.json",
            "app.js",
            "project.config.json",
            "config.js",
            "cloudfunctions/api/index.js",
            "cloudfunctions/api/package.json",
            "cloudfunctions/api/package-lock.json",
            "cloudfunctions/watermark-gateway/package.json",
            "media-worker/package.json",
            "media-worker/package-lock.json",
            "scripts/install-git-hooks.ps1",
            "scripts/install-git-hooks.cmd",
            "scripts/write-release-record.ps1",
            "RELEASE-MANIFEST.txt",
        }
    )
    return required


def main() -> None:
    args = parse_args()
    if args.release_context:
        context = load_release_context(args.release_context)
    else:
        context = None
        if not args.check_only:
            raise _error(
                "正式写包必须提供 --release-context；无 context 时只能使用 --check-only"
            )

    temporary_source = None
    try:
        source_root, source_label, temporary_source = _resolve_source(args, context)
        if context and args.source_tree:
            context_source = _context_source_value(context)
            requested = (
                str(Path(args.source_tree).expanduser().resolve())
                if Path(args.source_tree).expanduser().is_dir()
                else args.source_tree
            )
            if context_source and Path(context_source).expanduser().is_dir():
                if not _same_path(Path(requested), Path(context_source)):
                    raise _error("--source-tree 与 release context 的源码来源不一致")
            elif requested != context.get("releaseCommit"):
                raise _error("--source-tree 与 release context.releaseCommit 不一致")
        checked = validate_source(source_root)
        version = checked["version"]
        source_sha256 = checked["sourceSha256"]
        required = _required_files(source_root)

        if context:
            if version != context["version"]:
                raise _error(
                    f"源码版本与 release context 不一致：{version} / {context['version']}"
                )
            if source_sha256.lower() != context["sourceSha256"].lower():
                raise _error(
                    "源码内容 SHA256 与 release context 不一致："
                    f"{source_sha256} / {context['sourceSha256']}"
                )
            if args.commit_sha not in ("未提交", context["releaseCommit"]):
                raise _error("--commit-sha 与 release context.releaseCommit 不一致")
            if args.tree_sha and args.tree_sha != context["treeSha"]:
                raise _error("--tree-sha 与 release context.treeSha 不一致")
            release_commit = context["releaseCommit"]
            source_commit = context["sourceCommit"]
            tree_sha = context["treeSha"]
            output = Path(context["artifactPath"])
            if args.output and args.output.expanduser().resolve() != output:
                raise _error("--output 必须与 release context.artifactPath 完全一致")
            operation_id = context["operationId"]
        else:
            release_commit = args.commit_sha
            source_commit = args.commit_sha
            tree_sha = args.tree_sha
            if not tree_sha and args.source_tree and not Path(args.source_tree).is_dir():
                tree_sha = _git_tree_sha(args.source_tree)
            tree_sha = tree_sha or "未提供"
            output = args.output.expanduser().resolve() if args.output else None
            operation_id = "只读检查"

        if args.check_only:
            print("发布包检查通过（未写入 ZIP）")
            print(f"版本：{version}")
            print(f"源码内容 SHA256：{source_sha256}")
            if context:
                print(f"操作 ID：{operation_id}")
                print(f"目标产物：{output}")
            print(json.dumps({
                "schemaVersion": CONTEXT_SCHEMA_VERSION,
                "checkOnly": True,
                "version": version,
                "sourceSha256": source_sha256,
                "operationId": operation_id,
                "artifactPath": str(output) if output else None,
            }, ensure_ascii=False, separators=(",", ":")))
            return

        if output is None:
            raise _error("正式写包缺少 artifactPath；请通过 release context 提供")
        _validate_artifact_name(output.name, version, release_commit)
        output.parent.mkdir(parents=True, exist_ok=True)
        build_time = (
            context.get("builtAt")
            or context.get("createdAt")
            or context.get("reservedAt")
            or "由 release context 固定"
        ) if context else "只读检查"
        manifest = "\n".join(
            _manifest_lines(
                version=version,
                source_label=source_label,
                source_commit=source_commit,
                release_commit=release_commit,
                tree_sha=tree_sha,
                source_sha256=source_sha256,
                operation_id=operation_id,
                artifact_name=output.name,
                build_time=build_time,
            )
        ) + "\n"

        with tempfile.NamedTemporaryFile(
            prefix=f".{output.stem}.", suffix=".tmp", dir=output.parent, delete=False
        ) as handle:
            temporary_output = Path(handle.name)
        try:
            _write_deterministic_zip(source_root, temporary_output, manifest)
            _verify_zip(temporary_output, {
                "operationId": operation_id,
                "version": version,
                "sourceCommit": source_commit,
                "releaseCommit": release_commit,
                "treeSha": tree_sha,
                "sourceSha256": source_sha256,
                "artifactName": output.name,
            }, required)
            disposition = _publish_without_overwrite(temporary_output, output)
        finally:
            temporary_output.unlink(missing_ok=True)

        with ZipFile(output) as archive:
            names = set(archive.namelist())
        print(f"打包完成：{output}")
        print(f"发布结果：{disposition}")
        print(f"版本：{version}")
        print(f"大小：{output.stat().st_size} bytes")
        print(f"文件数：{len(names)}")
        print(f"提交 SHA：{release_commit}")
        print(f"Git tree SHA：{tree_sha}")
        print(f"源码内容 SHA256：{source_sha256}")
        print("ZIP 完整性：通过")
        print(json.dumps({
            "schemaVersion": CONTEXT_SCHEMA_VERSION,
            "checkOnly": False,
            "operationId": operation_id,
            "version": version,
            "sourceCommit": source_commit,
            "releaseCommit": release_commit,
            "treeSha": tree_sha,
            "sourceSha256": source_sha256,
            "artifactPath": str(output),
            "artifactSha256": _sha256_file(output),
            "artifactSizeBytes": output.stat().st_size,
            "artifactDisposition": disposition,
            "fileCount": len(names),
        }, ensure_ascii=False, separators=(",", ":")))
    finally:
        if temporary_source is not None:
            temporary_source.cleanup()


if __name__ == "__main__":
    main()
