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
No onboarding mutations, credentials or remote writes are involved.

The immutable Core identity is the bound current-main source snapshot.
The help projection was refreshed against Core commit
`6840bdb38ca3f063b2d2b6c39684c6fdaff05873`, including its recovery and host
promotion entries. These administrative entries are compared, not onboarding steps. Public
GitHub read-back was blocked by the execution allowlist on 2026-11-11. Thus no
formal release, installed candidate, CLI interface or Action/Core compatibility
is certified. Null source/help/tag/asset observations mean unavailable, not absent.
The Core help example is candidate-only. Product-boundary prose derives from
current Issue #15 and product requirements; it is not source implementation proof.
Official GitHub manual-management links are guidance, not a tested onboarding E2E.

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
