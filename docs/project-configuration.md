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
  required Core destinations or the independent MCP/login channel. ENV-03
  enforces DNS/address safety, including public names resolving privately.
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
configuration. Declarations remain selected for the Job, while SKILL-01 reads the
configured file afresh at each role start from that active work tree. It never
loads project instructions from the dispatch repository, installed Core, or the
separate current-main snapshot.

An omitted identity uses the complete built-in Skill. Extend preserves the full
built-in text first, then a blank-line/horizontal-rule boundary, then the complete
project text. Override supplies only project text, including empty or incomplete
instructions without built-in front matter. There is no semantic validation,
automatic repair, or fallback after a loader or role-result failure. Installed
built-in integrity checks still apply whenever built-in instructions are used.
Shape Author, independent Validator, and final Shaper Review share the shape
setting but keep distinct execution roles; no scope or separate review keys exist.

Configured paths must end in .md (case insensitive) and identify regular files.
The Linux loader rejects symlinks in every configured path component and pins
parent directory descriptors before opening children, preventing a concurrent
path replacement from redirecting a read outside the work tree. Missing,
unreadable, non-Markdown, directory, or unsafe files fail before the affected
role launches with an ordinary PROJECT_SKILL_UNREADABLE_OR_UNSAFE error; lexical
configuration errors name the relevant configuration field. Diagnostics do not
include file contents or host paths. Role identities, permissions, isolation,
credential handling, required results, GitHub controls, and protected delivery
gates remain Core-owned, independently of the project instruction text.

ENV-03 normalizes additional hosts to lowercase and removes duplicates. Each role
uses the Job snapshot for both general Agent network requirements and the existing
HTTPS proxy. Exact hosts require port 443, matching TLS SNI and exclusively public
IPv4 DNS answers. HTTP, wildcard/suffix matching and private addresses stay denied.

Project policy uses `project.json` in the existing protected Runner-slot
`agent.mcpPolicyDirectory` mount; the independent MCP lease remains in
`current.json`. The Agent never receives that directory as a mount. Hosts with
additional project domains require this adopted policy channel; missing adoption
fails before launch. Policy publication is exclusive even for an empty list, so a
stale owner cannot be overwritten during slot reuse. The existing 64 KiB protected
policy-file bound applies, and oversized publication fails before launch.

Project leases are retired after confirmed container absence on completion,
execution/setup failure or cancellation. Unknown termination or tampered cleanup
retains Pending behavior and blocks slot reuse. Project retirement leaves MCP
permissions intact until their independent cleanup completes. No host-wide union,
new proxy, gateway, network or offline Hook permission is introduced.
