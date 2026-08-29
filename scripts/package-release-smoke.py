"""package-release.py 的窄 smoke：覆盖闸门入口和不可覆盖产物原语。"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "package-release.py"


def load_module():
    spec = importlib.util.spec_from_file_location("package_release_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 package-release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PACKAGE = load_module()


class PackageReleaseSmoke(unittest.TestCase):
    def test_direct_write_requires_context(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--release-context", result.stderr + result.stdout)

    def test_check_only_does_not_write_zip(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--check-only", "--source-tree", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("未写入 ZIP", result.stdout)
        summary = json.loads(result.stdout.splitlines()[-1])
        self.assertTrue(summary["checkOnly"])
        self.assertRegex(summary["version"], r"^\d+\.\d+\.\d+$")

    def test_lockfile_root_versions_are_checked(self):
        with tempfile.TemporaryDirectory(prefix="package-release-lock-smoke-") as temp:
            path = Path(temp) / "package-lock.json"
            valid = {"version": "1.2.3", "packages": {"": {"version": "1.2.3"}}}
            path.write_text(json.dumps(valid), encoding="utf-8")
            PACKAGE._validate_lockfile_version(path, "1.2.3")

            invalid = {"version": "1.2.4", "packages": {"": {"version": "1.2.3"}}}
            path.write_text(json.dumps(invalid), encoding="utf-8")
            with self.assertRaises(RuntimeError):
                PACKAGE._validate_lockfile_version(path, "1.2.3")

            invalid["version"] = "1.2.3"
            invalid["packages"][""]["version"] = "1.2.4"
            path.write_text(json.dumps(invalid), encoding="utf-8")
            with self.assertRaises(RuntimeError):
                PACKAGE._validate_lockfile_version(path, "1.2.3")

    def test_artifact_name_binds_version_and_commit(self):
        commit = "a" * 40
        self.assertEqual(
            PACKAGE._validate_artifact_name(
                f"wechat-miniapp-release-v1.2.3-{commit[:12]}.zip",
                "1.2.3",
                commit,
            ),
            commit[:12],
        )
        with self.assertRaises(RuntimeError):
            PACKAGE._validate_artifact_name(
                f"wechat-miniapp-release-v1.2.4-{commit[:12]}.zip",
                "1.2.3",
                commit,
            )

    def test_atomic_publish_is_idempotent_and_never_overwrites(self):
        with tempfile.TemporaryDirectory(prefix="package-release-atomic-smoke-") as temp:
            directory = Path(temp)
            output = directory / "wechat-miniapp-release-v1.2.3-aaaaaaaa.zip"
            first = directory / "first.tmp"
            first.write_bytes(b"same")
            self.assertEqual(PACKAGE._publish_without_overwrite(first, output), "新建")

            second = directory / "second.tmp"
            second.write_bytes(b"same")
            self.assertEqual(PACKAGE._publish_without_overwrite(second, output), "幂等复用")

            different = directory / "different.tmp"
            different.write_bytes(b"different")
            with self.assertRaises(RuntimeError):
                PACKAGE._publish_without_overwrite(different, output)
            self.assertEqual(output.read_bytes(), b"same")

    def test_context_expiry_is_rejected(self):
        commit = "b" * 40
        with tempfile.TemporaryDirectory(prefix="package-release-context-smoke-") as temp:
            context_path = Path(temp) / "context.json"
            context = {
                "schemaVersion": 1,
                "operationId": "smoke-operation",
                "canonicalRepo": str(ROOT),
                "version": "1.2.3",
                "sourceCommit": commit,
                "releaseCommit": commit,
                "treeSha": commit,
                "sourceSha256": "c" * 64,
                "artifactPath": str(Path(temp) / f"wechat-miniapp-release-v1.2.3-{commit}.zip"),
                "expiresAt": "2000-01-01T00:00:00Z",
            }
            context_path.write_text(json.dumps(context), encoding="utf-8")
            with self.assertRaises(RuntimeError):
                PACKAGE.load_release_context(context_path)

    def test_schema2_context_requires_and_accepts_queue_bindings(self):
        commit = "d" * 40
        with tempfile.TemporaryDirectory(prefix="package-release-context-v2-smoke-") as temp:
            directory = Path(temp)
            context_path = directory / "context.json"
            artifact = directory / f"wechat-miniapp-release-v1.2.3-{commit}.zip"
            context = {
                "schemaVersion": 2,
                "operationId": "op-schema2-smoke",
                "canonicalRepo": str(ROOT),
                "version": "1.2.3",
                "sourceCommit": commit,
                "releaseCommit": commit,
                "treeSha": commit,
                "sourceSha256": "e" * 64,
                "artifactPath": str(artifact),
                "baseHead": "f" * 40,
                "phase": "prepared",
                "expiresAt": "2099-01-01T00:00:00Z",
            }
            context_path.write_text(json.dumps(context), encoding="utf-8")
            loaded = PACKAGE.load_release_context(context_path)
            self.assertEqual(loaded["schemaVersion"], 2)
            self.assertEqual(loaded["baseHead"], "f" * 40)

            invalid = dict(context)
            invalid.pop("baseHead")
            context_path.write_text(json.dumps(invalid), encoding="utf-8")
            with self.assertRaises(RuntimeError):
                PACKAGE.load_release_context(context_path)


if __name__ == "__main__":
    unittest.main()
