import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import urlsplit

import direct_test_ui as direct
import release as r


FILES = {"index.html": b"home", "sw.js": b"new service worker", "dyskusje/chat.js": b"new chat"}
EXPECTED = "expected-fixture"
UNEXPECTED = "unexpected-fixture"


class PublicationVerificationTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.report_path = Path(tmp.name) / "verification.json"
        self.round = 0

    def verify(self, faults=None, *, delays=(0, 0, 0), budget=180, identities=None):
        faults = faults or {}

        def current():
            self.round += 1
            return next(identities) if identities else EXPECTED

        def fetch(url, headers, *, timeout):
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, r.ASSET_TIMEOUT)
            name = urlsplit(url).path.lstrip("/") or "index.html"
            value = faults.get((self.round + 1) // 2, {}).get(name, FILES[name])
            if isinstance(value, Exception):
                raise value
            return value

        with patch.object(r, "http", side_effect=fetch):
            r.verify_publication(direct.URL, FILES, EXPECTED, current, self.report_path,
                                 delays=delays, budget=budget)

    def report(self):
        return json.loads(self.report_path.read_text())

    def test_all_files_match_first_pass(self):
        self.verify()
        report = self.report()
        self.assertEqual(report["result"], "passed")
        self.assertEqual(len(report["attempts"]), 1)
        self.assertEqual(report["expected_files"], len(FILES))
        self.assertEqual(report["attempts"][0]["matched_files"], len(FILES))

    def test_one_stale_file(self):
        self.verify({1: {"sw.js": b"old"}})
        first, second = self.report()["attempts"]
        self.assertEqual(first["unmatched_paths"], ["sw.js"])
        self.assertEqual(first["files"][1]["actual_sha256"], r.digest(b"old"))
        self.assertEqual(second["checked_files"], len(FILES))

    def test_multiple_stale_files_in_separate_rounds(self):
        self.verify({1: {"sw.js": b"old", "index.html": b"old"}, 2: {"sw.js": b"old"}})
        self.assertEqual([a["matched_files"] for a in self.report()["attempts"]], [1, 2, 3])

    def test_transient_http_404_or_503(self):
        for status in (404, 503):
            with self.subTest(status=status):
                self.round = 0
                self.verify({1: {"sw.js": HTTPError("https://example.invalid", status, "", None, None)}})
                self.assertEqual(self.report()["attempts"][0]["files"][1]["http_status"], status)
                self.assertEqual(self.report()["result"], "passed")

    def test_network_timeout_and_no_secret_in_report(self):
        self.verify({1: {"sw.js": TimeoutError("never-log-this-token")}})
        self.assertEqual(self.report()["attempts"][0]["files"][1]["error"], "timeout")
        self.assertNotIn("never-log-this-token", self.report_path.read_text())

    def test_permanent_sha_mismatch_exhausts_attempts(self):
        faults = {n: {"sw.js": b"old"} for n in (1, 2, 3)}
        with self.assertRaisesRegex(ValueError, "attempts_exhausted"):
            self.verify(faults)
        report = self.report()
        self.assertEqual(len(report["attempts"]), 3)
        self.assertTrue(all(a["checked_files"] == len(FILES) for a in report["attempts"]))
        self.assertTrue(report["finished_at"])

    def test_permanent_unavailable_and_report_on_failure(self):
        error = HTTPError("https://example.invalid", 503, "", None, None)
        with self.assertRaisesRegex(ValueError, "attempts_exhausted"):
            self.verify({1: {"sw.js": error}, 2: {"sw.js": error}}, delays=(0, 0))
        self.assertEqual(self.report()["attempts"][-1]["files"][1]["http_status"], 503)

    def test_deployment_change_aborts_before_or_after_assets(self):
        for ids, checked in [([UNEXPECTED], 0), ([EXPECTED, UNEXPECTED], len(FILES))]:
            with self.subTest(ids=ids), self.assertRaisesRegex(ValueError, "deployment_changed"):
                self.round = 0
                self.verify(identities=iter(ids))
            attempt, = self.report()["attempts"]
            self.assertEqual(attempt["checked_files"], checked)
            self.assertIn(UNEXPECTED, (attempt["deployment_before"], attempt["deployment_after"]))

    def test_time_budget_exhausted_before_next_delay(self):
        with self.assertRaisesRegex(ValueError, "budget_exhausted"):
            self.verify({1: {"sw.js": b"old"}}, delays=(0, 60), budget=3)
        self.assertEqual(len(self.report()["attempts"]), 1)

    def test_unexpected_http_is_terminal(self):
        with self.assertRaisesRegex(ValueError, "non_retryable_file_error"):
            self.verify({1: {"sw.js": HTTPError("https://example.invalid", 403, "", None, None)}})
        self.assertEqual(len(self.report()["attempts"]), 1)

    def test_wrangler_invoked_once_even_if_deployment_discovery_needs_retry(self):
        metadata = {"commit_hash": "a" * 40, "branch": "main",
                    "commit_message": "g19-release-run-10"}
        found = {"id": EXPECTED, "latest_stage": {"status": "success"},
                 "deployment_trigger": {"metadata": metadata}}
        with tempfile.TemporaryDirectory() as temp, patch.object(r, "save"), \
                patch.object(r.subprocess, "run", return_value=Mock(returncode=0)) as wrangler, \
                patch.object(r.time, "sleep"), patch.object(r, "cf", side_effect=[[], [found]]), \
                patch.object(r, "deployment", return_value=found):
            deployed = r.deploy(Path(temp), FILES, {"source_sha": "a" * 40},
                                "main", "production", {"run_id": 10})
        self.assertEqual(deployed["id"], EXPECTED)
        wrangler.assert_called_once()
        self.assertEqual(wrangler.call_args.args[0][1:3], ["pages", "deploy"])

    def test_direct_flow_uploads_once_and_never_rolls_back(self):
        snapshot = {"url": direct.URL, "production_branch": "main",
                    "production_id": direct.ACTIVE, "config_sha256": "same"}
        active = snapshot | {"production_id": EXPECTED}
        deploy = Mock(return_value={"id": EXPECTED, "url": direct.URL})
        verified = r.verify_publication

        def run_verifier(url, files, expected, current, _):
            return verified(url, files, expected, current, self.report_path, delays=(0, 0))

        old_deployment = {"deployment_trigger": {"metadata": {
            "commit_hash": "e8b0bf30b5cb8b14b5600502fb973ac6b8fb2de3"}}}
        for succeeds in (True, False):
            with self.subTest(succeeds=succeeds):
                deploy.reset_mock()
                calls = {"assets": 0}

                def fetch(url, headers, *, timeout):
                    name = urlsplit(url).path.lstrip("/") or "index.html"
                    if name == "sw.js":
                        calls["assets"] += 1
                        if calls["assets"] == 1 or not succeeds:
                            return b"old"
                    return FILES[name]

                with patch.dict(direct.os.environ, GITHUB_REF="refs/tags/g19-direct-test-ui-f64b17f",
                                GITHUB_RUN_ID="10"), patch.object(direct, "artifact", return_value=FILES), \
                        patch.object(r, "snapshot", side_effect=[snapshot, snapshot] + [active] * 6), \
                        patch.object(r, "deployment", return_value=old_deployment), \
                        patch.object(r, "deploy", deploy), patch.object(r, "save"), \
                        patch.object(r, "http", side_effect=fetch), \
                        patch.object(r, "verify_publication", side_effect=run_verifier), \
                        patch.object(r, "subprocess", wraps=r.subprocess) as process, \
                        patch.object(r, "cf") as api:
                    if succeeds:
                        direct.main()
                    else:
                        with self.assertRaisesRegex(ValueError, "attempts_exhausted"):
                            direct.main()
                    deploy.assert_called_once()
                    process.run.assert_not_called()
                    api.assert_not_called()
                    self.assertEqual(calls["assets"], 2)


if __name__ == "__main__":
    unittest.main()
