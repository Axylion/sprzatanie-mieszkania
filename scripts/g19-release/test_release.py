"""Offline release-gate tests. No GitHub or Cloudflare requests."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

import release as r

BASE = "aaaaaaaa-0000-0000-0000-000000000000"
NEW = "cccccccc-0000-0000-0000-000000000000"
SOURCE = "a" * 40
WORKER = "g19-test-v1"
MANIFEST = {
    "name": "Goleszan 19",
    "version": "offline-test",
    "source_sha": SOURCE,
    "build_command": "true",
    "output_directory": "dist",
    "supabase_url": r.SUPABASE,
    "service_worker_version": WORKER,
    "expected_file_count": None,
}
BASELINE = {
    "config_sha256": "c" * 64,
    "production_id": BASE,
    "production_branch": "main",
    "url": r.PERMANENT_URL,
}
FILES = {
    "index.html": b"manifest.webmanifest serviceWorker",
    "sw.js": f'const CACHE_NAME = "{WORKER}";'.encode(),
    "dyskusje/config.js": b"window.CONFIG = " + json.dumps({
        "url": r.SUPABASE,
        "publishableKey": "sb_publishable_example",
        "vapidPublicKey": "",
        "adminEmail": "",
    }).encode(),
    "manifest.webmanifest": b'{"display":"standalone","start_url":"./","icons":[{"src":"icon.png"}]}',
    "icon.png": b"mock icon",
}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.candidate = self.root / "candidate"
        self.candidate.mkdir()
        with zipfile.ZipFile(self.candidate / "dist.zip", "w") as archive:
            for name, content in FILES.items():
                archive.writestr(name, content)
        self.build = {
            "source_sha": SOURCE,
            "file_count": len(FILES),
            "files": {name: r.digest(data) for name, data in FILES.items()},
            "artifact_sha256": r.digest((self.candidate / "dist.zip").read_bytes()),
        }
        (self.candidate / "build.json").write_text(json.dumps(self.build))
        self.env = patch.dict(
            os.environ,
            GITHUB_RUN_ID="10",
            GITHUB_SHA="b" * 40,
            GITHUB_ACTOR="Axylion",
            GITHUB_STEP_SUMMARY=str(self.root / "summary"),
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_safe_name_rejects_traversal(self):
        for name in ("../secret", "a//b", "/absolute", "a/../b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                r.safe_name(name)

    def test_verify_zip_accepts_exact_candidate(self):
        self.assertEqual(r.verify_zip(self.candidate, self.build, MANIFEST), FILES)

    def test_verify_zip_rejects_changed_archive(self):
        with (self.candidate / "dist.zip").open("ab") as archive:
            archive.write(b"changed")
        with self.assertRaisesRegex(ValueError, "ZIP SHA-256 mismatch"):
            r.verify_zip(self.candidate, self.build, MANIFEST)

    def test_verify_zip_rejects_wrong_source(self):
        build = dict(self.build, source_sha="f" * 40)
        with self.assertRaisesRegex(ValueError, "Source SHA mismatch"):
            r.verify_zip(self.candidate, build, MANIFEST)

    def test_verify_zip_rejects_wrong_expected_artifact_hash(self):
        manifest = dict(MANIFEST, expected_artifact_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "Unexpected build artifact SHA-256"):
            r.verify_zip(self.candidate, self.build, manifest)

    def test_stable_rejects_project_configuration_drift(self):
        changed = dict(BASELINE, config_sha256="d" * 64)
        with self.assertRaisesRegex(ValueError, "configuration changed"):
            r.stable(changed, BASELINE)

    def test_stable_requires_new_production_when_requested(self):
        with self.assertRaisesRegex(ValueError, "Active Production changed"):
            r.stable(BASELINE, BASELINE, new_production=True)

    def test_check_served_only_accepts_permanent_url(self):
        with self.assertRaisesRegex(ValueError, "Only the permanent test URL"):
            r.check_served("https://example.pages.dev/", FILES)

    def test_check_served_compares_every_file_at_permanent_url(self):
        def fetch(url, headers):
            self.assertTrue(url.startswith(r.PERMANENT_URL))
            self.assertEqual(headers["User-Agent"], r.PAGES_USER_AGENT)
            route = url.removeprefix(r.PERMANENT_URL).split("?", 1)[0]
            return FILES[route or "index.html"]

        with patch.object(r, "http", side_effect=fetch) as http:
            r.check_served(r.PERMANENT_URL, FILES)
        self.assertEqual(http.call_count, len(FILES))

    def test_execute_publishes_to_production_and_checks_one_url(self):
        after = dict(BASELINE, production_id=NEW)
        production = {"id": NEW, "url": r.PERMANENT_URL, "branch": "main"}
        with (
            patch.object(r, "snapshot", side_effect=[BASELINE, BASELINE, after, after]),
            patch.object(r, "deployment", return_value={}) as deployment,
            patch.object(r, "download_candidate"),
            patch.object(r, "deploy", return_value=production) as deploy,
            patch.object(r, "check_served") as check_served,
            patch.object(r, "cleanup_previews", return_value={
                "status": "complete", "removed": [], "retained": []
            }),
            patch.object(r, "save"),
        ):
            r.execute("offline-test", MANIFEST, self.root)
        deploy.assert_called_once()
        self.assertEqual(deploy.call_args.args[3], "main")
        check_served.assert_called_once_with(r.PERMANENT_URL, FILES)
        self.assertEqual(
            [call.args for call in deployment.call_args_list],
            [(BASE, "production"), (BASE, "production")],
        )

    def test_execute_stops_on_configuration_drift_before_deploy(self):
        changed = dict(BASELINE, config_sha256="d" * 64)
        with (
            patch.object(r, "snapshot", side_effect=[BASELINE, changed]),
            patch.object(r, "deployment", return_value={}),
            patch.object(r, "download_candidate"),
            patch.object(r, "deploy") as deploy,
            patch.object(r, "save"),
        ):
            with self.assertRaisesRegex(ValueError, "configuration changed"):
                r.execute("offline-test", MANIFEST, self.root)
        deploy.assert_not_called()

    def test_cleanup_refuses_to_delete_non_preview(self):
        with patch.object(r, "cf", return_value={
            "id": BASE, "environment": "production"
        }), patch.object(r.subprocess, "run") as run:
            result = r.cleanup_previews(self.root)
        run.assert_not_called()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["retained"][0]["id"], BASE)

    def test_cleanup_records_cloudflare_refusal_without_hiding_it(self):
        preview = {"id": NEW}
        detail = {
            "id": NEW,
            "environment": "preview",
            "deployment_trigger": {"metadata": {"branch": "g19-old-preview"}},
        }
        with (
            patch.object(r, "all_preview_deployments", return_value=[preview]),
            patch.object(r, "cf", return_value=detail),
            patch.object(r.subprocess, "run", return_value=Mock(returncode=1)),
        ):
            result = r.cleanup_previews(self.root)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["retained"][0]["id"], NEW)


if __name__ == "__main__":
    unittest.main()
