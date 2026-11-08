# User MCP inheritance

Nibfin's product direction is to reuse the maintainer's existing MCP settings
and legal authentication inside isolated Agent roles. A separate public copy of
the governing Proposal is not an installation requirement.

This implementation adds a guarded HTTP inheritance boundary. It does not change
the fixed Core, Action or CLI candidates used by the successful external E2E.
It has not been adopted into the production host or exercised in a real Agent
turn. Passing unit tests or native configuration parsing is not that evidence.

## Trusted source and supported configuration

The Actions Job host launcher now requires the finite native Job source described
in [Native MCP within an Actions Job](mcp-job.md). It does not accept a persistent
capsule or native Linux configuration as a fresh Job acquisition fallback. The
following source forms remain low-level reader/export utilities for bounded
verification and separately authorized migration, rather than Job admission.

A low-level native source is an object containing `codex`,
`home` and `uid`. `codex` is a root-owned native executable; `home` is the user's
canonical, private native Codex configuration directory; `uid` is its owner.
The controller must already have legitimate access to that source. This change
does not grant access to another user's home or Windows credential manager.

The low-level Linux reader can also read a private exported source:

```json
{ "kind": "delegated-http-v1", "file": "/private/mcp/delegation.json" }
```

The expected member comes from the trusted adopted Runner binding. The capsule's
self-declared member, platform and source hash are metadata, not authentication.
Authority comes from Owner-operated export/import and the private file selected
by administrator-owned host adoption. Workflow inputs cannot select this source.

Only the native resolved `mcp_servers` configuration is imported. Native
`app-server` `config/read` supplies the full policies, including per-tool approval
rules omitted by `mcp get --json`. The reader accepts user and trusted system
layers, and rejects project layers and selected-profile layers it cannot
faithfully reproduce. Explicit CLI overrides are not imported. Plugin servers
present only in the native inventory are reported as unavailable, not silently
claimed as inherited. No model turn or MCP tool runs during configuration read.

Currently supported transport is HTTPS on port 443, with static headers,
environment-derived headers or an existing, matching native file-cache OAuth
access token. File-cache parsing follows Codex `rust-v0.166.0`'s
`codex-rs/rmcp-client/src/oauth.rs`: server name and URL must match, and
`expires_at` is an epoch-millisecond integer. Executor-owned credentials are not
delegated. This is version-specific compatibility, not a universal cache format.

The original refresh token/cache is never copied, rotated or overwritten.
Delegated access tokens must have enough remaining lifetime for the bounded
execution. Native keyring-only OAuth, ChatGPT-authenticated MCP, desktop connector
OAuth and STDIO server isolation are not implemented by this boundary. They
receive explicit diagnostics; required servers deny execution.
An existing desktop Notion connection does not establish native CLI OAuth.
Users must not paste credentials into Issues, PRs, logs or chat.

## Owner-operated Windows delegation

The bootstrap commands are:

```text
export-mcp <codex> <settings-home> <auth-home> <member-id> <new-private-file>
import-mcp <member-id> <new-private-file> (private stdin only)
```

Export resolves the original user configuration afresh and reads matching native
credentials from the separately enrolled private authentication home. It exports
normalized HTTPS settings and current access headers only. OAuth registration,
client secrets, refresh tokens, model authentication and unrelated user settings
are not transferred. Native `o_auth` and `oauth` inventory spellings are recognized.

The capsule expires no later than the delegated access token or eight hours after
export. It must have at least 31 minutes remaining on import. Its expiry remains
bound to the role profile and is checked again before execution. No automatic
OAuth refresh, credential-store rotation or perpetual installation grant is
created. Expired delegation denies execution and requires controlled renewal;
this change does not establish an automatic native refresh integration.

Windows ownership/DACL, canonical paths, parent write authority, reparse points
and hard links are checked. Only the current owner, SYSTEM and Administrators may
read the private source/output. Original public settings may be readable by other
accounts but must not be writable by them. The exporter never prints the capsule;
its command result contains metadata only. Transfer must use the approved private
pipe and controller-owned destination, never an Issue, chat or Workflow input.

Windows native configuration reading uses a small shipped C# helper, built with
the existing Microsoft .NET Framework compiler in an owner-only temporary
directory. No SDK, service or execution-policy change is installed. The helper
assigns the suspended CLI to a non-breakaway Job Object before resuming it. It
terminates the job and proves zero active processes before emitting its dedicated
termination marker. Native stderr cannot forge that marker. Unknown termination
denies export and preserves recovery resources; verified temporary helpers retire.
The current adapter requires the standard `C:/Windows` system layout and existing
.NET Framework compiler; other Windows layouts and macOS export are unverified.

Import accepts only the exact capsule schema and compatible native version. It
reapplies the same profile restrictions and writes a new controller-private file;
it does not overwrite an existing source or activate a host route. Runtime loading
still performs guarded catalog discovery and all container/egress preflights.
Source export, cross-host credential transfer, runtime/gateway adoption and service
activation remain distinct authorized operations. Run verified bootstrap code,
never a Candidate checkout, to perform these operations.

## Role and isolation policy

Original enabled/disabled tool filters and stricter prompt settings remain.
Automatic remote mutation is not inherited: native approval policy is tightened
to `writes`, and a discovery-only client intersects configured tool filters with
the trusted server's read-only catalog. Unannotated tools are unavailable.
Catalog annotations are server assertions, not independently proven effects;
the administrator must trust the selected provider and its read-only definitions.
This does not make arbitrary third-party MCP servers safe.

Discovery performs initialization, tool listing and session retirement only.
Before contacting a server it writes an exclusive controller-private intent in
the existing Agent state directory. A returned session ID is persisted privately.
Unknown initialization or retirement leaves that intent in place and rejects
later discovery; there is no automatic deletion or retry. Reconciliation must
establish actual session state first. No application tool is invoked by discovery.

STDIO commands can execute outside Codex's command sandbox. They therefore remain
explicitly unavailable until an independently verified process boundary exists.
Issue text, Candidate files and Workflow inputs cannot choose the source, launch
commands, change MCP policy or access a Docker socket.

The generated MCP-only configuration uses a private read-only `/auth/mcp.toml`
mount, copied into denied `/agent-home/config.toml`. It never enters public
inputs, the worktree, argv or prompts. Native safety settings remain command-line
overrides; unrelated user hooks, Skills and policy settings are not imported.
The real command-denial probe includes both private MCP paths. Private output is
checked for inherited credential values before any result becomes evidence.

## Egress adoption

The existing verified gateway may additionally bind-mount a controller-owned
`agent.mcpPolicyDirectory` read-only at `/mcp-policy`, with
`NIBFIN_MCP_POLICY_DIRECTORY=/mcp-policy`. The host directory must be canonical
0755 under a private controller-owned parent. It contains data, never executable
policy modules. Gateway image, source hash, environment and exact mounts remain
verified. Do not create another Engine or use host networking for this feature.

Each execution exclusively creates `current.json` with its identity, exact trusted
MCP destination hosts and a bounded expiry. The gateway still requires HTTPS,
matching TLS SNI, and public IPv4 DNS results. No wildcard, private-address or
arbitrary port access is added. Hooks retain their offline boundary. The lease
is removed only after container absence is proven; unknown termination preserves
the lease and Pending state. An expired capability cannot authorize new tunnels.

Changing the adopted runtime or gateway requires a separately reviewed source
and host adoption. Do not edit the verified proxy file in place, hot-swap the
successful E2E candidate, retry the blocked Shape receipt, or claim Phase 1
delivery from these tests.

## Remaining integration gates

- The Windows file-delegation path needs approved real credential transfer and
  adopted protected-role validation. Unit tests do not establish that result.
- Desktop/keyring-only authentication and automatic native refresh integration
  remain unverified; current file-cache delegation is explicitly bounded.
- Actual provider login, role tool availability, read-only rejection, private
  path denial and gateway behavior must be exercised on the adopted candidate.
- The previously blocked Shape requires legal correction/re-authorization;
  its original receipt and recovery evidence must remain intact.

References: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp),
[Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp), and
[native OAuth implementation](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/rmcp-client/src/oauth.rs).
