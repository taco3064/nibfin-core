---
title: Architecture and authority
description: Repository responsibilities and the sources of delivery truth.
---

Nibfin supports protected delivery for public GitHub repositories. The
[product Proposal](https://app.notion.com/p/40006b644a2080dab1a8c2e562f95373)
defines product semantics; these pages project those requirements and verified
implementation for public readers.

## Three repositories

- [Core](https://github.com/taco3064/nibfin-core) owns delivery rules, authorization,
  stages, Skills, Candidate evidence and protected operations.
- [Action](https://github.com/taco3064/nibfin-act) is a thin invocation and result
  entry that calls approved Core. It does not duplicate the engine.
- [CLI](https://github.com/taco3064/gh-nibfin) owns installation, repository Runner
  management and upgrades, integrating through Core's existing interfaces rather
  than maintaining another delivery engine.

The planned local Dashboard is a projection and control client through existing
Core authority and GitHub permissions. It is not a separate control authority or
an available product. See [limitations](../limitations/) for evidence boundaries.

## Sources of truth

GitHub owns current Issue content, native **Blocked by**, Assignees, labels,
Runner and Job state, and PR, check and merge results. The current authorized
Issue defines the work requirements. Historical Scope snapshots provide
traceability, not a competing requirements authority. Core enforces protected
execution; Action, CLI and documentation cannot grant that authority.

Legal Issue updates are normal requirements management. After a material change,
reconfirm affected requirements and content, repeating affected shaping,
delivery or acceptance as necessary. Unrelated main movement alone does not
invalidate evidence for unchanged content. Integration eligibility still depends
on current applicable CI and GitHub merge rules and branch protections.

## Member routing

Read current GitHub state and inspect Assignees in the order returned by the
GitHub API. Skip only members lacking the required execution eligibility. Select
the first eligible member and derive a stable User ID label, for example
`nibfin-user-1001`. GitHub routes and queues work among that member's Runners.
Runner availability does not change member selection.

- First member ineligible, next member eligible: select the next member.
- First eligible member's Runners Busy or Offline: keep that member selected;
  GitHub queues the Job, subject to platform limits. Do not fall back to another
  Assignee.
- Authorization unreadable or uncertain: stop; do not guess a selection.

These examples describe the selection rule reflected in Core's maintained
selection source and tests. They do not claim live multi-Runner testing.
Labels route work; they do not authenticate a Runner or grant write permission.
Runner identity and authorized execution must still be verified.

Reassignment requires lawful reevaluation and safe reconciliation of the previous
Job. Editing Assignees does not change a previously queued Job's routing label.
See [recovery](../security/#recovery-and-single-writer-operation) before retrying
or assigning another Writer.

## Website boundary

The English public documentation lives in Core's `website/`. GitHub Actions to
GitHub Pages is the selected build and hosting route. Source placement and a
successful local build establish neither deployment nor a live URL.

The website provides reading and search. It has no login, SaaS backend, separate
policy or state store, or control over Issues, Runners, CI or Merge. Protected
publication must use reviewed content and applicable protected PR/CI and official
Pages authorization. Untrusted fork input must not gain publication credentials
or privileged execution. DOC07 owns publication implementation and authenticated
publication read-back; DOC08 owns live-site verification. This documentation
change proves neither.
