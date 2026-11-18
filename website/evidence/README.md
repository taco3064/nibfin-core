# Public source checklist

`checklist.json` is an audit projection of the inspected source and reviewed
articles, not command authority. Article digests bind the complete reviewed text,
including GUI guidance and support statements, to this audit. The audited articles
are listed once in `checklist.json`: the index, four onboarding routes,
Execution environments, Agent providers, Architecture, Security and Limitations.
Generated link validation still covers every article, including neighboring guides
outside this claim audit. Update audited text only after inspecting its evidence.
Command syntax comes from
maintained component source/help, never a hand-edited availability label.

Run `node website/scripts/docs-check.mjs` from the repository root for a read-only
comparison. The native website check runs it before Astro. It executes the fixed
candidate help invocation with the current Node runtime,
validates its command list and administrative admission qualification, checks
adjacent candidate warnings/identity, and rejects unlisted commands and changed
article audits. Execution is bounded; errors and invalid output fail.
Candidate examples on the CLI, Installation and Agent providers pages share one
command inventory.
Each entry lists its allowed pages; per-page order and exact syntax are checked.
The installation article owns managed onboarding. CLI and Runner articles retain
explicit legacy/manual references without making those steps managed prerequisites.
Unlisted commands, misplaced commands and contradictory availability still fail,
even when an article digest is refreshed.
No onboarding mutations, credentials or remote writes are involved.

`historicalCoreHelp` preserves the previously observed source identity, digest,
date, provenance and help output. These are historical observations, not candidate
byte or output prerequisites. The adjacent article source reference identifies
that historical inspection; it does not identify the current candidate. Candidate
comments, command ordering and unrelated help additions need no evidence refresh.
The candidate contract is maintained in the verifier: a nonempty command list and
the lifecycle requirement for administrator-adopted configuration and live native
admission. No listed administrative command is executed. The example remains
candidate-only. The 2026-11-13 GitHub read-back reached the
three public repositories and their release lists. No formal release was listed.
The current CLI README and Issues establish candidate interfaces, including the
local Dashboard and Runner registration. Fresh installation, protected host
execution, and formal release support were not exercised. The official GitHub
manual-management links provide current platform guidance.

`source-fixture.json` is wholly synthetic. Its identity, source, help, version,
release and asset exercise comparison failure modes. It cannot certify a real
component or publication. The tests independently change flags, identities,
versions, source, assets, release input and candidate/release presentation. The
real checklist deliberately withholds released claims instead of using fixtures
as release evidence. Public release claims require independent public read-back.

Internal article-link validation reads generated HTML, including every article
and fragment, under each configured base. Missing-route and broken-fragment
controls restore valid input and rerun. Existing theme/island controls remain.
Stable content routes are `getting-started`, `installation`, `cli` and `runners`;
DOC04 and DOC07 can consume them without treating this work as Pages deployment.

## Managed walkthrough review (#335)

The supplied gh-nibfin source snapshot identified in the checklist was inspected
directly: its parser, managed login consent, original installation intent,
15-minute merge polling, host/peer adoption and relay activation. Core's maintained
credential and relay guides ground renewal, disconnect, private credential
authority, notification bounds and unknown-effect recovery. These observations
update the article audit, not the older public release-list observation above.
No new public release readback, fresh installation or provider E2E was performed.

The checklist records producer source paths and qualifications alongside the
shared candidate command inventory. Compatible producer verification remains an
installation obligation: available implementation or cross-built binaries do not
prove that a selected CLI pin can consume those features. In particular, the
current producer's unprotected-default-branch refusal is documented as a limitation
rather than a product prerequisite. No pin workaround is prescribed.

Tests refresh article digests in disposable copies to exercise the independent
command and status checks, including managed consent syntax on the installation
page and rejection of commands moved to an unlisted page. Synthetic release
fixtures retain their independent public-readback requirement.

## Environment and provider review (#343)

The supplied gh-nibfin source grounds WSL and Multipass discovery, guest-local
handoff, install-time Agent selection and explicit managed rebuild. Core's
installed-provider and resource-preparation contracts ground the shared binding
and native Linux architecture mappings. These observations extend the claim
inventory; they do not certify desktop runtime, clean installation, kernel
isolation, live provider operation or a formal release.

The candidate inventory records Codex as Unverified and production Claude as
Planned. The focused candidate validator keeps provider claims consistent with
that inventory and withholds commands selecting unavailable providers. Existing
audit regression controls cover both guides, affected environment claims,
unlisted fenced and inline commands, and contradictory provider availability.
Website audit, build and browser results belong to the existing PR CI; publication
and its read-back belong to CD after merge.
