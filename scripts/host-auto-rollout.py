#!/usr/bin/python3
"""Apply completed Nibfin CD rollouts from the trusted Linux host."""

import base64
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

CORE = "taco3064/nibfin-core"
ACTION = "taco3064/nibfin-act"
E2E = "taco3064/nibfin-e2e"
CONFIG = Path("/etc/nibfin")
INSTALL = Path("/opt/nibfin")
CLI = INSTALL / "core/bin/nibfin-core.mjs"
SERVICE_SCRIPT = Path("/usr/local/libexec/nibfin/host-auto-rollout.py")
HOSTS = {
    CORE: "host.json",
    ACTION: "host.nibfin-act.json",
    "taco3064/gh-nibfin": "host.gh-nibfin.json",
}
E2E_HOST = "host.nibfin-e2e.json"
PIN_PATH = ".nibfin/producer-pins.json"
ISSUE = ".github/workflows/nibfin-issue.yml"
WAKE = ".github/workflows/nibfin-wake.yml"
RATE_WAIT = Path("/run/nibfin-rollout-rate-limit")
LAST_PR_CLEANUP = Path("/run/nibfin-rollout-pr-cleanup")
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


class RateLimited(RuntimeError):
    pass


def api(path, *options):
    response = subprocess.run(
        ("/usr/bin/gh", "api", "--include", path, *options),
        env={**ENV, "GH_TOKEN": github_token}, capture_output=True, timeout=90,
    )
    headers, _, body = response.stdout.replace(b"\r\n", b"\n").partition(b"\n\n")
    values = dict(
        line.lower().split(b":", 1) for line in headers.splitlines()[1:] if b":" in line
    )
    if response.returncode:
        retry = values.get(b"retry-after", b"").strip()
        remaining = values.get(b"x-ratelimit-remaining", b"").strip()
        reset = values.get(b"x-ratelimit-reset", b"").strip()
        diagnostic = response.stderr.lower()
        if (remaining == b"0" or retry.isdigit() or b"http 429" in diagnostic or
                b"rate limit exceeded" in diagnostic):
            now = int(time.time())
            delay = int(retry) if retry.isdigit() else 60
            deadline = max(now + delay, int(reset) + 1 if
                           remaining == b"0" and reset.isdigit() else 0)
            write_config(RATE_WAIT, deadline)
            raise RateLimited(f"GitHub rate limit; retry after {deadline}")
        raise RuntimeError(f"GitHub read failed: {path.split('?')[0]}")
    return json.loads(body)


def main_sha(repo):
    return api(f"repos/{repo}/branches/main")["commit"]["sha"]


def content(repo, path, commit):
    file = api(f"repos/{repo}/contents/{path}?ref={commit}")
    return base64.b64decode(file["content"]), file["sha"]


def artifact(artifacts, name, files):
    matches = [
        item for item in artifacts if item["name"] == name and not item["expired"]
    ]
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


def has_main_ci(commit):
    # GitHub can omit a successful push when status=success is combined with
    # the commit filter. Read the exact commit and check the returned result.
    runs = api(f"repos/{CORE}/actions/workflows/ci.yml/runs"
               f"?head_sha={commit}&per_page=100")
    return any(
        run["head_sha"] == commit and run["head_branch"] == "main" and
        run["event"] == "push" and run["status"] == "completed" and
        run["conclusion"] == "success" and run["head_repository"]["full_name"] == CORE
        for run in runs["workflow_runs"]
    )


def next_rollout(current, target=None, candidate_run=None):
    if candidate_run is not None:
        # Resume the durable target independently of the discovery window.
        record = api(f"repos/{CORE}/actions/runs/{candidate_run}")
        if not (record.get("id") == candidate_run and
                record.get("path") == ".github/workflows/cd.yml" and
                record.get("head_branch") == "main" and
                record.get("event") == "workflow_run" and
                record.get("status") == "completed" and
                record.get("conclusion") == "success"):
            return None
        records = [record]
    else:
        records = api(f"repos/{CORE}/actions/workflows/cd.yml/runs"
                      "?branch=main&event=workflow_run&status=success&per_page=15"
                      )["workflow_runs"]
    for record in records:
        if record["head_repository"]["full_name"] != CORE:
            continue
        run_id = record["id"]
        if candidate_run is not None and run_id != candidate_run:
            continue
        artifacts = api(f"repos/{CORE}/actions/runs/{run_id}/artifacts")["artifacts"]
        for item in artifacts:
            match = re.fullmatch(r"nibfin-activate-([a-f0-9]{40})", item["name"])
            if not match or item["expired"]:
                continue
            commit = match[1]
            if target and commit != target:
                continue
            if commit == current and not target:
                return None
            comparison = api(f"repos/{CORE}/compare/{current}...{commit}")["status"]
            if comparison != "ahead" and not (target and comparison == "identical"):
                continue
            data = artifact(artifacts, item["name"], ["activation.json"])
            pins = json.loads(data["activation.json"])
            require(pins["core"]["commit"] == commit and
                    pins["core"]["repository"] == CORE,
                    "Rollout Core identity mismatch")
            require(pins["action"]["repository"] == ACTION and
                    re.fullmatch("[a-f0-9]{40}", pins["action"]["commit"]),
                    "Rollout Action identity mismatch")
            require(has_main_ci(commit), "Core main CI is missing")
            return run_id, pins, artifacts
    return None


def consumer_workflows(repo, base):
    if repo == E2E:
        return (ISSUE,)
    if repo == CORE:
        workflows = api(f"repos/{repo}/contents/.github/workflows?ref={base}")
        if not any(item["path"] == WAKE for item in workflows):
            return (ISSUE,)
    return ISSUE, WAKE


def e2e_issue_recipe(commit):
    raw, _ = content(CORE, "src/caller-recipes.json", commit)
    return "\n".join(json.loads(raw)["issue"]).replace("CORE_COMMIT", commit).encode()


def replacements(repo, config, pins, base, workflows):
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    if repo == E2E:
        return {ISSUE: e2e_issue_recipe(core)}
    previous = config["repository"]["runner"]
    old_core, old_action = previous["actionCoreCommit"], previous["actionCommit"]
    versions = ((ISSUE, (old_core, core)), (WAKE, (old_core, core),
                                         (old_action, action)))
    files = {}
    for path, *changes in versions:
        if path not in workflows:
            continue
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


def consumer_wait(pr):
    checks = pr["statusCheckRollup"]
    incomplete = [
        {"name": check.get("name") or check.get("context"), "status": (
            check.get("conclusion") or check.get("status") or
            check.get("state") or "UNKNOWN"
        )}
        for check in checks if check.get("conclusion") not in ("SUCCESS", "SKIPPED")
    ]
    if pr["mergeStateStatus"] == "CLEAN" and checks and not incomplete:
        return None
    return {
        "mergeStateStatus": pr["mergeStateStatus"],
        "checkRollupPresent": bool(checks),
        "incompleteChecks": incomplete,
    }


REFRESH_ATTEMPTS = set()


def refresh_consumer(repo, branch, pr):
    """Refresh only an exact, eligible head; never infer readiness from a write."""
    key = (repo, pr["number"])
    if key in REFRESH_ATTEMPTS:
        return "refresh awaiting read-back/checks"
    path = f"repos/{repo}/pulls/{pr['number']}"
    try:
        current = api(path)
        eligible = (
            current["number"] == pr["number"] and current["state"] == "open" and
            not current["draft"] and current["base"]["ref"] == "main" and
            current["head"]["ref"] == branch and
            current["base"]["repo"]["full_name"] == repo and
            (current["head"]["repo"] or {}).get("full_name") == repo
        )
        if not eligible:
            return "refresh rejected: PR identity or eligibility changed"
        if current["head"]["sha"] != pr["headRefOid"]:
            return "refresh rejected: head mismatch; revalidation required"
        if current.get("mergeable") is False:
            return "refresh blocked: merge conflict"
        if current.get("mergeable_state") != "behind":
            return "refresh awaiting read-back: merge state changed or unknown"
        REFRESH_ATTEMPTS.add(key)
        api(f"{path}/update-branch", "--method", "PUT", "-f",
            f"expected_head_sha={pr['headRefOid']}")
        return "refresh requested; awaiting read-back/checks"
    except RateLimited:
        raise
    except (RuntimeError, KeyError, TypeError, OSError, ValueError,
            subprocess.TimeoutExpired):
        # The next observation rereads main, files and the exact head before
        # another effect. Within this invocation an ambiguous write is not retried.
        return "refresh provider uncertainty; reconcile PR before retry"


def read_consumer(repo, config, pins, run_id=None):
    base = main_sha(repo)
    workflows = consumer_workflows(repo, base)
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    expected = {k: pins[k] for k in ("core", "action", "artifact")}
    if repo == E2E:
        if content(repo, ISSUE, base)[0] == e2e_issue_recipe(core):
            return base, None
    elif json.loads(content(repo, PIN_PATH, base)[0]) == expected:
        for path, ids in ((ISSUE, [core]), (WAKE, [core, action])):
            if path not in workflows:
                continue
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
    require(len(prs) == 1,
            f"{repo} expected one open rollout PR for {branch}, found {len(prs)}")
    pr = prs[0]
    require(not pr["isCrossRepository"] and not pr["isDraft"],
            f"{repo}#{pr['number']} rollout PR is not eligible")
    files = replacements(repo, config, pins, base, workflows)
    require(set(files) == {item["path"] for item in pr["files"]},
            f"{repo}#{pr['number']} rollout PR contains unexpected changes")
    for path, expected in files.items():
        value, _ = content(repo, path, pr["headRefOid"])
        actual = value if isinstance(expected, bytes) else json.loads(value)
        require(actual == expected,
                f"{repo}#{pr['number']} rollout PR changed {path} unexpectedly")
    wait = consumer_wait(pr)
    if wait is not None:
        if pr["mergeStateStatus"] == "BEHIND":
            wait["refresh"] = refresh_consumer(repo, branch, pr)
        elif pr["mergeStateStatus"] == "DIRTY":
            wait["refresh"] = "refresh blocked: merge conflict"
        if run_id is not None:
            message = f"CD {run_id} waiting for {repo}#{pr['number']}"
            print(f"{message} {json.dumps(wait)}", flush=True)
        return base, False
    return base, pr


def close_superseded_rollouts(core):
    superseded = {}
    for repo in (*HOSTS, E2E):
        pull_requests = []
        page = 1
        while True:
            query = f"state=open&base=main&per_page=100&page={page}"
            batch = api(f"repos/{repo}/pulls?{query}")
            pull_requests.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        for pr in pull_requests:
            close_superseded_pr(repo, pr, core, superseded)


def close_superseded_pr(repo, pr, core, superseded):
    branch = pr["head"]["ref"]
    match = re.fullmatch(r"cd/(consumers|action)-([a-f0-9]{12})(-[a-f0-9]{12})?",
                         branch)
    head_repo = pr["head"]["repo"]
    if not match or not head_repo or head_repo["full_name"] != repo:
        return
    kind, prefix, action_suffix = match.groups()
    if prefix == core[:12] or (kind == "consumers") != bool(action_suffix):
        return
    if kind == "action" and repo != ACTION:
        return
    if pr["title"] != f"Prepare Core {prefix} rollout" or not re.fullmatch(
        r"Core CD run \d+\. Consumer merge waits for the safe host stop\.",
        pr["body"] or "",
    ):
        return

    path = f"repos/{repo}/pulls/{pr['number']}"
    commits = api(f"{path}/commits?per_page=2")
    if len(commits) != 1 or commits[0]["sha"] != pr["head"]["sha"]:
        return
    commit = commits[0]["commit"]
    subject = re.fullmatch(r"Prepare Core ([a-f0-9]{40}) rollout\s*", commit["message"])
    if not subject or not subject[1].startswith(prefix) or commit["author"]["email"] != (
        "nibfin-cd@users.noreply.github.com"
    ):
        return
    previous = subject[1]
    if previous not in superseded:
        comparison = api(f"repos/{CORE}/compare/{previous}...{core}")
        superseded[previous] = (comparison["status"] == "ahead" and
                                comparison["merge_base_commit"]["sha"] == previous)
    if not superseded[previous]:
        return

    allowed = {"core-source.json"} if kind == "action" else {PIN_PATH, ISSUE, WAKE}
    if kind == "consumers" and repo.endswith("/gh-nibfin"):
        allowed.add("internal/cli/producers.json")
    files = api(f"{path}/files?per_page={len(allowed) + 1}")
    if not files or not all(pin_only_change(file, allowed) for file in files):
        return
    current = api(path)
    if (current["state"] == "open" and current["head"]["sha"] == pr["head"]["sha"]
            and current["title"] == pr["title"] and current["body"] == pr["body"]):
        api(path, "--method", "PATCH", "-f", "state=closed")
        print(f"Closed superseded rollout {repo}#{pr['number']}", flush=True)


def pin_only_change(file, allowed):
    if (file["filename"] not in allowed or file["status"] != "modified"
            or not file.get("patch")):
        return False
    changed = [line[1:].strip() for line in file["patch"].splitlines()
               if line.startswith(("+", "-"))]
    if len(changed) != file["additions"] + file["deletions"]:
        return False
    if file["filename"].endswith(".yml"):
        pin = r'(?:core_commit: |# Core source: )?[a-f0-9]{40}"?'
    else:
        pin = (r'"(?:commit|archiveHash|manifestHash|digest)": '
               r'"(?:sha256:)?[a-f0-9]+",?|"id": \d+,?')
    return (file["additions"] == file["deletions"] and bool(changed) and
            all(re.fullmatch(pin, line) for line in changed))


def runner_services(hosts):
    return ["nibfin-shared-runner@1.service", "nibfin-shared-runner@2.service"]


def coordinator_cli(plan=None):
    # An interrupted rename can leave core absent. Only the two exact paths
    # already verified and recorded before apply are recovery executables.
    if plan and plan.get("apply"):
        target = plan["pin"]["commit"]
        require(re.fullmatch("[a-f0-9]{40}", target), "Invalid recovery target")
        for directory in (INSTALL / "core", INSTALL / f"core-staged-{target}",
                          INSTALL / f"core-before-{target}"):
            if (directory / "bin/nibfin-core.mjs").is_file():
                return directory / "bin/nibfin-core.mjs"
        raise RuntimeError("Verified rollout recovery package is missing")
    return CLI


def pool_step(operation):
    plan = json.loads((CONFIG / "rollout-plan.json").read_text())
    script = coordinator_cli(plan).parent.parent / "src/rollout-pool-entry.mjs"
    result = json.loads(run("node", script, operation))
    require(result["status"] != "pending", "Pool gate is busy; retry next timer")
    return result


def configure(repo, config, base, pins, source, issue_blob):
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    settings = config["repository"]
    config["installation"]["pin"] = pins["core"]
    if "providerBinding" in config:
        config["providerBinding"]["components"]["source"] = pins["core"]
    settings["approval"]["source"] = source
    runner_keys = {WAKE: "runner", ISSUE: "eventRunner"}
    workflows = consumer_workflows(repo, base)
    for path in workflows:
        key = runner_keys[path]
        runner = settings[key]
        runner.update(sourceCommit=base, workflowBlob=content(repo, path, base)[1])
    settings["runner"].update(actionCommit=action, actionCoreCommit=core)
    ref = f"{CORE}/.github/workflows/issue.yml@{core}"
    settings["eventRunner"]["reusable"].update(commit=core, ref=ref, blob=issue_blob)
    settings["eventCaller"]["reusable"].update(commit=core, ref=ref)
    if WAKE not in workflows:
        settings["runner"] = {
            **settings["eventRunner"], "actionCommit": action,
            "actionCoreCommit": core,
        }
        settings["runner"].pop("reusable", None)
    return config


def sync_directory(path):
    handle = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


def write_config(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", delete=False) as file:
        temp = Path(file.name)
        try:
            json.dump(value, file)
            if path == CONFIG / "rollout-plan.json":
                os.fchmod(file.fileno(), 0o644)
            file.flush()
            os.fsync(file.fileno())
            temp.replace(path)
            sync_directory(path.parent)
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


def configure_e2e(host, base, pins, source, issue_blob, preflight=False):
    """Bind the Issue caller to the shared pool through the verified rollout."""
    repo = api(f"repos/{E2E}")
    require(repo["full_name"] == E2E and not repo["private"] and
            repo["default_branch"] == "main", "Unexpected E2E repository")
    repository_id = repo["id"]
    branch = api(f"repos/{E2E}/branches/main")
    require(branch["protected"] and (preflight or branch["commit"]["sha"] == base),
            "E2E main changed or is unprotected")
    protection = api(f"repos/{E2E}/branches/main/protection/required_status_checks")
    require({"context": "verify", "app_id": 15368} in protection["checks"],
            "E2E verify is not required")
    event = api(f"repos/{E2E}/actions/workflows/nibfin-issue.yml")
    require(event["path"] == ISSUE and event["state"] == "active",
            "E2E Issue workflow is unavailable")
    caller, blob = content(E2E, ISSUE, base)
    core = pins["core"]["commit"]
    require(caller == e2e_issue_recipe(core), "E2E Issue caller differs from Core recipe")
    primary = host["sharedRunner"]["runner"]
    runner = {
        "repository": E2E, "repositoryId": repository_id,
        "runnerId": primary["runnerId"], "runnerName": primary["runnerName"],
        "memberId": host["memberId"], "workflowId": event["id"],
        "workflowPath": ISSUE, "sourceCommit": base, "workflowBlob": blob,
    }
    path = ".github/workflows/issue.yml"
    ref = f"{CORE}/{path}@{core}"
    config = {key: host[key] for key in (
        "schemaVersion", "kind", "uid", "memberId", "installation",
        "stateRoot", "tokenFile", "authFile",
    )}
    if "providerBinding" in host:
        config["providerBinding"] = host["providerBinding"]
    if "notionProposal" in host:
        config["notionProposal"] = host["notionProposal"]
    config.update(runnerId=runner["runnerId"], issues={})
    config["repository"] = {
        "approval": {"kind": "repository-admission-v1", "repository": E2E,
                     "repositoryId": repository_id, "memberId": host["memberId"],
                     "source": source},
        "runner": runner,
        "eventRunner": {**runner, "reusable": {
            "repository": CORE, "path": path, "commit": core, "ref": ref,
            "blob": issue_blob,
        }},
        "eventCaller": {"eventName": "issues", "reusable": {"commit": core, "ref": ref}},
        "isolation": host["repository"]["isolation"],
        "reviewers": [],
    }
    return config


def stage_bindings(hosts, consumers, pins, source, preflight=False):
    staged = CONFIG / "rollout"
    staged.mkdir(mode=0o700, exist_ok=True)
    core = pins["core"]["commit"]
    _, issue_blob = content(CORE, ".github/workflows/issue.yml", core)
    for repo, original in hosts.items():
        base, pr = consumers[repo]
        if pr:
            require(preflight, f"{repo} rollout did not land on main")
            base = pr["headRefOid"]
        config = json.loads(json.dumps(original))
        next_config = configure(repo, config, base, pins, source, issue_blob)
        write_config(staged / HOSTS[repo], next_config)
    base, pr = consumers[E2E]
    if pr:
        require(preflight, "E2E rollout did not land on main")
        base = pr["headRefOid"]
    primary = json.loads((staged / HOSTS[CORE]).read_text())
    e2e = configure_e2e(primary, base, pins, source, issue_blob, preflight)
    write_config(staged / E2E_HOST, e2e)


def rollout(hosts, selected):
    run_id, pins, artifacts = selected
    path = CONFIG / "rollout-plan.json"
    core, action = pins["core"]["commit"], pins["action"]["commit"]
    action_main = main_sha(ACTION)
    comparison = api(f"repos/{ACTION}/compare/{action}...{action_main}")["status"]
    require(comparison in ("identical", "ahead") and
            json.loads(content(ACTION, "core-source.json", action)[0]) == pins["core"],
            "Action main does not contain the verified Core pin")
    consumers = {repo: read_consumer(repo, config, pins, run_id)
                 for repo, config in hosts.items()}
    consumers[E2E] = read_consumer(E2E, None, pins, run_id)
    if any(pr is False for _, pr in consumers.values()):
        return
    for repo in (*hosts, E2E):
        permissions = api(f"repos/{repo}").get("permissions", {})
        require(permissions.get("push") is True,
                f"{repo} consumer promotion permission is unavailable")
    source = stage_package(pins, artifacts)
    previous = json.loads(path.read_text()) if path.exists() else None
    # Minimal legacy plans may already have stopped services. Never treat their
    # target commit as completion. Rebind and observe before any further effect.
    if not previous or previous.get("schemaVersion") != 2:
        wanted = {"schemaVersion": 2, "pin": pins["core"], "actionCommit": action,
                  "candidate": pins, "runId": run_id, "phase": "prepared",
                  "pending": "ROLLOUT_PREFLIGHT_REQUIRED", "mergeIntents": {}}
        write_config(path, wanted)
    plan = json.loads(path.read_text())
    require(plan["candidate"] == pins and plan["runId"] == run_id,
            "Rollout target changed after drain began")
    if plan["phase"] == "prepared":
        # Validate prospective bindings and permissions before closing admission.
        stage_bindings(hosts, consumers, pins, source, preflight=True)
        if (not LAST_PR_CLEANUP.exists() or
                json.loads(LAST_PR_CLEANUP.read_text()) != run_id):
            close_superseded_rollouts(core)
            write_config(LAST_PR_CLEANUP, run_id)
        pool_step("prepare")
        prepared = json.loads(path.read_text())
        if prepared.get("apply", {}).get("completed"):
            finish(runner_services(hosts))
            return
        pool_step("close")
    pool_step("stop")
    plan = json.loads(path.read_text())
    for repo, (_, pr) in consumers.items():
        if not pr:
            continue
        require(repo not in plan["mergeIntents"],
                f"{repo} merge response unresolved; retaining exact PR intent")
        # The validated PR is read again immediately before the effect.
        _, fresh = read_consumer(repo, hosts.get(repo), pins, run_id)
        require(fresh and fresh["headRefOid"] == pr["headRefOid"],
                f"{repo} rollout head or checks changed")
        plan["mergeIntents"][repo] = {"number": pr["number"], "head": pr["headRefOid"]}
        write_config(path, plan)
        gh("pr", "merge", "-R", repo, str(pr["number"]), "--rebase",
           "--match-head-commit", pr["headRefOid"])
    current_consumers = {repo: read_consumer(repo, hosts.get(repo), pins)
                         for repo in (*hosts, E2E)}
    require(all(pr is None for _, pr in current_consumers.values()),
            "Consumer merge has not been read back")
    stage_bindings(hosts, current_consumers, pins, source)
    result = json.loads(run("node", CLI, "promote-host"))
    require(result["status"] == "installed", "Host promotion failed")
    print(f"CD {run_id} installed Core {core} with Action {action}", flush=True)
    finish(runner_services(hosts))


def start_enabled(services):
    for service in services:
        enabled = subprocess.run(
            ("systemctl", "is-enabled", "--quiet", service), env=ENV
        )
        if enabled.returncode == 0:
            run("systemctl", "start", service)


def clean_superseded_staged_packages(current):
    pending = ("rollout-plan.json", "rollout.lock", "rollout")
    if any((CONFIG / name).exists() for name in pending):
        return
    staged = list(INSTALL.glob("core-staged-*"))
    if not staged:
        return
    mounts = run("findmnt", "--list", "--noheadings", "--output", "TARGET")
    for path in staged:
        match = re.fullmatch(r"core-staged-([a-f0-9]{40})", path.name)
        if (not match or path.is_symlink() or not path.is_dir()
                or path.stat().st_uid != 0):
            continue
        revision = match[1]
        if revision == current or path.stat().st_mode & 0o022:
            continue
        if str(path).encode() in mounts:
            continue
        manifest = path / "nibfin-manifest.json"
        if manifest.is_symlink() or not manifest.is_file():
            continue
        source = json.loads(manifest.read_text())
        if source.get("repository") != CORE or source.get("commit") != revision:
            continue
        comparison = api(f"repos/{CORE}/compare/{revision}...{current}?per_page=1")
        if (comparison["status"] == "ahead" and
                comparison["merge_base_commit"]["sha"] == revision):
            if any((CONFIG / name).exists() for name in pending):
                return
            shutil.rmtree(path)
            print(f"Removed superseded staged Core package {revision}", flush=True)


def refresh_rollout_service(host):
    source = INSTALL / "core/scripts/host-auto-rollout.py"
    if not source.is_file() or Path(__file__).resolve() != SERVICE_SCRIPT:
        return
    unit = Path("/etc/systemd/system/nibfin-rollout.service")
    template = source.with_name("nibfin-rollout.service")
    targets = [(SERVICE_SCRIPT, source.read_bytes(), 0o755),
               (unit, template.read_bytes(), 0o644)]
    changed = [(path, data, mode) for path, data, mode in targets
               if not path.exists() or path.read_bytes() != data]
    if not changed:
        reload_rollout_unit()
        return
    with tempfile.TemporaryDirectory(prefix="nibfin-rollout-service-") as work:
        pin = Path(work) / "pin.json"
        pin.write_text(json.dumps(host["installation"]["pin"]))
        run("node", CLI, "verify", INSTALL / "core", pin)
    for path, data, mode in changed:
        replace_service_file(path, data, mode)
    reload_rollout_unit()


def reload_rollout_unit():
    needed = run("systemctl", "show", "--property=NeedDaemonReload", "--value",
                 "nibfin-rollout.service")
    if needed.strip() == b"yes":
        run("systemctl", "daemon-reload")


def replace_service_file(path, data, mode):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temp = Path(output.name)
        try:
            output.write(data)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
            temp.replace(path)
            sync_directory(path.parent)
        finally:
            temp.unlink(missing_ok=True)


def finish(services):
    path = CONFIG / "rollout-plan.json"
    plan = json.loads(path.read_text())
    require(plan.get("apply", {}).get("completed"),
            "Installed commit alone does not establish rollout completion")
    if plan["phase"] != "complete":
        start_enabled(services)
    for service in services:
        run("systemctl", "is-active", "--quiet", service)
    pool_step("release")
    staged = CONFIG / "rollout"
    names = {*HOSTS.values(), E2E_HOST}
    names.update(Path(target["path"]).name for target in plan["apply"]["targets"])
    for name in names:
        (staged / name).unlink(missing_ok=True)
    current = json.loads((CONFIG / HOSTS[CORE]).read_text())
    refresh_rollout_service(current)
    path.unlink()
    sync_directory(CONFIG)
    # The apply backup is retained as the verified recovery package. Package
    # cleanup must not mistake the persistent kernel lock for a live operation.
    if staged.exists():
        staged.rmdir()
    clean_superseded_staged_packages(current["installation"]["pin"]["commit"])


def resume_installed_work():
    host = json.loads((CONFIG / HOSTS[CORE]).read_text())
    if not host.get("sharedRunner"):
        return
    response = subprocess.run(
        ("node", str(CLI), "complete-installed-lifecycle"), env=ENV,
        stdin=subprocess.DEVNULL, capture_output=True, text=True,
    )
    result = json.loads(response.stdout)
    require(isinstance(result, dict) and
            result.get("status") in ("dispatched", "paused", "pending") and
            isinstance(result.get("results"), list), "Invalid continuation response")
    print(json.dumps(result), flush=True)
    require(response.returncode == 0 and result["status"] != "pending",
            "Post-rollout continuation remains pending")


def require_manual_credential(host):
    # This legacy adapter hands its manual token to gh through an environment.
    # It must never read an imported credential or bypass Core consumer leases.
    marker = Path(host["tokenFile"]).with_name("managed.json")
    require(not marker.exists() and not marker.is_symlink(),
            "Managed credentials require Core admission; legacy rollout refused")


def read_manual_credential(host):
    path = Path(host["tokenFile"])
    lock = path.with_name("managed.lock")
    handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        require_manual_credential(host)
        return path.read_text().strip()
    finally:
        os.close(handle)
        lock.unlink()


def recover_legacy_wakes():
    script = INSTALL / "core/src/rollout-pool-entry.mjs"
    result = json.loads(run("node", script, "recover-wakes"))
    print(json.dumps({"legacyWakeRecovery": result}), flush=True)


def main():
    global github_token
    require(os.getuid() == 0, "Rollout must run as host administrator")
    hosts = {repo: json.loads((CONFIG / name).read_text())
             for repo, name in HOSTS.items()}
    current = hosts[CORE]["installation"]["pin"]["commit"]
    plan_path = CONFIG / "rollout-plan.json"
    plan = json.loads(plan_path.read_text()) if plan_path.exists() else None
    if plan and plan.get("schemaVersion") != 2:
        pool_step("legacy")
    if plan and plan.get("apply"):
        if not plan["apply"].get("completed"):
            result = json.loads(run("node", coordinator_cli(plan), "promote-host"))
            require(result["status"] == "installed", "Interrupted promotion pending")
        finish(runner_services(hosts))
        resume_installed_work()
        return
    continuation_error = None
    if plan is None:
        try:
            resume_installed_work()
        except (RuntimeError, OSError, ValueError) as error:
            continuation_error = error
        marker = Path(hosts[CORE]["tokenFile"]).with_name("managed.json")
        if marker.exists() or marker.is_symlink():
            if continuation_error:
                raise continuation_error
            return
    if RATE_WAIT.exists():
        if time.time() < json.loads(RATE_WAIT.read_text()):
            return
        RATE_WAIT.unlink()
    github_token = read_manual_credential(hosts[CORE])
    require(bool(github_token), "Host GitHub credential is missing")
    # Wake recovery verifies the installed package against the host pin. Resume
    # durable apply first: either may be absent or out of sync after a crash.
    recover_legacy_wakes()
    target = plan["pin"]["commit"] if plan else None
    selected = next_rollout(current, target, plan.get("runId") if plan else None)
    if selected:
        rollout(hosts, selected)
    elif target:
        raise RuntimeError(f"CD artifacts for interrupted rollout {target} are missing")
    else:
        if continuation_error:
            raise continuation_error
        clean_superseded_staged_packages(current)
    if selected and not plan_path.exists():
        installed = json.loads((CONFIG / HOSTS[CORE]).read_text())
        revision = installed["installation"]["pin"]["commit"]
        if revision == selected[1]["core"]["commit"]:
            resume_installed_work()
            clean_superseded_staged_packages(revision)
        elif continuation_error:
            raise continuation_error

def serialized_main():
    require(os.getuid() == 0, "Rollout must run as host administrator")
    # Lock a stable root-owned directory inode. No stale PID or unlink-based
    # lock stealing after a timer interruption, and no disposable lock file.
    handle = os.open(CONFIG, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        main()
    finally:
        os.close(handle)


def record_pending(code):
    path = CONFIG / "rollout-plan.json"
    if os.getuid() == 0 and path.is_file():
        plan = json.loads(path.read_text())
        if plan.get("schemaVersion") == 2:
            pending = plan.get("pending")
            if (code == "ROLLOUT_COORDINATOR_PENDING" and pending and
                    not pending.endswith("_REQUIRED")):
                return
            write_config(path, {**plan, "pending": code})


if __name__ == "__main__":
    try:
        serialized_main()
    except RateLimited as error:
        record_pending("ROLLOUT_RATE_LIMITED")
        print(f"Nibfin rollout: {error}", file=sys.stderr)
    except (RuntimeError, KeyError, OSError, ValueError,
            subprocess.TimeoutExpired) as error:
        record_pending("ROLLOUT_COORDINATOR_PENDING")
        print(f"Nibfin rollout: {error}", file=sys.stderr)
        sys.exit(1)
