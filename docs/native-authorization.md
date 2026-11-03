# Native authorization implementation boundary

The product decision is GitHub-native-first. No end-user signing keys or external
authorization service are introduced. The modules in this change are incomplete
trusted-side building blocks, not an installed or supported production executor.

## Immutable approval evidence

An internal approval record binds the exact original raw Scope, stable Issue and
repository IDs, original prerequisite identities, finite validity, operation list,
role user IDs, and fixed Core/policy/Skills identities. It is an immutable approval
basis, not another editable Issue or dependency graph. GitHub remains the live
state authority. Current Issue body, published Shape and actual native dependencies
must be checked separately at admission; the raw-Scope helper must not be used
as a substitute for published-Shape provenance.

The current reader uses a reviewed file at `.nibfin/approvals/ISSUE_NODE_ID.json`:

1. Read public repository identity and the effective default branch protection.
2. Require administrator enforcement, no force push/deletion/review bypass, and
   strict app-bound Required Checks. Zero human approvals are supported with
   last-push approval disabled. Positive approval counts require stale-review
   dismissal and last-push approval in this initial adapter.
3. Verify the recorded approval PR and exact head. Accept exact two-parent
   merges or single-commit rewrites with the same immediate base and full tree.
4. Read the provider rule-suite evidence for that exact merge, repository, branch
   and publishing actor. Active PR and Required Check evaluations must pass;
   bypass, missing evidence and unreadable resources deny.
5. Verify the file's Git blob at PR head, merge commit and current protected head.
   The approval merge must remain an ancestor. The most recent file-changing
   commit must be identical at merge and current head: editing then restoring the
   same bytes does not reactivate the old record.
6. Re-read independent exact-head reviews and the current repository permissions
   of reviewers and publisher. Zero-review solo approval requires the actual
   repository Owner with current admin permission to have merged. Applicable
   team reviews remain mandatory. Later dismissal, changes requested, self-approval,
   post-merge approval, publisher mismatch and permission loss deny.
7. Re-read PR, reviews, protection, branch, rule suite and repository identity
   around the observation. Changes deny; no stale-cache fallback exists.

An unchanged record can cover multiple permitted stages until expiry or
revocation. Ordinary unrelated commits do not invalidate it. No per-stage human
Environment/PR approval is imposed. Deletion, edit, supersession, loss of native
evidence or expiry revokes usability; immutable prior bytes remain historical
review evidence rather than a live grant.

The initial adapter intentionally refuses rulesets-only/additional effective
rules, CODEOWNERS-dependent policy, multi-commit approval rewrites, bot publishers,
and unbound status-check apps. These limitations are conservative engineering
boundaries awaiting native verification, not claims that GitHub lacks those
capabilities. The rule-suite API's evidence availability also bounds usability;
missing historical enforcement never becomes implicit approval. No Personal or
Organization configuration is claimed supported based solely on synthetic tests.

The full native policy response is pinned, so changes (including stricter rules)
require trusted re-adoption. The administrator who can rewrite protections is
inside the GitHub trust root. This adapter does not reproduce an offline signer's
independence from a compromised repository administrator.

## Trusted pins and remaining admission work

Pins and adapters must be installed/adopted by trusted Core outside candidate
worktrees. They cannot be supplied by Issue text, event JSON, Agent output or an
unreviewed workflow. Manual host adoption is described in `host-launcher.md`; automated enrollment
and live adoption validation remain incomplete. A candidate cannot
change policy/source pins and authorize itself.

The approval reader returns observations, not an execution capability. In
particular, its Required Check list is not proof of correct CI workflow source or
actual checkout SHA. A passing merged rule suite is not a substitute for the
stage's exact-head/test-merge CI provenance verification. The final stage gate
must freshly combine all of the following before each protected operation:

- Native approval, roles and current permissions, exact installed source/policy.
- Frozen Scope, independently published Shape, current native prerequisites and
  actual eligible assignee order.
- Real Runner/job/run-attempt identity, locally authenticated caller, isolated
  Agent/hook environment and evidence that every previous writer has terminated.
- Correct role/session, candidate/artifact/hook identities, independent acceptance
  and applicable provider CI/review evidence.

`runner-binding.mjs` currently observes a pinned, active, non-reusable
`workflow_dispatch` source on the default branch, a live Linux self-hosted job,
repository-visible registered Runner and the authorized member/initiator. It
refuses fork events, stale attempts, changed source, other actors and unknown
runner state. It does not authenticate an arbitrary local caller or prove Docker
isolation, and it never queries availability to choose a different assignee.

## Unknown writes and local receipts

The Linux operation journal uses a private, owner-only, non-symlink directory.
An exclusive lease is held across fresh admission, durable intent, a trusted
side-effect adapter and exact read-back. Repeated completed decisions deny;
unknown effects stay Pending and are not retried. A killed process leaves its
lease in place. No automatic stale-lock theft or recovery API exists.

This local receipt store contains hashes, not a second Issue/dependency database.
It is not a cross-host lock or proof that a canceled Actions job killed its host
process. Cross-host exclusion and authorized reconciliation remain required
before production assembly. The journal's callbacks are trusted code, not an API
for executing arbitrary commands from a worktree.


GitHub member IDs do not stand in for isolated Agent executions. The same
approved member may own Author, Validator, Writer and Acceptor executions, but
execution and session IDs must differ for independent verification. The runtime
binds the acting member to the actual selected Runner; the privileged write
assembly independently reads the identity of its own GitHub credential before
every mutation. Credentials never enter an Agent session. Native human PR
approval, when configured, excludes the author/writer and requires current
permissions. Zero human approvals do not remove independent Agent role checks.
