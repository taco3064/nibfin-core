# Adopted dispatch to stage execution

The current `stage.yml` routes explicitly to the Linux launcher backend.
This is not a universal Core OS requirement or proof of Desktop support.
See [host-environments.md](host-environments.md).

`wake.yml` connects the existing `WakeDispatcher` locator payload to the installed
stage launcher. It is a reusable workflow for a protected default-branch
`workflow_dispatch` caller. It is not a public Issue-to-command endpoint.

1. Fixed inline workflow code compares `core_commit` with the administrator's
   adopted Core commit **before checkout**. No read token is present in that step.
2. GitHub-hosted resolution reads the actual run/attempt, caller source and actor,
   adopted approval, current Issue, dependencies and eligible assignee. Dispatch
   inputs contain only Issue/repository identities. Stage/member overrides deny.
3. Normal unshaped work resolves to `shape`; shaped work resolves to `deliver`.
   Both require their operation and routed role to be authorized. Resolution is
   not stage admission or proof that existing Shape was legitimately published.
4. Only successful resolution schedules `stage.yml`. That job receives three
   routing strings, not the hosted token/adoption secret. The installed host
   independently checks OIDC, native Runner/job, approval, source, receipts and
   isolation before any Agent or privileged operation.

The CLI `nibfin-core resolve-wake` exposes the same resolver for trusted thin
consumers. It reads `NIBFIN_WAKE_ADOPTION`, `NIBFIN_READ_TOKEN`,
`NIBFIN_CORE_COMMIT` and standard Actions environment/event-file fields. These
must be supplied by the protected caller, not Issue content. The public ESM
adapter is `resolveWakeDispatch`; it does not accept arbitrary executable code.

## Caller and adoption

The administrator commits a caller like this to the target's protected default
branch. Replace both `CORE_COMMIT` placeholders with the same reviewed 40-digit
Core commit; this example is deliberately not an active deployment.

```yaml
name: Nibfin adopted wake
on:
  workflow_dispatch:
    inputs:
      issue_number: { required: true, type: string }
      issue_id: { required: true, type: string }
      repository_id: { required: true, type: string }
permissions:
  contents: read
  id-token: write
concurrency:
  group: nibfin-${{ github.repository_id }}-${{ inputs.issue_number }}
  cancel-in-progress: false
jobs:
  wake:
    uses: taco3064/nibfin-core/.github/workflows/wake.yml@CORE_COMMIT
    with:
      core_commit: CORE_COMMIT
    secrets:
      NIBFIN_WAKE_ADOPTION: ${{ secrets.NIBFIN_WAKE_ADOPTION }}
      NIBFIN_READ_TOKEN: ${{ secrets.NIBFIN_READ_TOKEN }}
```

`NIBFIN_WAKE_ADOPTION` is JSON with `schemaVersion: 1`, `coreCommit`, and an
`issues` array. Each item is the existing `observeWake` configuration:
`{approvalPin, workflow, actorId}`. Pins come from verified native resources and
the protected approval, not event data. The workflow pin describes this target
caller, including its exact default-branch source, workflow ID/path/blob. The
approval's Core source commit must equal `coreCommit`. `actorId` is the authorized
publisher and the actual dispatch/re-run actor must match it.

The hosted read token needs the native reads used by approval/dependency/member/
workflow observation, including branch protection and merge-enforcement evidence.
It is separate from the installed host's guarded write credential and the
subscription Agent login. A generic read-only `GITHUB_TOKEN` is not assumed to
have administration-read access. Never place any of these credentials in a
workflow input, Issue, repository file, artifact or Agent worktree.

Host adoption keeps `runner.reusable` pinned to `stage.yml` and adds
`runner.wakeWorkflow`, pinned to `wake.yml`, each with repository/path/commit/blob/
ref. Both must be `taco3064/nibfin-core` at the same exact commit. Native Runner
admission validates both source files and rejects missing, duplicate or extra
reusable references. The signed OIDC caller pin still names the innermost
`stage.yml`. Adopt the actual full nested job name, not an assumed short name.

## Verified scope and remaining work

Tests exercise the real resolver with native-provider fixtures, both entry
stages, locator/source/actor/permission/label/dependency rejection, run-attempt
changes, the pre-checkout guard and the full two-workflow Runner source chain.
Package CI verifies the installed resolver export. These are reproducible code
checks, not a live authenticated workflow/Agent claim.

The Dispatch bridge now invokes `stage <issue> continue`. The installed host
holds one Writer fence and follows the existing ordered stage definitions.
Each stage constructs a separate role execution, re-enters native admission,
and reads its persisted receipt before continuing. Successful receipt prefixes
are not executed again; malformed, failed or stale prerequisites stop. There is
no parallel phase store. Existing single-stage calls remain available.

Only explicit pre-effect nonterminal CI observations wait (five-second reads,
ten-minute limit). A known CI timeout is Pending after clean host inspection;
an unknown effect retains the fence. Failed checks, changed authority and
arbitrary observation failures do not enter that wait loop. Later dispatches
still need current authorization and valid receipts; no stale-lock recovery or
cross-member handoff is added.

## Hosted Issue-event entry

An administrator may install a separate protected caller:

```yaml
name: Nibfin Issue wake
on:
  issues:
    types: [labeled, assigned, reopened, closed]
permissions:
  contents: read
concurrency:
  group: nibfin-event-${{ github.repository_id }}-${{ github.event.issue.number }}
  cancel-in-progress: false
jobs:
  wake:
    uses: taco3064/nibfin-core/.github/workflows/issue.yml@CORE_COMMIT
    with:
      core_commit: CORE_COMMIT
    secrets:
      NIBFIN_WAKE_ADOPTION: ${{ secrets.NIBFIN_WAKE_ADOPTION }}
      NIBFIN_WAKE_TOKEN: ${{ secrets.NIBFIN_WAKE_TOKEN }}
```

The adoption adds `eventWorkflow: {id, path, commit, blob}` for this exact caller.
The dispatch credential is the approved publisher with native authorization
reads and Actions dispatch permission, never an Agent/model credential. The
hosted job verifies its native run, protected caller source and Issue identity;
it reuses `observeWake`, `WakeDispatcher`, the existing operation journal and
native fanout. Only `scope` label events are considered. Closed events re-read
native delivered status and both dependency directions before waking adopted
downstream work. Unadopted targets never acquire authority.

No target repository checkout or Issue-selected command executes in that job.
An event rerun (attempt > 1) is refused: an unknown dispatch must be reconciled
against native runs, not blindly replayed. The hosted journal is per invocation,
not a permanent queue or cross-host SSOT. Distinct events can schedule duplicate
runs; native concurrency and the protected host's fence/receipt checks prevent
repeated delivery. Install the Dispatch caller's existing per-Issue concurrency
as shown above. GITHUB_TOKEN Issue writes do not imply event recursion: a Scope
publisher using it must choose the existing explicit Dispatch handoff, not both.

These additions have local contract coverage only. Actual authenticated event,
Runner/OIDC, Agent execution and complete external delivery remain unverified
until exercised on an authorized adopted host. See `local-verification-handoff.md`.


Caller adoption commits are ancestry anchors. Ordinary protected main commits
may advance only if the adopted caller blob and its latest file-changing commit
remain identical at the anchor, actual Run source and current main. Rewrites,
caller edits (including edit-then-restore), missing history and changed immutable
Core/reusable pins deny. OIDC always authenticates the actual Run source; a later
main commit never replaces the running Job's identity. Failed stage receipts or
rebase requirements stop for authorized correction; this change does not add
automatic repair or stale-lock recovery.
