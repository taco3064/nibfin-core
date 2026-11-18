# Deliver freshness regression notes

Issue [Core #459](https://github.com/taco3064/nibfin-core/issues/459) requires
trusted observation before initial/resumed implementation and Candidate handoff.
The workspace comparison snapshot is not proof of a new remote observation.

## Instruction comparison

This is a partial reconstruction and manual walkthrough, not a fresh model replay
or a claim about production Runner behavior. The available historical input is
the original Scope supplied in the trusted #459 invocation: E2E PR #196 passed
verification, main advanced when #197 merged, and Core subsequently rebased the
same PR, verified its new head and merged it. Original stage bodies, edit histories,
native dependencies, Runner policy and job logs were not available here. No
historical Issue was edited or dispatched, and no credentials were used.

Sources: [E2E #196](https://github.com/taco3064/nibfin-e2e/pull/196),
[E2E #197](https://github.com/taco3064/nibfin-e2e/pull/197), and the original Scope
in the bound #459 Shape receipt. These links identify the reported case; they do
not establish additional stage-time facts that were not supplied.

Expected decisions, set before the walkthrough:

- Failure case: retained approved work behind observed main must be aligned by
  Core before Writer resumes. Preserve work and PR identity; obtain current-head
  native checks before merge.
- Nearby passing case: work already on observed main proceeds without a rebase.
  Equivalent changes may reuse evidence under existing policy. A future CI result
  does not prevent handing off locally complete work.

The same limited inputs were compared against the original Deliver instructions
in the read-only `/main` snapshot and the revised instructions in `/work`.
The original instructions explicitly require alignment before final
acceptance/review/merge, but leave entry, resume and post-Writer handoff implicit.
The revision explicitly covers those boundaries, retains ordinary conflict repair
inside Deliver, and blocks unresolved requirement or protected-boundary choices.
Both versions preserve Core ownership of Git operations and native integration.
The already-current case still proceeds; the revision explicitly preserves
policy-permitted equivalent-content evidence reuse and workflow ownership.
Neither walkthrough invents a public API, native prerequisite, credential channel
or pre-Deliver verification requirement. This tests instruction coverage only;
it does not establish model decision quality or recover missing historical facts.

## Maintained controlled coverage

`test/deliver-freshness.test.mjs` checks boundary coordination, retained partial
work, unavailable observation, protected changes, semantic blockers and prompt
instructions. Native-stage fixtures exercise separate main observations at entry
and handoff. Workspace fixtures exercise real Git on disposable local repositories,
including empty/incomplete work, ordinary conflicts and retained conflict state.
These are controlled simulations of provider/Runner inputs, not live certification.

The existing continuation and publication coverage remains responsible for drift
after verification, equivalent-content reuse and updating the same PR with an
expected-head lease. Native CI must still verify the actual rebased head. Full CI,
packaging, Docker checks, independent Accept and final review remain Unverified
until their owning stages run.
