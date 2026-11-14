# Adopted host stage entry

This is the current Linux backend, not a universal host-OS requirement.
See [host-environments.md](host-environments.md) for the coupling audit,
Desktop assessment and support limits. Existing security checks remain mandatory.

The installed CLI now executes one bounded stage:

```sh
/usr/bin/node /opt/nibfin/core/bin/nibfin-core.mjs stage 42 shape
```

The first argument selects an already adopted Issue. It supplies no authority.
Stage names are those returned by `contract`; `continue` drives their existing
ordered contract under one host fence, with a distinct execution per role.
Continuation output uses `stage: continue`, with the actual `terminalStage` and
its persisted receipt hash. JSON output retains interface v1:
`completed` exits 0, `denied` exits 1, and `pending` exits 2. When re-admission
observes changed inputs, `changedFields` lists field names such as
`ci.provenanceHash` or `pause.observationHash` without their values.
GitHub Actions may queue a continuation while another run for the same Issue is
active. That wait is normal scheduling. An invalid request is refused before
configuration or network access.

## Administrative adoption contract

This initial launcher supports one manually adopted Linux host per member route,
using an explicitly adopted Docker backend. It is not a general host installer,
automatic enrollment flow, distributed lease, or new product-wide OS requirement.
The administrator installs the verified package at `/opt/nibfin/core` with
root-owned, non-Runner-writable code and creates `/etc/nibfin/host.json`. The
configuration and all ancestors must be root-owned, non-symlinked and not
group/world writable. Rootless Core runs as the configured non-root Runner.
The controlled rootful backend requires a separate private controller identity
and a fixed privilege relay; see [rootful-host.md](rootful-host.md).
There is no environment variable or request parameter to replace this file.

The adoption file has these fields; credentials are never embedded in it:

| Field | Trusted administrative value |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `single-host-linux-v1` |
| `uid` | Actual non-root controller UID |
| `runnerUid` | Rootful only: distinct unprivileged Runner UID; see `rootful-host.md` |
| `runnerId`, `memberId` | Native registered Runner ID and authorized GitHub user ID |
| `installation` | `{directory: "/opt/nibfin/core", pin}` using the verified public package pin |
| `stateRoot` | Canonical existing controller-owned 0700 directory; persistent across jobs |
| `tokenFile` | Controller-owned 0600 single-link file in a private directory; native read/write credential |
| `authFile` | Existing private subscription login file, validated by the Agent adapter |
| `globalInstructionsFile` | Optional absolute path to the user's global `AGENTS.md` |
| `model` | Adopted Codex model |
| `issues` | Map keyed by positive Issue number, containing the records below |

At Job start, Core reads the configured global instructions once and supplies the
same text to each role. For a native MCP source on this host, the default is
`AGENTS.md` in its adopted Codex home. An absent default means there are no
instructions to inherit. An explicitly configured file must be readable.
For a split desktop and Runner host, point both at the same user-maintained file.
Only this text is inherited. The role continues to use its fixed Core permissions.

Each Issue record contains:

- `approval`: the existing `readProtectedApproval` pin, including its exact Issue
  ID, independently reviewed approval source and Core source identity. This file
  cannot manufacture approval: Core reads current native protection, approval,
  permissions and revocation on every admitted operation.
- `runner`: the existing `readRunnerBinding` pin: repository/name/ID,
  Runner/name/ID, member/name/ID, workflow ID/path/blob, exact caller source commit,
  actual job name and, when used, reusable workflow repository/path/commit/blob/ref.
  Run/attempt/job/initiating actor IDs are derived from current native resources,
  not configured per invocation. The actual job name may include the caller's
  reusable-job prefix; adopt the observed full name, not an assumed short name.
- `caller`: the exact OIDC repository/owner IDs, subject, ref, workflow ref and
  reusable source pin. These must agree with the adopted runner contract.
- `eventRunner`, `eventCaller`: required only for native Issue-event dispatch.
  These separately adopt the actual event job and signed `issues` identity,
  pinned to Core's `issue.yml` on the same host/member/repository. They cannot
  replace normal stage identity; see `wake-entry.md`.
- `isolation`: an adopted `linux-rootless-docker-v1` or `linux-rootful-docker-v1` profile with exact Issue
  identity, fixed Agent/hook image and socket, dedicated isolated network/proxy,
  installed security policies and Codex version. Both adapters use the same daemon.
- `ciWorkflows`, `reviewers`: the existing native CI and independent review pins.

When using the nested dispatch bridge, also adopt `runner.wakeWorkflow` for the
exact `wake.yml` source; `runner.reusable` and the OIDC reusable pin still name
`stage.yml`. Both source files and the actual nested job name must be verified.
See [wake-entry.md](wake-entry.md) for the caller and hosted resolver configuration.

Acquire those pins from native provider resources and independently reviewed
installation decisions. Never derive trusted pins from the incoming token or
Issue text. The native credential needs the existing observer's repository,
protection, Runner, membership, checks and approved-write access; the workflow's
read-only `GITHUB_TOKEN` does not substitute for it. No credential is passed to
the workflow input, Agent context or child shell environment.

## Legacy workflow call

At previously adopted Core revisions, `.github/workflows/stage.yml` is the
executable reusable entry. A protected
default-branch `workflow_dispatch` caller invokes it with an exact Core commit
pin and `issue_number`, `stage`, `member_id`. Pass `contents: read` and
`id-token: write`; the caller cannot elevate the host's approved operations.
`member_id` chooses the native scheduling label only. Core independently checks
actual assignee/member, Runner, run/attempt/job, signature and source identity.

The workflow does not checkout candidate code, install arbitrary dependencies,
load an input-selected adapter or receive subscription/write secrets. It runs
the installed CLI with an explicitly limited environment. The reusable source
must match the independently adopted native workflow and OIDC pins. Merely
placing this file on a branch is not a supported live deployment claim.

## State, cancellation and recovery

After the merged delivery has closed the Issue, Core checks the local files against
the recorded Candidate while it still holds the Issue fence. Matching working
files can be removed while Git objects, artifacts and receipts stay available.
Local edits, unrelated ignored files and unresolved executions keep the workspace.

For hosts using automated Core rollouts, the verified package includes
`scripts/host-auto-rollout.py`, `scripts/nibfin-rollout.service` and
`scripts/nibfin-rollout.timer`. During host setup or maintenance, the administrator
installs the script at `/usr/local/libexec/nibfin/host-auto-rollout.py`, installs
the units under `/etc/systemd/system`, reloads systemd and enables the timer.
Once installed, the service refreshes its script from verified Core updates.
The service removes superseded staged packages after the Runner resumes or on an
idle pass. Installed rollback packages, host settings and gateways remain available.

Core CD also prepares the E2E Issue caller from the same verified Core package.
The host waits for the E2E `verify` check and for the shared Runners to become
idle. During promotion it updates the E2E caller on `main` and registers E2E
with the Core shared Runner pool. No separate E2E Runner registration is needed.
To check routing after promotion, follow an E2E Issue event to the Core shared
Runner wake, then check the linked stage run for the expected Issue and role.
On a two-Runner host, check the enrollment in the configuration each Runner
sees. A Runner service can bind a repository-specific file to
`/etc/nibfin/host.json`. Each view used by the shared pool needs the E2E peer
file and its repository ID in the shared Runner allowlist.

Core prepares the Issue workspace from freshly read main, keeping Git metadata
outside the Agent mount. Later stages reuse that workspace and receipts; they
never reset an existing workspace. Approval/source changes still invalidate
stage evidence through the existing native executor.
Workspace creation also writes its authority binding into the existing evidence
store. An existing workspace without that current binding stops Pending; changed
Scope, approval or Core source cannot silently reuse it.

Before any workspace mutation, a per-Issue exclusive file is created and synced.
It serializes stages for that Issue on the host. Every writer inspection confirms its
identity, the exact adopted Runner ID/name registration with the member route,
online status and busy state, and the absence of all containers except the adopted
egress gateway on the dedicated daemon. Other same-member or unrelated registrations
do not determine admission or prove Writer exclusivity. GitHub assigns the native
Job; its full Runner binding remains mandatory. Agent/hook preflights remain
mandatory.

Only a known non-Pending result or an explicit pre-effect CI observation timeout,
followed by a clean host inspection, releases the fence. Nonterminal native CI,
not-yet-registered checks and unknown mergeability have distinct pending codes.
Exceptions, process death, unknown writes or leftover containers
retain `stage.lock`; a subsequent job returns Pending. Never delete it based on
a PID, age, canceled job or apparent offline Runner. An administrator must first
reconcile previous processes, containers and native writes. Moving/replacing the
host or its Runner registration also requires reconciliation; removing a GitHub
registration is not proof that the old host stopped. This launcher does not
automatically adopt a replacement host or claim cross-host crash recovery.

For a published PR repair whose head read-back was interrupted, stop the adopted
Runner and wait for GitHub to report it offline. Recovery requires the same
trusted Linux host to have entered a different kernel boot. The durable host
fence records `/proc/sys/kernel/random/boot_id` before any Writer starts. A
missing PID, a completed Job, a rerun or a removed Label cannot replace this
proof. Same-boot interruptions and legacy fences without a valid boot identity
remain Pending. As the host controller, run
`nibfin-core.mjs recover-commit-pr <issue-number> <observed-pr-head>` from a
verified, administrator-installed Core package. This can use a separate recovery
package while the previous Core remains adopted. It verifies the original
pending decision against the terminal Job, open PR, branch, and exact Candidate
tree and parent. It records the observed publication and archives the fence
after confirming there are no remaining execution containers. It does not push
or retry the GitHub operation. Restart the adopted Runner after settlement.
The existing `recover-review <issue-number> <observed-pr-head>` command uses the
same boot proof and retains its closed-session and prior-review evidence gates.

A retained `execution.lock` is reconciled only for the exact interrupted
operation, controller PID and confirmed result. Ordinary journal acquisition
continues to refuse retained locks. Recovery attempts are serialized; changed
fences, locks or journal state, unknown containers and failed provider read-back
preserve unresolved evidence. A crash that retains a recovery guard stays
Pending for trusted investigation; it is never reclaimed by PID absence or age.
After successful reconciliation, use the ordinary `stage <issue> continue` path.
It reuses valid receipts from the first unfinished stage and reapplies current
admission. Recovery does not start a Writer or bypass permission, assignment,
native dependencies, approval, isolation or CI. Local fixture tests simulate
different boots; they do not certify an actual reboot or live GitHub mutation.

## Validation boundary

For configured MCP access, the launcher owns a durable actual-Job acquisition
claim and one shared restricted profile before constructing any stage executor.
See [Native MCP within an Actions Job](mcp-job.md) for the supported single-entry
Caller, finite Windows-owner startup handoff and separate adoption requirements.
Unarmed hosts, retired Jobs and persistent-capsule fallbacks fail closed. Unknown
preparation or retirement preserves the host fence and never automatically retries.

Tests cover native identity discovery against provider fixtures, duplicate/offline
registered routes, concurrent launch refusal, a real killed child retaining its
fence, unsafe paths and CLI request rejection. Existing installed-executor tests
cover signed caller/native approval and stage receipt persistence. These do not
establish a live authenticated Agent execution through the new launcher. That
requires a genuinely adopted host, protected caller and subscription login; the
manual bootstrap Issue itself is not a normal protected stage request.

## Direct Notion Proposal reads

For an adopted Issue that only needs the Notion Proposal, set the Issue's
`notionProposal` field to `{ "pageId": "<uuid>", "tokenFile": "<absolute path>" }`
in the trusted host file. Share that page with a read-only Notion internal
connection. Keep the token in a controller-owned 0600 file under a private 0700
directory. Each admitted Job fetches the exact page once and gives its roles a
read-only snapshot at `/input/proposal.md`. Later Jobs read the current page,
including any edits. The token stays with the controller.
This Issue uses the direct Proposal read in place of the host MCP profile.
Missing access and incomplete responses fail before taking the execution fence.

## Project declarations

After establishing the target development workspace, the launcher selects optional
[project configuration](project-configuration.md) once for this Job. Subsequent
stage compositions reuse that selection, while custom Skill content remains a
later consumer responsibility. Invalid configuration reports
`PROJECT_CONFIG_INVALID` with a sanitized file/field diagnostic.
