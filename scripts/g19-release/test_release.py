"""Local offline release gate tests. No GitHub or Cloudflare requests."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
import zipfile

import release as r

BASE = "aaaaaaaa-0000-0000-0000-000000000000"
PREVIEW = "bbbbbbbb-0000-0000-0000-000000000000"
NEW = "cccccccc-0000-0000-0000-000000000000"
SOURCE = "a" * 40
CONTROL = "b" * 40
VERSION = "offline-test"
WORKER = "g19-test-v1"
MANIFEST = {"name": "Goleszan 19", "version": VERSION, "source_sha": SOURCE,
            "build_command": "true", "output_directory": "dist", "supabase_url": r.SUPABASE,
            "service_worker_version": WORKER, "expected_file_count": None}
SNAPSHOT = {"config_sha256": "c" * 64, "production_id": BASE, "production_branch": "main"}
STAGED = {"id": PREVIEW, "branch": "g19-" + VERSION, "marker": "g19-release-run-8",
          "url": "https://bbbbbbbb." + r.DOMAIN + "/"}
FILES = {
    "index.html": b"manifest.webmanifest serviceWorker",
    "sw.js": f'const CACHE_NAME = "{WORKER}";'.encode(),
    "dyskusje/config.js": b"window.CONFIG = " + json.dumps(
        {"url": r.SUPABASE, "publishableKey": "sb_publishable_example",
         "vapidPublicKey": "", "adminEmail": ""}).encode(),
    "manifest.webmanifest": b'{"display":"standalone","start_url":"./","icons":[{"src":"icon.png"}]}',
    "icon.png": b"mock icon",
}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.archive = self.root / "candidate"
        self.archive.mkdir()
        with zipfile.ZipFile(self.archive / "dist.zip", "w") as z:
            for name, content in FILES.items():
                z.writestr(name, content)
        self.build = {"source_sha": SOURCE, "file_count": len(FILES),
                      "files": {n: r.digest(d) for n, d in FILES.items()},
                      "artifact_sha256": r.digest((self.archive / "dist.zip").read_bytes())}
        (self.archive / "build.json").write_text(json.dumps(self.build))
        identity = {"preview_id": PREVIEW, "source_sha": SOURCE,
                    "artifact_sha256": self.build["artifact_sha256"]}
        self.prior = {"api": {"baseline": SNAPSHOT},
                      "preview": {"baseline": SNAPSHOT, "preview": STAGED, "run_id": 8, "build": self.build},
                      "functional": {"identity": identity, "approved_by": "Axylion",
                                     "automatic": {"published_assets_sha256": "passed"},
                                     "manual": dict.fromkeys(r.CHECKS, "passed")}}
        env = patch.dict(os.environ, GITHUB_RUN_ID="10", GITHUB_SHA=CONTROL,
                         GITHUB_ACTOR="Axylion", GITHUB_STEP_SUMMARY=str(self.root / "summary"))
        env.start()
        self.addCleanup(env.stop)
        self.publisher = Mock(return_value={"id": NEW, "url": "https://" + r.DOMAIN + "/"})
        self.snapshot = Mock(side_effect=[SNAPSHOT, SNAPSHOT, SNAPSHOT | {"production_id": NEW},
                                          SNAPSHOT | {"production_id": NEW}])
        self.preview = Mock(return_value={"url": STAGED["url"], "deployment_trigger": {
            "metadata": {"commit_hash": SOURCE, "branch": STAGED["branch"],
                         "commit_message": STAGED["marker"]}}})
        self.fetch = Mock()
        for name, value in {"snapshot": self.snapshot, "previous": lambda _, s, __: self.prior[s],
                            "deployment": self.preview, "download": self.fetch, "deploy": self.publisher,
                            "save": Mock(), "verify_release_assets": Mock()}.items():
            stub = patch.object(r, name, value)
            stub.start()
            self.addCleanup(stub.stop)

    def production(self):
        r.execute(VERSION, "production", MANIFEST, self.root)

    def blocks(self):
        with self.assertRaises((ValueError, KeyError)):
            self.production()
        self.publisher.assert_not_called()

    def test_production_reuses_exact_verified_files(self):
        self.production()
        self.publisher.assert_called_once()
        self.assertEqual(self.publisher.call_args.args[1], FILES)

    def test_wrong_source_sha(self):
        self.build["source_sha"] = "f" * 40
        self.blocks()

    def test_modified_zip(self):
        with (self.archive / "dist.zip").open("ab") as f:
            f.write(b"modified")
        self.blocks()

    def test_file_digest_mismatch(self):
        self.build["files"]["index.html"] = "0" * 64
        self.blocks()

    def test_missing_zip(self):
        (self.archive / "dist.zip").unlink()
        self.blocks()

    def test_missing_or_expired_artifact_at_github(self):
        # Use original download function captured before patching the stage.
        for artifacts in ([], [{"name": "g19-candidate", "expired": True}]):
            with self.subTest(artifacts=artifacts), patch.object(
                    r, "gh", return_value=json.dumps({"artifacts": artifacts})) as gh:
                with self.assertRaises(ValueError):
                    real_download(8, "g19-candidate", self.root)
                self.assertEqual(gh.call_count, 1)
        self.fetch.side_effect = ValueError("expired")
        self.blocks()

    def test_missing_functional(self):
        del self.prior["functional"]
        self.blocks()

    def test_functional_record_tampered(self):
        self.prior["functional"]["manual"]["mobile"] = "failed"
        self.blocks()

    def test_preview_id_tampered_in_functional_record(self):
        self.prior["functional"]["identity"]["preview_id"] = NEW
        self.blocks()

    def test_live_preview_mismatch(self):
        self.preview.return_value["deployment_trigger"]["metadata"]["commit_hash"] = "d" * 40
        self.blocks()

    def test_production_drift(self):
        self.snapshot.side_effect = [SNAPSHOT, SNAPSHOT | {"production_id": NEW}]
        self.blocks()

    def test_cloudflare_error(self):
        self.snapshot.side_effect = ValueError("Cloudflare API returned HTTP 403")
        self.blocks()

    def test_project_and_domain_guards(self):
        project = dict(name=r.PROJECT, subdomain=r.DOMAIN, domains=[r.DOMAIN], source=None,
                       production_branch="main", canonical_deployment={"id": BASE, "environment": "production"})
        for changes in ({"name": "other"}, {"domains": ["production.example.com"]},
                        {"source": {"type": "github"}}, {"uses_functions": True}):
            with self.subTest(changes=changes), patch.object(r, "cf", return_value=project | changes):
                with self.assertRaises(ValueError):
                    real_snapshot()
        self.publisher.assert_not_called()

    def test_api_stage_get_only_and_no_deploy(self):
        r.execute(VERSION, "api", MANIFEST, self.root)
        self.publisher.assert_not_called()
        self.fetch.assert_not_called()
        with patch.dict(os.environ, CLOUDFLARE_API_TOKEN="synthetic-only", CLOUDFLARE_ACCOUNT_ID=r.ACCOUNT), \
                patch.object(r, "http", return_value=b'{"success": true, "result": {}}') as http:
            self.assertEqual(r.cf(), {})
            self.assertEqual(http.call_args.args[1], {"Authorization": "Bearer synthetic-only"})
            http.side_effect = urllib.error.HTTPError("https://example.invalid", 403, "", None, None)
            with self.assertRaisesRegex(ValueError, "HTTP 403"):
                r.cf()

    def test_preview_upload_keeps_production_active(self):
        self.snapshot.side_effect = [SNAPSHOT] * 3
        self.publisher.return_value = STAGED
        r.execute(VERSION, "preview", MANIFEST, self.root)
        self.publisher.assert_called_once()
        self.assertEqual(self.publisher.call_args.args[3:5], (STAGED["branch"], "preview"))
        self.assertEqual(self.snapshot.call_count, 3)

    def test_preview_rejects_changed_production_after_upload(self):
        self.snapshot.side_effect = [SNAPSHOT, SNAPSHOT, SNAPSHOT | {"production_id": NEW}]
        self.publisher.return_value = STAGED
        with self.assertRaisesRegex(ValueError, "Active Production changed"):
            r.execute(VERSION, "preview", MANIFEST, self.root)
        self.publisher.assert_called_once()

    def test_functional_verifies_the_preview_artifact_without_upload(self):
        r.execute(VERSION, "functional", MANIFEST, self.root)
        r.verify_release_assets.assert_called_once_with(STAGED, FILES, SNAPSHOT, environment="preview", manifest=MANIFEST)
        self.publisher.assert_not_called()

    def test_post_verifies_the_active_artifact_without_upload(self):
        production = {"id": NEW, "url": "https://" + r.DOMAIN + "/"}
        self.prior["production"] = {"identity": self.prior["functional"]["identity"],
                                    "baseline": SNAPSHOT, "production": production}
        self.snapshot.side_effect = [SNAPSHOT | {"production_id": NEW}] * 2
        r.execute(VERSION, "post", MANIFEST, self.root)
        r.verify_release_assets.assert_called_once_with(production, FILES, SNAPSHOT, environment="production", manifest=MANIFEST)
        self.publisher.assert_not_called()

    def test_recreated_tag_or_concurrent_duplicate_rejected(self):
        for items in ([{"id": 7}, {"id": 10}], [{"id": 7}], []):
            with self.subTest(items=items), self.assertRaises(ValueError):
                r.verify_unique_run(items, 10)

    def test_wrong_actor_or_rerun_rejected(self):
        event = self.root / "event.json"
        event.write_text('{"created": true}')
        ref = r.tag(VERSION, "production")
        env = dict(GITHUB_REF_NAME=ref, GITHUB_REF="refs/tags/" + ref,
                   GITHUB_REPOSITORY=r.REPO, GITHUB_EVENT_NAME="push", GITHUB_EVENT_PATH=str(event),
                   GITHUB_ACTOR="Axylion", GITHUB_ACTOR_ID=r.OWNER_ID, GITHUB_TRIGGERING_ACTOR="Axylion",
                   GITHUB_RUN_ATTEMPT="1")
        for overwrite in ({"GITHUB_ACTOR": "other"}, {"GITHUB_ACTOR_ID": "0"},
                          {"GITHUB_RUN_ATTEMPT": "2"}, {"GITHUB_TRIGGERING_ACTOR": "other"}):
            with self.subTest(overwrite=overwrite), patch.dict(os.environ, env | overwrite):
                with self.assertRaisesRegex(ValueError, "Unauthorized"):
                    r.context()
        self.publisher.assert_not_called()

    def test_unsafe_asset_and_secret_rejected(self):
        with self.assertRaises(ValueError):
            r.scan_asset("_worker.js", b"dummy")
        with self.assertRaises(ValueError):
            r.scan_asset("example.txt", b"-----BEGIN PRIVATE KEY-----")


real_download = r.download
real_snapshot = r.snapshot


class ServedFileTests(unittest.TestCase):
    def test_verifies_every_file_with_browser_user_agent(self):
        def fetch(url, headers):
            self.assertEqual(headers["User-Agent"], r.PAGES_USER_AGENT)
            self.assertEqual(headers["Accept-Encoding"], "identity")
            self.assertEqual(headers["Cache-Control"], "no-cache")
            route = url.removeprefix(STAGED["url"]).split("?", 1)[0]
            return FILES[route or "index.html"]

        with patch.object(r, "http", side_effect=fetch) as http:
            r.check_served(STAGED["url"], FILES)
        self.assertEqual(http.call_count, len(FILES))

    def test_rejects_different_bytes(self):
        with patch.object(r, "http", return_value=b"wrong"):
            with self.assertRaisesRegex(ValueError, "Published bytes differ for sw.js"):
                r.check_served(STAGED["url"], {"sw.js": FILES["sw.js"]})

    def test_rejects_non_200_even_with_matching_bytes(self):
        for status in (206, 403):
            with self.subTest(status=status), patch.object(r.urllib.request, "build_opener") as opener:
                opener.return_value.open.return_value.__enter__.return_value = Mock(
                    status=status, read=Mock(return_value=FILES["sw.js"]))
                with self.assertRaisesRegex(ValueError, f"Expected HTTP 200, received HTTP {status}"):
                    r.check_served(STAGED["url"], {"sw.js": FILES["sw.js"]})


if __name__ == "__main__":
    unittest.main()
