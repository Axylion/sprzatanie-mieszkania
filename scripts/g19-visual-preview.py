"""Build metadata and publish exclusively to the Goleszan visual Preview."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


PROJECT = "goleszan-19-preview"
DOMAIN = f"{PROJECT}.pages.dev"
BRANCH = "f1-ui-review"
GIT_BRANCH = "feature/g19-visual-review"
ALIAS = f"https://{BRANCH}.{DOMAIN}"
DIST = Path("dist")
METADATA = "visual-preview.json"
POLICY = "connect-src 'self'; form-action 'self'"
SW_VERSION = rb'^const CACHE_NAME = "([^"]+)";$'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def service_worker_version(data):
    match = re.search(SW_VERSION, data, re.MULTILINE)
    require(match, "Service Worker cache version is missing")
    return match[1].decode()


def package():
    sha = os.environ["GITHUB_SHA"]
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "Invalid Git SHA")
    worker = DIST / "sw.js"
    source = worker.read_bytes()
    version = f"{service_worker_version(source)}-preview-{sha}"
    # A new worker must activate even when only CSS or another shell asset changes.
    worker.write_bytes(re.sub(SW_VERSION, f'const CACHE_NAME = "{version}";'.encode(),
                              source, count=1, flags=re.MULTILINE))
    # Keep this restriction in the Preview artifact, including on worker responses.
    (DIST / "_headers").write_text(f"/*\n  Content-Security-Policy: {POLICY}\n")
    assets = {
        path.relative_to(DIST).as_posix(): sha256(path.read_bytes())
        for path in sorted(DIST.rglob("*"))
        if path.is_file() and path.name != "_headers"
    }
    manifest = {
        "sha": sha,
        "service_worker": version,
        "assets": assets,
    }
    (DIST / METADATA).write_text(json.dumps(manifest, sort_keys=True) + "\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get(url, headers=None):
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with opener.open(request, timeout=15) as response:
            require(response.status == 200, f"Expected HTTP 200 at {url}")
            return response.read(), response.headers
    except urllib.error.HTTPError as error:
        raise ValueError(f"HTTP {error.code} at {url}") from None


def cloudflare(path=""):
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    require(re.fullmatch(r"[a-f0-9]{32}", account) and token,
            "Configure Preview-only Cloudflare account ID and API token")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/{PROJECT}{path}"
    body, _ = get(url, {"Authorization": f"Bearer {token}"})
    data = json.loads(body)
    require(data["success"] is True, "Cloudflare API did not report success")
    return data["result"]


def production_snapshot():
    project = cloudflare()
    branch = project["production_branch"]
    active = project["canonical_deployment"]
    require(project["name"] == PROJECT and project["subdomain"] == DOMAIN
            and set(project.get("domains") or []) <= {DOMAIN}
            and project.get("source") is None
            and project.get("uses_functions") is False,
            "Expected the existing Direct Upload Pages project with its pages.dev domain")
    require(branch and re.sub(r"[^a-z0-9]", "-", branch.lower()) != BRANCH
            and branch != GIT_BRANCH,
            "Preview branch could collide with Production")
    require(active and active["environment"] == "production" and active["id"],
            "Could not identify the active Production deployment")
    return project["id"], branch, active["id"]


def find_deployment(marker, sha):
    for attempt in range(12):
        deployments = cloudflare("/deployments?env=preview&per_page=25")
        candidates = [
            item for item in deployments
            if item["deployment_trigger"]["metadata"].get("commit_message") == marker
        ]
        require(len(candidates) <= 1, "Multiple Cloudflare deployments match this run")
        if candidates:
            deployment = candidates[0]
            stage = deployment["latest_stage"]
            require(stage["status"] not in {"failure", "canceled"},
                    "Cloudflare reported a failed Preview deployment")
            if stage["name"] == "deploy" and stage["status"] == "success":
                metadata = deployment["deployment_trigger"]["metadata"]
                url = deployment["url"].rstrip("/")
                require(deployment["environment"] == "preview" and metadata["branch"] == BRANCH
                        and metadata["commit_hash"] == sha
                        and re.fullmatch(r"https://[a-f0-9]+\." + re.escape(DOMAIN), url),
                        "Cloudflare deployment metadata does not match the Preview build")
                return url
        if attempt < 11:
            time.sleep(5)
    raise ValueError("Cloudflare did not confirm the Preview deployment")


def verify_http(base, manifest, marker, *, all_assets=False):
    expected_metadata = (DIST / METADATA).read_bytes()
    assets = dict(manifest["assets"]) if all_assets else {
        "index.html": manifest["assets"]["index.html"],
        "sw.js": manifest["assets"]["sw.js"],
    }
    assets[""] = assets.pop("index.html")
    assets[METADATA] = sha256(expected_metadata)
    for path, expected in assets.items():
        body, headers = get(f"{base}/{path}?verify={marker}", {"Cache-Control": "no-cache"})
        require(sha256(body) == expected, f"Published bytes differ at {base}/{path}")
        require(POLICY in headers.get("Content-Security-Policy", ""),
                f"Preview connection policy is missing at {base}/{path}")
        if path == "sw.js":
            require(service_worker_version(body) == manifest["service_worker"],
                    "Published Service Worker version differs")


def deploy():
    sha = os.environ["GITHUB_SHA"]
    require(os.environ["GITHUB_REF"] == f"refs/heads/{GIT_BRANCH}", "Unexpected Git branch")
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "Invalid Git SHA")
    marker = f'g19-visual-{os.environ["GITHUB_RUN_ID"]}-{os.environ["GITHUB_RUN_ATTEMPT"]}'
    manifest = json.loads((DIST / METADATA).read_bytes())
    require(manifest["sha"] == sha, "Build metadata does not match the workflow SHA")

    # A clean cwd excludes repository Wrangler configuration and Pages Functions.
    with tempfile.TemporaryDirectory() as directory:
        subprocess.run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund",
                        "wrangler@4.168.0"], cwd=directory,
                       env={key: value for key, value in os.environ.items()
                            if key != "CLOUDFLARE_API_TOKEN"}, check=True)
        before = production_snapshot()
        try:
            subprocess.run(
                [str(Path(directory) / "node_modules/.bin/wrangler"), "pages", "deploy",
                 str(DIST.resolve()), "--project-name", PROJECT, "--branch", BRANCH,
                 "--commit-hash", sha, "--commit-message", marker, "--commit-dirty=false"],
                cwd=directory, check=True,
            )
            immutable_url = find_deployment(marker, sha)
            for attempt in range(6):
                try:
                    verify_http(ALIAS, manifest, marker)
                    break
                except ValueError:
                    if attempt == 5:
                        raise
                    time.sleep(5)
            verify_http(immutable_url, manifest, marker, all_assets=True)
        finally:
            require(production_snapshot() == before,
                    "Active Production or its branch changed during this run")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"Preview verified for `{sha}`\n\n- {ALIAS}/\n"
                      f"- {immutable_url}/\n- Service Worker `{manifest['service_worker']}`\n"
                      f"- Production deployment `{before[2]}` confirmed\n")


if __name__ == "__main__":
    try:
        {"package": package, "deploy": deploy}[sys.argv[1]]()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Visual Preview failed: {error}", file=sys.stderr)
        sys.exit(1)
