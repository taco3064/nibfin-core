# Optional project configuration

ENV-01 reads `.nibfin.json` from the authenticated Issue target's existing,
main-derived development work tree. A shared Runner's execution repository never
supplies this file. The launcher selects declarations after establishing that
workspace and before composing stages. One in-memory Job closure retains the
selection across stages, including retries; a subsequent Job reads its own file.
There is no cross-repository union or permanent settings database.

The JSON root is an object with only these optional properties (no version key):

```json
{
  "tools": { "node": "22.15.0", "python": "3.13.7", "go": "1.24.0" },
  "allowedDomains": ["pypi.org", "files.pythonhosted.org"],
  "skills": {
    "shape": { "mode": "extend", "path": ".nibfin/skills/shape/SKILL.md" },
    "deliver": { "mode": "override", "path": ".nibfin/skills/deliver/SKILL.md" },
    "accept": { "mode": "extend", "path": ".nibfin/skills/accept/SKILL.md" }
  }
}
```

- `tools` is an object accepting only `node`, `python`, and `go`. Values are
  strings of three decimal components (`major.minor.patch`), without leading
  zeros except zero itself. Prefixes, ranges, aliases, prerelease suffixes,
  whitespace and commands are rejected. Acceptance declares a version; it does
  not promise that ENV-02 can provision it.
- `allowedDomains` is an array of complete ASCII DNS names, with valid labels
  and an alphabetic suffix. Schemes, URLs, credentials, ports, paths, wildcards,
  IP literals, single-label names, trailing dots and local/private suffixes
  (`localhost`, `local`, `internal`, `lan`, `home`, `arpa`, `localdomain`) are rejected.
  These declarations request additional HTTPS destinations; they never replace
  required Core destinations or the independent MCP/login channel. ENV-03 must
  enforce actual DNS/address safety, including public names resolving privately.
- `skills` accepts only `shape`, `deliver`, and `accept`. Each entry requires
  exactly `mode` (`extend` or `override`) and `path` (a nonempty relative file
  path). Absolute/drive/UNC paths, backslashes, colons, control characters,
  empty components, `.` and `..` components are rejected. Unknown properties
  at every level fail rather than being ignored.

Absence of the file and `{}` preserve all existing defaults. Omitted properties
remain absent; explicit empty objects/arrays remain explicit empty declarations.
An unusable present file is an ordinary error naming `.nibfin.json` and the
relevant field; diagnostics do not quote file contents or untrusted values.
The configuration file must be regular and cannot be a symlink.
Before any role starts, a configuration error retires prepared MCP resources and
releases the stage fence only after the operation journal and containers are
proven settled. Correcting the file then permits a new invocation. Unresolved
writes, containers or MCP retirement retain the fence for existing recovery.

Validated tools reach the Agent and offline Hooks environment boundaries;
additional domains reach the Agent network configuration boundary. This reader
neither installs tools nor changes the proxy allowlist or container image.
Validated Skill declarations and the target work-tree root reach the role Agent
configuration. ENV-01 does not open or apply custom Skill files, so their content
is not snapshotted. SKILL-01 must resolve paths with real filesystem containment
(including symlink escape protection) and read current development work-tree
content when each later role starts. Extend appends to the built-in instructions;
override replaces their instruction content. Role identities, permissions and
protected delivery gates remain Core-owned.
