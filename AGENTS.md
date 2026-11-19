# Core repository instructions

## Follow GitHub's documented mechanisms

Design every GitHub integration around GitHub's documented behavior. Use
GitHub Actions for job assignment, queueing, concurrency, cancellation and
reruns. Use GitHub's native state, permissions and branch protection for
repository operations. Check the current workflow and repository settings
before making claims about their behavior.

Treat GitHub's documented guarantees as the design baseline. Do not assume
GitHub has a defect or add a second scheduler, queue, lock, retry policy, or
approval gate to compensate for a hypothetical gap. Keep any Nibfin-specific
safeguard tied to a demonstrated responsibility of Nibfin. Explain the
observed need before proposing a safeguard, and keep its scope limited to
the affected operation.

If the documented mechanism appears insufficient or observed behavior
contradicts it, bring the relevant official documentation, effective settings,
and a minimal reproduction or native run record to a human maintainer.
Pause the affected design decision until a maintainer agrees on the diagnosis
and the proposed response. Do not autonomously implement a workaround for
an alleged GitHub gap.

[GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
and [self-hosted runner routing](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#routing-precedence-for-self-hosted-runners).

## Changing Nibfin Skills

Use historical GitHub Issues to check that a Skill change improves decisions
while preserving the approved development outcome and role boundaries.

Apply this procedure to every Skill change, including follow-up corrections
and changes to the shared role prompt that affect Skill decisions. Before
editing, identify the applicable repository instructions and verification
obligations. Carry those obligations through implementation and handoff.

1. Select a representative failure and a nearby case that should still pass.
   Use the original Issue body, its edit history and timeline, native
   dependencies, linked PRs and Actions jobs, and the corresponding source and
   Runner policy. Keep the input limited to facts available at the stage being
   replayed. When a body or log cannot be recovered, identify the gap and label
   the reconstruction as partial. Keep credentials and private runner data out
   of public evidence.
2. Write down the expected stage decision and its source before evaluating the
   revision. Have fresh independent sub-agents replay the old and revised
   instructions on the same input in a disposable, read-only exercise. Use
   separate fresh invocations for the two versions so one output cannot teach
   the other. Supply the actual role prompt and relevant input mounts. Keep
   the expected answer out of the input. A replay should never edit or dispatch
   the historical Issue.
3. Compare both outputs against the expected decision. Check for invented public
   interfaces, dependencies, permissions and pre-Deliver verification. Preserve
   the actual product behavior, responsibility and security boundary. Record
   source links, role, runtime, outcome and limitations in the PR. A manual
   walkthrough or deterministic prompt test checks a narrower property than a
   fresh model run. Identify which was used.

For each case, record the historical source and input reconstruction, expected
decision and its basis, old and revised instructions, actual role and execution
environment, both outputs, and the comparison result. Use the existing PR or
verification record. Keep expected decisions and example answers out of the
replayed Agent's inputs. Identify any unavoidable exposure as a limitation.

When the user requests an actual Runner replay, or the changed behavior depends
on Runner capabilities, perform a fresh role invocation in the applicable
Runner environment with the relevant source and input mounts. A model run
outside that environment establishes only the behavior observed there. Source
inspection, deterministic prompt tests and ordinary code tests do not establish
the outcome of a missing Runner replay.

An invocation that fails during setup, isolation checks or Agent startup has
not exercised the Skill. Diagnose and correct the setup, then replay the case
again. Preserve the applicable execution boundary. Record any remaining
environment dependency and the specific behavior still unverified.

Before reporting a Skill adjustment verified, compare every required case
against its recorded expectation and account for incomplete or failed runs.
If revised output still reproduces the historical failure, correct the Skill
and replay the affected cases. Check the nearby passing case for regressions.
Report the actual method, results and unresolved work in the final handoff.
Keep later CI and CD evidence with the workflow that owns it. These replay
instructions do not authorize new evidence gates for the historical Issue or
require its workflow to be rerun or its metadata to be changed.

Useful cases:

- [E2E #124](https://github.com/taco3064/nibfin-e2e/issues/124) and
  [the failed Deliver](https://github.com/taco3064/nibfin-core/actions/runs/44093311788).
  The simulated switch still covers preview without mutation and durable recovery.
  When the same preview implementation has a maintained fixture interface, the
  plan can use it without requiring installed Core paths or a public test API.
  In a separate case where command parsing is the required behavior, preserve
  the CLI boundary.
- [Core #343](https://github.com/taco3064/nibfin-core/issues/343),
  [the failed Deliver](https://github.com/taco3064/nibfin-core/actions/runs/44088851966)
  and [the merged PR](https://github.com/taco3064/nibfin-core/pull/435).
  Trace website checks to Core CI and publication to Core CD. Preserve the
  maintained documentation changes while allowing handoff before the owning
  workflow result exists. In a separate case with an actual role-owned check,
  preserve that check.

## Use events instead of periodic repair machinery

Do not introduce timers, cron jobs, scheduled workflows, polling services or
external monitors to keep dispatch, continuation, recovery, installation or
upgrade control flow moving. Use documented GitHub events, explicit lifecycle
completion and the existing operation's normal retry path. Do not replace a
rejected timer with another periodic mechanism.

Scheduled work requires an actual time-based product requirement and explicit
Owner approval. Automatic or reliable operation alone is not such approval.
Explain any genuine platform gap with current source, effective configuration
and official documentation before proposing an exception.

Do not invent a restriction and then add infrastructure to satisfy it. The
requirement that users must not manually handle credentials means automating
supported setup from their existing GitHub CLI login; it does not require
credentials to remain only on the local host. Verify actual permissions and
preserve confidential handling without requiring manual token creation,
copying or pasting.

The Owner has rejected the notification-relay.timer design. Do not extend that
timer or its artifact-polling route, or make it a prerequisite for installation,
Runner replacement or continuation. Use the authorized migration path to remove
its dependencies while preserving active work and existing native event routing.

## Shared Runner upgrades

The Nibfin Dashboard exposes Pause/Resume for selected Issues through
`gh nibfin dashboard --repo OWNER/REPO`. Use it when an operator needs a
particular Issue to wait at a stage boundary. Existing admitted work can
settle. Record which Issues were paused for maintenance and resume only those
after verification. Preserve pauses already set by their owners.

For a Core or Runner upgrade affecting the shared pool, use Core CD and the
authorized [host rollout](scripts/host-auto-rollout.py). The timer preflights
the package and consumer bindings,
then records its exact target and phase in `/etc/nibfin/rollout-plan.json`.
Its separate `/etc/nibfin/rollout-admission.json` closes both slots and new local
relay dispatch. Admitted leases and prior effect readback may settle; unrelated
queued Jobs do not block drain. The timer stops only the matched shared services,
rechecks native Jobs, registrations, fences and cgroups, and promotes the package
and bindings through a durable apply intent. It restarts both listeners under
closure and verifies source, all four enrollments and original registrations
before reopening admission. The operator's relay pause remains unchanged. If an
execution or external effect is
unresolved, let the existing recovery path settle it before promotion.
Individual Issue pauses are optional and do not establish pool-wide idleness.

After promotion, verify the installed Core revision, enrollment for the four
repositories and both Runner registrations. The timer retains the previous
verified package for recovery.
A pending phase/code identifies the unresolved observation or effect. Do not
remove the plan, closure, journals or backup to force progress: the next timer
reads back the same target and partial effects. Unknown installed bindings stay
closed; an installed commit alone is insufficient. The legacy Python credential
adapter continues to refuse imported managed credentials.

Compatible pending Jobs use normal admission. The rollout timer also polls
legacy wake receipts in bounded rotating batches, including without a local relay.
Known stale relay and legacy wake origins are
reconciled by exact Run/attempt before current Issue eligibility, pause and
source are rechecked. A replacement uses a separate effect journal associated
with that origin. Ambiguous POSTs remain pending, with no title-based attribution,
blind retry or bulk queue cancellation. Authorized work resumes through the
normal Issue wake flow. Legacy receipts retain their original source observation
and exact run ID; receipts from older installations without that observation
report `LEGACY_WAKE_ORIGIN_EVIDENCE_MISSING` and remain unchanged.

## English for public-facing text

Write all externally visible project text in English. This includes Issue and
pull request titles and bodies, comments, reviews, Discussions, release notes,
and repository documentation such as README files, guides, and documentation
published from the repository. Apply the same rule to automated publication.

## Limits and recovery

Do not invent timeouts, retry counts, size or count limits, fixed evidence
versions, or other thresholds that can delay, reject, or stop work. Every
such limit needs a concrete failure it prevents and a basis for its value,
such as a documented platform constraint or a measured resource need.
Explain what happens when the limit is reached and how work can resume.
Discuss any new or changed limit with a human maintainer before adopting it
unless the maintainer has already approved the specific change.

On continuation, check the authoritative GitHub state for the work already
completed. When a successful read finds no completed outcome, rerun the
unfinished stage using its normal admission and native GitHub checks.
A missing local receipt alone must never stop continuation. Keep the
ordinary handling for failed observations and apply it to the affected step.
