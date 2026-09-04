"""package-release.py 的窄 smoke：覆盖闸门入口和不可覆盖产物原语。"""

from __future__ import annotations

import importlib.util
import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
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
PAYMENT_FUNCTION_NAMES = (
    "payment-api",
    "payment-notify",
    "payment-reconcile",
)


def create_payment_source(directory: Path) -> Path:
    source = directory / "source"
    scripts_root = source / "scripts"
    scripts_root.mkdir(parents=True)
    shutil.copy2(
        ROOT / PACKAGE.PAYMENT_MANIFEST_RELATIVE,
        scripts_root / "payment-cloudfunctions.json",
    )
    cloudfunctions_root = source / "cloudfunctions"
    for name in ("payment-core", *PAYMENT_FUNCTION_NAMES):
        shutil.copytree(
            ROOT / "cloudfunctions" / name,
            cloudfunctions_root / name,
            ignore=shutil.ignore_patterns("node_modules"),
        )
    return source


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


class PackageReleaseSmoke(unittest.TestCase):
    def _create_git_repository(self, root: Path) -> tuple[Path, str, str]:
        canonical = root / "wechat-miniapp"
        canonical.mkdir(parents=True)
        commands = (
            ("init",),
            ("config", "user.email", "package-release-smoke@example.invalid"),
            ("config", "user.name", "Package Release Smoke"),
        )
        for command in commands:
            subprocess.run(
                ["git", "-C", str(canonical), *command],
                check=True,
                capture_output=True,
            )
        (canonical / "probe.txt").write_text("linked worktree\n", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(canonical), "add", "probe.txt"],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "-C", str(canonical), "commit", "-m", "probe"],
            check=True,
            capture_output=True,
        )
        commit = subprocess.run(
            ["git", "-C", str(canonical), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        tree = subprocess.run(
            ["git", "-C", str(canonical), "rev-parse", "HEAD^{tree}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        policy = {
            "schemaVersion": 1,
            "canonicalRepo": str(canonical),
            "contextRoot": str(root / "wechat-miniapp-release-contexts"),
            "worktreeRoot": str(root / "wechat-miniapp-release-worktrees"),
        }
        (root / PACKAGE.POLICY_FILENAME).write_text(
            json.dumps(policy), encoding="utf-8"
        )
        return canonical, commit, tree

    def _write_linked_context(
        self,
        root: Path,
        canonical: Path,
        worktree: Path,
        operation_id: str,
        commit: str,
        tree: str,
    ) -> Path:
        context_root = root / "wechat-miniapp-release-contexts"
        context_root.mkdir(exist_ok=True)
        context_path = context_root / f"release-{operation_id}.json"
        context = {
            "schemaVersion": 2,
            "operationId": operation_id,
            "canonicalRepo": str(canonical),
            "releaseWorktree": str(worktree),
            "version": "1.2.3",
            "sourceCommit": commit,
            "releaseCommit": commit,
            "treeSha": tree,
            "sourceSha256": "e" * 64,
            "artifactPath": str(
                root / f"wechat-miniapp-release-v1.2.3-{commit[:12]}.zip"
            ),
            "baseHead": commit,
            "phase": "prepared",
            "expiresAt": "2099-01-01T00:00:00Z",
        }
        context_path.write_text(json.dumps(context), encoding="utf-8")
        return context_path

    def test_payment_functions_are_production_authorized_formal_package_requirements(self):
        version = PACKAGE.read_version(ROOT)
        manifest = PACKAGE._validate_payment_manifest(ROOT, version)
        self.assertIsNotNone(manifest)
        self.assertTrue(manifest["productionDeployment"]["enabled"])
        self.assertTrue(manifest["productionDeployment"]["automaticDeployment"])
        required = PACKAGE._required_files(ROOT)
        self.assertIn("scripts/payment-cloudfunctions.json", required)
        self.assertIn("cloudfunctions/payment-core/index.js", required)
        for item in manifest["functions"]:
            self.assertIn(item["entry"], required)
            self.assertIn(item["packageJson"], required)
            self.assertIn(item["packageLock"], required)
            self.assertIn(item["config"], required)
            for runtime_file in item.get("runtimeFiles", []):
                self.assertIn(runtime_file, required)
            self.assertIn(f"{item['vendoredCoreRoot']}/index.js", required)
        self.assertIn("cloudfunctions/payment-reconcile/monitor.js", required)

    def test_payment_production_contract_rejects_partial_or_extra_activation(self):
        version = PACKAGE.read_version(ROOT)
        manifest_path = (ROOT / PACKAGE.PAYMENT_MANIFEST_RELATIVE).resolve()
        original_read_json = PACKAGE._read_json
        valid_manifest = PACKAGE._validate_payment_manifest(ROOT, version)
        mutations = [
            ("production disabled", lambda value: value["productionDeployment"].update(enabled=False)),
            ("function disabled", lambda value: value["functions"][0].update(deploymentEnabled=False)),
            ("runtime switch disabled", lambda value: value["functions"][0]["runtimeSwitches"].update(orderCreationEnabled=False)),
            ("notify route changed", lambda value: value["functions"][1]["httpRoute"].update(path="/wrong")),
            ("reconcile cron changed", lambda value: value["functions"][2]["timer"].update(cron="0 0 * * * * *")),
        ]
        for label, mutate in mutations:
            with self.subTest(label=label):
                invalid_manifest = copy.deepcopy(valid_manifest)
                mutate(invalid_manifest)

                def fake_read_json(path, json_label):
                    if Path(path).resolve() == manifest_path:
                        return invalid_manifest
                    return original_read_json(path, json_label)

                with mock.patch.object(PACKAGE, "_read_json", side_effect=fake_read_json):
                    with self.assertRaises(RuntimeError):
                        PACKAGE._validate_payment_manifest(ROOT, version)

    def test_payment_client_invocation_permissions_are_hard_gated(self):
        version = PACKAGE.read_version(ROOT)
        manifest_path = (ROOT / PACKAGE.PAYMENT_MANIFEST_RELATIVE).resolve()
        original_read_json = PACKAGE._read_json
        expected = {
            "payment-api": True,
            "payment-notify": False,
            "payment-reconcile": False,
        }

        manifest = PACKAGE._validate_payment_manifest(ROOT, version)
        self.assertEqual(
            {item["name"]: item["clientInvocationAllowed"] for item in manifest["functions"]},
            expected,
        )

        for function_name, allowed in expected.items():
            with self.subTest(function_name=function_name):
                invalid_manifest = copy.deepcopy(manifest)
                item = next(
                    entry for entry in invalid_manifest["functions"]
                    if entry["name"] == function_name
                )
                item["clientInvocationAllowed"] = not allowed

                def fake_read_json(path, label):
                    if Path(path).resolve() == manifest_path:
                        return invalid_manifest
                    return original_read_json(path, label)

                with mock.patch.object(PACKAGE, "_read_json", side_effect=fake_read_json):
                    with self.assertRaises(RuntimeError):
                        PACKAGE._validate_payment_manifest(ROOT, version)

    def test_payment_runtime_files_are_formal_package_requirements(self):
        version = PACKAGE.read_version(ROOT)
        manifest_path = (ROOT / PACKAGE.PAYMENT_MANIFEST_RELATIVE).resolve()
        original_read_json = PACKAGE._read_json
        manifest = PACKAGE._validate_payment_manifest(ROOT, version)
        reconcile = next(
            item for item in manifest["functions"]
            if item["name"] == "payment-reconcile"
        )
        self.assertEqual(
            reconcile["runtimeFiles"],
            ["cloudfunctions/payment-reconcile/monitor.js"],
        )

        invalid_manifest = copy.deepcopy(manifest)
        invalid_reconcile = next(
            item for item in invalid_manifest["functions"]
            if item["name"] == "payment-reconcile"
        )
        invalid_reconcile["runtimeFiles"] = [
            "cloudfunctions/payment-reconcile/missing-monitor.js"
        ]

        def fake_read_json(path, label):
            if Path(path).resolve() == manifest_path:
                return invalid_manifest
            return original_read_json(path, label)

        with mock.patch.object(PACKAGE, "_read_json", side_effect=fake_read_json):
            with self.assertRaisesRegex(RuntimeError, "缺少运行时文件"):
                PACKAGE._validate_payment_manifest(ROOT, version)

    def test_payment_runtime_require_manifest_is_fixed(self):
        version = PACKAGE.read_version(ROOT)
        with tempfile.TemporaryDirectory(prefix="package-release-payment-runtime-") as temp:
            source = create_payment_source(Path(temp))
            PACKAGE._validate_payment_manifest(source, version)
            manifest_path = source / PACKAGE.PAYMENT_MANIFEST_RELATIVE
            manifest = read_json(manifest_path)
            manifest["sharedCore"]["runtimeRequire"] = "aips-payment-core"
            write_json(manifest_path, manifest)

            with self.assertRaisesRegex(
                RuntimeError,
                r"runtimeRequire 必须为 \./vendor/payment-core",
            ):
                PACKAGE._validate_payment_manifest(source, version)

    def test_all_payment_entries_directly_require_vendored_core(self):
        version = PACKAGE.read_version(ROOT)
        with tempfile.TemporaryDirectory(prefix="package-release-payment-entry-") as temp:
            source = create_payment_source(Path(temp))
            PACKAGE._validate_payment_manifest(source, version)
            for name in PAYMENT_FUNCTION_NAMES:
                with self.subTest(function_name=name):
                    entry_path = source / "cloudfunctions" / name / "index.js"
                    valid_source = entry_path.read_text(encoding="utf-8")
                    invalid_source = valid_source.replace(
                        'require("./vendor/payment-core")',
                        'require("aips-payment-core")',
                        1,
                    )
                    self.assertNotEqual(invalid_source, valid_source)
                    entry_path.write_text(invalid_source, encoding="utf-8")
                    with self.assertRaisesRegex(
                        RuntimeError,
                        rf"{name} 必须从 \./vendor/payment-core 直接加载 payment-core",
                    ):
                        PACKAGE._validate_payment_manifest(source, version)
                    entry_path.write_text(valid_source, encoding="utf-8")
            PACKAGE._validate_payment_manifest(source, version)

    def test_payment_packages_and_locks_reject_core_file_dependency(self):
        version = PACKAGE.read_version(ROOT)
        with tempfile.TemporaryDirectory(prefix="package-release-payment-package-") as temp:
            source = create_payment_source(Path(temp))
            PACKAGE._validate_payment_manifest(source, version)
            self.assertTrue(all(
                not (source / "cloudfunctions" / name / "node_modules").exists()
                for name in PAYMENT_FUNCTION_NAMES
            ))

            for name in PAYMENT_FUNCTION_NAMES:
                with self.subTest(function_name=name, file="package.json"):
                    package_path = source / "cloudfunctions" / name / "package.json"
                    package = read_json(package_path)
                    package["dependencies"]["aips-payment-core"] = (
                        "file:vendor/payment-core"
                    )
                    write_json(package_path, package)
                    with self.assertRaisesRegex(
                        RuntimeError,
                        rf"{name} 不得通过 npm file 依赖加载 payment-core",
                    ):
                        PACKAGE._validate_payment_manifest(source, version)
                    del package["dependencies"]["aips-payment-core"]
                    write_json(package_path, package)

                with self.subTest(function_name=name, file="package-lock.json"):
                    lock_path = source / "cloudfunctions" / name / "package-lock.json"
                    package_lock = read_json(lock_path)
                    package_lock["packages"][""]["dependencies"][
                        "aips-payment-core"
                    ] = "file:vendor/payment-core"
                    package_lock["packages"]["node_modules/aips-payment-core"] = {
                        "resolved": "vendor/payment-core",
                        "link": True,
                    }
                    write_json(lock_path, package_lock)
                    with self.assertRaisesRegex(
                        RuntimeError,
                        rf"{name} package-lock 不得保留 payment-core npm 链接",
                    ):
                        PACKAGE._validate_payment_manifest(source, version)
                    del package_lock["packages"][""]["dependencies"][
                        "aips-payment-core"
                    ]
                    del package_lock["packages"]["node_modules/aips-payment-core"]
                    write_json(lock_path, package_lock)
            PACKAGE._validate_payment_manifest(source, version)

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
            [sys.executable, str(SCRIPT), "--check-only", "--source-tree", "."],
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
            with mock.patch.object(PACKAGE, "_validate_context_repository"):
                loaded = PACKAGE.load_release_context(context_path)
            self.assertEqual(loaded["schemaVersion"], 2)
            self.assertEqual(loaded["baseHead"], "f" * 40)

            invalid = dict(context)
            invalid.pop("baseHead")
            context_path.write_text(json.dumps(invalid), encoding="utf-8")
            with self.assertRaises(RuntimeError):
                PACKAGE.load_release_context(context_path)

    def test_context_accepts_registered_operation_worktree(self):
        with tempfile.TemporaryDirectory(prefix="package-release-linked-worktree-") as temp:
            root = Path(temp)
            canonical, commit, tree = self._create_git_repository(root)
            operation_id = "op-linked-worktree-smoke"
            worktree = root / "wechat-miniapp-release-worktrees" / f"release-{operation_id}"
            worktree.parent.mkdir()
            subprocess.run(
                [
                    "git", "-C", str(canonical), "worktree", "add", "--detach",
                    str(worktree), commit,
                ],
                check=True,
                capture_output=True,
            )
            context_path = self._write_linked_context(
                root, canonical, worktree, operation_id, commit, tree
            )
            with mock.patch.object(PACKAGE, "ROOT", worktree):
                loaded = PACKAGE.load_release_context(context_path)
            self.assertEqual(loaded["releaseCommit"], commit)

    def test_context_rejects_same_commit_from_independent_clone(self):
        with tempfile.TemporaryDirectory(prefix="package-release-clone-reject-") as temp:
            root = Path(temp)
            canonical, commit, tree = self._create_git_repository(root)
            operation_id = "op-independent-clone-smoke"
            clone = root / "wechat-miniapp-release-worktrees" / f"release-{operation_id}"
            clone.parent.mkdir()
            subprocess.run(
                ["git", "clone", "--quiet", str(canonical), str(clone)],
                check=True,
                capture_output=True,
            )
            context_path = self._write_linked_context(
                root, canonical, clone, operation_id, commit, tree
            )
            with mock.patch.object(PACKAGE, "ROOT", clone):
                with self.assertRaisesRegex(RuntimeError, "不属于同一 Git 仓库"):
                    PACKAGE.load_release_context(context_path)

    def test_context_rejects_clone_that_self_reports_as_canonical(self):
        with tempfile.TemporaryDirectory(prefix="package-release-canonical-spoof-") as temp:
            root = Path(temp)
            canonical, commit, tree = self._create_git_repository(root)
            operation_id = "op-canonical-spoof-smoke"
            clone = root / "wechat-miniapp-release-worktrees" / f"release-{operation_id}"
            clone.parent.mkdir()
            subprocess.run(
                ["git", "clone", "--quiet", str(canonical), str(clone)],
                check=True,
                capture_output=True,
            )
            context_path = self._write_linked_context(
                root, canonical, clone, operation_id, commit, tree
            )
            context = read_json(context_path)
            context["canonicalRepo"] = str(clone)
            write_json(context_path, context)
            with mock.patch.object(PACKAGE, "ROOT", clone):
                with self.assertRaisesRegex(RuntimeError, "固定发布策略不一致"):
                    PACKAGE.load_release_context(context_path)

    def test_context_rejects_registered_worktree_for_different_operation(self):
        with tempfile.TemporaryDirectory(prefix="package-release-operation-reject-") as temp:
            root = Path(temp)
            canonical, commit, tree = self._create_git_repository(root)
            actual_operation = "op-actual-worktree-smoke"
            context_operation = "op-different-worktree-smoke"
            worktree = (
                root
                / "wechat-miniapp-release-worktrees"
                / f"release-{actual_operation}"
            )
            worktree.parent.mkdir()
            subprocess.run(
                [
                    "git", "-C", str(canonical), "worktree", "add", "--detach",
                    str(worktree), commit,
                ],
                check=True,
                capture_output=True,
            )
            context_path = self._write_linked_context(
                root, canonical, worktree, context_operation, commit, tree
            )
            with mock.patch.object(PACKAGE, "ROOT", worktree):
                with self.assertRaisesRegex(RuntimeError, "不在 operation 固定目录"):
                    PACKAGE.load_release_context(context_path)


if __name__ == "__main__":
    unittest.main()
