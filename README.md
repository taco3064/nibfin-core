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

CI runs the same commands as the `verify` job on pull requests and pushes to `main`.
