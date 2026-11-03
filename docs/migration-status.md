# Core #1 migration status

This is source-level implementation evidence for the manual bootstrap. It is not
a protected Shape, acceptance receipt, release, or proof of a working Runner.

The inspected migration reference is Kairo revision
`50581cd4db47ee78f1c1e4862fa10f0c95fcc4a5`. No operational configuration, private
fixtures, credentials, or historical execution evidence is included in this tree.

| Workstream | Current module and evidence | Remaining boundary |
| --- | --- | --- |
| C01 | Node ESM tooling and CI in PR #19 | Independent approval and effective branch/check protection read-back |
| C02/C03 | Canonical identities, bounded approval records, frozen raw Scope and live native approval observations | Trusted pin adoption, full stage admission, actual Personal/Organization enforcement proof |
| C11/C13 | Durable local intent/read-back/replay handling, exclusive leases and killed-process test; live Runner/job/source observation adapter | Privileged operation implementations, reconciliation and cross-host writer/isolation proof |
| C04 | `github-read.mjs`, `dependencies.mjs`; native paginated reads, cross-repository identity checks, open/changed/inaccessible dependency denials | Authenticated stage admission and authorized downstream wake-up |
| C08 | Selective port of the existing strict candidate parser/schema; fresh public tests cover ordered hooks, invalid/ambiguous inventories and unsafe paths | Workspace capture, artifact identities, isolated hook execution, trusted receipts |
| C12 | `selection.mjs`; provider order, ineligible-member skip, no offline/busy fallback, unknown authorization denial | Real GitHub permission/grant adapter and Runner/job binding |

The read adapter carries over the native endpoint and fail-closed pagination
approach, without the private Runner selector or operational write methods. The
dependency reader checks the approved prerequisite identities against live native
resources twice around prerequisite reads. Its result is only a bounded
observation; the eventual trusted stage executor must repeat admission before
protected operations. It cannot authorize work by itself.

The selection helper deliberately accepts a trusted eligibility callback. It does
not infer eligibility from a label, Issue body, or caller-supplied boolean field.
The native member-permission reader is implemented; protected stage admission is not yet connected.

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

These are trusted-side components, not a connected delivery executor. No stage
may infer authority from their caller-supplied JSON or from aggregate test success.
See [native authorization boundaries](native-authorization.md) for the provisional
adapter restrictions, trusted pin acquisition boundary and missing live proof.

On 2026-11-03, actual GitHub reads of `main` branch protection and repository rule
suites both returned HTTP 403 (`Resource not accessible by integration`). This
connection cannot establish the positive native protection/enforcement proof.
Chrome extension setup and tab listing worked, but navigation to repository
settings timed out; no protection change or successful read-back is claimed.
The local execution environment has neither Docker nor a Codex Agent executable,
so it cannot supply the required live Runner/Agent/isolation demonstration.
These are evidence limitations, not a reason to introduce a signing-key workflow.

## Verification limits

Tests use synthetic public fixtures and injected provider responses. They do not
prove a real isolated Agent, privileged publication, cross-Runner continuation,
independent acceptance, merge, release, or external delivery. C02–C17 are not
claimed complete by these modules. Core #1 remains open.
