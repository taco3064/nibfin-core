<img src="assets/nibfin-logo.png" alt="Nibfin logo" width="600">

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

| Path             | Responsibility                                              |
| ---------------- | ----------------------------------------------------------- |
| `src/cli/`       | The `nibfin` command-line entry                             |
| `src/github/`    | GitHub state: Issues, pull requests and checks (#667)       |
| `src/agent/`     | Agent CLI runner (#668)                                     |
| `src/config/`    | `.nibfin.json`, role skill text and tools (#669)            |
| `src/stages/`    | Delivery stages (#671–#673)                                 |
| `src/route/`     | What runs next for an Issue, and its dispatch (#674)        |
| `src/workflows/` | Renders the Nibfin workflow files from the templates (#775) |
| `skills/`        | Role Skills, rewritten by #670                              |
| `templates/`     | Workflow templates, shipped in the image (#775)             |
| `docs/`          | Workflow callers and hand setup (#674)                      |

Tests sit next to the code as `src/**/*.test.ts`.

## Development

Use Node.js 24 or later and npm.

```sh
npm ci
npm run check   # typecheck, lint and format check
npm test        # node:test with 100% line, branch and function coverage
npm run build   # compile src/ to dist/
node dist/cli/main.js --version
npm run render:workflows   # rewrite .github/workflows/nibfin-*.yml from templates/
```

CI runs the same commands as the `verify` job on pull requests and pushes to `main`. On
pull requests, `verify` also builds the amd64 image from `Containerfile` and smoke-tests
it.

## Image

Nibfin jobs run in one container image, built in the cloud by the `Image` workflow
(`.github/workflows/image.yml`). Hosts never build it.

- **When:** on every push to `main` that changes an image input (`Containerfile`,
  `.dockerignore`, `.npmrc`, the package manifests, `tsconfig*.json`, `src/`, `skills/`,
  `templates/` or the workflow itself), and on manual dispatch.
- **What:** `node:24-bookworm-slim` with `git`, `gh`, `uv`, the Codex and Claude CLIs and
  `rulesync`, installed unmodified at their current release, plus the built `nibfin` CLI
  with its role skills and workflow templates.
  It also carries the system libraries and fonts Playwright's Chromium needs, installed
  by Playwright's own `install-deps chromium` at its current release (see Browsers).
  Everything runs as the non-root user `node` (uid 1000) in `/workspace`. The image
  holds no credentials.
- **Where:** `ghcr.io/taco3064/nibfin`, one multi-arch (amd64, arm64) image per run,
  tagged with the commit SHA and carrying a GitHub artifact attestation. Each
  architecture is smoke-tested before it is pushed. The run summary reports the digest.
- **`:main`:** the tag Nibfin's own Jobs pull (#674). A run on `main` moves it to its
  image only forward: when `:main` is absent, or its
  `org.opencontainers.image.revision` label names an ancestor of the commit (or the
  commit itself). Image runs of one ref queue instead of cancelling each other.
- **Workflows:** `nibfin-*.yml` run the delivery stages for Nibfin's own repositories;
  see `docs/nibfin-callers.md`. They are rendered from `templates/workflows/` by
  `nibfin render-workflows`, which also renders the files `gh nibfin` writes into user
  repositories (see `src/workflows/README.md`); `npm test` fails when a committed file
  differs from its render. CI lints every workflow with actionlint
  (`.github/actionlint.yaml`).

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

### Browsers

An agent in a Job can drive a headless Chromium with Playwright, for example to
screenshot a web UI at several viewport widths. The image has Chromium's system
libraries and fonts (Latin, emoji, CJK, Thai and a Unifont fallback) but no browser
and no Playwright package; the project brings both:

1. Pin `playwright` or `@playwright/test` in the project's `package.json` and
   lockfile; that version is the one the Job uses.
2. In the Job, run `npm ci`, then `npx playwright install chromium`. No root and no
   `--with-deps` are needed. For headless-only use,
   `npx playwright install --only-shell chromium` downloads only the headless shell
   (about 130 MB instead of about 340 MB).

Core sets `PLAYWRIGHT_BROWSERS_PATH` to `ms-playwright` in the tool cache
(`NIBFIN_TOOL_CACHE`) for the agent's run, so downloads persist across Jobs: a later Job
on the same Playwright version downloads nothing. Playwright itself removes builds
that the last installing project no longer uses, so after a version change the old
build is deleted; another repository on a different version downloads its build again.
Only Chromium is supported; Firefox and WebKit lack their system libraries.
