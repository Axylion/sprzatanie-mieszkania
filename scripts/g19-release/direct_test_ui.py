"""Publish the approved archive to the canonical slot of the test Pages project."""
import os
from pathlib import Path
import tempfile

import release as release

SOURCE = "64d2d70eaf891781fde264178efce19e24c18b0c"
ARCHIVE = "693997e8ae2477ddd46d68a535dbcc64fc76788fe53e7938a68c00fc572e675b"
UI8 = "c4bcf201-9463-4f6a-94f3-f80a0462ce43"
URL = "https://goleszan-19-preview.pages.dev/"
MANIFEST = {
    "source_sha": SOURCE,
    "expected_file_count": 68,
    "service_worker_version": "goleszan19-shell-v13-11-0-f1-ui10-r3-polish",
    "supabase_url": "https://pbsubdmuupwmtgzncxmh.supabase.co",
}


def artifact():
    candidate = Path("direct-ui-candidate")
    build = release.read_json(candidate / "build.json")
    release.require(build["artifact_sha256"] == ARCHIVE, "Unexpected archive SHA-256")
    return release.verify_zip(candidate, build, MANIFEST)


def main():
    release.require(os.environ["GITHUB_REF"] == "refs/tags/g19-direct-test-ui-64d2d70",
                    "Unexpected release ref")
    files = artifact()
    baseline = release.snapshot()
    release.require(baseline["url"] == URL and baseline["production_branch"] == "main"
                    and baseline["production_id"] == UI8, "Unexpected active test deployment")
    rollback = release.deployment(UI8, "production")
    release.require(rollback["deployment_trigger"]["metadata"]["commit_hash"] ==
                    "e8b0bf30b5cb8b14b5600502fb973ac6b8fb2de3", "Unexpected rollback source SHA")
    record = {"run_id": int(os.environ["GITHUB_RUN_ID"]), "source_sha": SOURCE,
              "artifact_sha256": ARCHIVE, "baseline": baseline, "status": "preflight-passed"}
    release.save(record)
    print(f"Active test deployment and rollback confirmed: {UI8}", flush=True)
    with tempfile.TemporaryDirectory() as directory:
        release.stable(release.snapshot(), baseline)
        record["deployment"] = release.deploy(Path(directory), files, MANIFEST, "main",
                                               "production", record)
        release.save(record)
    active = release.snapshot()
    release.stable(active, baseline, new_production=True)
    deployed = record["deployment"]
    release.require(active["production_id"] == deployed["id"] and deployed["url"] == URL,
                    "New deployment is not active on the canonical test URL")
    print(f"Cloudflare Deployment ID: {deployed['id']}", flush=True)
    release.check_served(URL, files)
    release.deployment(UI8, "production")
    release.require(release.snapshot() == active, "Active deployment changed during verification")
    record.update(status="success", verified_files=len(files))
    release.save(record)
    print(f"HTTP 200 and SHA-256 verified for {len(files)} files at {URL}", flush=True)


if __name__ == "__main__":
    main()
