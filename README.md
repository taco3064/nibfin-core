<img src="website/src/assets/nibfin-logo.png" alt="Nibfin logo" width="600">

# Nibfin Core

Core delivery engine, Skills, and reusable workflows for Nibfin.

## Status

Manual bootstrap is tracked in [issue #1](https://github.com/taco3064/nibfin-core/issues/1). The repository contains CI foundations, native approval and Runner observations, durable stage execution and evidence storage, candidate capture, isolated hook adapters, native PR/CI/write adapters, and packaged Skills. A stage CLI and reusable execution workflow now connect the existing runtime on a manually adopted host. Live authenticated integration remains unverified and there is no published release. It is not ready for installation as a delivery engine.

Subsequent implementation is proposed through pull requests with applicable CI and independent approval before merge.

## Development

Use Node.js `24.22.1` (also recorded in `.node-version`) and npm `11.9.0`.
If your Node installation bundles a different npm, install the pinned tool with
`npm install --global npm@11.9.0 --ignore-scripts` before installing this project.

```sh
npm ci --ignore-scripts
npm run verify
```

Core runtime has no third-party package dependencies. The documentation
workspace uses pinned Astro, Starlight and TypeScript dependencies. `check`
validates the runtime
configuration and recursively syntax-checks JavaScript in `scripts/`, `test/`,
and, when present, `src/` and `bin/`, without executing those modules. Missing
configuration, missing tests and syntax errors fail the check. `test` runs the
Node test runner. This baseline provides syntax checks, not a type checker or
style linter.

CI runs on pull requests and pushes to `main` and `bootstrap/**`, using a
GitHub-hosted runner and a read-only token. The workflow does not run on a
self-hosted runner or request project secrets. CI success is not evidence of
independent approval, branch protection, delivery capability or release readiness.

## Implemented foundations

- Candidate obligation parsing retains the existing `kairo-candidate` fence and
  ordered `artifacts`/`hooks` schema. This is a format compatibility choice, not a
  dependency on a private repository. Workspace capture separately binds Git trees and required artifact bytes, including ignored evidence.
- The GitHub reader uses authenticated native endpoints and bounded pagination.
  Dependencies are re-read, stable identities are checked, and inaccessible or
  changed resources fail closed. No parallel dependency graph is persisted.
- Assignee selection preserves the provider's order. It selects the first member
  approved by a trusted eligibility adapter, without querying Runner availability.
  The resulting `nibfin-user-ID` label is a route, not execution authorization.

- Approval records bind immutable Scope, repository/Issue IDs, bounded operations,
  independent role IDs, source/policy/Skills identities and a finite validity window.
  Native approval reads verify a reviewed merged record against current GitHub
  permissions, classic protection, merge enforcement and unchanged file history.
  These observations do not by themselves authorize execution.
- Runner observations bind the real run/attempt/job/Runner/member and pinned
  workflow source. They do not prove host isolation or cross-host exclusion.
- The Linux local operation journal records intent before a trusted side effect,
  requires exact read-back, rejects replays and preserves unknown outcomes as
  Pending. It never steals a stale writer lease.

See [native authorization boundaries](docs/native-authorization.md) and
[migration status](docs/migration-status.md) for boundaries and remaining work.

## Lifecycle implementation

`StageRuntime` composes fresh trusted observations, stage admission, a durable
operation journal, fixed handlers and immutable receipts. `nativeObserver` reads
GitHub again at admission; mutable event payloads cannot provide authority.
`stageHandlers` implements the bounded Scope-to-closure sequence through installed
adapters. Its integration test uses simulated Agent and GitHub effects, not a live
delivery claim.

Candidate capture keeps Git metadata outside the Agent workspace, disables Git
filters and hooks, honors ignored untracked files, and independently retains all
required evidence bytes. Offline hooks run through a rootless Docker adapter
with no network or credentials and confirmed container cleanup. CI observations
bind check app, workflow bytes, actual job attempt, trusted checkout step, tested
commit and independent reviews. Privileged writes require fresh exact-target
admission and provider read-back, with no automatic retry of unknown effects.

Production Agent isolation, caller/source adoption, cross-host continuation,
downstream wake-up, release publication and live native enforcement verification
remain unfinished. None of the adapter injection points is an external JSON API.

`source-package.mjs` builds a reproducible archive from an exact committed public
revision and verifies every installed file against an independently pinned
manifest. This is packaging infrastructure, not a published or usable release.
`codex-plan.mjs` compiles fixed role-specific CLI arguments and credential-denying
permissions; it is not a live Agent/container adapter or isolation proof.


## Source distribution tools (development)

```sh
node bin/nibfin-core.mjs pack /absolute/public-checkout FULL_COMMIT_SHA /absolute/new-output
node bin/nibfin-core.mjs install /absolute/new-output/nibfin-core.tar.gz /absolute/new-install /absolute/approved-source-pin.json
node bin/nibfin-core.mjs verify /absolute/new-install /absolute/approved-source-pin.json
```

The generated pin is a build result, not approval. Approve the public source and
archive/manifest identities independently before installation. Installation
checks the archive digest before extraction, validates every installed file and
refuses an existing destination. No private Kairo access or package dependency
is needed. A development archive is not an official release or an execution
grant. The [adopted-host stage entry](docs/host-launcher.md) is available through
the CLI and `.github/workflows/stage.yml`; live protected dispatch remains to be
verified with real adoption, approval and subscription authentication.

The subscription Agent adapter, private per-execution sessions, restricted egress,
Actions OIDC caller proof and native wakeup are implemented with bounded tests.
Actual host enforcement, trusted launcher adoption and live integration
remain requirements before activation; see the migration status for details.


## Current-source review and concurrent delivery

Per Proposal §1.3, Shaper roles inspect the current GitHub Issue and a freshly
fetched read-only `/main` snapshot. Final review uses a new isolated conversation;
no historical transcript transfer or permanent Shape/Accept archive is required.
Missing in-flight Shape approval can be re-established by fresh independent
validation and exact current publication read-back. A label alone never grants
execution, and current code never fabricates a past approval.

Before acceptance, publication, final review and merge, Candidate base must match
fresh main. Deliver rebases with Git, resolves ordinary in-scope conflicts and
recaptures the actual Candidate. Changed content requires new hooks, independent
acceptance, applicable CI and review. A repaired existing PR uses an expected-head
lease; a competing update or moved main prevents stale publication/merge. Native
Blocked by eligibility uses current upstream state, not a historical receipt
archive. Local journals/receipts serve in-flight correctness and unknown effects.

## Documentation workspace

The public documentation source is in [`website/`](website/README.md). Root
`npm ci --ignore-scripts` installs its pinned workspace dependencies.
`npm run website:check` checks types/content and builds the static site;
`npm run verify` includes website validation alongside the existing Core checks.
See the workspace guide for preview commands, routes, base overrides and checks.
This workspace does not deploy GitHub Pages or claim a published site.
