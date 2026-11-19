"""One explicit administrator rollout; no discovery, timer or background worker."""
import base64
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
ENTRY = ROOT / "src/core-rollout-manager-entry.mjs"
LIVE_CLI = Path("/opt/nibfin/core/bin/nibfin-core.mjs")


def node_path():
    metadata = ROOT.parent / "runtime.json"
    for path in (metadata, *metadata.parents):
        stat = path.lstat()
        if path.is_symlink() or stat.st_uid != 0 or stat.st_mode & 0o022:
            raise RuntimeError("Untrusted installed administrator runtime")
    value = json.loads(metadata.read_text())
    path = value.get("nodePath")
    if not isinstance(path, str) or not path.startswith("/opt/nibfin/tools/"):
        raise RuntimeError("Untrusted installed administrator runtime path")
    return path


def execute(*args, timeout=None, env=None):
    if args and args[0] == "node":
        args = (node_path(), *args[1:])
    result = subprocess.run([str(value) for value in args], env=env,
                            capture_output=True)
    if result.returncode:
        raise RuntimeError("Core rollout subprocess requires normal retry")
    return result.stdout


def bridge(*args, request=None):
    result = subprocess.run([node_path(), str(ENTRY), *args],
                            input=json.dumps(request).encode() if request else None,
                            capture_output=True,
                            env={"PATH": "/usr/bin:/bin", "LANG": "C"})
    value = json.loads(result.stdout)
    if result.returncode or value.get("status") == "pending":
        raise RuntimeError(value.get("code", "CORE_ROLLOUT_OBSERVATION_UNAVAILABLE"))
    return value


def load_runtime():
    path = ROOT / "scripts/host-auto-rollout.py"
    spec = importlib.util.spec_from_file_location("core_rollout_runtime", path)
    runtime = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = runtime
    spec.loader.exec_module(runtime)
    runtime.CLI = ENTRY
    runtime.run = execute
    runtime.coordinator_cli = lambda plan=None: ENTRY
    runtime.gh = lambda *args: base64.b64decode(
        bridge("github", request=list(args))["bytes"])
    runtime.api = lambda path, *args: json.loads(runtime.gh("api", path, *args))
    runtime.pool_step = lambda operation: bridge("pool", operation)
    return runtime


def chosen_target(runtime, target, host):
    """Validate exactly the requested native artifact, without a discovery scan."""
    run_id, artifact_id = target["runId"], target["artifactId"]
    item = runtime.api(f"repos/{runtime.CORE}/actions/artifacts/{artifact_id}")
    match = re.fullmatch(r"nibfin-activate-([a-f0-9]{40})", item.get("name", ""))
    runtime.require(match and not item.get("expired") and
                    item.get("workflow_run", {}).get("id") == run_id,
                    "Explicit native CD artifact does not match the target run")
    selected = runtime.next_rollout(host["installation"]["pin"]["commit"],
                                    match[1], run_id)
    runtime.require(selected and any(record["id"] == artifact_id and
                    record["name"] == item["name"] for record in selected[2]),
                    "Verified native CD target is unavailable")
    return selected


def finish(runtime, services):
    """Read back installation, restore our listeners, then release our closure."""
    path = runtime.CONFIG / "rollout-plan.json"
    plan = json.loads(path.read_text())
    runtime.require(plan.get("apply", {}).get("completed"),
                    "Rollout apply is not complete")
    if plan["phase"] != "complete":
        runtime.pool_step("restore")
    runtime.pool_step("release")
    plan = json.loads(path.read_text())
    receipt = {"target": plan["administratorTarget"], "pin": plan["pin"],
               "candidate": plan["candidate"], "runId": plan["runId"],
               "originalServices": plan["originalServices"]}
    runtime.write_config(runtime.CONFIG / "core-rollout-operation.json", receipt)
    current = json.loads((runtime.CONFIG / "host.json").read_text())
    runtime.refresh_rollout_service(current)
    for name in (*runtime.HOSTS.values(), runtime.E2E_HOST):
        (runtime.CONFIG / "rollout" / name).unlink(missing_ok=True)
    path.unlink()
    runtime.sync_directory(runtime.CONFIG)
    directory = runtime.CONFIG / "rollout"
    if directory.is_dir() and not any(directory.iterdir()):
        directory.rmdir()


def continuation():
    # Only after release: execute the new installed Core in a separate process.
    result = subprocess.run([node_path(), str(LIVE_CLI),
                             "complete-installed-lifecycle"], capture_output=True,
                            env={"PATH": "/usr/bin:/bin", "LANG": "C"})
    value = json.loads(result.stdout)
    if value.get("status") not in ("dispatched", "paused", "pending"):
        raise RuntimeError("Installed lifecycle returned an invalid result")
    if not isinstance(value.get("results"), list):
        raise RuntimeError("Installed lifecycle omitted continuation results")
    if result.returncode not in (0, 2):
        raise RuntimeError("Installed lifecycle observation needs normal retry")
    return value


def operation(runtime, target):
    path = runtime.CONFIG / "rollout-plan.json"
    hosts = {repo: json.loads((runtime.CONFIG / name).read_text())
             for repo, name in runtime.HOSTS.items()}
    plan = json.loads(path.read_text()) if path.exists() else None
    runtime.require(not plan or plan.get("administratorTarget") == target,
                    "Another rollout target has not completed")
    runtime.prepare_plan = lambda value: {**value, "administratorTarget": target}
    runtime.finish = lambda services: finish(runtime, services)
    if plan and plan.get("apply"):
        if not plan["apply"].get("completed"):
            result = bridge("promote-host")
            runtime.require(result["status"] == "installed", "Apply remains pending")
        finish(runtime, runtime.runner_services(hosts))
    else:
        # Native target discovery and current installed observation do not depend
        # on old local receipts. Neither missing bookkeeping nor old manager code
        # means that the installed package must be installed again.
        selected = chosen_target(runtime, target, hosts[runtime.CORE])
        complete = False
        if not plan:
            current = bridge("observe-installed")
            runtime.require(current.get("status") == "observed",
                            "Installed state observation is incomplete")
            if current.get("pin") == selected[1]["core"]:
                observed = [runtime.read_consumer(repo, hosts.get(repo),
                            selected[1], selected[0])
                            for repo in (*hosts, runtime.E2E)]
                complete = all(pr is None for _, pr in observed)
        if not complete:
            outcome = runtime.rollout(hosts, selected)
            if not outcome or outcome.get("status") != "installed" or path.exists():
                return {"status": "pending", "installation": "pending",
                        "code": "CORE_ROLLOUT_STAGE_PENDING"}
    try:
        result = continuation()
    except (OSError, ValueError, RuntimeError):
        result = {"status": "pending", "results": [],
                  "code": "INSTALLED_CONTINUATION_OBSERVATION_UNAVAILABLE"}
    return {"status": "installed", "installation": "complete",
            "continuation": result}


def main():
    if len(sys.argv) != 3 or not all(re.fullmatch(r"[1-9][0-9]*", value)
                                     for value in sys.argv[1:]):
        raise RuntimeError("Expected one native CD run ID and activation artifact ID")
    bridge("admit")
    groups = Path("/proc/self/cgroup").read_text()
    if re.search(r"nibfin-shared-runner@(?:1|2)\.service", groups):
        raise RuntimeError("Out-of-pool rollout cannot stop its own Runner job or hook")
    runtime = load_runtime()
    handle = os.open(runtime.CONFIG, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        target = {"runId": int(sys.argv[1]), "artifactId": int(sys.argv[2])}
        with contextlib.redirect_stdout(sys.stderr):
            result = operation(runtime, target)
        print(json.dumps(result))
    finally:
        os.close(handle)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(json.dumps({"status": "pending", "installation": "pending",
                          "code": "CORE_ROLLOUT_OPERATION_RETRY",
                          "detail": str(error)}))
        sys.exit(2)
