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

1. Select a representative failure and a nearby case that should still pass.
   Use the original Issue body, its edit history and timeline, native
   dependencies, linked PRs and Actions jobs, and the corresponding source and
   Runner policy. Keep the input limited to facts available at the stage being
   replayed. When a body or log cannot be recovered, identify the gap and label
   the reconstruction as partial. Keep credentials and private runner data out
   of public evidence.
2. Write down the expected stage decision and its source before evaluating the
   revision. Replay the old and revised instructions on the same input in a
   disposable, read-only exercise. Where possible use a fresh role invocation
   with the actual prompt and relevant input mounts. Keep the expected answer
   out of the input. A replay should never edit or dispatch the historical Issue.
3. Compare both outputs against the expected decision. Check for invented public
   interfaces, dependencies, permissions and pre-Deliver verification. Preserve
   the actual product behavior, responsibility and security boundary. Record
   source links, role, runtime, outcome and limitations in the PR. A manual
   walkthrough or deterministic prompt test checks a narrower property than a
   fresh model run. Identify which was used.

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

## Shared Runner upgrades

The Nibfin Dashboard exposes Pause/Resume for selected Issues through
`gh nibfin dashboard --repo OWNER/REPO`. Use it when an operator needs a
particular Issue to wait at a stage boundary. Existing admitted work can
settle. Record which Issues were paused for maintenance and resume only those
after verification. Preserve pauses already set by their owners.

For a Core or Runner upgrade affecting the shared pool, use Core CD and the
authorized [host rollout](scripts/host-auto-rollout.py). The host rollout checks
native Jobs, Runner registrations and execution fences, then stops the shared
Runner services when safe. It rechecks the pool before promoting the verified
package and restarting the services. If an execution or external effect is
unresolved, let the existing recovery path settle it before promotion.
Individual Issue pauses are optional and do not establish pool-wide idleness.

After promotion, verify the installed Core revision, enrollment for the four
repositories and both Runner registrations. Check that authorized work can
resume through the normal Issue wake flow.

## English for public-facing text

Write all externally visible project text in English. This includes Issue and
pull request titles and bodies, comments, reviews, Discussions, release notes,
and repository documentation such as README files, guides, and documentation
published from the repository. Apply the same rule to automated publication.
