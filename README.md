# Nibfin Core

Nibfin Core runs the Scope, Shape, Deliver and Accept roles against a GitHub repository,
keeping all delivery state in Git and GitHub.

## Status

Core is being rebuilt. This repository currently holds only the TypeScript baseline:
the toolchain, CI and a `nibfin` CLI that supports `--help` and `--version`. Later Issues
(#666–#674) add the image, GitHub state, agent runner, configuration, stages and
workflows. The previous implementation is kept for reference at the tag
`legacy-2026-11-23`. There is no release yet.

## Layout

| Path          | Responsibility                                        |
| ------------- | ----------------------------------------------------- |
| `src/cli/`    | The `nibfin` command-line entry                       |
| `src/github/` | GitHub state: Issues, pull requests and checks (#667) |
| `src/agent/`  | Agent CLI runner and `.nibfin.json` (#668, #669)      |
| `src/stages/` | Delivery stages (#671–#673)                           |
| `skills/`     | Role Skills, rewritten by #670                        |

Tests sit next to the code as `src/**/*.test.ts`.

## Development

Use Node.js 24 or later and npm.

```sh
npm ci
npm run check   # typecheck, lint and format check
npm test        # node:test with 100% line, branch and function coverage
npm run build   # compile src/ to dist/
node dist/cli/main.js --version
```

CI runs the same commands as the `verify` job on pull requests and pushes to `main`. On
pull requests, `verify` also builds the amd64 image from `Containerfile` and smoke-tests
it.

## Image

Nibfin jobs run in one container image, built in the cloud by the `Image` workflow
(`.github/workflows/image.yml`). Hosts never build it.

- **When:** on every push to `main` that changes an image input (`Containerfile`,
  `.dockerignore`, `.npmrc`, the package manifests, `tsconfig*.json`, `src/`, `skills/`
  or the workflow itself), and on manual dispatch.
- **What:** `node:24-bookworm-slim` with `git`, `gh`, `uv`, the Codex and Claude CLIs and
  `rulesync`, installed unmodified at their current release, plus the built `nibfin` CLI.
  Everything runs as the non-root user `node` (uid 1000) in `/workspace`. The image
  holds no credentials.
- **Where:** `ghcr.io/taco3064/nibfin`, one multi-arch (amd64, arm64) image per run,
  tagged with the commit SHA and carrying a GitHub artifact attestation. Each
  architecture is smoke-tested before it is pushed. The run summary reports the digest.

Always pull by digest:

```sh
podman pull ghcr.io/taco3064/nibfin@sha256:<digest>
gh attestation verify oci://ghcr.io/taco3064/nibfin@sha256:<digest> \
  --repo taco3064/nibfin-core
```

GHCR creates the package as private on the first run, and the workflow token cannot change
that. After the first run, the Owner makes it public once: open the `nibfin` package on
GitHub, go to **Package settings**, and under **Danger Zone** choose **Change
visibility** → **Public**.
