---
title: Protected delivery lifecycle
description: Independent validation, delivery evidence and verified completion.
---

The [architecture](../architecture/) identifies who owns requirements and state.
Each lifecycle step still requires current authorization and satisfied native
GitHub dependencies. A wake-up cannot waive those checks.

## From Scope to Closure

1. **Scope:** author the work boundary in the current authorized Issue, with
   native dependencies and Assignees.
2. **Shape:** define the implementation contract and independently validate it.
   Authorized publication and read-back establish the published contract.
3. **Deliver:** a single Writer implements that contract and runs applicable
   checks. Core captures the authoritative Candidate after the Writer stops.
4. **Hooks and Accept:** supported `pre-commit` hooks run before independent
   Accept of the exact Candidate and its evidence. Supported
   `prepare-commit-msg` and `commit-msg` hooks run after Accept. Declared order is
   preserved within each phase; hook changes cannot silently change the Candidate.
5. **PR, CI and final review:** publish through the authorized path, verify
   applicable checks on the actual PR head, and obtain final Shaper review of
   delivered content against current requirements. A changed Candidate or PR head
   requires fresh applicable verification.
6. **Merge and Closure:** authorize Merge under current GitHub rules, read back
   the actual integration result, and verify Closure and any applicable release
   or deployment outcomes. A request acknowledgement or screenshot is not release
   evidence.

Independent technical roles do not inherently require a second GitHub account or
an extra human reviewer. Actual GitHub protection rules determine required human
approval; technical independence does not bypass those rules.

## Workflow labels

- `scope`: the Issue has an adopted work boundary; it can be evaluated for Shape.
- `shaped`: Shape has been independently validated, published and read back;
  delivery can be evaluated against current authorization and evidence.
- `delivered`: records verified completion, consistent with actual Merge and
  Closure and applicable release or deployment evidence.

These labels describe workflow state. None grants execution permission, proves a
stage ran, or independently proves completion. Manually adding a label cannot
replace missing evidence.

## Wake-ups and admission

Native Issue events prompt a fresh state read. Admission rereads the current
Issue, native Blocked by, Assignees, labels and execution authorization; the
Runner must also satisfy identity and isolation requirements. The event payload
is not permission. GitHub manages Job routing and queuing, without a second
scheduler or durable state authority in the website.

Most events caused by a repository's `GITHUB_TOKEN`, including label mutations,
do not recursively trigger another Actions workflow. `workflow_dispatch` and
`repository_dispatch` are legitimate exceptions, subject to authorization. Use
one verifiable activation path; do not duplicate activation wake-ups through
both an event and dispatch for the same transition.

Native dependency changes do not automatically produce an Actions `issues`
wake-up. A lawful existing event or dispatch path must reevaluate affected work.
Downstream continuation must report an actual dispatched Run, a specific reason
it cannot execute, or Pending for unknown effects. A successful wake workflow or
an empty scheduling result does not prove downstream work started.

Read back the actual Run, Job and results. An accepted API request does not prove
execution; creating a PR does not prove CI started or passed. GitHub can require
workflow approval, and that requirement must be respected. See
[security and recovery](../security/) when execution or external effects are
uncertain.
