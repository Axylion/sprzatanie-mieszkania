"""Publish the approved archive to the canonical slot of the test Pages project."""
import os
from pathlib import Path
import tempfile

import release as release

SOURCE = "b224f45dc196a6bb2d0647225d9a80ac02bedef7"
ARCHIVE = "0286028e8a51807e12cc4e05d1c7259258d71dfb942aa40529559585d68e7bb7"
ACTIVE = "19ba5519-e826-4b28-b68b-31335cedd94b"
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
    release.require(os.environ["GITHUB_REF"] == "refs/tags/g19-direct-test-ui-b224f45",
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
    release.check_served(URL, files)
    release.deployment(ACTIVE, "production")
    release.deployment(UI8, "production")
    release.require(release.snapshot() == active, "Active deployment changed during verification")
    record.update(status="success", verified_files=len(files))
    release.save(record)
    print(f"HTTP 200 and SHA-256 verified for {len(files)} files at {URL}", flush=True)


if __name__ == "__main__":
    main()
