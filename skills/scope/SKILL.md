---
name: scope
description: Decompose approved requirements into ordered implementation Issues with clear outcomes, ownership and dependencies. Publish or audit only within the authorized Scope process.
---

# Scope approved product requirements into implementable work

Scope decomposes approved requirements into ordered, appropriately sized implementation Issues. Each Issue states the outcome, ownership, boundaries and dependencies needed to sequence the work. Shape investigates the individual Issue and establishes an implementation plan. Accept plans and performs independent verification after Deliver produces the implementation.

**One development outcome per Issue:** Each code-backed implementation Issue owns a substantive maintained change to code, tests, configuration, workflows, packaging or product documentation. Keep standalone verification and release activity in their existing authorized processes. Required behavior or a governing support constraint can appear in the Issue. Accept determines how to check the implementation. Preserve the actual delivery gates and track release obligations at their owning stage.

**Grounded decomposition:** Establish enough implementation feasibility to choose the Issue split, owners and dependencies. Cite relevant code or provider facts and record assumptions that could change the split. Leave the implementation route and plan to Shape within the approved product boundaries. Do not demand a prototype or a target-platform machine before planning independently testable code. Escalate a product decision only for incompatible binding requirements, a known prohibited/unsafe route without a viable alternative, or truly undecided product semantics. A temporary provider error, missing host or unexecuted E2E is not such a contradiction. Do not publish a research/spike, audit, feasibility check, release, or evidence-only task as a code-backed self-delivery Issue. An independently approved non-development outcome may be tracked or executed by the project's separately authorized non-delivery mechanism, but such approval does **not** make it eligible for a code-backed lifecycle.

## Mandatory work-type and feasibility gate (before drafting or publishing)

**Classify first; only then decompose.** Derive the applicable work types and delivery mechanism from current product authority; this Skill must not silently impose a code-backed lifecycle on projects that explicitly authorize a different one. **When the intended lifecycle requires a nonempty maintained Candidate (including AI self-development), every new Issue proposed for that lifecycle must pass all five checks:**

1. **Actual development:** Name the observable product deficiency and the **necessary maintained source outcome** (code, meaningful regression tests, configuration, workflow, packaging, or actual product documentation). Identify the owning repository and likely affected surface. A test-only change qualifies **only when it is itself necessary maintained regression/contract coverage**, not a pretext to record an external verification result. Product documents qualify when the deliverable is real maintained documentation, not a ceremonial evidence report.
2. **No verification/release masquerade:** Distinguish implementation and its routine tests from standalone E2E/security audit, incident diagnosis, live Runner/OS proof, formal Release/Marketplace publication, asset read-back, deployment approval, self-hosting proof, or support certification. These have named accountable owners **within existing acceptance, CI, release, or provider workflows**, without a new self-delivery Issue or execution-enrollment metadata. An ordinary provider tracking Issue may exist outside that lifecycle where authorized; its presence is not execution eligibility.
3. **Grounded route and prerequisites:** Inspect existing implementation and official provider capabilities before writing **"reuse existing"**, **"already supported"**, or **"automatically recoverable"**. Name the concrete current interface/provider source and why it suffices. If it does **not** exist, either explicitly scope a **needed new feature with a feasible path and observable code outcome**, or return the precise affected product decision for authorized replanning. Do not make an absent capability both a prerequisite and the proposed deliverable, or insert a research Issue to conceal the gap.
4. **Supported implementation:** Check that the installed runtime can implement and deliver the proposed change. Resolve delivery-engine gaps when the work actually depends on them.
5. **No accidental execution grant:** A draft, normal tracking Issue, verification ledger, release checklist, label, or native dependency is not automatically a deliverable or a work grant. Publish only eligible implementation Issues into a code-backed lifecycle, using actual authorized metadata and a current runtime read-back. When correcting existing protected work, follow its separate lifecycle-safe reapproval, invalidation and recovery rules; do not use ordinary Scope Publish to rewrite active execution.

Record the classification for **every proposed work item**, including rejected candidates, with an explicit outcome: `IMPLEMENTATION`, `ACCEPTANCE/VERIFICATION`, `RELEASE/DEPLOYMENT`, `INVESTIGATION/DECISION`, or `ALREADY SATISFIED`. These are **planning categories, not provider labels, runtime result enums or a new state system**. Only `IMPLEMENTATION` may be published into a code-backed self-delivery lifecycle. If any proposed Issue cannot pass the five checks, the affected bound Plan is **not `PLAN_READY`** for that enrollment; do not fix it by fabricating a Candidate. Preserve the real verification/release obligation in the existing accountable stage so it does not disappear.

### Delivery-route check

- **Trace the changed paths and operations.** For each proposed Issue, identify
  the expected files or path patterns and required operations, including
  inherited writes and checks. Compare them with the target repository's
  effective Candidate restrictions, installed stage permissions and provider
  protections. Cite the current rule and give the responsible actor and route
  for each required protected change.
- **Resolve delivery ownership before enrollment.** A task that needs a
  protected workflow, ownership rule or other enforcement change belongs on an
  authorized maintenance route when the installed runtime excludes that path.
  Separate ordinary code or tests only when the remaining Issue is independently
  useful and can complete on its own. If an essential route cannot be verified,
  keep the affected work out of self-delivery and record the exact path or
  operation, missing evidence, and next responsible owner.
- **Keep implementation and release ownership clear.** When work implements a release gate, identify any maintained input it needs to build or operate. Existing release processes own live verification and publication.

Record the resolved route and its evidence in the raw Issue or the public-safe
handoff. In Publish, refresh this check before the first write. If the approved
route or planned writes no longer fit the installed policy, return
`REPLAN_REQUIRED` for the affected manifest. In Audit, identify the specific
misrouted work and recommend the authorized correction.

## Modes, authority and boundaries

**Plan**, **Publish** and **Audit** are mutually exclusive modes. Plan and Audit are strictly read-only; Publish is a separately authorized invocation that creates only the approved raw work and native dependencies, and then verifies provider read-back. Scope does not select executors, grant work eligibility or produce Shape, Delivery, Acceptance or completion proofs. Role and permission limits apply equally to people and Agents.

Read the project's **current normative authority** (Proposal, product specification or authorized decisions), current repositories/tests/releases/Issues/PRs, the **intended delivery policy**, the **delivery mechanism actually installed for the project**, and the issue provider's supported operations. Keep normative repository ownership distinct from observed code location; record drift, never silently change ownership. A delivery engine being developed as the product is not necessarily the currently installed executor of this portfolio.

- **Authority is read-only and decision-specific.** Check the document's explicit decision/approval records **and current Owner authorization** for each binding clause, with exact anchors and affected work. A document labeled draft does **not** make every explicit approved decision undecided; conversely, approval of some clauses does **not** approve the whole document. Before blocking, identify the precise unapproved or contradictory clause, the behavior/Issues it affects, **why existing approvals are insufficient**, and the exact decision needed. Do not invent a global document-approval prerequisite, change normative authority, infer approval from old code/history, or ask about decisions already settled by attributable evidence. Return `AUTHORITY_UPDATE_REQUIRED` only where changing a binding product decision is necessary; otherwise classify the actual unresolved requirement within its affected scope.
- **Invocation boundary:** Bind a whole project or an explicitly approved requirement slice; cover every obligation in the boundary and all material cross-cutting security, compatibility, integration, documentation, release and operational obligations that govern it. Reference unrelated future work without expanding the bound scope. A slice cannot claim whole-product completeness.
- **Protected work:** Raw publication is not a grant or freeze. Changes to already frozen, authorized, shaped, executing, delivered or closed Issues (including metadata, assignments and native dependencies) need the project's separately authorized invalidation/reapproval/recovery process first. A Scope Plan approval does not provide it. No actor may silently assign/reorder executors or trigger delivery through raw issue creation. An authorized publisher, not Shape Author/Validator, applies approved formal Shape updates under the delivery policy.
- **Scope and Shape separation:** Scope owns the Issue split, repository ownership and native dependency order. It can use Shape's bounded read-only Investigation for facts needed to split or sequence work. Formal Shape establishes an implementation plan for one existing Issue. After Deliver, Accept chooses the verification methods. Refer changes to the approved split or boundaries to the authorized Scope process.
- **Reusable contract:** Do not hardcode a project's repositories, issue IDs, platforms, commands, permissions, labels, roles, versions or product-specific policies in this Skill. Resolve them from the current authority, provider and runtime. The approximately **1,000 meaningful first-party LOC** target below is a reusable planning guideline, not a product requirement.

## Plan: establish coverage before drafting Issues

1. **Inventory authority by decision, not document label:** For each bound requirement compare its exact anchor with in-document approvals and current Owner authorization; record **approved**, **specifically undecided/contradictory**, deferred or excluded, the affected behavior/Issues, normative repository owner, existing implementation and planned work. An ambiguous binding decision needs evidence-led investigation and an exact question; a draft heading alone is not evidence of a gap or a missing blanket approval. Source-project completion never proves target-project delivery.
2. **Inspect reality and deduplicate:** Review relevant open **and closed** Issues, code, tests, PRs, published sources/releases, provider contracts, and the reusable flows or upstream interfaces each candidate Issue actually invokes. Trace inherited permissions, required inputs and observable behavior through those shared paths; a shared implementation does **not** mean every caller must satisfy the same privileged observation or has the same completion status. Reuse legitimate work. If existing Issues are deliberately not inspected, mark deduplication `UNVERIFIED` and **publication readiness blocked** until checked, not technology infeasible or falsely duplicate-free.
3. **Classify each candidate before allocating its owner; own every implementable outcome and the single bootstrap:** Choose one normative owning repository and coherent deliverable per Issue; do not duplicate cross-repository core logic. **For each genuinely empty project, create exactly one minimal initialization root Issue** owning the shared directory/package configuration, tooling and dependency management and lockfile, necessary build/typecheck/test entry points, common settings and initial module boundaries. All other work for that project must depend **directly or transitively** on completion of this baseline before changing shared setup; no parallel root may initialize the same project. A website, testing or research subdirectory does not automatically create an independent project or justify a conflicting second initializer. Independently empty projects each have their own single root; an existing usable baseline is reused **without** a new bootstrap Issue. Keep the bootstrap free of feature delivery, formal release and E2E; once complete, independent feature work may run in parallel, without an all-shaped barrier. For cross-platform work, identify target boundaries and sources that make the split feasible, including host/guest ownership and platform capabilities. Coding for a target OS does not require a planner or coding Agent on that OS.
4. **Bound work:** Target roughly 1,000 lines or fewer of meaningful maintained first-party changes per implementation Issue, including copied/ported adaptations, tests, workflows, configuration and nontrivial refactors (not merely net added lines). Give an estimate range and confidence. If larger, seek separable outcomes; if not safely divisible, record the reason and its explicit exception within the Owner-approved Plan. Use appropriate alternative effort units for **maintained product documentation**. Release/evidence work stays in its actual non-delivery responsibility, not an implementation estimate. Never drop necessary tests to meet the budget.
5. **Resolve actual operation and inherited-permission paths:** Identify the necessary actor, input and permission for operations that affect the split or development feasibility, including operations inherited through shared helpers. Ground any decision affecting the split in actual code or authoritative provider behavior. Shape investigates and selects the implementation route within those boundaries.

### Runner feasibility before publication

For work proposed for automatic delivery, check the capabilities that materially
affect the Issue split against the adopted Runner profile, project configuration,
maintained fixture interfaces and existing CI/CD selection rules. Identify which
stage needs each capability. The planning machine's tools, host permissions,
credentials and network do not establish what a Runner Job can use.

Prefer a maintained fixture or shared implementation interface when it exercises
the required behavior. Require a public command, live service, native platform or
privileged operation only when the approved goal needs that boundary. If a
necessary capability is missing, identify its actual owner and sequence the work
around its output. If the assigned profile is unknown, record that uncertainty
and leave enrollment readiness unverified where the uncertainty is material.
Keep the Issue focused on implementation outcomes and leave verification methods
to Accept and the existing workflows.

### Producer, consumer and delivery order

For each required upstream interface or artifact, trace the producer to the consumer and confirm that it will be available when needed.

1. **Producer actually owns the output.** Identify the implementation/configuration producer and, where needed, the **separately authorized release/publishing operator or existing workflow**. An installer, upgrade command, build/test runner or source-code implementer does **not automatically publish a formal release**. If a consumer requires an *already released* CLI/Action/library, establish the actual publication owner, availability, source pin, approval and read-back plan **without inventing a separate AI self-delivery Issue for the act of publishing**. Allocate missing release work to the already authorized release process; if the product lacks such a process, report the exact release-readiness/authority gap. A referenced release does not exist merely because a consumer requests it.
2. **Consumer can obtain the correct maturity.** Record the concrete file/export/API/command/configuration, intended location, main inputs/outputs/error states or permitted local contract, producer/consumer, retrieval/build/import/call method, needed-by stage and necessary read permissions. Prefer the current accessible source and usable interface. Do not introduce a hash or fixed version as a work prerequisite. If a design genuinely needs an exception, explain the concrete need and ask the Owner before adopting it. A future file may be planned if its producer owns it; do not claim an unpublished release or unavailable package exists. Require candidate build, formal published release or actual measured result **only when the consumer really needs that maturity**. No generic “versioned artifact” or extra handoff package substitutes for a usable contract.
3. **Check the Issue as a whole.** Confirm the outcome, intended behavior, permissions and exclusions describe one implementable change. Remove contradictions and extra proof demands that have no authority. For required runtime artifacts or hooks, preserve the actual requirement for Shape and the runtime.
4. **Check the order.** Verify that every work item can get the inputs it needs at the stage that consumes them. Identify the exact missing output and the downstream Issues it affects.

**Correction loop:** Re-read each affected draft and its actual producers and consumers. Verify claims of existing capability against current source or the provider interface. Correct only the drafts, responsibilities and planned edges that the current Plan may revise. Report unresolved implementation, ownership or dependency gaps with the affected items and the authorized next step.

### Dependency and risk review

- **A verification/release milestone is not automatically a native implementation dependency.** An implementation consumer may require a truly available released artifact or mandated proof, but trace that need to the **real version, official release, existing CI/acceptance or provider result** and its lawful owner. Do not add a `Blocked by` edge to an evidence-only tracker purely to preserve the planning graph. When removing an improperly enrolled tracker, **re-evaluate each downstream native edge separately** through the authorized mutation/recovery path; neither blindly delete an edge nor treat the tracker as delivered.
- Before `PLAN_READY`, inspect every **proposed self-delivery Issue** for meaningful maintained change, grounded existing-interface assumptions and an actually compatible installed runtime. Record `NOT SELF-DELIVERY` for any verification, release, experiment or administrative task rather than trying to shoehorn it into a PR/Candidate.

- A hard edge is justified only by the **specific not-yet-satisfied output or policy-required proof** the downstream work cannot begin or finish without, including source maturity and availability. It is not a roadmap priority or preference to serialize. Examine direct **and transitive** dependencies; do not make an upstream module wait for real E2E proof generated only after its consumers exist.
- Validate stable identities, missing/external predecessors, cycles, consumer/source maturity, issue-provider native-relationship support, and actual installed execution policy's recognized completion proofs. For an empty project's planned graph, ensure **exactly one minimal bootstrap root** and a direct/transitive dependency path from every other Issue in that project to it; prevent competing initialization work without turning the post-bootstrap project into a global serial chain. For an already initialized project, do not invent a root to satisfy this check. Graph membership in a plan is not runtime eligibility. Evaluate every suspected transitive/redundant edge **individually** for independent contractual/policy necessity; do not bulk-delete by count. Identify independently parallelizable post-bootstrap work and semantic artifact-order cycles.
- For product-critical assumptions, identify their basis and what changes for other Issues if the assumptions prove false. A real contradiction with binding requirements or an undecided product behavior must return to the separate authority process. Ordinary implementation uncertainties stay in the chosen Issue. Carry forward binding environment constraints for the stage that needs them. Do not add a research/spike Issue merely to test feasibility as a substitute for coding.
- Before a large freeze/authorization, report the **actual current delivery engine's** ability (verified, unverified or unsupported) to safely handle partial Scope changes, native edge updates, evidence invalidation, authorization migration and restart/recovery. Missing a convenient partial migration feature does not alone block Plan/Publish, but protected change still requires the real recovery process.

## Raw Issue contract and Shape handoff

Each **complete raw Issue Body** should be readable without reconstructing the portfolio tables. Adapt these elements to the project's existing conventions, without embedding unrelated project-wide security boilerplate:

- **Outcome and ownership:** current gap, exact binding authority anchors and decision-specific approval status, observable result, one normative owning repository, included/excluded work and adjacent interfaces. If this is the **sole bootstrap** for an empty project, state its minimal shared baseline and exclude features, publication and E2E; other project work cites this baseline rather than separately initializing it.
- **Work boundaries and feasibility:** state the maintained outcome, existing capabilities relevant to the split, essential platform and permission constraints, and what another Issue must provide first. Record the code or provider facts supporting the split, along with material assumptions. Shape uses this handoff to choose the implementation route.
- **Inputs and handoff:** identify the concrete upstream capabilities needed
  to implement the work. For existing capabilities, cite the maintained
  interface or artifact and confirm it supports the planned use. Check the
  actual source when an upstream Issue is closed. Add `Blocked by` for
  planned output only when its absence prevents meaningful implementation.
  If a grounded contract and local double support independent work, keep
  implementation moving and record the later integration owner.
- **Expected outcome:** describe the single maintained development result and its observable behavior. Include product constraints and explicit exclusions. Accept decides how to verify the change after implementation.
- **Estimate and disclosure:** meaningful-change range/exception, any specific residual risks, and public-safe references only. Do not copy private source, secrets, fixtures, credentials, internal logs or confidential evidence into public Issues simply because the planner can read them.

**Scope → Shape handoff** preserves the stable Issue identity, provider-read raw Body, authority anchors, read-back native dependencies, expected outputs, prerequisites and relevant investigation. The trusted runtime supplies authorization and preserves Scope provenance. Route an invalid split or missing dependency back to Scope for correction.

## Plan outputs and verdict

Provide a **concrete full proposed portfolio**, not only a positive summary:

1. **Bound authority and coverage:** per-decision approval/undecided/deferred status grounded in exact clauses, document approval records and Owner authorization. For each unresolved decision identify **the specific conflicting/unapproved text, affected Issues/behavior, insufficient evidence and decision required**; do not substitute a document-wide draft status. Report requirement-to-Issue coverage, observed vs. normative ownership, actually evidenced prior completion, inspected revisions and unavailable access.
2. **Complete raw Issue register:** planned IDs, full proposed Bodies, ownership, outcomes, boundaries, assumptions, estimates and dependency order. Actual provider Issue IDs are only needed after Publish.
3. **Producer and dependency trace:** each necessary interface or artifact, its owner, consumers and availability. Identify the first broken handoff and its downstream impact.
4. **Dependency manifest:** justified producer → consumer hard edges with intended native-provider/policy compatibility, Mermaid DAG, artifact order and individually reviewed apparent transitive redundancies. For each empty project show its **single minimal initialization root**, every other Issue's direct/transitive path to it, and independent parallel branches after baseline completion; for already initialized projects cite the usable baseline instead. Planned references are not actual provider-native relationships.
5. **Publication plan and risk:** full approved-to-be-written Issue bodies/metadata/edges, disclosure check, safe raw-creation triggers, intended durable journal and reconciliation method; critical route risks, future E2E resource readiness, and actual engine change/reapproval limits. List necessary Owner decisions and protected-work constraints explicitly.

**Pre-verdict evidence record:** Cite the reread Issue and authority clauses, corrected draft passages and observed producer and dependency facts. Separate planning observations from any executed checks or live evidence cited as background.

**Plan verdict:** Use `PLAN_READY` when the proposed Issues cover the approved outcomes, each describes feasible maintained work, and the ownership and dependencies support the proposed order. Use `PLAN_BLOCKED` for a specific unresolved implementation, authority, ownership or dependency gap. Use `AUTHORITY_UPDATE_REQUIRED` where a binding product decision must change. Evidence for later Acceptance or release belongs to its owning stage.

Report Plan readiness, deduplication and Publish readiness separately. The planning verdict does not authorize writes or certify delivery.

## Publish: authorized mutation and recovery

Publish requires separate explicit Owner approval of the concrete manifest, including authority revision, full raw bodies, repositories, metadata and native edges. Before first mutation, refresh authority, duplicate and identity checks, implementation eligibility, ownership, permissions, native edges, protected-work eligibility and disclosure safety. Replan and reapprove when material facts or the approved write set change. Provider permissions and a writable, durable recovery journal are required. Return `PUBLICATION_BLOCKED` or `REPLAN_REQUIRED` before any write that cannot safely proceed.

For each authorized Issue/metadata/native-dependency operation:

1. Persist a **write-ahead intent** before invoking the provider, binding the approved manifest, target, operation, expected identity/body/edge and stable correlation key. Do not proceed if the journal cannot survive restart or distinguish retries.
2. Perform only approved writes on eligible raw work; persist responses and independently read back actual stable repository/Issue identity, exact Body, approved metadata and **both native dependency directions**. Real native provider relationships are required wherever the project delivery policy uses them; Markdown checklists do not substitute.
3. Reconcile timeouts, lost responses, partial publication or concurrent publishers against persisted intents and fresh provider reads **before** any retry. Unknown or ambiguous outcome stops the affected operation; never blindly duplicate, auto-rollback, conceal drift, or overwrite protected work. Remediation needs a separately reviewed/approved new Publish after applicable lifecycle recovery.
4. Create the public-safe Scope → Shape handoff from the **provider-read exact raw baseline**, identity and native graph. Keep necessary private evidence in access-controlled storage, not lower-trust Issue Bodies.

Return `PUBLISHED` only when every approved operation and handoff is fully reconciled by read-back; return `PARTIAL_PUBLICATION` when a write occurred but completion is unknown or incomplete. Raw publication creates neither Owner Grant nor a shaped, accepted, merged or completed Issue. The trusted delivery mechanism independently applies every later stage and permission gate.

## Audit: read-only reconciliation

When scoping interrupted-work recovery, require progress after missing local
bookkeeping or a lost response. Read the authoritative provider, reuse confirmed
effects, and re-enter unfinished work through its existing authorized stage.
Do not make reconstruction of the old response a prerequisite for continuation.
Keep observation failure distinct from a successful read finding no result.
Assign actual terminal-stage reporting and resumption to their existing runtime
owners, with checks for both missing outcomes and already completed writes.
For retained PRs behind main, include controlled rebase and affected verification
on the same PR in the existing delivery flow.

Audit the same work-type, implementation, ownership and dependency boundaries as Plan. Compare current Issues with source and native relationships. Identify gaps, duplicate or misrouted work, and the authorized next owner. Audit remains read-only. Distinguish reported historical verification from evidence observed directly.

Use `AUDIT_PASS` for an evidenced portfolio assessment and `AUDIT_FAILED` for unresolved Issues, implementation outputs, native edges or authority gaps. Audit corrections require the approved Publish or protected lifecycle recovery process.

## Report and fixed verdicts

| Mode | Verdicts |
| --- | --- |
| Plan | `PLAN_READY`, `PLAN_BLOCKED`, `AUTHORITY_UPDATE_REQUIRED` |
| Publish | `PUBLISHED`, `PARTIAL_PUBLICATION`, `PUBLICATION_BLOCKED`, `REPLAN_REQUIRED` |
| Audit | `AUDIT_PASS`, `AUDIT_FAILED` |

Use one verdict for the active mode. Report the bound scope, sources, exact conflicting clause, affected work, ownership and dependency impact. Identify the decision or correction needed and distinguish the planning verdict from any implementation or verification evidence.

For GitHub-native issue dependencies, check current official documentation and provider behavior where relevant: [issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies), [REST API](https://docs.github.com/en/rest/issues/issue-dependencies), and [GitHub CLI](https://cli.github.com/manual/). For other providers, require the project-authorized native relationship mechanism with equivalent read-back and runtime compatibility.
