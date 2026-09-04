from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "package-account-visual-test.py"
SPEC = importlib.util.spec_from_file_location("package_account_visual_test", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载候选打包脚本：{SCRIPT}")
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class AccountVisualTestPackageSmoke(unittest.TestCase):
    def test_real_source_build_is_isolated_safe_and_deterministic(self):
        original_config = (ROOT / "config.js").read_bytes()
        self.assertIn(b'buildProfile: "production"', original_config)
        source_paths = PACKAGE._collect_source_files(ROOT)
        source_before, _ = PACKAGE._snapshot_files(ROOT, source_paths)

        with tempfile.TemporaryDirectory(prefix="account-visual-test-smoke-") as temp:
            base = Path(temp)
            first = PACKAGE.package_candidate(ROOT, base / "first", "smoke-source")
            second = PACKAGE.package_candidate(ROOT, base / "second", "smoke-source")

            self.assertFalse(first["releaseEligible"])
            self.assertEqual(first["g3Status"], "pending")
            self.assertEqual(first["buildProfile"], "visual-test")
            self.assertGreater(first["zipSizeBytes"], 0)
            self.assertEqual(first["zipSha256"], second["zipSha256"])
            self.assertEqual(first["manifestSha256"], second["manifestSha256"])
            self.assertEqual((ROOT / "config.js").read_bytes(), original_config)
            source_after, _ = PACKAGE._snapshot_files(ROOT, source_paths)
            self.assertEqual(source_after, source_before)

            candidate = Path(first["candidateDirectory"])
            candidate_config = (candidate / "config.js").read_bytes()
            self.assertIn(b'buildProfile: "visual-test"', candidate_config)
            self.assertNotIn(b'buildProfile: "production"', candidate_config)
            self.assertIn(b'cloudEnvId: ""', candidate_config)
            self.assertNotIn(b'cloudEnvId: "cloud1-', candidate_config)
            self.assertTrue((candidate / "pages/user-center/user-center.js").is_file())
            self.assertTrue((candidate / "pages/recharge/recharge.js").is_file())
            self.assertTrue((candidate / "pages/account-records/account-records.js").is_file())
            self.assertTrue((candidate / "utils/account-demo.js").is_file())
            candidate_app = (candidate / "app.js").read_text(encoding="utf-8")
            self.assertIn('config.buildProfile === "visual-test"', candidate_app)
            self.assertIn("visual-test-offline", candidate_app)
            self.assertFalse((candidate / "cloudfunctions").exists())
            self.assertFalse((candidate / "scripts").exists())
            self.assertFalse((candidate / "project.private.config.json").exists())

            manifest_path = Path(first["manifestPath"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["contract"], "account-visual-test-candidate")
            self.assertFalse(manifest["releaseEligible"])
            self.assertEqual(manifest["g3Status"], "pending")
            self.assertEqual(manifest["demo"]["query"], "demo=1")
            self.assertEqual(manifest["demo"]["pages"], ["user-center", "recharge", "records"])
            self.assertFalse(manifest["safety"]["credentialsIncluded"])
            self.assertFalse(manifest["safety"]["cloudFunctionsIncluded"])
            self.assertFalse(manifest["safety"]["cloudInitializationAllowed"])
            self.assertFalse(manifest["safety"]["productionUploadAllowed"])
            self.assertFalse(manifest["safety"]["productionDeploymentAllowed"])
            self.assertFalse(manifest["safety"]["productionConfigurationWritesAllowed"])
            self.assertFalse(manifest["safety"]["productionDataWritesAllowed"])
            self.assertFalse(manifest["safety"]["realPaymentAllowed"])
            self.assertEqual(manifest["injection"]["sourceProfile"], "production")
            self.assertEqual(manifest["injection"]["candidateProfile"], "visual-test")
            self.assertEqual(manifest["injection"]["candidateCloudEnvId"], "")
            self.assertNotEqual(
                manifest["injection"]["sourceSha256"],
                manifest["injection"]["candidateSha256"],
            )
            self.assertNotIn(str(ROOT), manifest_path.read_text(encoding="utf-8"))

            with ZipFile(first["zipPath"], "r") as archive:
                names = set(archive.namelist())
                self.assertIn("app.js", names)
                self.assertIn("config.js", names)
                self.assertIn(PACKAGE.MANIFEST_NAME, names)
                self.assertFalse(any(name.startswith("cloudfunctions/") for name in names))
                self.assertFalse(any(name.startswith("scripts/") for name in names))
                self.assertFalse(any(Path(name).name.lower() in PACKAGE.FORBIDDEN_FILE_NAMES for name in names))
                self.assertIn(b'buildProfile: "visual-test"', archive.read("config.js"))
                self.assertIn(b'cloudEnvId: ""', archive.read("config.js"))
                zip_manifest = json.loads(archive.read(PACKAGE.MANIFEST_NAME).decode("utf-8"))
                self.assertEqual(zip_manifest, manifest)

    def test_hard_coded_credentials_and_private_keys_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, "硬编码凭据"):
            PACKAGE._scan_credential_bytes(
                PurePosixPath("pages/demo/demo.js"),
                b'const config = { apiKey: "sk-real-value-123456789" };',
            )
        with self.assertRaisesRegex(RuntimeError, "私钥内容"):
            PACKAGE._scan_credential_bytes(
                PurePosixPath("assets/private.txt"),
                b"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
            )
        PACKAGE._scan_credential_bytes(
            PurePosixPath("pages/demo/demo.js"),
            'const config = { apiKey: "", secretKey: "未配置" };'.encode("utf-8"),
        )

    def test_private_paths_and_invalid_profile_injection_are_rejected(self):
        for name in (".env", "project.private.config.json", "assets/client.pem"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                PACKAGE._assert_safe_package_path(PurePosixPath(name))
        with self.assertRaisesRegex(RuntimeError, "production buildProfile"):
            PACKAGE._inject_visual_profile(b'module.exports = { buildProfile: "visual-test" };')

    def test_cli_emits_auditable_summary(self):
        with tempfile.TemporaryDirectory(prefix="account-visual-test-cli-smoke-") as temp:
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--source-root",
                    str(ROOT),
                    "--output-root",
                    temp,
                    "--source-label",
                    "cli-smoke",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(summary["ok"])
            self.assertFalse(summary["releaseEligible"])
            self.assertEqual(summary["g3Status"], "pending")
            self.assertEqual(sha256(Path(summary["zipPath"])), summary["zipSha256"])
            self.assertEqual(sha256(Path(summary["manifestPath"])), summary["manifestSha256"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
