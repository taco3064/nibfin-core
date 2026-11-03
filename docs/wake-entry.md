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

This bridge starts one authorized stage. It does not automatically advance every
later stage, resume unknown execution, or manufacture missing validator receipts.
Native Issue-event observation/fanout remains the existing Core API, to be wired
by the authorized thin caller; this workflow accepts legal Dispatch only. Its
actual provider handoff and authenticated host execution must be verified before
C14 is accepted. See `local-verification-handoff.md`.
