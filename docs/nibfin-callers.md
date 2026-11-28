# Nibfin's own repositories: callers and hand setup

Nibfin's own repositories run the delivery stages through workflows (#674).
`taco3064/nibfin-core` is the execution repository: every route and stage Job runs in
its `nibfin-shared-runner.yml`. `taco3064/gh-nibfin` and `taco3064/nibfin-e2e` are
peers: their events wake their Issues by dispatching to the execution repository.

- `nibfin-issue.yml` (every repository): turns an event into a route run.
- `nibfin-events.yml` (nibfin-core, reusable): one step of Core's Action
  (`command: wake`), which runs Core's event filters and the dispatch.
- `nibfin-shared-runner.yml` (nibfin-core): run titles, one concurrency group per
  Issue, calls `nibfin-job.yml`.
- `nibfin-job.yml` (nibfin-core, reusable): checkout, image, container and clean-up.
  Its route Job and its finish Job (merge a recorded review, close a delivered
  Issue, wake downstream Issues; #755) run no agent: they run on a GitHub-hosted
  runner (`ubuntu-24.04`) when the execution repository is public, and when it is
  private on the `nibfin` runners (route) or the Assignee's `nibfin-<user id>`
  runners (finish).
- `nibfin-runner-request.yml` (nibfin-core): installs `age`, then one step of Core's
  Action (`command: runner-request`) answers a collaborator's runner request Issue
  with a registration token encrypted to their SSH key.
- `nibfin-e2e-notify.yml` (every repository): asks nibfin-e2e to retest a delivered
  Issue.

nibfin-core's `nibfin-*.yml` files are rendered from `templates/workflows/` by
`npm run render:workflows` (the own execution set of `nibfin render-workflows`; see
`src/workflows/README.md`). Edit the template, not the file: `npm test` fails when a
committed file differs from its render. The same templates render the files
`gh nibfin` writes into user repositories.

Events only wake an Issue. Core reads GitHub, decides what runs (`src/route`) and
dispatches it. When a person is needed, Core adds the `pending` label with a comment;
removing `pending` is the go-ahead. On the next wake of an Issue with `pending`, the
route Job's repair stage clears what needs no person (a temporary failure, a usage
limit that resets within the Job) and leaves a marked repair record (see "Repair
stage" in `src/stages/README.md`).

## The peer caller

Each peer repository has the own channel's peer set: `.github/workflows/nibfin-issue.yml`,
which calls `taco3064/nibfin-core/.github/workflows/nibfin-events.yml@main`, and
`nibfin-e2e-notify.yml`. Render them from Core's templates instead of copying them by
hand. Pass with `--workflow` every workflow of that repository that runs on push to the
default branch and every one that produces a required check, by exact name; no
`--image` is needed:

```sh
nibfin render-workflows --set peer --channel own --default-branch <branch> \
  --workflow <name>...
```

It prints one JSON object keyed by file path (see `src/workflows/README.md`). With the
image, for example:

```sh
podman run --rm ghcr.io/taco3064/nibfin:main nibfin render-workflows --set peer \
  --channel own --default-branch main --workflow CI > peer.json
jq -j '.[".github/workflows/nibfin-issue.yml"]' peer.json > .github/workflows/nibfin-issue.yml
```

The copies gh-nibfin and nibfin-e2e hold today were written by hand before the render
existed; refresh them from it by hand.

The push trigger also gives every merge commit the `Nibfin ·` push run that CD
detection waits for, so keep it unfiltered on the default branch. The `closed` type
wakes a closed Issue, whose route deletes its `nibfin/issue-<n>` and
`nibfin/issue-<n>-cd-<k>` branches (#700); a peer whose caller predates it adds
`closed` by hand.

The `pull_request_review` (`submitted`) trigger wakes the Issue of a same-repository
`nibfin/issue-*` pull request when a reviewer with admin or write permission submits a
review, so a pull request that waits for a required approval is re-checked (#726); a
peer whose caller predates it adds that trigger and the `pull_request.head.ref` run-name
term by hand.

## Hand setup

Nothing below is done by Nibfin; the Owner does it once.

### Every repository (nibfin-core, gh-nibfin, nibfin-e2e)

- Labels: create `pending` (and `pause` where it is missing).
- Secret `NIBFIN_GITHUB_TOKEN`: the gh login token of the Nibfin account with the
  `workflow` scope. `gh auth login` does not request it, so run
  `gh auth refresh -s workflow` first, then
  `gh auth token | gh secret set NIBFIN_GITHUB_TOKEN --repo <owner>/<repo>`.
- Variable `NIBFIN_EXECUTION_REPO`: `taco3064/nibfin-core`.
- Settings: limit Issue and pull request creation to collaborators, and require
  approval of fork pull request workflows for all external contributors. The public
  execution repository's self-hosted runners hold the login volumes.
- Keep "Automatically delete head branches" off: Nibfin deletes an Issue's branches
  when the Issue closes, not when a pull request merges (#700). `gh nibfin init` must
  not enable it.
- Old-design cleanup: delete the variable `NIBFIN_SHARED_RUNNER_POOL` and the
  `NIBFIN_WAKE_*` secrets wherever they exist.

### nibfin-core only

- Variables: neither the provider nor the model is a variable. Each runner's `.env`
  sets `NIBFIN_PROVIDER` (`codex` or `claude`) and may set `NIBFIN_MODEL` for that
  runner only (without it, Core's default for the provider applies), so neither is
  ever taken from an Issue, repository text, a variable or a dispatch input; restart
  the runner after changing its `.env`. An old `NIBFIN_MODEL` repository variable is
  unused. Optional limits:
  `NIBFIN_MEMORY` (default `3g`, also the memory check before the first agent run),
  `NIBFIN_MEMORY_HIGH` (default `2560m`, an integer with optional K/M/G; above it
  the kernel throttles and reclaims instead of killing), `NIBFIN_PIDS_LIMIT`
  (default `4096`), `NIBFIN_CPUS` (default `4`) and `NIBFIN_CONTAINER_LIMITS`.
  Set `NIBFIN_CONTAINER_LIMITS` to exactly `off` to start the stage container without
  `--pids-limit`, `--memory`, `--cpus` and `--cgroup-conf memory.high`; unset or any
  other value keeps them. With limits off, `NIBFIN_MEMORY` still sets the memory check
  threshold (default `3g`), and `NIBFIN_MEMORY_HIGH`, `NIBFIN_PIDS_LIMIT` and
  `NIBFIN_CPUS` have no effect.
- The image package `ghcr.io/taco3064/nibfin` is public (see the README). Jobs pull
  `:main`, which the Image workflow moves forward after each build on `main`.

### gh-nibfin and nibfin-e2e

- Delete gh-nibfin's `nibfin-wake.yml`, and nibfin-e2e's `nibfin-release.yml` and
  `runner-admission-verification.yml`.
- Replace the disabled `nibfin-issue.yml` with the rendered one above, then enable it:
  `gh workflow enable nibfin-issue.yml --repo <owner>/<repo>`.

### Runners (Linux, inside the `podman machine` VM on the Windows host)

- The VM needs only Podman, git 2.18 or later (for `actions/checkout`) and the
  GitHub Actions runner. A personal account's runner serves one repository, so the
  runners register with `taco3064/nibfin-core`.
- Two runners. Labels: `nibfin` for route runs (used only while the execution
  repository is private), and `nibfin-<user id>` for the stage
  runs of Issues whose Assignee has that user id (`gh api users/<login> --jq .id`).
  Each runner's `.env` sets `NIBFIN_PROVIDER=<provider>`; restart the runner after
  changing it. Of one member's runners of two providers, whichever takes the Job
  first runs it. An Issue may have several Assignees. For each stage, route goes
  through them in GitHub's order and dispatches to the first whose label
  `nibfin-<user id>` (compared case-insensitively) is on an online runner of the
  execution repository (a busy runner counts as online); otherwise to the first with
  any such runner, where the Job queues until one comes online (#739). When no
  Assignee has one, the Issue is an ordinary assignment and nothing is dispatched,
  labelled or commented. A run already queued or running keeps its runner; a
  reassignment takes effect at the next dispatch.
  An Issue assigned to a collaborator (anyone but the execution repository's owner)
  first gets `pause` and a comment asking them to read it and remove `pause`, once per
  collaborator (#721); removing `pause` starts the stage.
- Run each runner as a service in a lingering systemd user session
  (`loginctl enable-linger <user>`). With the container limits on (the default),
  delegate the cgroup v2 `cpu`, `memory` and `pids` controllers to the user, so
  rootless Podman can apply them.
- A WSL-based `podman machine` cannot apply per-container limits: cap the VM's memory
  in `.wslconfig` on the Windows host and set `NIBFIN_CONTAINER_LIMITS=off` in
  nibfin-core. The cap is for the whole VM and must leave more than `NIBFIN_MEMORY`
  available inside it, or every stage run ends in `pending`
  (`STAGE_HOST_MEMORY_LOW`).
- Create the two volumes and log in once with the same user namespace the Jobs use:

  ```sh
  podman volume create nibfin-home-<provider>
  podman volume create nibfin-tools
  podman run --rm -it --userns=keep-id:uid=1000,gid=1000 \
    --volume nibfin-home-<provider>:/nibfin/home \
    --env CLAUDE_CONFIG_DIR=/nibfin/home --env CODEX_HOME=/nibfin/home \
    ghcr.io/taco3064/nibfin:main sh
  ```

  Inside, log the provider's CLI in (`claude`, then `/login`; or `codex login`); its
  config home is `/nibfin/home`, the Jobs' `NIBFIN_AGENT_HOME`. The login
  and tool-cache volumes stay between Jobs; each Job removes its checkout, its
  output directory and older local Nibfin images.

### After the rollout

- Close by hand any Issue that was merged before `nibfin-issue.yml` existed: its
  merge commit has no `Nibfin ·` push run, so it stays `awaiting-cd`.
- Core's own workflow files are rendered and change only with the templates; like any
  `.github/workflows/` change, such an edit is delivered by hand.
- The workflows run `@main` and the image `:main`. After a merge that changes the
  CLI or the templates they can differ until the Image workflow finishes. A failure
  in that window that Core can see sets `pending`. A Job that fails before Core can
  report (checkout, image pull or start, an option the older CLI lacks, or the very
  first rollout before `:main` exists) ends with Core's Action
  (`taco3064/nibfin-core/action@main`, command `job-failed`): it adds `pending` with
  the code `JOB_FAILED` unless Core already reported for the Issue (see "Pending" in
  `src/stages/README.md`). Only what that step cannot do (the Action cannot be
  fetched, the token is invalid, the `pending` write fails, the run has no Issue)
  leaves just a failed Actions run, which GitHub notifies the owner about.
