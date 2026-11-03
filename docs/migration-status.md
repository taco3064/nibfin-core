# Core #1 migration status

This is source-level implementation evidence for the manual bootstrap. It is not
a protected Shape, acceptance receipt, release, or proof of a working Runner.

## Current audit and remaining bootstrap work (2026-11-04)

Core #1 is implemented in part, not accepted. PRs #19–#22 are merged; main
`b73272173e28e431953507450675a293a1187919` passed 152 tests and package/install
verification. Independent Agent technical review is required. Solo Owner policy
supports zero GitHub human Required Approvals; configured team approvals still
apply. No second human account is required.

Post-merge workflow runs may return an empty `pull_requests` array, as observed
in [run 41666463853](https://github.com/taco3064/nibfin-core/actions/runs/41666463853).
Closure now requires the trusted pre-merge CI evidence and re-observes the same
checks, run/attempt, job, workflow and checkout identities. Empty associations
are tolerated only after merge with exactly matching evidence. Missing prior
evidence, changed provenance and mismatched nonempty associations deny.

Normal dependency eligibility and fanout require Closed plus `scope`, `shaped`
and `delivered`. These are current native lifecycle conditions, not proof of
historical authorization or a grant to execute the downstream Issue. Each target
still needs its own fresh authorization and source review. No permanent upstream
receipt archive is introduced. Manual Bootstrap #1 is outside this lifecycle:
its release/setup gate is resolved by authorized manual cutover and Scope audit,
not by inventing `delivered` or an unlabeled/Issue-number bypass. Existing native
edges are not automatically edited by Core.

Remaining work is more than a subscription login:

- Adopt and verify an actual trusted host/caller/approval configuration, then run
  a real authenticated Agent with independent validation and isolation controls.
- Verify C14's legal wake-to-execution handoff. `WakeDispatcher` sends Issue
  identity to a pinned caller; `stage.yml` accepts stage/member routing inputs.
  The trusted caller must resolve current eligibility and connect these contracts.
  The reusable workflow and dispatcher tests alone do not prove this integration.
  A dispatch resolver CLI and reusable wake-to-stage workflow are now implemented
  (see `wake-entry.md`); live handoff, Issue-event caller integration and automatic
  later-stage continuation remain unverified/incomplete.
- Publish a non-placeholder Core version and read back its immutable source and
  assets. Package CI is not a release. Full external cutover and all three repos'
  self-delivery proofs remain downstream work, not added Core #1 requirements.

## Current launcher integration (2026-11-03)

The CLI now exposes `stage <adopted-issue-number> <stage>`, and
`.github/workflows/stage.yml` calls the administrator-installed executable without
checking out repository code. The launcher reads fixed root-owned adoption data,
verifies installed source and native job/OIDC/approval, prepares or reuses the
private Issue workspace and composes the existing Codex stage executor.

A durable host-wide fence serializes stages and survives process death. Native
registration inspection denies duplicate member routes, including offline ones;
the dedicated daemon must contain only the adopted gateway outside an invocation.
Unknown execution retains the fence and returns Pending, never automatic retry.
The supported initial boundary is a manually adopted single host; automatic
enrollment and cross-host recovery are not implemented.

Tests cover native job discovery, source/job mismatch, duplicate registered
routes, concurrent launches, a real killed process retaining the fence, unsafe
adoption paths and CLI request refusal. These are launcher integration controls,
not a new live authenticated Agent claim. Protected caller/approval setup,
subscription-backed execution, authorized wakeup, independent merge and release
remain outstanding. See [host-launcher.md](host-launcher.md). Earlier entries
below record implementation history and are superseded by this section where
they describe the stage CLI/workflow as absent.

## Remote process verification (2026-11-03)

Real [GitHub-hosted run 41627906612](https://github.com/taco3064/nibfin-core/actions/runs/41627906612)
at `e29e9d3db52eaf455ec680cbb6e2cdc7ed46ea66` passed both offline hook
isolation and an unauthenticated Codex CLI sandbox probe. No customer machine,
subscription credential, inference request or production Runner registration was
used. The 139-test CI and package build also passed at that revision.

- The actual `OfflineSandbox` ran successful and deliberately failing commands,
  refused access to host-only files and inherited credentials, kept the baseline
  and container root read-only, prevented outbound connections and removed all
  hook containers.
- Actual Codex CLI `0.138.0` refused reads of existing synthetic authentication
  and private-output files and connections to a listening container-local port.
  A separate command had to produce known output and exit 37; an empty or
  unexecuted probe cannot pass. Cleanup of mapped test files also succeeded.
- The CLI probe used container UID 1000 and the upstream seccomp/AppArmor
  profiles from `openai/codex-security@3fa6215fc1021bbee546a61f8b407bcd521953f0`,
  retaining dropped capabilities and no-new-privileges. The earlier default
  container policy and UID 0 combination failed nested sandbox startup.
- Bootstrap now uses the observed CLI command (`sandbox --permissions-profile`)
  and synchronous probe output. The remote probe shares that argument builder.

## Production adapter follow-up (2026-11-03)

The production `CodexSandbox` now uses container UID/GID 1000 and the vendored,
revision-pinned upstream seccomp/AppArmor profiles. Actual Docker inspection must
confirm both the security options and active AppArmor profile before launch.
The original subscription file keeps its private permissions. A disposable copy
is mounted separately; shared workspace/input/output/session access requires a
canonical controller-owned 0700 parent. Link and hard-link inputs are rejected,
and preparation preserves Git executable modes.

After proving the Agent container absent, a bounded offline helper makes mapped
UID output readable/removable by Core. Unknown helper outcomes remain Pending.
Core reads output only after this cleanup, removes the disposable authentication
copy and erases the stopped session's contents, including failed-login sessions.
The production denial probe first confirms that its private files exist and that
the controller can connect to the proxy; missing targets cannot prove isolation.

[Remote run 41630580323](https://github.com/taco3064/nibfin-core/actions/runs/41630580323)
at `9a77196f110c4b50338d92836dc34c63cb678808` executed the real production
adapter/bootstrap, verified its nested probe, denied missing subscription login,
preserved original authentication permissions, removed the copied authentication, erased the stopped session,
and removed containers and test files. All 141 tests and package CI passed. This closes the former
probe-only versus production-adapter gap for unauthenticated execution.

**Boundary:** no authenticated inference, registered self-hosted Runner/OIDC
binding, native wakeup or protected delivery is claimed. The same run includes the positive probe-target checks and
stopped-session erasure. Earlier fixture-only entries below describe initial
module evidence; this section records the additional remote observations.

## Native Actions identity verification (2026-11-03)

[Remote run 41635757771](https://github.com/taco3064/nibfin-core/actions/runs/41635757771)
at `73a2041a4ef39b34d92f4e9a0b2ff5154000750f` verified a real GitHub-issued
OIDC token with the production verifier, native current-attempt job/check identity
and GitHub's actual signing keys. The hosted push caller was correctly denied;
altering the signed runner environment and event caused signature rejection.
The same run passed the real Hooks, CLI sandbox and production adapter controls.
CI and package/install verification passed for that revision.

The first live identity check exposed an outdated test assumption about `sub`.
This newly created repository uses GitHub's immutable subject format containing
both owner and repository IDs. The test now constructs that exact subject from
native Actions identity rather than copying a subject out of the untrusted token.
Production already compares the exact adopted subject; no permissive fallback,
name-only wildcard or accepted-event relaxation was added. See the official
[OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).

This proves a real native signature and the hosted/forged-caller refusal boundary.
It does not establish self-hosted Runner admission, subscription inference or
protected stage execution. Its adopted native binding,
independent review and complete launcher/workflow integration remain unfinished.

## Temporary registered Runner verification (2026-11-03)

[Run 41639935625, attempt 2](https://github.com/taco3064/nibfin-core/actions/runs/41639935625/attempts/2),
job `125933291030`, passed at source `91737de936dd5b979eb2cd5deb84742676c17adf`.
An official Actions Runner 2.338.2 registered on the remote test host with only
one unique label and ephemeral mode. The check matched its actual native Runner,
job/check/run-attempt identity and GitHub-signed self-hosted OIDC claims. The
production verifier rejected the push event; a modified token failed signature
verification. No protected-event admission rule was relaxed.

Attempt 1 stopped during Node installation because this remote UID namespace
cannot restore archive UID 1001. Attempt 2 ran the same source with the host's
`TAR_OPTIONS=--no-same-owner`. This is test-host archive handling, not an Agent
sandbox permission change. CI and the separate hosted isolation suite passed
for this source. This remote Runner test does not combine the supported Docker
host and authenticated Agent into a complete production execution.

The ephemeral Runner removed its registration after the job. The one-time
workflow is removed after verification so subsequent commits cannot enqueue
jobs against the retired label. Trusted host adoption, protected dispatch
admission, authenticated inference and independent protected delivery remain
unverified.

The inspected migration reference is Kairo revision
`50581cd4db47ee78f1c1e4862fa10f0c95fcc4a5`. No operational configuration, private
fixtures, credentials, or historical execution evidence is included in this tree.

| Workstream | Current module and evidence | Remaining boundary |
| --- | --- | --- |
| C01 | Node ESM tooling and CI in PR #19 | Merged after independent Agent review and required CI; no second human required |
| C02/C03 | Canonical identities, bounded approval records, frozen raw Scope and live native approval observations | Trusted pin adoption and actual Personal/Organization enforcement proof; pure admission and native observer are implemented |
| C11/C13 | Durable local intent/read-back/replay handling, exclusive leases and killed-process test; live Runner/job/source observation adapter | Privileged write/read-back and isolated hook adapters implemented; reconciliation and cross-host writer/isolation proof remain |
| C04 | `github-read.mjs`, `dependencies.mjs`; native paginated reads, cross-repository identity checks, open/changed/inaccessible dependency denials | Native observer connects authenticated admission; authorized downstream wake-up remains |
| C08 | Selective port of the existing strict candidate parser/schema; fresh public tests cover ordered hooks, invalid/ambiguous inventories and unsafe paths | Workspace capture, artifact identities, isolated hook adapter and durable receipts implemented; real isolation demonstration remains |
| C12 | `selection.mjs`; provider order, ineligible-member skip, no offline/busy fallback, unknown authorization denial | Native observer composes permission/grant and Runner/job binding; actual local caller proof remains |

The read adapter carries over the native endpoint and fail-closed pagination
approach, without the private Runner selector or operational write methods. The
dependency reader checks the approved prerequisite identities against live native
resources twice around prerequisite reads. Its result is only a bounded
observation; the eventual trusted stage executor must repeat admission before
protected operations. It cannot authorize work by itself.

The selection helper deliberately accepts a trusted eligibility callback. It does
not infer eligibility from a label, Issue body, or caller-supplied boolean field.
The native member-permission reader is implemented; the native observer connects it to protected stage admission.

## Native authorization decision and current implementation

The updated Proposal and Core #1 explicitly choose GitHub-native-first authority.
Ordinary users do not manage Ed25519 keys or signed Owner Grant files. That product
question is resolved; implementation must retain the reference's immutable
identity, independent approval, revocation and fail-closed boundaries.

`identity.mjs` selectively adapts the reference's canonical evidence hashing and
rejects lossy/non-JSON values. `approval-record.mjs` separates frozen raw Scope
from mutable Issue text and validates bounded operations, independent roles,
source/policy/Skills identities and expiry. `github-approval.mjs` reads real native
review, permission, protection, merge-enforcement and file-history resources.
`runner-binding.mjs` reads actual Actions run/attempt/job, registered Runner,
member permission and fixed workflow source; labels alone cannot establish it.
`operation-journal.mjs` adapts durable intent, exclusive local leases and unknown
write handling, including a killed-process test. It is not a distributed lock.

These are trusted-side components connected through the stage runtime, observer and handlers. The production launcher and live Agent adapter remain unfinished. No stage
may infer authority from their caller-supplied JSON or from aggregate test success.
See [native authorization boundaries](native-authorization.md) for the provisional
adapter restrictions, trusted pin acquisition boundary and missing live proof.

The earlier branch setup required a human approval. The Owner subsequently
corrected the solo configuration, and PRs #19–#22 merged through required CI.
The connector cannot read administration-only protection settings; merge success
is not a claim that this connector independently read every protection field.
Independent Agent technical review remains mandatory; a second human does not.
Actual supported authenticated Agent execution remains unverified.

GitHub-hosted package and release-preparation jobs need no customer-managed
Docker, Linux or WSL setup. The provisional container adapter is an implementation
option, not a product-wide installation requirement.

## Verification limits

Tests use synthetic public fixtures and injected provider responses. They do not
prove a real isolated Agent, privileged publication, cross-Runner continuation,
independent acceptance, merge, release, or external delivery. C02–C17 are not
claimed complete by these modules. Core #1 remains open.

## Lifecycle and workspace implementation

The stage runtime and handler integration test exercises Scope authoring,
independent validation, publication, delivery, ordered hooks, independent
acceptance, PR publication, fresh Shaper review, merge and closure. It uses
real local journals/evidence storage with synthetic Agent/provider effects.
Stage requests cannot supply authority, callbacks, credentials or arbitrary
commands. Unknown effects retain Pending rather than replaying writes.

Git metadata is outside the Agent mount. Captures bind raw regular-file bytes,
Git trees and diffs, reject links and unsafe paths, and preserve required ignored
artifacts separately. Hook commands are fixed by Core and executed only by the
offline rootless adapter. Its tests inspect requested Docker contracts but do not
claim a real container ran in this development environment.

The native CI adapter requires app-bound checks, pinned workflow bytes, current
attempt/job identity and a checkout log marker confined to the trusted checkout
step. It does not accept a green unrelated job or later Agent-written log text.
The PR write adapter checks exact source/base identities before publishing.
Packaged Scope/Shape are the provided project sources; Deliver/Accept provide the
role-specific contract. No personal ChatGPT Skill is installed by this package.


The privileged write assembly now verifies the credential owner's native GitHub
identity and repeats admission separately for push and PR creation. Same-member
Agent roles retain distinct execution/session boundaries; requiring different
GitHub accounts for each Agent role was an implementation overconstraint and is
removed. Human PR approvals follow the actual configured count, including zero
for the solo Owner; independent Agent validation remains mandatory.

Committed-source packaging produces a deterministic archive and an exact-file
manifest. Real Git and tar extraction tests verify reproducibility and rejection
of modified source, added files, symlinks and swapped manifests. The fixed Codex
plan disables inherited configuration/apps, denies credentials/session/output
paths to tools. Final Shaper review now starts fresh against current sources. These
are tested contracts; live CLI compatibility, nested sandbox enforcement and
production Agent assembly are still unverified and cannot authorize execution.


## Agent, caller, wakeup and distribution adapters

The Codex role adapter reads pinned Skills, requires subscription authentication,
uses separate per-execution sessions, including fresh final Shaper review. Local
session locks remain held after unknown execution. The container adapter verifies
actual image, mounts, environment, resource constraints and egress, requires a
nested CLI denial probe, and confirms container removal before issuing proof.
Synthetic tests cover policy substitution, credential output encodings, symlink
outputs, forged execution identity, lost create replies and unknown cleanup.
No Docker/Codex process was run on an actual supported host here.

Actions caller identity verifies GitHub-issued RS256 OIDC tokens against the
fixed native issuer and exact repository/run/attempt/actor/check-run/source. A
reusable workflow adds its own pinned source. Fresh tokens are required by the
native observer; environment variables alone are not caller proof.

Wakeup reads native eligibility before and immediately before dispatch. It uses
the native API version returning the scheduled run identity, then reads that run
back. Legacy/ambiguous responses remain Pending and are not retried. Fanout
re-reads the native graph and requires current Closed + scope/shaped/delivered
lifecycle eligibility; downstream authorization is separate. These are bounded
adapter tests, not the required real token-trigger demonstration.

The public CLI can pack committed source, install a digest-pinned archive into a
new directory and verify exact installed bytes. It does not expose a production
stage command before trusted host adoption is wired. Archive
extraction refuses traversal, links, duplicates, invalid checksums and mismatched
manifests; it never overwrites an existing installation.

## Owner clarification implemented (2026-11-03, Proposal §1.3)

Permanent historical evidence retention is not a product requirement. The earlier
open question in this document is superseded. Current main/code/tests and native
Issue/PR/Review/Checks/Run resources govern fresh investigation. Native dependency
eligibility no longer requires an archived predecessor completion receipt.

The final Shaper starts a fresh isolated conversation with a newly fetched,
read-only main snapshot. Known-completed sessions remove their private home;
unknown executions retain their fence. Current Shape may be independently
revalidated and confirmed without rewriting it or asserting historical approval.
Local EvidenceStore objects remain in-flight receipts, not cross-Runner SSOT.

Real Git tests cover clean rebases preserving parallel merged work and ordinary
conflicts resolved by Deliver. Candidate/head changes invalidate old acceptance,
hooks, CI and final review. The runtime includes fresh main in admission, checks
Candidate base at final gates and verifies the synthesized PR's direct parent.
Rebased publication updates the existing PR under an exact old-head push lease.
No long-term receipt synchronization service or permanent archive is introduced.

Production launcher/adoption, real supported-host isolation, actual native wakeup,
independent review and release remain to be completed and verified.


## Public package and release preparation

The public ESM entry exports the bounded stage API and a versioned consumer
contract. `contract`, `pack`, `install` and `verify` are available through the CLI;
production stage CLI assembly remains unfinished. The reusable package workflow
runs on GitHub-hosted infrastructure and verifies the installed CLI before
uploading build artifacts. A build artifact is not a published release.

The release workflow only plans or creates an unpublished draft from the current
protected main commit, with fresh native run and actor permission checks. Draft
creation records intent before writing and does not retry unknown effects.
Version 0.0.0 cannot create a release draft. Publication verification requires a
native immutable release, its exact tag commit, publisher and asset digests.
No release has been published by this implementation work.

The native stage composition now owns observer/write/handler/journal/store wiring
and the bounded JSON transport. Integration tests use real local persistence and
synthetic native/Agent observations to cover successful Shape execution, revoked
approval, replay and unknown-effect fencing across executor instances. See the
[consumer interface](consumer-api.md) for the implemented API and remaining
standalone launcher/adoption boundary.


Installation-aware execution now fixes source verification and GitHub-signed
caller identity inside Core. Tests combine real installed files, signed synthetic
OIDC tokens, native-provider fixtures and durable receipts. Modified installation,
foreign job, mismatched approved source and absent writer proof deny execution.
The fixed Codex composition constructs Core-owned Agent/workspace/hook adapters;
it does not claim an actual supported-host execution or replace the remaining
trusted adoption, workspace preparation and writer reconciliation requirements.
