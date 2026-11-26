#!/usr/bin/env python3
"""Cloudflare Pages release stages. Only deploy() can modify Cloudflare."""
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
WORKFLOW = ".github/workflows/goleszan-pages-release.yml"
ACCOUNT = "6c1ff8f43cd435c244a2f03a7650fe4e"
PROJECT = "goleszan-19-preview"
DOMAIN = PROJECT + ".pages.dev"
PAGES_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "Chrome/131.0.0.0 Safari/537.36"
)
SUPABASE = "https://pbsubdmuupwmtgzncxmh.supabase.co"
SHA = r"[0-9a-f]{40}"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
VERSION = r"[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?"
CHECKS = (
    "interface", "calendar_and_duties", "supplies_and_instructions",
    "announcements_and_discussions", "settings_and_navigation", "light_and_dark",
    "mobile", "pwa_and_service_worker", "no_critical_javascript_errors",
)
POST_CHECKS = ("active_service_worker", "registered_device", "notification_preferences")
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


def tag(version, stage):
    return f"g19-release-{version}-{stage}"


def context():
    match = re.fullmatch(rf"g19-release-({VERSION})-(api|preview|functional|production|post)",
                         os.environ["GITHUB_REF_NAME"])
    require(match, "Invalid release tag")
    version, stage = match.groups()
    env = os.environ
    require(env["GITHUB_REPOSITORY"] == REPO and env["GITHUB_EVENT_NAME"] == "push"
            and env["GITHUB_ACTOR"].lower() == OWNER and env["GITHUB_ACTOR_ID"] == OWNER_ID
            and env["GITHUB_TRIGGERING_ACTOR"].lower() == OWNER
            and env["GITHUB_RUN_ATTEMPT"] == "1"
            and env["GITHUB_REF"] == "refs/tags/" + tag(version, stage)
            and re.fullmatch(SHA, env["GITHUB_SHA"]), "Unauthorized or repeated run")
    event = read_json(Path(env["GITHUB_EVENT_PATH"]))
    require(event.get("created") is True and not event.get("deleted") and not event.get("forced"),
            "Only a newly created tag is accepted")
    manifest = read_json(Path(__file__).resolve().parents[2] / "releases" / (version + ".json"))
    require(manifest["version"] == version and isinstance(manifest["name"], str)
            and bool(manifest["name"].strip()) and re.fullmatch(SHA, manifest["source_sha"])
            and isinstance(manifest["build_command"], str) and bool(manifest["build_command"].strip())
            and manifest["supabase_url"] == SUPABASE
            and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", manifest["service_worker_version"]),
            "Invalid release manifest")
    safe_name(manifest["output_directory"])
    count = manifest.get("expected_file_count")
    require(count is None or (type(count) is int and count > 0), "Invalid expected file count")
    return version, stage, manifest


def gh(*args):
    # Never pass Cloudflare credentials to the GitHub client.
    env = dict(os.environ)
    env.pop("CLOUDFLARE_API_TOKEN", None)
    return subprocess.check_output(("gh", *args), env=env, text=True)


def runs(version, stage):
    data = json.loads(gh("api", "--paginate", "--slurp", "--method", "GET",
                         f"repos/{REPO}/actions/runs", "-f", "event=push",
                         "-f", "branch=" + tag(version, stage), "-F", "per_page=100"))
    return [r for page in data for r in page["workflow_runs"]
            if r["path"].split("@", 1)[0] == WORKFLOW
            and r["display_title"] == tag(version, stage) and r["head_branch"] == tag(version, stage)]


def verify_unique_run(items, current_id):
    require(len(items) == 1 and items[0]["id"] == current_id,
            "Duplicate stage or current run not visible in GitHub")


def authorize(version, stage, manifest):
    current_id = int(os.environ["GITHUB_RUN_ID"])
    for attempt in range(5):
        items = runs(version, stage)
        if items:
            break
        time.sleep(2)
    verify_unique_run(items, current_id)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        print(f"stage={stage}\nsha={manifest['source_sha']}", file=output)


def download(run_id, name, target):
    data = json.loads(gh("api", f"repos/{REPO}/actions/runs/{run_id}/artifacts?per_page=100"))
    items = [a for a in data["artifacts"] if a["name"] == name]
    require(len(items) == 1 and items[0].get("expired") is False,
            f"Artifact {name} is missing or expired for run {run_id}")
    gh("run", "download", str(run_id), "--repo", REPO, "--name", name, "--dir", str(target))


def previous(version, stage, target):
    items = runs(version, stage)
    require(len(items) == 1, f"Expected exactly one {stage} run")
    run = items[0]
    require(run["status"] == "completed" and run["conclusion"] == "success"
            and run["event"] == "push" and run["run_attempt"] == 1
            and run["head_sha"] == os.environ["GITHUB_SHA"]
            and run["actor"]["login"].lower() == OWNER and str(run["actor"]["id"]) == OWNER_ID
            and run["triggering_actor"]["login"].lower() == OWNER
            and str(run["triggering_actor"]["id"]) == OWNER_ID, f"{stage} lacks owner approval or success")
    download(run["id"], "g19-stage", target)
    record = read_json(target / "record.json")
    require(record["stage"] == stage and record["version"] == version
            and record["run_id"] == run["id"] and record["workflow_sha"] == os.environ["GITHUB_SHA"],
            f"{stage} record provenance mismatch")
    return record


def safe_name(name):
    require(isinstance(name, str) and all(re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", part)
                                           for part in name.split("/")), "Unsafe path")
    return name


def verify_source(actual, expected):
    require(actual == expected and re.fullmatch(SHA, expected), "Source SHA mismatch")


def scan_asset(name, data):
    blocked = {"_headers", "_redirects", "_routes.json", "_worker.js", "functions",
               "node_modules", "wrangler.toml", "wrangler.json", "wrangler.jsonc"}
    require(not (set(name.lower().split("/")) & blocked)
            and Path(name.lower()).suffix not in {".pem", ".key", ".p12", ".pfx"},
            "Server-side control file or private-key path in static artifact")
    patterns = (
        rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----",
        rb"\b(?:sb_secret_|github_pat_|gh[pousr]_|xox[baprs]-|sk-(?:proj-)?)[A-Za-z0-9_-]{15,}",
        rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        rb'https?://[^\s/@:\x22\x27]+:[^\s/@\x22\x27]+@[^\s/\x22\x27]+',
        rb'''(?i)(?:api[_-]?token|password|client[_-]secret|service[_-]role[_-]key)["']?\s*[:=]\s*["'][\w.+/=-]{20,}["']''',
    )
    require(not any(re.search(rule, data) for rule in patterns), "Possible credential in static artifact")
    for match in re.finditer(rb"eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{12,}", data):
        payload = match[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + b"=" * (-len(payload) % 4)))
        require(claims.get("role") == "anon" and claims.get("ref") == SUPABASE.split(".")[0][8:],
                "Unexpected JWT in static artifact")
    origins = re.findall(rb"https://[a-z0-9-]+\.supabase\.co\b", data, re.I)
    require(all(origin == SUPABASE.encode() for origin in origins), "Unexpected Supabase origin")


def check_app(files, manifest):
    config = files["dyskusje/config.js"].decode()
    settings = json.loads(config[config.index("{"):config.rindex("}") + 1])
    require(set(settings) == {"url", "publishableKey", "vapidPublicKey", "adminEmail"}
            and settings["url"] == manifest["supabase_url"]
            and re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", settings["publishableKey"])
            and (not settings["vapidPublicKey"] or re.fullmatch(r"B[A-Za-z0-9_-]{86}", settings["vapidPublicKey"]))
            and (not settings["adminEmail"] or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", settings["adminEmail"])),
            "Unexpected frontend configuration")
    worker = files["sw.js"].decode()
    version = manifest["service_worker_version"]
    require(re.search(rf'''\bCACHE_NAME\s*=\s*["']{re.escape(version)}["']''', worker),
            "Service Worker version mismatch")
    webmanifest = json.loads(files["manifest.webmanifest"])
    require(webmanifest.get("display") in {"standalone", "fullscreen", "minimal-ui"}
            and webmanifest.get("start_url") in {"/", "./", ".", "./index.html", "/index.html"}
            and bool(webmanifest.get("icons"))
            and b"manifest.webmanifest" in files["index.html"]
            and b"serviceWorker" in files["index.html"], "Invalid PWA entry points")
    for icon in webmanifest["icons"]:
        path = re.sub(r"^(?:\./|/)", "", icon["src"])
        require(safe_name(path) in files, "PWA icon missing")
    expected = manifest.get("expected_file_count")
    require(expected is None or expected == len(files), "File count mismatch")


def package(source, target, manifest):
    verify_source(command("git", "rev-parse", "HEAD", cwd=source), manifest["source_sha"])
    subprocess.run(["bash", "-eo", "pipefail", "-c", manifest["build_command"]], cwd=source, check=True)
    folder = source / manifest["output_directory"]
    require(folder.is_dir() and folder.resolve().is_relative_to(source.resolve())
            and folder.absolute() == folder.resolve(), "Build directory missing or redirected")
    files = {}
    total = 0
    for path in sorted(folder.rglob("*")):
        name = safe_name(path.relative_to(folder).as_posix())
        require(not path.is_symlink(), "Symlink in build")
        if path.is_dir():
            continue
        require(path.is_file() and path.stat().st_size <= MAX_FILE, "Invalid build file")
        total += path.stat().st_size
        require(total <= MAX_ARCHIVE_CONTENT, "Build exceeds release size limit")
        files[name] = path.read_bytes()
        scan_asset(name, files[name])
    check_app(files, manifest)
    target.mkdir()
    with zipfile.ZipFile(target / "dist.zip", "w") as archive:
        for name, data in files.items():
            archive.writestr(zipfile.ZipInfo(name), data, compress_type=zipfile.ZIP_DEFLATED)
    record = {"source_sha": manifest["source_sha"], "file_count": len(files),
              "files": {name: digest(data) for name, data in files.items()},
              "artifact_sha256": digest((target / "dist.zip").read_bytes())}
    write_json(target / "build.json", record)


def verify_zip(root, build, manifest):
    archive = root / "dist.zip"
    require(archive.is_file(), "ZIP missing")
    verify_source(build["source_sha"], manifest["source_sha"])
    require(archive.stat().st_size <= MAX_ARCHIVE_CONTENT + 5 * 1024 * 1024
            and digest(archive.read_bytes()) == build["artifact_sha256"], "ZIP SHA-256 mismatch")
    files = {}
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        require(len(entries) == len(build["files"]) == build["file_count"]
                and sum(entry.file_size for entry in entries) <= MAX_ARCHIVE_CONTENT,
                "ZIP count or size mismatch")
        for entry in entries:
            name = safe_name(entry.filename)
            require(name not in files and not entry.is_dir() and entry.file_size <= MAX_FILE,
                    "Invalid ZIP entry")
            data = z.read(entry)
            require(digest(data) == build["files"].get(name), "Asset SHA-256 mismatch")
            scan_asset(name, data)
            files[name] = data
    check_app(files, manifest)
    return files


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http(url, headers, limit=30 * 1024 * 1024):
    with urllib.request.build_opener(NoRedirect).open(
            urllib.request.Request(url, headers=headers, method="GET"), timeout=20) as response:
        require(response.status == 200, f"Expected HTTP 200, received HTTP {response.status}")
        body = response.read(limit + 1)
        require(len(body) <= limit, "HTTP response exceeds size limit")
        return body


def cf(path=""):
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    require(token and os.environ.get("CLOUDFLARE_ACCOUNT_ID") == ACCOUNT,
            "Cloudflare token or account variable is unavailable")
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/pages/projects/{PROJECT}"
    try:
        data = json.loads(http(endpoint + path, {"Authorization": f"Bearer {token}"}))
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Cloudflare API returned HTTP {exc.code}") from None
    require(data.get("success") is True, "Cloudflare API did not report success")
    return data["result"]


def snapshot():
    project = cf()
    require(project["name"] == PROJECT and project["subdomain"] == DOMAIN
            and set(project.get("domains") or []) <= {DOMAIN}
            and project.get("source") is None and not project.get("uses_functions"),
            "Unexpected Pages project, domain, Git integration or Functions")
    branch = project["production_branch"]
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,150}", branch)
            and command("git", "check-ref-format", "--branch", branch) == branch,
            "Invalid Production branch")
    active = project["canonical_deployment"]
    require(active["environment"] == "production" and re.fullmatch(UUID, active["id"]),
            "Active Production is missing or invalid")
    # Store hashes of configuration fields rather than responses containing settings.
    config = {key: project.get(key) for key in
              ("id", "name", "subdomain", "domains", "source", "uses_functions",
               "production_branch", "build_config", "deployment_configs", "framework", "framework_version")}
    config["domains"] = sorted(config["domains"] or [])
    return {"account": ACCOUNT, "project": PROJECT, "url": "https://" + DOMAIN + "/",
            "production_branch": branch, "production_id": active["id"],
            "config_sha256": digest(json.dumps(config, sort_keys=True).encode())}


def stable(current, initial, *, new_production=False):
    require(current["config_sha256"] == initial["config_sha256"], "Pages configuration changed")
    require((current["production_id"] != initial["production_id"]) == new_production,
            "Active Production changed unexpectedly or the new deployment is not active")


def deployment(identifier, environment):
    require(re.fullmatch(UUID, identifier), "Invalid deployment ID")
    result = cf("/deployments/" + identifier)
    require(result["id"] == identifier and result["environment"] == environment
            and result["latest_stage"]["name"] == "deploy"
            and result["latest_stage"]["status"] == "success", "Deployment did not succeed")
    return result


def preview_url(url):
    parts = urllib.parse.urlsplit(url)
    require(parts.scheme == "https" and re.fullmatch(rf"[0-9a-f]+\.{re.escape(DOMAIN)}", parts.netloc)
            and parts.path in {"", "/"} and not (parts.query or parts.fragment),
            "Unexpected Preview URL")
    return url.rstrip("/") + "/"


def verify_preview(preview, manifest):
    found = deployment(preview["id"], "preview")
    require(preview_url(found["url"]) == preview["url"]
            and found["deployment_trigger"]["metadata"]["commit_hash"] == manifest["source_sha"]
            and found["deployment_trigger"]["metadata"]["branch"] == preview["branch"]
            and found["deployment_trigger"]["metadata"]["commit_message"] == preview["marker"],
            "Preview deployment identity mismatch")


def check_served(url, files):
    def check(item):
        name, expected = item
        route = "" if name == "index.html" else name
        if route.endswith("/index.html"):
            route = route[:-len("index.html")]
        elif route.endswith(".html"):
            route = route[:-5]
        target = url + urllib.parse.quote(route, safe="/") + "?g19=" + digest(expected)[:16]
        actual = http(target, {"Accept-Encoding": "identity", "Cache-Control": "no-cache",
                               "User-Agent": PAGES_USER_AGENT})
        require(digest(actual) == digest(expected), f"Published bytes differ for {name}")
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(check, files.items()))


def deploy(root, files, manifest, branch, environment, record):
    marker = "g19-release-run-" + str(record["run_id"])
    record["deployment_attempt"] = {"branch": branch, "environment": environment, "marker": marker}
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
    result = subprocess.run([str(wrangler), "pages", "deploy", str(disk.resolve()),
                             "--project-name", PROJECT, "--branch", branch,
                             "--commit-hash", manifest["source_sha"], "--commit-message", marker,
                             "--commit-dirty=false"], cwd=root, env=env, capture_output=True)
    require(result.returncode == 0, "Wrangler failed; inspect Cloudflare before any retry")
    for attempt in range(12):
        candidates = [d for d in cf("/deployments?env=" + environment + "&per_page=25")
                      if d.get("deployment_trigger", {}).get("metadata", {}).get("commit_message") == marker]
        require(len(candidates) <= 1, "More than one deployment matched this run")
        if candidates and candidates[0]["latest_stage"]["status"] == "success":
            found = deployment(candidates[0]["id"], environment)
            metadata = found["deployment_trigger"]["metadata"]
            require(metadata["commit_hash"] == manifest["source_sha"] and metadata["branch"] == branch
                    and metadata["commit_message"] == marker, "Deployment metadata mismatch")
            return {"id": found["id"], "branch": branch, "marker": marker,
                    "url": preview_url(found["url"]) if environment == "preview" else "https://" + DOMAIN + "/"}
        require(not candidates or candidates[0]["latest_stage"]["status"] not in {"failure", "canceled"},
                "Cloudflare recorded a failed deployment")
        time.sleep(5)
    raise ValueError("Could not verify deployment; inspect Cloudflare before any retry")


def save(record):
    write_json(Path("stage-record/record.json"), record)


def approval_matches(functional, identity):
    require(functional["identity"] == identity
            and functional["automatic"] == {"published_assets_sha256": "passed"}
            and functional["manual"] == dict.fromkeys(CHECKS, "passed")
            and functional["approved_by"].lower() == OWNER, "Functional Check is missing or mismatched")


def execute(version, stage, manifest, root):
    run_id = int(os.environ["GITHUB_RUN_ID"])
    record = {"version": version, "stage": stage, "run_id": run_id,
              "workflow_sha": os.environ["GITHUB_SHA"], "manifest": manifest,
              "approved_by": os.environ["GITHUB_ACTOR"], "artifact_retention_days": RETENTION_DAYS,
              "status": "started"}
    save(record)
    current = snapshot()
    if stage == "api":
        deployment(current["production_id"], "production")
        record["baseline"] = current
    else:
        api = previous(version, "api", root / "api")
        baseline = api["baseline"]
        record["baseline"] = baseline
        stable(current, baseline, new_production=stage == "post")
        deployment(baseline["production_id"], "production")
        if stage == "preview":
            require("g19-" + version != current["production_branch"], "Preview collides with Production branch")
            candidate = root / "candidate"
            download(run_id, "g19-candidate", candidate)
            build = read_json(candidate / "build.json")
            files = verify_zip(candidate, build, manifest)
            stable(snapshot(), baseline)
            record["build"] = build
            record["preview"] = deploy(root, files, manifest, "g19-" + version, "preview", record)
            save(record)
            stable(snapshot(), baseline)
        else:
            preview = previous(version, "preview", root / "preview")
            require(preview["baseline"] == baseline, "Preview baseline differs from API Check")
            verify_preview(preview["preview"], manifest)
            build = preview["build"]
            candidate = root / "candidate"
            download(preview["run_id"], "g19-candidate", candidate)
            files = verify_zip(candidate, build, manifest)
            identity = {"preview_id": preview["preview"]["id"], "source_sha": build["source_sha"],
                        "artifact_sha256": build["artifact_sha256"]}
            record.update(build=build, preview=preview["preview"], identity=identity)
            if stage == "functional":
                check_served(preview["preview"]["url"], files)
                record.update(automatic={"published_assets_sha256": "passed"},
                              manual=dict.fromkeys(CHECKS, "passed"))
            else:
                functional = previous(version, "functional", root / "functional")
                approval_matches(functional, identity)
                record["functional"] = functional
                if stage == "production":
                    stable(snapshot(), baseline)
                    record["production"] = deploy(root, files, manifest, current["production_branch"],
                                                  "production", record)
                    save(record)
                    after = snapshot()
                    stable(after, baseline, new_production=True)
                    require(after["production_id"] == record["production"]["id"], "New Production is not active")
                else:
                    production = previous(version, "production", root / "production")
                    require(production["identity"] == identity and production["baseline"] == baseline
                            and current["production_id"] == production["production"]["id"],
                            "Production record does not match live deployment")
                    record["production"] = production["production"]
                    record["manual_post"] = dict.fromkeys(POST_CHECKS, "passed")
                check_served(record["production"]["url"], files)
                deployment(baseline["production_id"], "production")
                verified = snapshot()
                stable(verified, baseline, new_production=True)
                require(verified["production_id"] == record["production"]["id"],
                        "Active Production changed during post-deployment checks")
                record["automatic_post"] = {"published_assets_sha256": "passed", "rollback_target": "available"}
    record["status"] = "success"
    save(record)
    summary = [f"Stage: {stage}. Release: {version}."]
    if "baseline" in record:
        summary.append(f"Rollback candidate: {record['baseline']['production_id']}")
    for key in ("preview", "production"):
        if key in record:
            summary.append(f"{key.title()}: {record[key]['id']} ({record[key]['url']})")
    print("\n".join(summary))
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        print("\n\n".join(summary), file=output)


def main():
    version, stage, manifest = context()
    mode = sys.argv[1]
    if mode == "authorize":
        authorize(version, stage, manifest)
    elif mode == "package":
        require(stage == "preview", "Build is only permitted for Preview")
        package(Path(sys.argv[2]), Path(sys.argv[3]), manifest)
    elif mode == "execute":
        with tempfile.TemporaryDirectory(prefix="g19-release-", dir=os.environ["RUNNER_TEMP"]) as temp:
            execute(version, stage, manifest, Path(temp))
    else:
        raise ValueError("Unknown command")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as exc:
        if isinstance(exc, (json.JSONDecodeError, subprocess.CalledProcessError)):
            print("Release stopped: invalid JSON or command failed; raw output suppressed.", file=sys.stderr)
        elif type(exc) is ValueError:
            print(f"Release stopped: {exc}", file=sys.stderr)
        else:
            print(f"Release stopped: {type(exc).__name__}; raw output suppressed.", file=sys.stderr)
        sys.exit(1)
