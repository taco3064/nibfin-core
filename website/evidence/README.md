# Public source checklist

`checklist.json` is an audit projection of the inspected source and reviewed
articles, not command authority. Article digests bind the complete reviewed text,
including GUI guidance and support statements, to this audit. The audited articles
are the index and the four onboarding routes. Neighboring guides retain their own
source reviews; generated link validation still covers every article. Update them only
after inspecting the changed text and its evidence. Command syntax comes from
maintained component source/help, never a hand-edited availability label.

Run `node website/scripts/docs-check.mjs` from the repository root for a read-only
comparison. The native website check runs it before Astro. It compares the actual
Core entry bytes and read-only help with the projection, checks adjacent candidate
warnings/identity, and rejects unlisted commands and changed article audits.
Candidate examples on the CLI and installation pages share one command inventory.
Each entry lists its allowed pages; per-page order and exact syntax are checked.
The installation article owns managed onboarding. CLI and Runner articles retain
explicit legacy/manual references without making those steps managed prerequisites.
Unlisted commands, misplaced commands and contradictory availability still fail,
even when an article digest is refreshed.
No onboarding mutations, credentials or remote writes are involved.

The Core help projection still compares the inspected source and current read-only
output. The example is candidate-only. The 2026-11-13 GitHub read-back reached the
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
