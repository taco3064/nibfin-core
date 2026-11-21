# Local Codex handoff: Core #1 remaining verification

## Authority and constraints

Continue the existing `taco3064/nibfin-core#1` manual bootstrap. Read the latest
Proposal, Issue and actual main before work. Do not create new prerequisite
Issues, rewrite the architecture, claim protected self-delivery for manual #1,
or require a second human PR Approve. Independent Agent technical review and
current-source CI still apply. Public repository content is English.

Keep the eight manual Bootstrap Blocked-by edges unchanged. Do not add fake
scope/shaped/delivered labels to #1. Authorized cutover/Scope audit resolves those
edges only after the three bootstraps and external cutover criteria are met.
Full three-repository self-delivery is not an additional Core #1 release gate.

## Completed source work to verify first

- PRs #19–#23 established the runtime and corrected solo authority, single-commit
  rebase/closure, vanished merged-run PR links, and dependency lifecycle checks.
- `docs/wake-entry.md` describes the new dispatch-to-stage bridge and exact
  nested-workflow pins. Read its limits; it starts one stage, not the whole cycle.
- `package.json` prepares `0.1.0-rc.1`; this is a candidate identifier, not a
  published or accepted release. `private: true` prevents accidental npm publish;
  the approved distribution path is GitHub source archives and Releases.

Fetch latest main, run `npm ci --ignore-scripts` and `npm run verify` with the
repository-pinned Node/npm. Inspect current PR/CI evidence before changing code.
Use separate reviewed PRs for any fixes, never a direct feature push to main.

## Establish an actual authorized test environment

The Linux launcher is one backend, not a required user OS. Read
[host-environments.md](host-environments.md) first. Missing local capabilities
do not authorize disabling AppArmor or requiring another physical computer.

1. Inspect available local tools/OS and existing logins without printing or
   copying credentials. Do not assume local Codex login alone proves the product
   sandbox works. Current host launcher supports one manually adopted Linux host
   with its documented rootless Docker isolation; unsupported configurations
   must stop rather than disable safeguards. If local tooling cannot host that
   configuration, use an Owner-authorized remote test host.
2. Read `docs/host-launcher.md`, `docs/native-authorization.md`, actual sandbox
   source and `scripts/verify-live-*.mjs`. Verify the GitHub identity can lawfully
   read branch protections and historical merge enforcement, register/read the
   test Runner where needed, and perform only approved writes. The ChatGPT
   connector previously returned 403 for branch-protection reads; do not reuse
   that observation as proof that a newly authenticated local identity will fail.
3. Use the user's existing Codex subscription login through the supported local
   login flow. Never request a token in chat, put auth in GitHub artifacts/secrets
   without explicit authorization, or pass the privileged GitHub token into an
   Agent session. Install verified Core separately from candidate files and set
   the fixed `/etc/nibfin/host.json` adoption with private credential references.
4. Obtain all approval/Caller/Runner/workflow/CI pins from actual native resources.
   Do not fabricate rule-suite evidence or turn a label/event into a grant. A
   merged approval source and a suitable normal test Issue require Owner-approved
   scope; manual Core #1 is not that normal Issue. If no such target is already
   authorized, present a concrete small test proposal for Owner decision before
   creating or altering external Issues or approval policy.

## Execute and repair within Core #1

Install the pinned caller from `docs/wake-entry.md`, configure its adopted read
identity, and call it through the exact three Issue locator inputs. Capture the
native run/attempt, resolved stage/member, actual Runner job, signed innermost
workflow identity and admission outcome. Verify forged actor/source/locator and
unready prerequisites cannot admit execution. Avoid repeated platform-only tests.

Run at least an actual authenticated Shape and independent Validator execution,
using distinct execution/session identities and the installed production adapter.
Observe isolated credentials, blocked host access and process cleanup. Success
must come from real outputs and native resources, not fixture results. If a later
stage is needed to establish the claimed capability, drive its authorized entry;
do not infer full delivery from a successful Shape. Preserve Pending fences for
unknown writes or processes and reconcile before retrying.

Finish the missing thin Issue-event/dispatch and stage-continuation integration
only within already approved responsibilities. Core owns decisions; Action/CLI
must not duplicate policy. Do not claim that current single-stage dispatch proves
the whole automatic lifecycle. Record precise unresolved boundaries if actual
native evidence exposes a defect, and fix/review it in the same Core #1 scope.

## Candidate packaging and release

GitHub package CI builds `nibfin-core.tar.gz`, `source-pin.json`, `SHA256SUMS` from
the exact commit and tests installation. Core CD runs after successful push CI on
`main`, using the tested commit and changes since its last successful automatic
run. Core package changes prepare a rollout and its consumer updates.
To retry a rollout or request
consumer draft PRs, run the same workflow manually from `main`.
Automatic Core CD reports Docs failures in the Pages jobs and keeps the
verified Core rollout eligible. The next automatic run retries unpublished
Docs. To retry only Docs, run Core CD with `deploy_docs=true`.

To prepare a version draft, first verify that the reviewed version on `main`
matches `package.json` and has passed CI. The repository must protect release
tags so only authorized release operators can create them and existing tags
cannot be moved. Push the version tag from that reviewed revision:

```sh
git tag v0.1.0-rc.1
git push origin refs/tags/v0.1.0-rc.1
```

Read back the Core CD run, draft and assets before retrying an uncertain result.
Select the final version through reviewed source changes, independently check the
assets and applicable immutable-release settings, publish only with the Owner's
release authorization, then read back tag/source/publisher/assets/digests using
the existing `verifyPublishedRelease` contract. Do not assume `private: true`
blocks GitHub Releases or remove it merely to allow an accidental npm publish.

Return actual commit, run/job URLs, exact tested source, authentication/isolation
outcomes, remaining gaps, and release read-back. Keep Core #1 open until the Owner
has reviewed the completion evidence. Do not apply `delivered` to manual #1.

## Core #632 Deliver progress instruction replay

Expected decisions recorded before changing the Skill: for current Issue #632,
a meaningful implementation boundary with unfinished final obligations may yield
one voluntary `progress` result under the revised contract. The old contract
cannot express that handback. A finished implementation returns `ready` in both
versions. No meaningful changes means continue implementation rather than invent
a progress save. A previously confirmed progress save means resume toward final
readiness, with no replacement-Runner save requirement. These expectations come
from the current Issue's binding decisions and implementation steps 1, 6 and 8.
The current Issue and published Shape are supplied in `/input/context.json`;
this is a representative current case, not a recovered historical execution.

Replay results (fresh independent read-only model invocations in the assigned
Linux snapshot environment):

| Case | Old Skill | Revised Skill | Expected comparison |
| --- | --- | --- | --- |
| Meaningful unfinished implementation | Continue to final readiness; no explicit progress handback | Voluntary `progress`, with remaining work recorded | Changed as required |
| Finished implementation and Deliver checks | `ready` | `ready` | Preserved |
| No meaningful changes | Continue implementation | Continue implementation; no invented save | Preserved |
| Trusted previously saved progress | Continue to final readiness | Continue; do not repeat the save on a new Runner | Preserved and explicit |

All cases kept hooks/Accept ineligible before final readiness and kept commits
and pushes exclusively with Core. Expected decisions above were not supplied to
the replay agents. Initial independent Skill-only runs gave the same decisions.
The final comparison used fresh `old_candidate_prompt_replay` and
`revised_prompt_replay` invocations, full prompts generated through maintained
`rolePrompt('deliver', ...)`, the same current `/input/context.json`, Proposal
and prospective Candidate `resultSchema`. Old Skill came from read-only `/main`;
revised Skill came from `/work`. No prior replay output was provided. The
prospective schema was identical in the two runs, isolating Skill decisions.

The active Job schema does not yet permit `progress`; the revised replay also
correctly stated that it must continue working under that old schema. Candidate
parser regressions exercise the shared prospective contract for both providers.
These are conceptual model replays, not an installed Writer run, live GitHub
save, or host activation test. Inputs reconstruct the current Issue #632, not
an unavailable historical execution. The generated role prompt includes native
bound context, Python selection and Proposal mounting; caller global preferences
were not separately serialized into those disposable prompts. The current
Issue and published Shape are the product authority in both versions.

Implementation separates progress/completed checkpoint messages, restoration and
publication matching. Legacy unmarked handoffs remain completed. Progress restores
tracked files without requiring final artifacts, preserves local edits and pending
rebases, and returns through fresh Deliver admission. A completed message is saved
even when its tree equals prior progress. The local operation journal does not
mark a progress handback as completed Deliver; ordinary completed-operation replay
protection is retained. Existing provider validation, VM retirement/handback,
credential scanning, exclusive Writer, publication authorization and observed-head
leases are reused. No live workspace collection or new credentials are introduced.

Development verification command (repository-local fixtures; controlled native
Git repositories and mocked GitHub transport, not live provider publication):

```sh
TMPDIR=/work/.deliver-test-tmp node --test --test-concurrency=1 \
  --test-name-pattern='progress|legacy unmarked|fresh Runner' \
  test/delivery-checkpoint.test.mjs test/deliver-progress.test.mjs \
  test/workspace.test.mjs test/stage-runtime.test.mjs
```

The final run passed 15 targeted cases. Coverage includes shared provider parsing,
progress-only outcome/refusal, completion despite an identical tracked tree,
lost push response and failed read-back reconciliation, restored progress with
and without local receipt state, zero correction budget, missing final artifacts,
retained local edits, current-main alignment and conflict repair, lifecycle and
requirements eligibility, legacy completed reuse, and protected/empty changes.
Initial failures were test setup defects: an absent configured TMPDIR parent and
a mock assuming ineligible progress would receive resume context. Creating the
repository-local parent and correcting that mock resolved them. Source tracing for partial
conflict coverage also found a full-artifact capture during continuation;
`continueRebase` now preserves the recorded partial mode.

`python3 --version` reported Python 3.13.7. Syntax and whole-file source limits
were checked for every modified/new program file using `node --check` and the
maintained `sourceLimits` helper with explicit paths. Full Git-dependent
`scripts/check.mjs`, selected PR-head CI/native suites, independent Accept and
publication remain Unverified with their owning stages; these snapshots have no
usable Git index. No CI, CD, installed runtime or live GitHub success is claimed.
Disposable test fixtures and generated replay inputs were removed after use;
maintained regression tests and this verification record remain in the Candidate.

## Core #632 CI correction: native publication recovery

The reported PR-head verify failure at `test/reboot-recovery.test.mjs:64`
reproduced with the assigned Candidate: the `provider effect: true` case returned
`RECOVERY_CANDIDATE_MISMATCH`; the false case passed. Command:

```sh
TMPDIR=/work/.deliver-test-tmp node --test --test-concurrency=1 \
  --test-name-pattern='native first publication recovery' \
  test/reboot-recovery.test.mjs
```

The new checkpoint `Status` trailer followed `Candidate`, while native recovery
and open-PR adoption require the Candidate binding on the final message line.
Checkpoint encoding now writes Status before Candidate. Existing identity, tree,
parent, requirements, lifecycle and completed-mode checks remain intact; recovery
validation was not broadened. A regression asserts the final Candidate trailer
for both progress and completed messages. No Skill correction was necessary.

After correction, the following controlled fixture checks passed:

```sh
TMPDIR=/work/.deliver-test-tmp node --test --test-concurrency=1 \
  test/reboot-recovery.test.mjs test/delivery-checkpoint.test.mjs
TMPDIR=/work/.deliver-test-tmp node --test --test-concurrency=1 \
  test/adopt-open-pr.test.mjs
```

Results: 34/34 and 3/3 passed. Reboot tests cover confirmed provider publication,
unfinished publication, interrupted reconciliation, retry and refusal gates.
These use mocked provider reads and repository-local recovery fixtures, not live
host recovery or GitHub publication. Python from project PATH reports 3.13.7.
All Candidate program sources passed syntax and whole-file source limits using
explicit paths. Fixture teardown removed disposable files; its empty scratch
parent was removed. Core-owned runtime resources were retained unchanged.
Matching revised-head full CI and independent Acceptance remain Unverified with
their owning stages. The earlier CI failure is not claimed as resolved remotely.

## Core #632 Acceptance correction: nested Deliver continuation

The current independent finding identified confirmed progress returning from
nested Deliver without resuming unfinished implementation. Source inspection
confirmed that only the main stage loop handled `DELIVER_PROGRESS_SAVED`;
correction, integration repair and checkpoint recovery returned every
non-completed Deliver result directly. The host launcher uses this same
`continueStages` entry with checkpoint saving enabled.

Progress receipt validation and re-entry now share one execution helper across
all four paths. Each confirmed progress result must match the stored Deliver
receipt and include its checkpoint before Core inspects current state and
executes Deliver again. Correction diagnostics remain attached to that operation.
Progress does not consume the correction allowance, and final Candidate comparison
still runs after completed correction. Other pending or denied outcomes retain
their existing handling. No Skill or authorization changes were needed for this
correction.

Command run from `/work`:

```sh
node --test --test-concurrency=1 test/deliver-progress.test.mjs \
  test/stage-continuation.test.mjs
```

Result: 23/23 passed. New controlled continuation cases cover Accept correction,
CI correction with preserved diagnostics, integration repair and missing-checkpoint
recovery. Each saves progress, immediately re-enters Deliver after inspection,
and advances to hooks and Accept only after completed Deliver. The correction
case uses one repair allowance, proving progress does not spend it. Existing
zero-budget progress, restored-receipt, unknown-effect, refusal and continuation
regressions also passed. These fixtures simulate stage results and stored native
receipts; they do not claim live publication or installed-host execution.

Python from project PATH reports 3.13.7. Explicit comparisons against `/main`
identified 13 changed program files; all passed `node --check` and maintained
`sourceLimits` checks over their entire contents. Full Git-dependent CI and
independent Acceptance for the revised Candidate remain Unverified with their
owning stages. The test paths above do not create filesystem fixtures; no new
disposable resources were created or retained during this correction. Existing
Core-owned runtime resources were left in place.
