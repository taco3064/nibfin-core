# Nibfin Core

Core delivery engine, Skills, and reusable workflows for Nibfin.

## Status

Manual bootstrap is tracked in [issue #1](https://github.com/taco3064/nibfin-core/issues/1). The repository currently contains a CI foundation and contract, native approval/Runner observation, dependency-read, assignee-selection and local operation-journal modules. There is no executable delivery runtime or published release. It is not ready for installation as a delivery engine.

Subsequent implementation is proposed through pull requests with applicable CI and independent approval before merge.

## Development

Use Node.js `24.22.1` (also recorded in `.node-version`) and npm `11.9.0`.
If your Node installation bundles a different npm, install the pinned tool with
`npm install --global npm@11.9.0 --ignore-scripts` before installing this project.

```sh
npm ci --ignore-scripts
npm run verify
```

There are no third-party package dependencies. `check` validates the runtime
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
  dependency on a private repository. Parsing does not capture or accept work.
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
