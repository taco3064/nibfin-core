# `src/config`

Reads the repository's `.nibfin.json`, resolves its role skills and installs its
declared tools. Owned by #669.

## Errors

`ConfigError { code, cause }` rejects the Job. `cause` keeps the original error.

- `CONFIG_INVALID`: `.nibfin.json` is not JSON, breaks the schema (the message lists
  every problem with its JSON path), or does not resolve to a regular file inside the
  workspace.
- `CONFIG_SKILL_PATH_INVALID`: a skill path is unsafe or unusable; the message names the
  path and the reason.
- `TOOL_INSTALL_FAILED`: a tool could not be installed, or the cache is not usable.

## Schema

`readNibfinConfig(workspace, { builtInDir? })` reads `<workspace>/.nibfin.json`;
`parseNibfinConfig(text, skillNames)` validates text against the given skill names,
which `readNibfinConfig` discovers from `builtInDir` (see Role skills). A missing
file gives `{ tools: {}, skills: {} }`: no tools and the built-in skills. A symlink is followed only when it stays inside the real workspace; a
dangling one is invalid, not missing.

```json
{
  "tools": { "node": "22.15.0", "python": "3.13.7", "go": "1.24.2" },
  "skills": { "deliver": { "mode": "extend", "path": "docs/deliver.md" } }
}
```

- Top level: only `tools` and `skills`, both optional objects.
- `tools`: only `node`, `python` and `go`, each an exact `x.y.z` string. Go also takes
  `x.y`, which must name a release called exactly `go<x.y>`: first releases up to Go
  1.20 have names like `go1.20`, without `.0`.
- `skills`: only the built-in skills (today `accept`, `deliver`, `repair`, `scope` and
  `shape`; Proposal R7.5), each exactly `{ mode, path }` with `mode` `extend` or
  `override` and `path` a string. Any other name is rejected as an unknown skill, with
  the list of the built-in skills.
- Any other key at any level is invalid, including the removed `allowedDomains` and
  `writerBackend`.

## Role skills

`resolveRoleSkill(role, config, { workspace, builtInDir? })` returns the skill text.
The built-in skill is `<builtInDir>/<role>/SKILL.md`; `builtInDir` defaults to Core's
own `skills/` beside `src/` and `dist/` (`defaultBuiltInDir`).

The built-in skills are discovered, not listed in code:
`readBuiltInSkillNames(builtInDir?)` returns the sorted names of the directories of `builtInDir` that hold a regular-file
`SKILL.md`, so a skill added to `skills/` is adjustable with no code change (#734).
A failure to read `builtInDir` itself keeps its original error. The names come only
from Core's own directory, never from the workspace. `resolveRoleSkill` rejects a
role that is not one of them with `CONFIG_INVALID`, naming the skills that exist.

- No setting: the built-in text.
- `extend`: the built-in text, a blank line, then the repository file.
- `override`: the repository file only. A missing file is an error; the built-in text
  is never used in its place.

The repository path must be relative, end in `.md`, contain no NUL, and resolve
(symlinks followed) to a regular `.md` file inside the real workspace, holding UTF-8
text. Skill text is prompt content only; it cannot change permissions or merge gates.

## Tools

`prepareTools(tools, { workspace, cacheDir, fetch?, run?, executables?, arch? })`
installs each declared tool and returns its `PATH` entries in the order Node.js,
Python, Go. Each entry is `<cacheDir>/<tool>/<version>/bin`.

- **Sources.** Only the publishers below; repository files never choose a source, and
  no repository code runs. Linux archives for `x64` or `arm64` (`process.arch`).
  - Node.js: `https://nodejs.org/dist/v<v>/node-v<v>-linux-<x64|arm64>.tar.gz`,
    checked against that release's `SHASUMS256.txt`.
  - Go: the `go<v>` release in `https://go.dev/dl/?mode=json&include=all`, its
    `linux` `amd64|arm64` `archive` file from `https://go.dev/dl/<filename>`
    (redirects followed), checked against the listed `sha256`.
  - Python: `uv python install <v>`, then `uv python find --managed-python <v>`.
- **Checksums.** The downloaded bytes are hashed before `tar -xzf` unpacks them
  (`--strip-components=1 --no-same-owner`). Only the publisher's checksum is trusted.
- **uv.** `UV_NO_CONFIG=1`, so no `uv.toml` or `pyproject.toml` can set a mirror;
  `UV_PYTHON_INSTALL_DIR` and `UV_PYTHON_BIN_DIR` point into the install directory.
  The interpreter that `find` prints must lie inside the new installation. `bin/`
  gets `python` and `python3` as relative symlinks to it.
- **Processes.** `tar` and `uv` run with `childEnvironment` from `src/agent`, so stage
  credentials and variables such as `UV_PYTHON_INSTALL_MIRROR` never reach them, and
  with a working directory inside the cache.
- **Cache.** `cacheDir` must be outside the workspace, also after symlinks are
  resolved. Versions are checked against the schema again before they become paths
  or URLs, and any filesystem failure while preparing the cache is
  `TOOL_INSTALL_FAILED` with the original cause. Each install fills a unique `<cacheDir>/<tool>/.<version>-*` directory and
  renames it to `<cacheDir>/<tool>/<version>`. Only that final directory counts as
  installed, so an existing one is reused without downloading and an interrupted
  temporary directory is ignored. A rename collision means another Job finished first;
  its directory is used. The Job removes its own temporary directory after any failure
  or collision.

`fetch` (default `globalThis.fetch`), `run` and `executables` (`tar`, `uv`) are
injectable. Tests use a fake publisher and fake processes; one test unpacks a small
archive with the system `tar`.

## Interfaces with other Issues

- #671 calls `readNibfinConfig` before any role runs and rejects the Job on
  `ConfigError` with its code and cause, then uses `resolveRoleSkill` and
  `prepareTools`. The `PATH` entries are for the agent's tool processes only: Core's
  own CLIs (agent CLIs, rulesync) keep running on the image's Node, started through
  Core's Node by absolute path, not through `env node` on the changed `PATH`.
- #666 ships `uv` in the image; `tar` comes with its base image.
