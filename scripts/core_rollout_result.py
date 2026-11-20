"""Consume typed Core results; never infer an error type from a message."""
import json
from pathlib import Path
import re


CONTRACT = json.loads((Path(__file__).resolve().parent.parent /
                       "src/core-rollout-result.json").read_text())


def result_exit(value):
    status = value.get("status") if isinstance(value, dict) else None
    if not isinstance(status, str):
        return None
    if status in CONTRACT["failureExitCodes"]:
        return CONTRACT["failureExitCodes"][status]
    return 0 if status in CONTRACT["successStatuses"] else None


def project_result(value):
    if result_exit(value) is None:
        return None
    if value["status"] in CONTRACT["failureExitCodes"]:
        code = value.get("code")
        if value["status"] != "pending" and (not isinstance(code, str)
                or not re.fullmatch(CONTRACT["codePattern"], code)):
            return None
        result = {"status": value["status"]}
        if isinstance(code, str) and re.fullmatch(CONTRACT["codePattern"], code):
            result["code"] = code
        api = value.get("githubApi")
        if isinstance(api, dict) and api.get("kind") in CONTRACT["githubCauseKinds"]:
            if api["kind"] != "http":
                result["githubApi"] = {"kind": api["kind"]}
            elif type(api.get("httpStatus")) is int:
                result["githubApi"] = {"kind": "http", "httpStatus": api["httpStatus"]}
        if value.get("installation") in ("complete", "pending", "unsupported"):
            result["installation"] = value["installation"]
        run_id, url = value.get("coreRunId"), value.get("coreRunURL")
        if (code == "UPGRADE_CORE_ACTIVATION_QUEUED" and type(run_id) is int
                and run_id > 0 and run_id.bit_length() <= 53 and isinstance(url, str)
                and re.fullmatch(CONTRACT["coreRunURLPattern"], url)
                and url.endswith(f"/{run_id}")):
            result.update(schemaVersion=1, coreRunId=run_id, coreRunURL=url)
        if isinstance(value.get("results"), list):
            result["results"] = project_records(value["results"])
        if isinstance(value.get("reasons"), list):
            result["reasons"] = [item for item in value["reasons"]
                                 if isinstance(item, str)
                                 and re.fullmatch(r"[A-Za-z0-9_-]+", item)]
        if isinstance(value.get("cleanup"), list):
            result["cleanup"] = project_cleanup(value["cleanup"])
        return result
    result = {key: item for key, item in value.items()
              if key in CONTRACT["successFields"]}
    if isinstance(value.get("results"), list):
        result["results"] = project_records(value["results"])
    if isinstance(value.get("cleanup"), list):
        result["cleanup"] = project_cleanup(value["cleanup"])
    if "completion" in value:
        result["completion"] = project_result(value["completion"])
    if "continuation" in value:
        result["continuation"] = project_result(value["continuation"]) or {
            "status": "pending", "code": CONTRACT["malformedCode"], "results": []}
    return result


def project_cleanup(values):
    contract = CONTRACT["packageCleanup"]
    result = []
    for item in values:
        if not isinstance(item, dict):
            continue
        name = item.get("package")
        if (name is not None and (not isinstance(name, str) or
                not re.fullmatch(contract["packagePattern"], name))):
            continue
        if item.get("status") not in contract["statuses"] or \
                item.get("code") not in contract["codes"]:
            continue
        record = {"status": item["status"], "code": item["code"]}
        if name is not None:
            record["package"] = name
        result.append(record)
    return result


def project_records(values):
    records = []
    for value in values:
        if not isinstance(value, dict):
            continue
        patterns = CONTRACT["recordStringPatterns"]
        result = {key: value[key] for key, pattern in patterns.items()
                  if isinstance(value.get(key), str)
                  and re.fullmatch(pattern, value[key])}
        for key in CONTRACT["recordIntegerFields"]:
            item = value.get(key)
            if type(item) is int and item > 0 and item.bit_length() <= 53:
                result[key] = item
        if value.get("status") in CONTRACT["recordStatuses"]:
            result["status"] = value["status"]
        if isinstance(value.get("code"), str) and re.fullmatch(
                CONTRACT["codePattern"], value["code"]):
            result["code"] = value["code"]
        api = project_result({"status": "pending", "githubApi": value.get("githubApi")})
        if "githubApi" in api:
            result["githubApi"] = api["githubApi"]
        if result:
            records.append(result)
    return records


class CoreRolloutFailure(RuntimeError):
    def __init__(self, result):
        self.result = project_result(result)
        if not self.result or self.result["status"] not in CONTRACT["failureExitCodes"]:
            self.result = {"status": "pending", "code": CONTRACT["malformedCode"]}
        super().__init__(self.result.get("code", CONTRACT["fallbackCode"]))


def read_result(process):
    try:
        value = project_result(json.loads(process.stdout or process.stderr))
        if value is not None and result_exit(value) == process.returncode:
            return value
    except (TypeError, ValueError, AttributeError):
        pass
    raise CoreRolloutFailure({"status": "pending", "code": CONTRACT["malformedCode"]})


def failure_result(error, *, continuation=False):
    value = error.result if isinstance(error, CoreRolloutFailure) else {
        "status": "pending", "code": CONTRACT["fallbackCode"]}
    result = project_result(value)
    if continuation:
        # Installation is already confirmed; retry only its unfinished continuation.
        result = {**result, "status": "pending"}
        result.setdefault("results", [])
    return result
