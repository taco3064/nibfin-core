# `src/action`

Core's JavaScript Action (#776, Proposal R5.7, R5.8): the steps of the Nibfin workflows
that run where the Nibfin image is not available, such as the last step of a Job whose
container never started. The Action lives in `action/` at the repository root:
`action/action.yml` (`runs.using: node24`, `runs.main: main.mjs`) and the committed
bundle `action/main.mjs`.

Workflows call it as `taco3064/nibfin-core/action@<ref>`: Nibfin's own repositories
`@main` (R5.6), users' repositories `@<commit>`, the nibfin-core commit their image was
built from (`nibfin render-workflows --commit`, see `src/workflows/README.md`).

## Commands

The `command` input picks one; every other input is per command. The runner gives each
input as `INPUT_<NAME>` (upper cased, hyphens kept); the Action reads them from its
environment, with no `@actions/core`.

- `job-failed` (inputs `token`, `repo`, `issue`, `stage`): the last step of a route,
  finish or stage Job that failed. It calls `askPersonOnce` with `JOB_FAILED` (see
  "Pending" in `src/stages/README.md`).
- `wake` (inputs `token`, `execution-repo`): the job of `nibfin-events.yml` and of the
  user `nibfin-issue.yml`. It reads the event from `GITHUB_EVENT_NAME` and the
  runner's event file (`GITHUB_EVENT_PATH`) and runs `runWake` (see "Wake" in
  `src/route/README.md`). `execution-repo` is `${{ vars.NIBFIN_EXECUTION_REPO }}`.
  `token` is read only when the event wakes an Issue, so a skipped event, such as a
  review on a fork pull request (which gets no secret), needs none.

Both commands build the run URL with Core's `runUrl` from `GITHUB_REPOSITORY` and
`GITHUB_RUN_ID`; in a reusable workflow these and the event are the caller's. They
exit 0 when they did their work (`job-failed`: added `pending` or left a standing
stop as it is; `wake`: dispatched, or skipped the event), and 1 when an input is
invalid or GitHub could not be read or written (a failed wake does so after asking a
person on its Issues); the log then has the failure's code and message, never an
input's value.

Every GitHub call goes through Core's client (`connectClient`): up to 3 retries with
Core's delays and rate-limit waits, log lines that name the call and path only. The
Action reads only its environment and GitHub, never the workspace.

## Source and bundle

- `inputs.ts` reads and checks the inputs; `run.ts` connects them to Core's modules
  and the log; `main.ts` is the entry point. The rules themselves live in their Core
  modules.
- The Action imports module files only: never the `src/stages/index.ts` or
  `src/route/index.ts` barrels, and nothing under `src/cli/`, `src/config/` or
  `src/workflows/`, whose paths are built from `import.meta.url` and point at files the
  bundle's location does not have.
- `npm run bundle:action` builds (`tsc -p tsconfig.build.json`) and bundles
  `dist/action/main.js` with `rollup` (`action/rollup.config.mjs`: ES output, Node
  resolution preferring built-ins, CommonJS for Octokit's `bottleneck`) into the single
  file `action/main.mjs`. Run it after changing anything the Action imports and commit
  the result.
- CI runs `npm run bundle:action` and fails when `action/` then differs from the
  commit, as GitHub's own `check-dist` does. `action/main.mjs` is generated output:
  ESLint and Prettier ignore it, like `dist/`.
- `image.yml` runs for every change under `action/`, so each commit that changes the
  Action has an image of that revision (R8.1). The image does not ship the Action.
