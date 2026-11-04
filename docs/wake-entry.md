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

### Fixed Action continuation caller

`caller-recipes.json` also owns the `action-wake` recipe. It accepts the same
three Issue/repository locator inputs as `WakeDispatcher`, routes to one fixed
member Runner and invokes an immutable `nibfin-act` commit with `stage: continue`.
It has no shell steps, checkout, role policy or subscription/write secrets.
The protected Issue-event entry still observes eligibility before dispatch;
the installed Core still independently admits every subsequent stage.

An administrator adopting this caller sets `runner.actionCommit` to that exact
reviewed Action commit and `runner.actionCoreCommit` to the installed Core pin.
Do not set `runner.reusable` or `runner.wakeWorkflow` for this direct Action
caller. Its native job and OIDC pins identify the actual caller job, not a
Core reusable workflow. The event job retains its separate `issue.yml` pins.
Hosted wake adoption includes `workflow.actionCommit`; Core renders the exact
recipe with the approved writer's native user ID and approval's Core source.
An ordinary main advance is permitted only with the same complete recipe and
unchanged file history. Altered Action/Core/member pins or edited/restored
callers fail the existing source checks. Inputs cannot select any of these pins.

The Action must independently verify that its packaged Core pin matches the
administrator-installed Core. Render/install consumers must adopt the new
three-recipe inventory at immutable compatible revisions. Existing `wake` and
`issue` recipes remain byte-compatible; older pinned consumers continue using
their original source. This wiring is not authenticated E2E evidence.

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

## Issue-event entry and durable dispatch

Install the exact `issue` caller rendered from `src/caller-recipes.json` with
`callerRecipe('issue', coreCommit)`. The same source defines the `wake` caller.
These complete codeless templates are the only callers allowed to run at a later
protected-main commit. Do not add checkout, local actions, scripts, extra jobs or
mutable references. Custom callers require their exact adopted commit. Caller
edits, including edit-then-restore, revoke continuity.

The hosted resolve job verifies the native Issue event and current approval,
then emits only Issue/member locators. It performs no dispatch and has no
persistent journal. Its configured token needs native authorization reads;
its historical secret name does not grant permission to write.

The second job invokes only the fixed installed `dispatch-event <issue>` entry.
It checks the administrator-adopted event Runner/job, signed OIDC, protected
source, current approval, publisher role and single-host identity. It holds the
same host-wide fence as stages and uses the existing OperationJournal under
private persistent `stateRoot/wake`. No workflow input selects its token,
directory, command, adapter or security policy.

Add `eventWorkflow: {id, path, commit, blob}` to the hosted adoption. Add
`eventRunner` and `eventCaller` to the fixed host Issue record: they use the same
repository, member and registered Runner as its stage record;
`eventRunner.reusable` names this Core's exact `issue.yml`, and the signed
`eventCaller.eventName` is exactly `issues`. Adopt the actual full event job
name. Normal stage callers still admit only `workflow_dispatch`.

Opened, edited, assigned, unassigned, reopened, unlabeled and closed events may
resolve current state. Labeled events only consider `scope`. Closed fanout
rechecks actual delivered status and both native dependency directions. Target
adoption is resolved independently of eligibility: one known unready target
does not prevent a ready sibling. Unknown effects stop fanout and retain the
journal/fence; identical completed dispatch decisions are never posted again.
Reruns remain refused. No journal is deleted to enable automatic retries.

GITHUB_TOKEN Issue writes do not imply event recursion. Such a Scope publisher
must explicitly use the adopted Dispatch handoff; do not assume a label change
will start the Issue workflow. Each stage re-enters native admission and reads
its receipt under the same host fence. Failed evidence requires authorized
correction; this entry does not add automatic repair or cross-host recovery.

Tests and package installation establish reproducible code behavior only.
Actual event, Runner/OIDC, authenticated Agent/container execution and full
external delivery remain unverified until exercised on a lawful adopted host.
