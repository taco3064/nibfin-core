# Core consumer interface v1

Thin Action and CLI consumers use the public ESM exports in `src/public-api.mjs`.
They must not copy admission, routing, acceptance, publication or recovery policy.
Public installation uses the exact source and archive pins; it does not fetch
private Kairo code.

## Stage transport

`runStageInput(input, executor)` accepts a JSON string of at most 4096 UTF-8 bytes:

```json
{"schemaVersion":1,"stage":"shape"}
```

Only these two fields are permitted. The `contract` CLI command lists supported
stages. A request cannot provide a token, adapter path, command, source pin,
approval, execution identity or an `authorized` flag. Invalid requests are
rejected before the host is consulted. The transport emits no raw exception text.

| Status | Meaning | Consumer behavior |
| --- | --- | --- |
| `completed` | Stage-specific read-back and receipt persistence succeeded | Display the receipt identity; this is not completion of the entire Issue |
| `denied` | Admission failed, the request was invalid, or correction is required | Report the code; do not bypass the gate |
| `pending` | Execution or an external effect cannot be established safely | Stop automatic retries and retain the existing in-flight state |

## Trusted composition

Installed host code calls `nativeStageExecutor` with its native reader, fixed
approval/runner configuration, authenticated execution identity, source/caller/
isolation inspectors, Agent, workspace, hook sandbox and private write credential.
These are privileged code dependencies, never fields accepted from workflow
events, Issue bodies or Agent output. Importing this API is not authorization.

Core constructs the native observer, guarded writes, fixed stage handlers,
Issue-bound journal and approval-bound evidence store together. It repeats native
observation before execution and each protected write. A change in the approval,
Scope or installed source cannot move a running stage into another receipt
namespace. Independent roles use separate authenticated execution identities.

The same Issue's journal survives construction of another executor. A previously
completed operation is rejected as a replay; an unknown operation stays Pending.
This local fence does not prove exclusivity across different Runner hosts. The
trusted isolation inspector must establish the applicable writer boundary; an
event or a config value cannot stand in for that proof.

## Verified installation and fixed Agent assembly

`installedStageExecutor` is the installation-aware entry. Its installation pin,
native caller pin, execution identity and credentials are privileged launcher
inputs. It owns source-file verification and signed Actions caller verification;
the consumer cannot replace these with callbacks. Construction verifies the
actual installation before any network call, and each invocation and native
observation verifies it again. The source must equal the protected approval's
repository, commit, policy and Skills identities.

`codexStageExecutor` adds fixed Core-owned CandidateWorkspace, CodexRoleAgent,
CodexSandbox and OfflineSandbox adapters. Skills are read from the verified
installation, not a separately configured module tree. This provisional adapter
requires an already prepared workspace, adopted private authentication/state
paths and a trusted live writer-exclusivity inspector. It performs actual Agent
and hook preflights before admission. A JSON `exclusive` flag or native job
completion alone cannot supply the writer proof. There is no automatic Docker,
Linux or WSL installation and no new host support claim.

| Entry | Trusted responsibility retained by host |
| --- | --- |
| `nativeStageExecutor` | All platform adapters and source/caller/isolation inspectors |
| `installedStageExecutor` | Platform adapters and isolation inspector; Core owns source and caller verification |
| `codexStageExecutor` | Adopted paths, prepared workspace and live writer proof; Core also owns Agent/workspace/hook adapter construction |

The native reader and write credential remain outside Agent invocation input.
The Actions token request credential is sent only to the validated native token
service, never GitHub API or an Agent. Native signatures, actual run/job identity,
current membership and protected approval must all agree before a stage runs.

## Current integration limits

The public package includes the composition API and bounded stage transport.
The CLI offers `contract`, `pack`, `install`, `verify` and
`stage <adopted-issue-number> <stage>`. The stage entry reads fixed administrative
host configuration, discovers the actual job, verifies native signed identity,
prepares the workspace and constructs the existing Codex executor. The current
Core workflow entry is `.github/workflows/shared-runner.yml`. Core CI and Core CD
use the shared packaging action.
See the [host adoption and execution contract](host-launcher.md) for inputs,
permissions, durable cancellation fences and the single-host support boundary.
Automatic enrollment, live authenticated execution and public release remain
separate requirements; the entry's existence does not establish those outcomes.


## Provisional Linux adapter prerequisites

The verified installation includes upstream security profiles under
`src/security`, with their source revision and license. Host adoption must load
that exact AppArmor profile. The adapter uses an explicitly adopted Docker backend with
cgroup resource enforcement, a pinned image containing Codex CLI 0.138.0, an
isolated internal network and the fixed egress proxy. It rejects absent or changed
container policy; no privileged or unconfined fallback exists.
The controlled rootful backend additionally requires the identity/socket and
user-namespace boundary in [rootful-host.md](rootful-host.md).

Each work/main/input/output/session mount must have its own canonical,
controller-owned parent with mode 0700. Mapped UID access applies below that
private boundary and preserves executable-file identity. The original auth file
is never made public or changed. Private copies and stopped session contents are
removed only after writer termination and mapped-file cleanup are established.
Uncertain cleanup returns Pending and cannot issue execution proof.

Remote tests exercise the production adapter with actual Docker and Codex, using
empty synthetic login state. They verify sandbox enforcement and missing-login
denial, not subscription inference. A separate ephemeral registered Runner test
verified native self-hosted identity and push-event refusal; it does not establish
trusted host adoption or protected stage admission. See the migration status
for exact source revisions, runs and the distinct test-host boundaries.


The adopted Actions subject must match the repository's current exact native
OIDC configuration. New github.com repositories use
`repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH` by default. Existing or
customized repositories may differ. Do not infer the trusted subject from an
incoming token, accept both formats automatically, or remove the independent
repository/owner ID checks. A changed subject requires trusted adoption read-back.

## Source cache modes on Windows

The pinned manifest authenticates each file's declared Git mode (`100644` or
`100755`) on every OS. Node on Windows does not round-trip POSIX execute bits:
the real CLI cache test observed identical launcher bytes but mode `100644`
for the declared `100755` Linux launcher. Windows source verification therefore
validates declared modes against the authenticated manifest, alongside complete
file-set, content/size/hash, canonical-path, regular-file and link checks.
POSIX hosts additionally retain their actual executable-class comparison.

This is source-cache verification, not Windows executable/ACL attestation or
trusted host adoption. Protected stage/backend eligibility is unchanged. The
Windows filesystem smoke test does not establish a Windows container backend.

Reference: [Node 24 filesystem permission caveats](https://nodejs.org/docs/latest-v24.x/api/fs.html#fschmodpath-mode-callback).

## Bounded process transport for verified consumers

The public `command` export is the shared trusted host process primitive. It is
not an Issue/Workflow JSON interface or an authorization adapter. Consumers must
verify the exact installed Core source before importing this helper, select a
fixed absolute executable/argv in their reviewed code, and supply an explicit
restricted environment. No shell or inherited credentials are used.

Options retain `cwd`, `env`, `input`, positive `timeout` and output `limit`.
`allowedExitCodes` defaults to `[0]` and must be a nonempty bounded list of
integers 0 through 255. A thin stage consumer may use `[0, 1, 2]` to read Core's
completed/denied/Pending JSON. This whitelist changes transport decoding only;
the consumer must still enforce the Core outcome/exit/receipt contract.
Successful transport returns Buffer `stdout`, Buffer `stderr` and `exitCode`.

Timeout or output overflow first requests SIGTERM. After a fixed one-second
grace, Core attempts SIGKILL and settles the transport independently of `close`,
closing its local pipes and unreferencing remaining handles. A leader already
observed to exit is not signalled again. Partial output is not returned with
transport failure. A settled caller does not prove that another UID, a detached
descendant or external operation terminated. Stage consumers must return Pending
and preserve fences/journals until actual effects and processes are reconciled.
