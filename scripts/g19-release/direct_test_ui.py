"""Publish the approved archive to the canonical slot of the test Pages project."""
import os
from pathlib import Path
import tempfile
import time

import release as release

SOURCE = "884b9bb3442b797ae0e5fd5f5af7f1f5b3f4df11"
ARCHIVE = "fa8d925eeca3e8c0eeddce78096048c3b0eb6919799f4a3f7cf7f8a7f659f913"
ACTIVE = "1d0d914e-8209-42aa-9601-bbf080b2c3b0"
UI8 = "c4bcf201-9463-4f6a-94f3-f80a0462ce43"
URL = "https://goleszan-19-preview.pages.dev/"
MANIFEST = release.read_json(Path("direct-ui-candidate/manifest.json"))


def artifact():
    candidate = Path("direct-ui-candidate")
    release.require(MANIFEST["source_sha"] == SOURCE, "Unexpected source SHA")
    build = release.read_json(candidate / "build.json")
    release.require(build["artifact_sha256"] == ARCHIVE, "Unexpected archive SHA-256")
    return release.verify_zip(candidate, build, MANIFEST)


def main():
    release.require(os.environ["GITHUB_REF"] == "refs/tags/g19-direct-test-ui-884b9bb",
                    "Unexpected release ref")
    files = artifact()
    baseline = release.snapshot()
    release.require(baseline["url"] == URL and baseline["production_branch"] == "main"
                    and baseline["production_id"] == ACTIVE, "Unexpected active test deployment")
    release.deployment(ACTIVE, "production")
    rollback = release.deployment(UI8, "production")
    release.require(rollback["deployment_trigger"]["metadata"]["commit_hash"] ==
                    "e8b0bf30b5cb8b14b5600502fb973ac6b8fb2de3", "Unexpected rollback source SHA")
    record = {"run_id": int(os.environ["GITHUB_RUN_ID"]), "source_sha": SOURCE,
              "artifact_sha256": ARCHIVE, "baseline": baseline, "ui8_rollback": UI8,
              "status": "preflight-passed"}
    release.save(record)
    print(f"Active test deployment confirmed: {ACTIVE}; UI8 rollback confirmed: {UI8}", flush=True)
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
    for attempt in range(5):
        try:
            release.check_served(URL, files)
            break
        except (ValueError, OSError):
            if attempt == 4:
                raise
            release.require(release.snapshot() == active, "Active deployment changed during verification")
            time.sleep(5 * (attempt + 1))
    release.deployment(ACTIVE, "production")
    release.deployment(UI8, "production")
    release.require(release.snapshot() == active, "Active deployment changed during verification")
    record.update(status="success", verified_files=len(files))
    release.save(record)
    print(f"HTTP 200 and SHA-256 verified for {len(files)} files at {URL}", flush=True)


if __name__ == "__main__":
    main()
