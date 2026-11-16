"""Closed MCP schemas and bounded framing for the credential-free worker."""
import json
from pathlib import Path

LIMITS = json.loads(Path(__file__).with_name("claude-work-limits.json").read_text())
REQUEST_LIMIT = LIMITS["requestBytes"]
RESPONSE_LIMIT = LIMITS["responseBytes"]
TIMEOUT = LIMITS["commandSeconds"]
OUTPUT_LIMIT = LIMITS["outputBytes"]


def closed(properties, required):
    return {"type": "object", "additionalProperties": False,
            "properties": properties, "required": required}


PATH = {"type": "string", "minLength": 1, "maxLength": 1024}
SCHEMAS = {
    "read": closed({
        "surface": {"enum": ["work", "main", "input"]},
        "path": PATH,
        "search": {"type": "string", "minLength": 1, "maxLength": 256},
    }, ["surface", "path"]),
    "write": closed({
        "path": PATH,
        "content": {"type": "string", "maxLength": LIMITS["contentBytes"]},
    }, ["path", "content"]),
    "check": closed({
        "command": {"type": "string", "minLength": 1, "maxLength": 8192},
    }, ["command"]),
}


def validate(value, schema):
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError("INVALID_ARGUMENTS")
    if schema.get("type") == "object":
        if (type(value) is not dict or set(value) - set(schema["properties"])
                or set(schema["required"]) - set(value)):
            raise ValueError("INVALID_ARGUMENTS")
        for key, item in value.items():
            validate(item, schema["properties"][key])
    if schema.get("type") == "string":
        if (type(value) is not str
                or not schema.get("minLength", 0) <= len(value)
                <= schema["maxLength"] or "\0" in value):
            raise ValueError("INVALID_ARGUMENTS")


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_MEMBER")
        result[key] = value
    return result


def decode(line):
    if len(line) > REQUEST_LIMIT or not line.endswith(b"\n"):
        raise ValueError("REQUEST_LIMIT")
    return json.loads(line, object_pairs_hook=unique,
                      parse_constant=lambda _: fail())


def fail():
    raise ValueError("INVALID_JSON")


def encode(value):
    data = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()
    if len(data) + 1 > RESPONSE_LIMIT:
        raise ValueError("RESPONSE_LIMIT")
    return data + b"\n"


def error(request_id, code=-32602):
    return {"jsonrpc": "2.0", "id": request_id,
            "error": {"code": code, "message": "WORK_REQUEST_DENIED"}}


def dispatch(request, operations, execute):
    request_id = None
    try:
        if type(request) is not dict:
            raise ValueError("INVALID_REQUEST")
        request_id = request.get("id")
        if (type(request_id) not in (str, int, type(None))
                or type(request_id) is str and len(request_id) > 128
                or type(request_id) is int and abs(request_id) > 2**53 - 1):
            request_id = None
            raise ValueError("INVALID_ID")
        if (set(request) - {"jsonrpc", "id", "method", "params"}
                or request.get("jsonrpc") != "2.0"):
            raise ValueError("INVALID_REQUEST")
        method = request.get("method")
        params = request.get("params", {})
        if type(params) is not dict:
            raise ValueError("INVALID_PARAMS")
        if "id" not in request:
            if method == "notifications/initialized" and not params:
                return None
            raise ValueError("INVALID_NOTIFICATION")
        if method == "initialize":
            if (set(params) != {"protocolVersion", "capabilities", "clientInfo"}
                    or params["protocolVersion"] not in
                    ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
                    or type(params["capabilities"]) is not dict
                    or type(params["clientInfo"]) is not dict):
                raise ValueError("INVALID_INITIALIZE")
            result = {"protocolVersion": params["protocolVersion"],
                      "capabilities": {"tools": {}},
                      "serverInfo": {"name": "work", "version": "1.0.0"}}
        elif method == "ping" and not params:
            result = {}
        elif method == "tools/list" and not params:
            result = {"tools": [{"name": name,
                                 "description": "Bounded workspace " + name,
                                 "inputSchema": SCHEMAS[name]}
                                for name in operations]}
        elif method == "tools/call":
            if set(params) != {"name", "arguments"}:
                raise ValueError("INVALID_TOOL_CALL")
            name = params["name"]
            if type(name) is not str or name not in operations:
                raise ValueError("OPERATION_DENIED")
            validate(params["arguments"], SCHEMAS[name])
            text = execute(name, params["arguments"])
            result = {"content": [{"type": "text", "text": text}]}
        else:
            return error(request_id, -32601)
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    except (ValueError, OSError, UnicodeError, TypeError, RecursionError):
        return error(request_id)
