#!/usr/bin/python3
"""Apply completed Nibfin CD rollouts from the trusted Linux host."""

import base64
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

CORE = "taco3064/nibfin-core"
ACTION = "taco3064/nibfin-act"
CONFIG = Path("/etc/nibfin")
INSTALL = Path("/opt/nibfin")
CLI = INSTALL / "core/bin/nibfin-core.mjs"
HOSTS = {
    CORE: "host.json",
    ACTION: "host.nibfin-act.json",
    "taco3064/gh-nibfin": "host.gh-nibfin.json",
}
PIN_PATH = ".nibfin/producer-pins.json"
ISSUE = ".github/workflows/nibfin-issue.yml"
WAKE = ".github/workflows/nibfin-wake.yml"
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C", "GH_PROMPT_DISABLED": "1"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, timeout=90, env=ENV):
    result = subprocess.run(args, env=env, capture_output=True, timeout=timeout)
    if result.returncode:
        detail = result.stderr.decode(errors="replace").strip()[-500:]
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {detail}")
    return result.stdout


def gh(*args):
    return run("/usr/bin/gh", *args, env={**ENV, "GH_TOKEN": github_token})


def api(path):
    return json.loads(gh("api", path))


def main_sha(repo):
    return api(f"repos/{repo}/branches/main")["commit"]["sha"]


def content(repo, path, commit):
    file = api(f"repos/{repo}/contents/{path}?ref={commit}")
    return base64.b64decode(file["content"]), file["sha"]


def artifact(artifacts, name, files):
    matches = [item for item in artifacts if item["name"] == name and not item["expired"]]
    require(len(matches) == 1, f"Expected one unexpired {name} artifact")
    item = matches[0]
    require(0 < item["size_in_bytes"] < 40 * 1024 * 1024, "Artifact size out of bounds")
    data = gh("api", f"repos/{CORE}/actions/artifacts/{item['id']}/zip")
    require(
        "sha256:" + hashlib.sha256(data).hexdigest() == item["digest"],
        f"Artifact digest mismatch for {name}",
    )
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(set(archive.namelist()) == set(files), f"Unexpected files in {name}")
        require(sum(item.file_size for item in archive.infolist()) < 40 * 1024 * 1024,
                f"Expanded {name} artifact is too large")
        return {file: archive.read(file) for file in files}


def next_rollout(current, target=None):
    runs = api(f"repos/{CORE}/actions/workflows/cd.yml/runs"
               "?branch=main&event=workflow_run&status=success&per_page=15")
    for record in runs["workflow_runs"]:
        if record["head_repository"]["full_name"] != CORE:
            continue
        run_id = record["id"]
        artifacts = api(f"repos/{CORE}/actions/runs/{run_id}/artifacts")["artifacts"]
        for item in artifacts:
            match = re.fullmatch(r"nibfin-activate-([a-f0-9]{40})", item["name"])
            if not match or item["expired"]:
                continue
            commit = match[1]
            if target and commit != target:
                continue
            if commit == current:
                return None
            comparison = api(f"repos/{CORE}/compare/{current}...{commit}")["status"]
            if comparison != "ahead":
                continue
            data = artifact(artifacts, item["name"], ["activation.json"])
            pins = json.loads(data["activation.json"])
            require(pins["core"]["commit"] == commit and
                    pins["core"]["repository"] == CORE,
                    "Rollout Core identity mismatch")
            require(pins["action"]["repository"] == ACTION and
                    re.fullmatch("[a-f0-9]{40}", pins["action"]["commit"]),
                    "Rollout Action identity mismatch")
            ci = api(f"repos/{CORE}/actions/workflows/ci.yml/runs"
                     f"?event=push&branch=main&head_sha={commit}&status=success")
            require(bool(ci["workflow_runs"]), "Core main CI is missing")
            return run_id, pins, artifacts
    return None


def replacements(repo, config, pins, base):
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    previous = config["repository"]["runner"]
    old_core, old_action = previous["actionCoreCommit"], previous["actionCommit"]
    versions = ((ISSUE, (old_core, core)), (WAKE, (old_core, core),
                                         (old_action, action)))
    files = {}
    for path, *changes in versions:
        value, _ = content(repo, path, base)
        for old, new in changes:
            require(old.encode() in value, f"{repo} {path} changed during rollout")
            value = value.replace(old.encode(), new.encode())
        files[path] = value
    expected = {k: pins[k] for k in ("core", "action", "artifact")}
    files[PIN_PATH] = expected
    if repo.endswith("/gh-nibfin"):
        files["internal/cli/producers.json"] = expected
    return files


def read_consumer(repo, config, pins):
    base = main_sha(repo)
    existing = json.loads(content(repo, PIN_PATH, base)[0])
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    expected = {k: pins[k] for k in ("core", "action", "artifact")}
    if existing == expected:
        for path, ids in ((ISSUE, [core]), (WAKE, [core, action])):
            require(all(sha.encode() in content(repo, path, base)[0] for sha in ids),
                    f"{repo} main has inconsistent rollout pins")
        if repo.endswith("/gh-nibfin"):
            cli, _ = content(repo, "internal/cli/producers.json", base)
            require(json.loads(cli) == expected, "CLI installer pins are inconsistent")
        return base, None
    branch = f"cd/consumers-{core[:12]}-{action[:12]}"
    prs = json.loads(gh("pr", "list", "-R", repo, "--base", "main", "--head", branch,
                        "--json", "number,headRefOid,isDraft,mergeStateStatus,"
                        "isCrossRepository,files,statusCheckRollup"))
    require(len(prs) == 1, f"{repo} rollout PR is unavailable")
    pr = prs[0]
    require(not pr["isCrossRepository"] and not pr["isDraft"],
            f"{repo} rollout PR is not eligible")
    files = replacements(repo, config, pins, base)
    require(set(files) == {item["path"] for item in pr["files"]},
            f"{repo} rollout PR contains unexpected changes")
    for path, expected in files.items():
        value, _ = content(repo, path, pr["headRefOid"])
        require((value if isinstance(expected, bytes) else json.loads(value)) == expected,
                f"{repo} rollout PR changed {path} unexpectedly")
    checks = pr["statusCheckRollup"]
    if not checks or pr["mergeStateStatus"] != "CLEAN" or not all(
        check.get("conclusion") in ("SUCCESS", "SKIPPED") for check in checks
    ):
        return base, False
    return base, pr


def idle(hosts, include_queued=True):
    for repo, config in hosts.items():
        runners = api(f"repos/{repo}/actions/runners")["runners"]
        runner = next((r for r in runners if r["id"] == config["runnerId"]), None)
        require(runner is not None, f"{repo} adopted Runner is missing")
        if runner["busy"]:
            return False
        for workflow in (ISSUE, WAKE):
            path = f"repos/{repo}/actions/workflows/{Path(workflow).name}/runs"
            active = api(path + "?status=in_progress&per_page=1")["total_count"]
            queued = include_queued and api(path + "?status=queued&per_page=1")[
                "total_count"
            ]
            if active or queued:
                return False
    return not any((path / "stage.lock").exists() or any(path.glob("issue-*/stage.lock"))
                   for path in (Path(config["stateRoot"])
                                for config in hosts.values()))


def configure(repo, config, base, pins, source, issue_blob):
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    settings = config["repository"]
    config["installation"]["pin"] = pins["core"]
    settings["approval"]["source"] = source
    for key, path in (("runner", WAKE), ("eventRunner", ISSUE)):
        runner = settings[key]
        runner.update(sourceCommit=base, workflowBlob=content(repo, path, base)[1])
    settings["runner"].update(actionCommit=action, actionCoreCommit=core)
    ref = f"{CORE}/.github/workflows/issue.yml@{core}"
    settings["eventRunner"]["reusable"].update(commit=core, ref=ref, blob=issue_blob)
    settings["eventCaller"]["reusable"].update(commit=core, ref=ref)
    return config


def write_config(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", delete=False) as file:
        temp = Path(file.name)
        try:
            json.dump(value, file)
            file.flush()
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def stage_package(pins, artifacts):
    core = pins["core"]["commit"]
    staged = INSTALL / f"core-staged-{core}"
    with tempfile.TemporaryDirectory(prefix="nibfin-package-") as directory:
        work = Path(directory)
        pin = work / "source-pin.json"
        pin.write_text(json.dumps(pins["core"]))
        if staged.exists():
            return json.loads(run("node", CLI, "verify", staged, pin))["source"]
        package = artifact(artifacts, f"nibfin-core-{core}",
                           ["nibfin-core.tar.gz", "source-pin.json", "SHA256SUMS"])
        require(json.loads(package["source-pin.json"]) == pins["core"],
                "Packaged source pin mismatch")
        archive = work / "nibfin-core.tar.gz"
        archive.write_bytes(package["nibfin-core.tar.gz"])
        result = json.loads(run("node", CLI, "install", archive, staged, pin))
        for path in [staged, *staged.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else
                       0o555 if path.stat().st_mode & 0o100 else 0o444)
        return result["source"]


def rollout(hosts, selected):
    run_id, pins, artifacts = selected
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    action_main = main_sha(ACTION)
    comparison = api(f"repos/{ACTION}/compare/{action}...{action_main}")["status"]
    require(comparison in ("identical", "ahead") and
            json.loads(content(ACTION, "core-source.json", action)[0]) == pins["core"],
            "Action main does not contain the verified Core pin")
    consumers = {repo: read_consumer(repo, config, pins)
                 for repo, config in hosts.items()}
    if any(pr is False for _, pr in consumers.values()):
        print(f"CD {run_id} waiting for consumer PR checks and mergeability")
        return
    source = stage_package(pins, artifacts)
    services = [f"{repo.split('/')[1]}-runner.service" for repo in hosts]
    plan = CONFIG / "rollout-plan.json"
    wanted = {"pin": pins["core"], "actionCommit": action}
    stopped = plan.exists() and json.loads(plan.read_text()) == wanted and all(
        run("systemctl", "show", "-p", "ActiveState", "--value", service).strip()
        == b"inactive" for service in services
    )
    if not stopped and not idle(hosts):
        print(f"CD {run_id} waiting for Runners, queued Jobs or unresolved executions")
        return
    if not stopped:
        write_config(plan, wanted)
    run("systemctl", "stop", *services)
    require(idle(hosts, include_queued=False),
            "Runner or execution became active during the safe stop")
    # New-version Jobs may queue while the Runners are stopped. The host
    # promoter independently checks containers and the existing execution fences.
    for repo, (_, pr) in consumers.items():
        if pr:
            gh("pr", "merge", "-R", repo, str(pr["number"]), "--rebase",
               "--match-head-commit", pr["headRefOid"])
    staged_configs = CONFIG / "rollout"
    staged_configs.mkdir(mode=0o700, exist_ok=True)
    _, issue_blob = content(CORE, ".github/workflows/issue.yml", core)
    for repo, config in hosts.items():
        base, remaining = read_consumer(repo, config, pins)
        require(remaining is None, f"{repo} rollout did not land on main")
        next_config = configure(repo, config, base, pins, source, issue_blob)
        write_config(staged_configs / HOSTS[repo], next_config)
    result = json.loads(run("node", CLI, "promote-host"))
    require(result["status"] == "installed", "Host promotion failed")
    print(f"CD {run_id} installed Core {core} with Action {action}", flush=True)
    finish(services)


def start_enabled(services):
    for service in services:
        enabled = subprocess.run(("systemctl", "is-enabled", "--quiet", service), env=ENV)
        if enabled.returncode == 0:
            run("systemctl", "start", service)


def finish(services):
    start_enabled(services)
    staged_configs = CONFIG / "rollout"
    for name in HOSTS.values():
        (staged_configs / name).unlink(missing_ok=True)
    if staged_configs.exists():
        staged_configs.rmdir()
    (CONFIG / "rollout-plan.json").unlink()


def main():
    global github_token
    require(os.getuid() == 0, "Rollout must run as host administrator")
    hosts = {repo: json.loads((CONFIG / name).read_text())
             for repo, name in HOSTS.items()}
    github_token = Path(hosts[CORE]["tokenFile"]).read_text().strip()
    require(bool(github_token), "Host GitHub credential is missing")
    current = hosts[CORE]["installation"]["pin"]["commit"]
    plan_path = CONFIG / "rollout-plan.json"
    target = None
    if plan_path.exists():
        target = json.loads(plan_path.read_text())["pin"]["commit"]
        if target == current:
            finish([f"{repo.split('/')[1]}-runner.service" for repo in hosts])
            target = None
    selected = next_rollout(current, target)
    if selected:
        rollout(hosts, selected)
    elif target:
        raise RuntimeError(f"CD artifacts for interrupted rollout {target} are missing")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, OSError, ValueError,
            subprocess.TimeoutExpired) as error:
        print(f"Nibfin rollout: {error}", file=sys.stderr)
        sys.exit(1)
