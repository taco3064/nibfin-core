# Nibfin Core

Core delivery engine, Skills, and reusable workflows for Nibfin.

## Status

Manual bootstrap is tracked in [issue #1](https://github.com/taco3064/nibfin-core/issues/1). This CI foundation contains no delivery runtime or published release. It is not ready for installation as a delivery engine.

Subsequent implementation is proposed through pull requests with applicable CI and independent approval before merge.

## Development

Use Node.js `24.22.1` (also recorded in `.node-version`) and npm `11.9.0`.

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
