from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
MANIFEST_NAME = "ACCOUNT-VISUAL-TEST-MANIFEST.json"
REQUIRED_ROOT_FILES = (
    "app.js",
    "app.json",
    "app.wxss",
    "config.js",
    "project.config.json",
    "sitemap.json",
)
REQUIRED_RUNTIME_DIRECTORIES = ("pages", "services", "utils")
OPTIONAL_RUNTIME_DIRECTORIES = ("assets", "components", "miniprogram_npm", "workers")
REQUIRED_DEMO_FILES = (
    "pages/user-center/user-center.js",
    "pages/recharge/recharge.js",
    "pages/account-records/account-records.js",
    "utils/account-demo.js",
)
FORBIDDEN_FILE_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    "project.private.config.json",
    "credentials.json",
    "service-account.json",
}
FORBIDDEN_SUFFIXES = {".key", ".p12", ".pfx", ".pem"}
PRIVATE_KEY_PATTERN = re.compile(rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
LITERAL_CREDENTIAL_PATTERN = re.compile(
    rb"(?i)(?:api[_-]?key|app[_-]?secret|secret[_-]?(?:id|key)|private[_-]?key|access[_-]?token)"
    rb"\s*[:=]\s*['\"]([^'\"\r\n]+)['\"]"
)
PROFILE_PATTERN = re.compile(
    rb"(?m)^(?P<indent>\s*)buildProfile\s*:\s*['\"]production['\"]\s*,?\s*$"
)
CLOUD_ENV_PATTERN = re.compile(
    rb"(?m)^(?P<indent>\s*)cloudEnvId\s*:\s*['\"][^'\"\r\n]*['\"]\s*,?\s*$"
)
SEMVER_PATTERN = re.compile(rb"appVersion\s*:\s*['\"](?P<version>\d+\.\d+\.\d+)['\"]")
PLACEHOLDER_CREDENTIALS = {
    "",
    "未配置",
    "placeholder",
    "example",
    "demo",
    "test",
    "your-api-key",
    "your-secret",
}


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


_configure_stdio()
sys.dont_write_bytecode = True


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _assert_safe_package_path(relative: PurePosixPath) -> None:
    parts = tuple(part.lower() for part in relative.parts)
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise RuntimeError(f"非法候选包路径：{relative.as_posix()}")
    name = parts[-1]
    if name in FORBIDDEN_FILE_NAMES or PurePosixPath(name).suffix.lower() in FORBIDDEN_SUFFIXES:
        raise RuntimeError(f"候选包禁止携带密钥或本机私有文件：{relative.as_posix()}")
    if any(part in {".git", "node_modules", "__pycache__"} for part in parts):
        raise RuntimeError(f"候选包禁止携带生成物：{relative.as_posix()}")


def _credential_is_placeholder(raw: bytes) -> bool:
    value = raw.decode("utf-8", errors="ignore").strip()
    lowered = value.lower()
    if lowered in PLACEHOLDER_CREDENTIALS:
        return True
    if not value or set(value) <= {"*", "x", "X", "-", "_"}:
        return True
    return lowered.startswith(("your-", "example-", "demo-", "test-", "placeholder-"))


def _scan_credential_bytes(relative: PurePosixPath, data: bytes) -> None:
    if PRIVATE_KEY_PATTERN.search(data):
        raise RuntimeError(f"候选包检测到私钥内容：{relative.as_posix()}")
    if b"\x00" in data:
        return
    for match in LITERAL_CREDENTIAL_PATTERN.finditer(data):
        if not _credential_is_placeholder(match.group(1)):
            raise RuntimeError(f"候选包检测到硬编码凭据：{relative.as_posix()}")


def _collect_source_files(source_root: Path) -> list[PurePosixPath]:
    for relative in REQUIRED_ROOT_FILES:
        path = source_root / relative
        if not path.is_file():
            raise RuntimeError(f"候选包缺少必需文件：{relative}")
    for relative in REQUIRED_RUNTIME_DIRECTORIES:
        if not (source_root / relative).is_dir():
            raise RuntimeError(f"候选包缺少运行时目录：{relative}")

    collected: set[PurePosixPath] = {PurePosixPath(item) for item in REQUIRED_ROOT_FILES}
    for directory in (*REQUIRED_RUNTIME_DIRECTORIES, *OPTIONAL_RUNTIME_DIRECTORIES):
        base = source_root / directory
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.is_symlink():
                raise RuntimeError(f"候选包禁止跟随符号链接：{path.relative_to(source_root).as_posix()}")
            if path.is_file():
                collected.add(PurePosixPath(path.relative_to(source_root).as_posix()))

    for relative in sorted(collected, key=lambda item: item.as_posix()):
        _assert_safe_package_path(relative)
    for relative in REQUIRED_DEMO_FILES:
        if PurePosixPath(relative) not in collected:
            raise RuntimeError(f"候选包缺少 Demo 双闸门文件：{relative}")
    return sorted(collected, key=lambda item: item.as_posix())


def _snapshot_files(source_root: Path, paths: list[PurePosixPath]) -> tuple[dict[str, bytes], list[dict]]:
    payloads: dict[str, bytes] = {}
    entries: list[dict] = []
    for relative in paths:
        source = source_root.joinpath(*relative.parts)
        data = source.read_bytes()
        _scan_credential_bytes(relative, data)
        name = relative.as_posix()
        payloads[name] = data
        entries.append({"path": name, "sha256": _sha256_bytes(data), "sizeBytes": len(data)})
    return payloads, entries


def _snapshot_sha256(entries: list[dict]) -> str:
    digest = hashlib.sha256()
    for entry in entries:
        digest.update(entry["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(entry["sha256"].encode("ascii"))
        digest.update(b"\0")
        digest.update(str(entry["sizeBytes"]).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _inject_visual_profile(config_bytes: bytes) -> bytes:
    matches = list(PROFILE_PATTERN.finditer(config_bytes))
    if len(matches) != 1:
        raise RuntimeError("config.js 必须且只能有一个 production buildProfile")
    match = matches[0]
    original = match.group(0)
    trailing_comma = b"," if original.rstrip().endswith(b",") else b""
    replacement = match.group("indent") + b'buildProfile: "visual-test"' + trailing_comma
    injected = config_bytes[:match.start()] + replacement + config_bytes[match.end():]
    if injected.count(b'buildProfile: "visual-test"') != 1:
        raise RuntimeError("visual-test buildProfile 注入失败")
    cloud_matches = list(CLOUD_ENV_PATTERN.finditer(injected))
    if len(cloud_matches) != 1:
        raise RuntimeError("config.js 必须且只能有一个 cloudEnvId")
    cloud_match = cloud_matches[0]
    cloud_original = cloud_match.group(0)
    cloud_comma = b"," if cloud_original.rstrip().endswith(b",") else b""
    cloud_replacement = cloud_match.group("indent") + b'cloudEnvId: ""' + cloud_comma
    injected = injected[:cloud_match.start()] + cloud_replacement + injected[cloud_match.end():]
    if injected.count(b'cloudEnvId: ""') != 1:
        raise RuntimeError("visual-test cloudEnvId 清空失败")
    return injected


def _read_version(config_bytes: bytes) -> str:
    match = SEMVER_PATTERN.search(config_bytes)
    if not match:
        raise RuntimeError("config.js 没有三段式 appVersion")
    return match.group("version").decode("ascii")


def _assert_demo_boundary(payloads: dict[str, bytes]) -> None:
    app = payloads["app.js"]
    if b'config.buildProfile === "visual-test"' not in app or b"visual-test-offline" not in app:
        raise RuntimeError("小程序启动阶段缺少 visual-test 离线闸门")
    demo = payloads["utils/account-demo.js"]
    if b"visual-test" not in demo or b"isVisualTestBuild" not in demo:
        raise RuntimeError("Demo 适配器缺少编译期 visual-test 闸门")
    forbidden_calls = (b"wx.cloud", b"requestPayment", b"createRechargeOrder", b"queryRechargeOrder")
    for token in forbidden_calls:
        if token in demo:
            raise RuntimeError(f"Demo 适配器禁止调用真实服务：{token.decode('ascii')}")
    for relative in REQUIRED_DEMO_FILES[:3]:
        page = payloads[relative]
        if b"accountDemo.resolve(options)" not in page:
            raise RuntimeError(f"页面缺少 Demo 运行期闸门：{relative}")


def _write_stage(stage: Path, payloads: dict[str, bytes]) -> None:
    for name, data in payloads.items():
        target = stage.joinpath(*PurePosixPath(name).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def _deterministic_zip(source_directory: Path, output: Path) -> None:
    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(source_directory.rglob("*"), key=lambda item: item.relative_to(source_directory).as_posix()):
            if not path.is_file():
                continue
            relative = path.relative_to(source_directory).as_posix()
            info = ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)


def _publish_file_without_overwrite(source: Path, destination: Path) -> str:
    if destination.exists():
        if not destination.is_file() or _sha256_file(source) != _sha256_file(destination):
            raise RuntimeError(f"已有不同内容的候选产物，拒绝覆盖：{destination}")
        return "reused"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    return "created"


def _directory_snapshot(directory: Path) -> dict[str, str]:
    return {
        path.relative_to(directory).as_posix(): _sha256_file(path)
        for path in sorted(directory.rglob("*"), key=lambda item: item.relative_to(directory).as_posix())
        if path.is_file()
    }


def _publish_directory_without_overwrite(source: Path, destination: Path) -> str:
    if destination.exists():
        if not destination.is_dir() or _directory_snapshot(source) != _directory_snapshot(destination):
            raise RuntimeError(f"已有不同内容的候选目录，拒绝覆盖：{destination}")
        return "reused"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)
    return "created"


def package_candidate(source_root: Path, output_root: Path, source_label: str = "working-tree-snapshot") -> dict:
    source_root = source_root.expanduser().resolve()
    output_root = output_root.expanduser().resolve()
    if not source_root.is_dir():
        raise RuntimeError(f"源目录不存在：{source_root}")
    for protected in (*REQUIRED_RUNTIME_DIRECTORIES, *OPTIONAL_RUNTIME_DIRECTORIES):
        protected_root = (source_root / protected).resolve()
        if output_root == protected_root or _is_relative_to(output_root, protected_root):
            raise RuntimeError(f"输出目录不能放在候选包运行时目录内：{output_root}")

    paths = _collect_source_files(source_root)
    source_payloads, source_entries = _snapshot_files(source_root, paths)
    _assert_demo_boundary(source_payloads)
    source_config = source_payloads["config.js"]
    if b'buildProfile: "production"' not in source_config:
        raise RuntimeError("源 config.js 必须保持 production，只允许在隔离副本注入 visual-test")

    version = _read_version(source_config)
    source_snapshot_sha256 = _snapshot_sha256(source_entries)
    payloads = dict(source_payloads)
    payloads["config.js"] = _inject_visual_profile(source_config)
    package_entries = [
        {"path": name, "sha256": _sha256_bytes(data), "sizeBytes": len(data)}
        for name, data in sorted(payloads.items())
    ]
    package_snapshot_sha256 = _snapshot_sha256(package_entries)
    artifact_name = f"wechat-miniapp-account-visual-test-v{version}-{package_snapshot_sha256[:12]}"
    manifest = {
        "schemaVersion": 1,
        "contract": "account-visual-test-candidate",
        "artifactName": artifact_name,
        "appVersion": version,
        "buildProfile": "visual-test",
        "sourceLabel": str(source_label or "working-tree-snapshot"),
        "sourceSnapshotSha256": source_snapshot_sha256,
        "packageSnapshotSha256": package_snapshot_sha256,
        "releaseEligible": False,
        "g3Status": "pending",
        "demo": {
            "queryRequired": True,
            "query": "demo=1",
            "pages": ["user-center", "recharge", "records"],
        },
        "safety": {
            "cloudFunctionsIncluded": False,
            "cloudInitializationAllowed": False,
            "credentialsIncluded": False,
            "productionUploadAllowed": False,
            "productionDeploymentAllowed": False,
            "productionConfigurationWritesAllowed": False,
            "productionDataWritesAllowed": False,
            "realPaymentAllowed": False,
        },
        "injection": {
            "path": "config.js",
            "sourceSha256": _sha256_bytes(source_config),
            "candidateSha256": _sha256_bytes(payloads["config.js"]),
            "sourceProfile": "production",
            "candidateProfile": "visual-test",
            "candidateCloudEnvId": "",
        },
        "files": package_entries,
    }
    manifest_bytes = _json_bytes(manifest)

    output_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="account-visual-test-") as temp:
        temporary_root = Path(temp)
        stage = temporary_root / artifact_name
        stage.mkdir()
        _write_stage(stage, payloads)
        (stage / MANIFEST_NAME).write_bytes(manifest_bytes)
        zip_source = temporary_root / f"{artifact_name}.zip"
        _deterministic_zip(stage, zip_source)
        manifest_source = temporary_root / f"{artifact_name}.manifest.json"
        manifest_source.write_bytes(manifest_bytes)

        final_directory = output_root / artifact_name
        final_zip = output_root / f"{artifact_name}.zip"
        final_manifest = output_root / f"{artifact_name}.manifest.json"
        directory_status = _publish_directory_without_overwrite(stage, final_directory)
        zip_status = _publish_file_without_overwrite(zip_source, final_zip)
        manifest_status = _publish_file_without_overwrite(manifest_source, final_manifest)

    summary = {
        "ok": True,
        "artifactName": artifact_name,
        "appVersion": version,
        "buildProfile": "visual-test",
        "releaseEligible": False,
        "g3Status": "pending",
        "candidateDirectory": str(final_directory),
        "zipPath": str(final_zip),
        "zipSha256": _sha256_file(final_zip),
        "zipSizeBytes": final_zip.stat().st_size,
        "manifestPath": str(final_manifest),
        "manifestSha256": _sha256_file(final_manifest),
        "sourceSnapshotSha256": source_snapshot_sha256,
        "packageSnapshotSha256": package_snapshot_sha256,
        "fileCount": len(package_entries),
        "publishStatus": {
            "directory": directory_status,
            "zip": zip_status,
            "manifest": manifest_status,
        },
    }
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成离线账户三页 visual-test 候选包。")
    parser.add_argument("--source-root", type=Path, default=ROOT, help="小程序源目录")
    parser.add_argument(
        "--output-root",
        type=Path,
        default=ROOT / "artifacts" / "account-visual-test",
        help="候选目录、ZIP 和 manifest 的输出目录",
    )
    parser.add_argument("--source-label", default="working-tree-snapshot", help="manifest 中的源码来源标签")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        summary = package_candidate(args.source_root, args.output_root, args.source_label)
    except Exception as error:
        print(f"account visual-test package: FAILED: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
