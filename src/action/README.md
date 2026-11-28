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
- `runner-request` (inputs `token`, `job-token`): the step of
  `nibfin-runner-request.yml`, after its "Install age" step (also when that failed).
  It reads the request Issue (number, title, body, author login and type) from the
  `issues` event file and runs `answerRequest` (`src/runner-request/answer.ts`):
  - a body without `<!-- nibfin:runner-request -->` is not a request (the job's `if:`
    is only a cost filter), and a request that is no longer open is not answered;
  - the checks of `checkRequest` (title, author type `User`, exactly one
    `ssh-key-id: <id>` with `<id>` matching `[1-9][0-9]{0,18}`, at most one
    `deploy-key: ssh-ed25519 <base64>` in the ssh-ed25519 wire format), the author's
    write or admin permission (`readCollaboratorPermission`, refused as "`<login>` has
    `<permission>` permission on `<repo>`, not write or admin") and the SSH key the
    request names (refused when the account has no such key, or one that is not
    ssh-ed25519 or ssh-rsa) decide a refusal, with today's texts;
  - otherwise `age --version` runs before any write; then the optional deploy key is
    added read-only as `nibfin-runner-<login>`, and a registration token is created,
    masked (`::add-mask::`) before anything else is printed, and encrypted with
    `age -a -R <file>` (the requester's key in a file of a fresh temporary directory,
    removed afterwards) to the answer `<!-- nibfin:runner-registration -->`;
  - a refusal is answered as `<!-- nibfin:runner-request-refused -->` and closes the
    Issue as not planned; so does any failure, as "the request workflow failed
    (`<run URL>`)", after which the command exits 1.

  The answer is written by a client for `job-token` that writes as
  `github-actions[bot]` (`connectAs`), the only author gh-nibfin's `runner add`
  accepts: it reads the state, lists the comments, writes the answer and closes over
  REST Issues endpoints only (`readIssueState`, `upsertMarkedComment` with
  `"pull-request"`, `closeIssueNotPlanned`), so `permissions: issues: write` is
  enough. The `token` client (Nibfin's) is connected only once the body checks
  passed; it reads the permission, adds the deploy key and creates the token. `age`
  runs with only `PATH` in its environment, so no `INPUT_*` token reaches it.

- `repository-dispatch` (inputs `token`, `repository`, `event-type`, `payload`): the
  step of `nibfin-e2e-notify.yml`. It sends the `repository_dispatch` event
  `event-type` to `repository` (`<owner>/<repo>`) with `payload`, a JSON object, as
  its `client_payload` (`dispatchRepository` in `src/github/workflow-dispatch.ts`).
  The target, the event type and the payload come from the workflow, so Core's code
  names no repository of Nibfin's own (R8.23). The log names the event and the
  repository, never the payload.

`job-failed`, `wake` and `runner-request` build the run URL with Core's `runUrl` from
`GITHUB_REPOSITORY` and `GITHUB_RUN_ID`; in a reusable workflow these and the event
are the caller's. Every command exits 0 when it did its work (`job-failed`: added
`pending` or left a standing stop as it is; `wake`: dispatched, or skipped the event;
`runner-request`: answered, refused, or found nothing to answer;
`repository-dispatch`: sent the event), and 1 when an input is invalid or GitHub could
not be read or written (a failed wake does so after asking a person on its Issues, a
failed runner request after answering that it failed); the log then has the
failure's code and message, never an input's value.

Every GitHub call goes through Core's client (`connectClient`, or `connectAs` for the
job token): up to 3 retries with Core's delays and rate-limit waits, log lines that
name the call and path only. The Action reads only its environment, the runner's
event file and GitHub, never the workspace; the runner request writes only the
recipient file `age` reads, in the system's temporary directory.

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
  ESLint ignores it, like `dist/`.
- `image.yml` runs for every change under `action/`, so each commit that changes the
  Action has an image of that revision (R8.1). The image does not ship the Action.
