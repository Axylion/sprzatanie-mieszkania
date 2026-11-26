#!/usr/bin/env python3
"""Build and publish each approved Goleszan release to one permanent Pages URL."""
import base64
from concurrent.futures import ThreadPoolExecutor
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
import urllib.parse
import urllib.request
import zipfile

REPO = "Axylion/sprzatanie-mieszkania"
OWNER = "axylion"
OWNER_ID = "80595490"
CONTROL_BRANCH = "release/goleszan-permanent-test"
WORKFLOW = ".github/workflows/goleszan-pages-release.yml"
ACCOUNT = "6c1ff8f43cd435c244a2f03a7650fe4e"
PROJECT = "goleszan-19-preview"
DOMAIN = PROJECT + ".pages.dev"
PERMANENT_URL = "https://" + DOMAIN + "/"
PAGES_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "Chrome/131.0.0.0 Safari/537.36"
)
SUPABASE = "https://pbsubdmuupwmtgzncxmh.supabase.co"
SHA = r"[0-9a-f]{40}"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
VERSION = r"[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?"
MAX_FILE = 25 * 1024 * 1024
MAX_ARCHIVE_CONTENT = 250 * 1024 * 1024
RETENTION_DAYS = 90


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def safe_name(name):
    require(isinstance(name, str) and all(
        re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", part)
        for part in name.split("/")
    ), "Unsafe path")
    return name


def context():
    env = os.environ
    require(
        env["GITHUB_REPOSITORY"] == REPO
        and env["GITHUB_EVENT_NAME"] == "push"
        and env["GITHUB_ACTOR"].lower() == OWNER
        and env["GITHUB_ACTOR_ID"] == OWNER_ID
        and env["GITHUB_TRIGGERING_ACTOR"].lower() == OWNER
        and env["GITHUB_RUN_ATTEMPT"] == "1"
        and env["GITHUB_REF"] == "refs/heads/" + CONTROL_BRANCH
        and re.fullmatch(SHA, env["GITHUB_SHA"]),
        "Unauthorized, repeated, or unexpected release run",
    )
    event = read_json(Path(env["GITHUB_EVENT_PATH"]))
    require(
        event.get("ref") == "refs/heads/" + CONTROL_BRANCH
        and event.get("after") == env["GITHUB_SHA"]
        and not event.get("deleted")
        and not event.get("forced"),
        "Only a normal push to the permanent-release control branch is accepted",
    )
    message = event.get("head_commit", {}).get("message", "").splitlines()[0]
    match = re.fullmatch(rf"release: publish ({VERSION})", message)
    require(match, "Commit message must be: release: publish <version>")
    version = match.group(1)
    manifest = read_json(
        Path(__file__).resolve().parents[2] / "releases" / (version + ".json")
    )
    require(
        manifest["version"] == version
        and isinstance(manifest["name"], str)
        and bool(manifest["name"].strip())
        and re.fullmatch(SHA, manifest["source_sha"])
        and isinstance(manifest["build_command"], str)
        and bool(manifest["build_command"].strip())
        and manifest["supabase_url"] == SUPABASE
        and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", manifest["service_worker_version"]),
        "Invalid release manifest",
    )
    safe_name(manifest["output_directory"])
    count = manifest.get("expected_file_count")
    require(count is None or (type(count) is int and count > 0),
            "Invalid expected file count")
    expected = manifest.get("expected_artifact_sha256")
    require(expected is None or re.fullmatch(r"[0-9a-f]{64}", expected),
            "Invalid expected artifact SHA-256")
    return version, manifest


def gh(*args):
    env = dict(os.environ)
    env.pop("CLOUDFLARE_API_TOKEN", None)
    return subprocess.check_output(("gh", *args), env=env, text=True)


def runs_for_commit():
    data = json.loads(gh(
        "api", "--paginate", "--slurp", "--method", "GET",
        f"repos/{REPO}/actions/runs",
        "-f", "event=push", "-f", "branch=" + CONTROL_BRANCH,
        "-F", "per_page=100",
    ))
    return [
        run for page in data for run in page["workflow_runs"]
        if run["path"].split("@", 1)[0] == WORKFLOW
        and run["head_branch"] == CONTROL_BRANCH
        and run["head_sha"] == os.environ["GITHUB_SHA"]
    ]


def authorize(manifest):
    current_id = int(os.environ["GITHUB_RUN_ID"])
    items = []
    for _ in range(5):
        items = runs_for_commit()
        if items:
            break
        time.sleep(2)
    require(
        len(items) == 1
        and items[0]["id"] == current_id
        and items[0]["run_attempt"] == 1,
        "Duplicate release run or current run not visible in GitHub",
    )
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        print(f"sha={manifest['source_sha']}", file=output)


def download_candidate(run_id, target):
    data = json.loads(gh(
        "api", f"repos/{REPO}/actions/runs/{run_id}/artifacts?per_page=100"
    ))
    items = [item for item in data["artifacts"] if item["name"] == "g19-candidate"]
    require(
        len(items) == 1 and items[0].get("expired") is False,
        "Build artifact is missing or expired",
    )
    gh(
        "run", "download", str(run_id), "--repo", REPO,
        "--name", "g19-candidate", "--dir", str(target),
    )


def verify_source(actual, expected):
    require(actual == expected and re.fullmatch(SHA, expected), "Source SHA mismatch")


def scan_asset(name, data):
    blocked = {
        "_headers", "_redirects", "_routes.json", "_worker.js", "functions",
        "node_modules", "wrangler.toml", "wrangler.json", "wrangler.jsonc",
    }
    require(
        not (set(name.lower().split("/")) & blocked)
        and Path(name.lower()).suffix not in {".pem", ".key", ".p12", ".pfx"},
        "Server-side control file or private-key path in static artifact",
    )
    patterns = (
        rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----",
        rb"\b(?:sb_secret_|github_pat_|gh[pousr]_|xox[baprs]-|sk-(?:proj-)?)[A-Za-z0-9_-]{15,}",
        rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        rb'https?://[^\s/@:\x22\x27]+:[^\s/@\x22\x27]+@[^\s/\x22\x27]+',
        rb'''(?i)(?:api[_-]?token|password|client[_-]secret|service[_-]role[_-]key)["']?\s*[:=]\s*["'][\w.+/=-]{20,}["']''',
    )
    require(not any(re.search(rule, data) for rule in patterns),
            "Possible credential in static artifact")
    for match in re.finditer(
        rb"eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{12,}", data
    ):
        payload = match[1]
        claims = json.loads(
            base64.urlsafe_b64decode(payload + b"=" * (-len(payload) % 4))
        )
        require(
            claims.get("role") == "anon"
            and claims.get("ref") == SUPABASE.split(".")[0][8:],
            "Unexpected JWT in static artifact",
        )
    origins = re.findall(rb"https://[a-z0-9-]+\.supabase\.co\b", data, re.I)
    require(all(origin == SUPABASE.encode() for origin in origins),
            "Unexpected Supabase origin")


def check_app(files, manifest):
    config = files["dyskusje/config.js"].decode()
    settings = json.loads(config[config.index("{"):config.rindex("}") + 1])
    require(
        set(settings) == {"url", "publishableKey", "vapidPublicKey", "adminEmail"}
        and settings["url"] == manifest["supabase_url"]
        and re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", settings["publishableKey"])
        and (
            not settings["vapidPublicKey"]
            or re.fullmatch(r"B[A-Za-z0-9_-]{86}", settings["vapidPublicKey"])
        )
        and (
            not settings["adminEmail"]
            or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", settings["adminEmail"])
        ),
        "Unexpected frontend configuration",
    )
    worker = files["sw.js"].decode()
    require(
        re.search(
            rf'''\bCACHE_NAME\s*=\s*["']{re.escape(manifest["service_worker_version"])}["']''',
            worker,
        ),
        "Service Worker version mismatch",
    )
    webmanifest = json.loads(files["manifest.webmanifest"])
    require(
        webmanifest.get("display") in {"standalone", "fullscreen", "minimal-ui"}
        and webmanifest.get("start_url") in {
            "/", "./", ".", "./index.html", "/index.html"
        }
        and bool(webmanifest.get("icons"))
        and b"manifest.webmanifest" in files["index.html"]
        and b"serviceWorker" in files["index.html"],
        "Invalid PWA entry points",
    )
    for icon in webmanifest["icons"]:
        path = re.sub(r"^(?:\./|/)", "", icon["src"])
        require(safe_name(path) in files, "PWA icon missing")
    expected = manifest.get("expected_file_count")
    require(expected is None or expected == len(files), "File count mismatch")


def package(source, target, manifest):
    verify_source(command("git", "rev-parse", "HEAD", cwd=source), manifest["source_sha"])
    subprocess.run(
        ["bash", "-eo", "pipefail", "-c", manifest["build_command"]],
        cwd=source, check=True,
    )
    folder = source / manifest["output_directory"]
    require(
        folder.is_dir()
        and folder.resolve().is_relative_to(source.resolve())
        and folder.absolute() == folder.resolve(),
        "Build directory missing or redirected",
    )
    files = {}
    total = 0
    for path in sorted(folder.rglob("*")):
        name = safe_name(path.relative_to(folder).as_posix())
        require(not path.is_symlink(), "Symlink in build")
        if path.is_dir():
            continue
        require(path.is_file() and path.stat().st_size <= MAX_FILE,
                "Invalid build file")
        total += path.stat().st_size
        require(total <= MAX_ARCHIVE_CONTENT, "Build exceeds release size limit")
        files[name] = path.read_bytes()
        scan_asset(name, files[name])
    check_app(files, manifest)
    target.mkdir()
    with zipfile.ZipFile(target / "dist.zip", "w") as archive:
        for name, data in files.items():
            archive.writestr(
                zipfile.ZipInfo(name), data, compress_type=zipfile.ZIP_DEFLATED
            )
    record = {
        "source_sha": manifest["source_sha"],
        "file_count": len(files),
        "files": {name: digest(data) for name, data in files.items()},
        "artifact_sha256": digest((target / "dist.zip").read_bytes()),
    }
    expected = manifest.get("expected_artifact_sha256")
    require(
        expected is None or record["artifact_sha256"] == expected,
        "Rebuilt artifact differs from the previously verified UI10-r3 candidate",
    )
    write_json(target / "build.json", record)


def verify_zip(root, build, manifest):
    archive = root / "dist.zip"
    require(archive.is_file(), "Build ZIP missing")
    verify_source(build["source_sha"], manifest["source_sha"])
    require(
        archive.stat().st_size <= MAX_ARCHIVE_CONTENT + 5 * 1024 * 1024
        and digest(archive.read_bytes()) == build["artifact_sha256"],
        "ZIP SHA-256 mismatch",
    )
    expected = manifest.get("expected_artifact_sha256")
    require(expected is None or build["artifact_sha256"] == expected,
            "Unexpected build artifact SHA-256")
    files = {}
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        require(
            len(entries) == len(build["files"]) == build["file_count"]
            and sum(entry.file_size for entry in entries) <= MAX_ARCHIVE_CONTENT,
            "ZIP count or size mismatch",
        )
        for entry in entries:
            name = safe_name(entry.filename)
            require(
                name not in files and not entry.is_dir() and entry.file_size <= MAX_FILE,
                "Invalid ZIP entry",
            )
            data = zipped.read(entry)
            require(digest(data) == build["files"].get(name),
                    "Asset SHA-256 mismatch")
            scan_asset(name, data)
            files[name] = data
    check_app(files, manifest)
    return files


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http(url, headers, limit=30 * 1024 * 1024):
    with urllib.request.build_opener(NoRedirect).open(
        urllib.request.Request(url, headers=headers, method="GET"), timeout=20
    ) as response:
        require(response.status == 200,
                f"Expected HTTP 200, received HTTP {response.status}")
        body = response.read(limit + 1)
        require(len(body) <= limit, "HTTP response exceeds size limit")
        return body


def cf_response(path=""):
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    require(
        token and os.environ.get("CLOUDFLARE_ACCOUNT_ID") == ACCOUNT,
        "Cloudflare token or account variable is unavailable",
    )
    endpoint = (
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"
        f"/pages/projects/{PROJECT}"
    )
    try:
        data = json.loads(http(
            endpoint + path, {"Authorization": f"Bearer {token}"}
        ))
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Cloudflare API returned HTTP {exc.code}") from None
    require(data.get("success") is True, "Cloudflare API did not report success")
    return data


def cf(path=""):
    return cf_response(path)["result"]


def snapshot():
    project = cf()
    require(
        project["name"] == PROJECT
        and project["subdomain"] == DOMAIN
        and set(project.get("domains") or []) <= {DOMAIN}
        and project.get("source") is None
        and not project.get("uses_functions"),
        "Unexpected Pages project, domain, Git binding, or Functions",
    )
    branch = project["production_branch"]
    require(
        re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,150}", branch)
        and command("git", "check-ref-format", "--branch", branch) == branch,
        "Invalid Production branch",
    )
    active = project["canonical_deployment"]
    require(
        active["environment"] == "production" and re.fullmatch(UUID, active["id"]),
        "Active Production is missing or invalid",
    )
    config = {
        key: project.get(key)
        for key in (
            "id", "name", "subdomain", "domains", "source", "uses_functions",
            "production_branch", "build_config", "deployment_configs",
            "framework", "framework_version",
        )
    }
    config["domains"] = sorted(config["domains"] or [])
    return {
        "account": ACCOUNT,
        "project": PROJECT,
        "url": PERMANENT_URL,
        "production_branch": branch,
        "production_id": active["id"],
        "config_sha256": digest(json.dumps(config, sort_keys=True).encode()),
    }


def stable(current, initial, *, new_production=False):
    require(
        current["config_sha256"] == initial["config_sha256"],
        "Pages project configuration changed",
    )
    require(
        (current["production_id"] != initial["production_id"]) == new_production,
        "Active Production changed unexpectedly or the new deployment is not active",
    )


def deployment(identifier, environment):
    require(re.fullmatch(UUID, identifier), "Invalid deployment ID")
    result = cf("/deployments/" + identifier)
    require(
        result["id"] == identifier
        and result["environment"] == environment
        and result["latest_stage"]["name"] == "deploy"
        and result["latest_stage"]["status"] == "success",
        "Deployment did not succeed",
    )
    return result


def check_served(url, files):
    require(url == PERMANENT_URL, "Only the permanent test URL may be checked")

    def check(item):
        name, expected = item
        route = "" if name == "index.html" else name
        if route.endswith("/index.html"):
            route = route[:-len("index.html")]
        elif route.endswith(".html"):
            route = route[:-5]
        target = url + urllib.parse.quote(route, safe="/") + "?g19=" + digest(expected)[:16]
        actual = http(
            target,
            {
                "Accept-Encoding": "identity",
                "Cache-Control": "no-cache",
                "User-Agent": PAGES_USER_AGENT,
            },
        )
        require(digest(actual) == digest(expected),
                f"Published bytes differ for {name}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(check, files.items()))


def deploy(root, files, manifest, branch, record):
    require(branch == record["baseline"]["production_branch"],
            "Deployment branch differs from the verified Production branch")
    marker = "g19-permanent-" + record["version"] + "-" + str(record["run_id"])
    record["deployment_attempt"] = {
        "branch": branch, "environment": "production", "marker": marker
    }
    save(record)
    disk = root / "upload"
    disk.mkdir()
    for name, data in files.items():
        path = disk / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    wrangler = Path(__file__).resolve().parent / "node_modules/.bin/wrangler"
    env = dict(os.environ)
    env.pop("GH_TOKEN", None)
    result = subprocess.run(
        [
            str(wrangler), "pages", "deploy", str(disk.resolve()),
            "--project-name", PROJECT, "--branch", branch,
            "--commit-hash", manifest["source_sha"],
            "--commit-message", marker, "--commit-dirty=false",
        ],
        cwd=root, env=env, capture_output=True,
    )
    require(
        result.returncode == 0,
        "Wrangler failed; inspect Cloudflare before any retry",
    )
    for _ in range(12):
        candidates = [
            item for item in cf("/deployments?env=production&per_page=25")
            if item.get("deployment_trigger", {}).get("metadata", {}).get("commit_message")
            == marker
        ]
        require(len(candidates) <= 1, "More than one deployment matched this release")
        if candidates and candidates[0]["latest_stage"]["status"] == "success":
            found = deployment(candidates[0]["id"], "production")
            metadata = found["deployment_trigger"]["metadata"]
            require(
                metadata["commit_hash"] == manifest["source_sha"]
                and metadata["branch"] == branch
                and metadata["commit_message"] == marker,
                "Production deployment identity mismatch",
            )
            return {
                "id": found["id"],
                "branch": branch,
                "marker": marker,
                "url": PERMANENT_URL,
            }
        require(
            not candidates
            or candidates[0]["latest_stage"]["status"] not in {"failure", "canceled"},
            "Cloudflare recorded a failed Production deployment",
        )
        time.sleep(5)
    raise ValueError("Could not verify Production deployment; inspect Cloudflare before retry")


def all_preview_deployments():
    first = cf_response("/deployments?env=preview&per_page=100")
    items = first.get("result")
    require(isinstance(items, list), "Unexpected Preview deployment inventory")
    info = first.get("result_info") or {}
    try:
        pages = int(info.get("total_pages") or 1)
    except (TypeError, ValueError):
        pages = 1
    require(1 <= pages <= 100, "Unexpected Preview deployment pagination")
    for page in range(2, pages + 1):
        extra = cf(f"/deployments?env=preview&per_page=100&page={page}")
        require(isinstance(extra, list), "Unexpected Preview deployment page")
        items.extend(extra)
    return items


def cleanup_previews(root):
    removed = []
    retained = []
    try:
        previews = all_preview_deployments()
    except Exception as exc:
        return {
            "status": "inventory_failed",
            "removed": removed,
            "retained": retained,
            "error": str(exc)[:300],
        }
    wrangler = Path(__file__).resolve().parent / "node_modules/.bin/wrangler"
    env = dict(os.environ)
    env.pop("GH_TOKEN", None)
    for item in previews:
        identifier = item.get("id", "")
        if not re.fullmatch(UUID, identifier):
            retained.append({"id": "unknown", "reason": "invalid deployment identity"})
            continue
        try:
            detail = cf("/deployments/" + identifier)
            require(
                detail.get("id") == identifier and detail.get("environment") == "preview",
                "Refusing to delete a non-Preview deployment",
            )
            branch = detail.get("deployment_trigger", {}).get("metadata", {}).get("branch", "")
            result = subprocess.run(
                [
                    str(wrangler), "pages", "deployment", "delete", identifier,
                    "--project-name", PROJECT, "--force",
                ],
                cwd=root, env=env, capture_output=True,
            )
            if result.returncode == 0:
                removed.append(identifier)
            else:
                retained.append({
                    "id": identifier,
                    "branch": branch,
                    "reason": "Cloudflare did not permit deletion",
                })
        except Exception as exc:
            retained.append({
                "id": identifier,
                "reason": type(exc).__name__,
            })
    return {
        "status": "complete" if not retained else "partial",
        "removed": removed,
        "retained": retained,
    }


def save(record):
    write_json(Path("stage-record/record.json"), record)


def execute(version, manifest, root):
    run_id = int(os.environ["GITHUB_RUN_ID"])
    record = {
        "version": version,
        "stage": "publish",
        "run_id": run_id,
        "workflow_sha": os.environ["GITHUB_SHA"],
        "manifest": manifest,
        "approved_by": os.environ["GITHUB_ACTOR"],
        "artifact_retention_days": RETENTION_DAYS,
        "status": "started",
    }
    save(record)
    baseline = snapshot()
    record["baseline"] = baseline
    deployment(baseline["production_id"], "production")
    candidate = root / "candidate"
    download_candidate(run_id, candidate)
    build = read_json(candidate / "build.json")
    files = verify_zip(candidate, build, manifest)
    record["build"] = build
    stable(snapshot(), baseline)
    record["status"] = "publishing"
    save(record)
    production = deploy(
        root, files, manifest, baseline["production_branch"], record
    )
    record["production"] = production
    save(record)
    after = snapshot()
    stable(after, baseline, new_production=True)
    require(after["production_id"] == production["id"],
            "New Production is not the active deployment")
    check_served(PERMANENT_URL, files)
    deployment(baseline["production_id"], "production")
    verified = snapshot()
    stable(verified, baseline, new_production=True)
    require(verified["production_id"] == production["id"],
            "Active Production changed during published-file checks")
    record["automatic_checks"] = {
        "published_assets_sha256": "passed",
        "rollback_target": "available",
        "permanent_url": PERMANENT_URL,
    }
    record["preview_cleanup"] = cleanup_previews(root)
    record["status"] = "success"
    save(record)
    summary = [
        f"Release: {version}.",
        f"Permanent test site: {PERMANENT_URL}",
        f"Production deployment ID: {production['id']}",
        f"Rollback target: {baseline['production_id']}",
        f"Published files verified: {build['file_count']}/{build['file_count']}",
        "Service Worker: " + manifest["service_worker_version"],
        "Preview deployments removed: " + str(len(record["preview_cleanup"]["removed"])),
        "Preview deployments retained: " + str(len(record["preview_cleanup"]["retained"])),
    ]
    print("\n".join(summary))
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        print("\n\n".join(summary), file=output)


def main():
    version, manifest = context()
    mode = sys.argv[1]
    if mode == "authorize":
        authorize(manifest)
    elif mode == "package":
        package(Path(sys.argv[2]), Path(sys.argv[3]), manifest)
    elif mode == "execute":
        with tempfile.TemporaryDirectory(
            prefix="g19-permanent-", dir=os.environ["RUNNER_TEMP"]
        ) as temp:
            execute(version, manifest, Path(temp))
    else:
        raise ValueError("Unknown command")


if __name__ == "__main__":
    try:
        main()
    except (
        ValueError, KeyError, OSError, subprocess.CalledProcessError,
        zipfile.BadZipFile,
    ) as exc:
        if isinstance(exc, (json.JSONDecodeError, subprocess.CalledProcessError)):
            print(
                "Release stopped: invalid JSON or command failed; raw output suppressed.",
                file=sys.stderr,
            )
        elif type(exc) is ValueError:
            print(f"Release stopped: {exc}", file=sys.stderr)
        else:
            print(
                f"Release stopped: {type(exc).__name__}; raw output suppressed.",
                file=sys.stderr,
            )
        sys.exit(1)
