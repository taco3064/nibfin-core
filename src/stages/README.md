# `src/stages`

Implements the delivery stages that move an Issue from Shape to a merged pull request.
Owned by #671, #672 and #673. #671 adds the Shape stage and the harness the other
stages reuse; #672 adds the Deliver stage; #673 adds the review stage, which reviews,
merges, follows CD and closes the Issue. #674 gives each Deliver Job the run name
`Nibfin · <owner>/<repo>#<n> · deliver`.

## Job context

`nibfin run --stage <stage> --repo <owner>/<repo> --issue <n> --provider <p>
[--model <model>] [--reason <reason>]` runs one stage for one Issue. The caller
(#674) supplies the rest of the context in the environment. `readJobContext(args,
env)` reads and checks it; a missing or invalid field is `STAGE_INPUT_INVALID` naming
the field, never its value.

| Input                 | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `--repo`              | The repository, `<owner>/<repo>`                               |
| `--issue`             | The Issue number                                               |
| `--provider`          | `codex` or `claude`, from the Pool or runner configuration     |
| `--model`             | Optional agent model                                           |
| `--reason`            | Deliver only: `ci-failure`, `review` or `cd-failure`           |
| `NIBFIN_GITHUB_TOKEN` | Issues and Pull requests write, the reads in `src/github`;     |
|                       | Deliver: Contents write (plus the workflows permission when    |
|                       | a change touches `.github/workflows/`) and Actions read on     |
|                       | the execution repository; review: Pull requests and Contents   |
|                       | write (plus the workflows permission when the PR changes       |
|                       | `.github/workflows/`), Actions read, and Issues and Pull       |
|                       | requests read on the repositories of downstream Issues         |
| `NIBFIN_ACTOR_ID`     | The numeric id of the account the token writes as              |
| `NIBFIN_ACTOR_LOGIN`  | That account's login                                           |
| `NIBFIN_AGENT_HOME`   | The agent CLI's config home on the login volume (absolute)     |
| `NIBFIN_WORKSPACE`    | A checkout of the base branch by name, without persisted creds |
| `NIBFIN_TOOL_CACHE`   | The cache for `.nibfin.json` tools, outside the workspace      |
| `NIBFIN_RUN_REPO`     | Deliver: the execution repository (`GITHUB_REPOSITORY`)        |
| `NIBFIN_RUN_ID`       | Deliver: this Job's workflow run id (`GITHUB_RUN_ID`)          |
| `NIBFIN_NEXT_FILE`    | Optional: where the stage writes its next action (absolute,    |
|                       | outside the workspace)                                         |

The provider never comes from a workflow or dispatch input. The token is never an
admin or dispatch credential; it is used only for the GitHub client and Core's own
Git remote calls, and is never printed or passed to an agent, whose environment is
the allowlist in `src/agent`. Unknown
stages and malformed options print the usage and exit 1. Any other failure prints its
code and message and exits 1.

## Harness

- `prepareStageJob(context, client, deps)` reads `.nibfin.json` before any role runs
  (a `ConfigError` rejects the Job with its code and cause) and installs its tools
  once per Job with `prepareTools`.
- `runStageAgent(job, role, sections)` resolves the role's skill text
  (`resolveRoleSkill`), composes the prompt (`composePrompt`: the skill, "Your role is
  …", the titled input sections and the role's result format) and runs `runAgent`
  with the tools as `pathEntries`. Each call is a separate agent run.
- **Read-only roles.** Right before the CLI starts (after rulesync has generated its
  files, through `runAgent`'s `beforeStart`), the stage records `HEAD` and
  `git status --porcelain --ignored --untracked-files=all`. That listing may hold only
  ignored files (`!!`). After the run, `HEAD` and the listing must be exactly the
  same, so a file written to or removed from a `.gitignore` or `info/exclude` path
  is caught too. Otherwise the run fails with `STAGE_WORKSPACE_MODIFIED`, listing
  added (`+`) and removed (`-`) entries. A changed ignored file that keeps its path
  is not detected.
- **Login.** On `AGENT_LOGIN_REQUIRED` the stage writes the marked `agent-login`
  comment on the Issue with the re-login command, then rethrows. The next successful
  agent run updates that comment to say it is resolved.
- **Results.** `parseAgentResult(finalMessage, outcomes)` reads the last fenced block
  whose opening line is exactly ` ```nibfin-result ` and closing line exactly
  ` ``` `. It must hold a JSON object with an `outcome` from `outcomes`; anything else
  is `STAGE_RESULT_INVALID` with the agent's final message. Each stage checks the
  other fields of its roles' results.

## Shape stage

`runShapeStage(context, client, deps?)`:

1. Reads the snapshot. When `deriveStage` is not `shape`, it logs the actual stage
   and exits 0, so a run after publication does nothing.
2. Reads the sources: the Issue's title, body and URL, and for each Blocked by Issue
   its URL, title, body and marked `shape` comment. An upstream Issue in another
   repository is flagged: its source is not in the workspace, so the Author reports a
   gap instead of guessing.
3. With an existing marked `shape` comment (and no `shaped`) the Validator checks it
   first; otherwise the Shape Author proposes one.
4. The Shape Validator runs separately with only the sources and the proposed Shape.
   `changes-required` sends its findings and the previous Shape to the Author for a
   revision and a fresh validation, without a round limit; each round is logged.
5. Before publishing, the stage reads the snapshot and the sources again. If the
   Issue is no longer at the Shape stage (paused, closed, …) it stops without
   publishing. If the Issue's title or body changed, a fresh validation runs against
   the new text.
6. It writes the marked `shape` comment (an unchanged body is not rewritten), checks
   the read-back body, adds `shaped`, checks the read-back labels and marks an earlier
   `shape-blocked` comment resolved. A failed read-back is
   `GITHUB_WRITE_UNCONFIRMED`.

Results:

- Author: `{ outcome: "ready", shape }` or `{ outcome: "blocked", reason }`.
- Validator: `{ outcome: "approved" }`, `{ outcome: "changes-required", findings }`
  or `{ outcome: "blocked", reason }`.

`shape`, `reason` and each finding are non-empty strings; `findings` is a non-empty
list; `shape` must not start with `<!-- nibfin:`. A `blocked` result from either role
writes the marked `shape-blocked` comment with the reason and stops with
`STAGE_BLOCKED`. The prompt tells both roles that `shape` and `reason` are posted as
written, so they follow the skill's Disclosure rules.

## Deliver stage

`runDeliverStage(context, client, deps?)`:

1. **Eligibility.** The snapshot must fit the reason: none → `deliver`;
   `ci-failure` → `ci-failed`; `review` → `review` with the actor's marked `review`
   comment on the PR whose `Reviewed head: <sha>` line equals the PR head;
   `cd-failure` → `cd-failed` (work on `nextFixBranch`), or `deliver` on a fix branch
   (a redo). Otherwise it logs the stage and exits 0.
2. **Writer check.** It lists the in-progress workflow runs of `NIBFIN_RUN_REPO`
   (every workflow and page) other than `NIBFIN_RUN_ID`. Another run named
   `Nibfin · <owner>/<repo>#<n> · deliver` (run name or workflow name) is
   `STAGE_WRITER_ACTIVE`: Pending, nothing written. GitHub offers no query for a
   concurrency holder.
3. **Branch.** The base is the workspace's checked-out branch. Core fetches it and the
   Issue branch (unshallowing a shallow checkout), checks out the pushed branch or
   creates it from `origin/<base>`, and sets the local commit identity to the actor
   (`<id>+<login>@users.noreply.github.com`).
4. **Writer** (writable, `deliver` skill) with the Issue, the approved Shape, the
   branch rules and, for a fix run, the fix context. `blocked` writes the marked
   `deliver-blocked` comment and stops with `STAGE_BLOCKED` (after the final push
   below). A `done` Writer must leave the branch checked out, no uncommitted changes
   and commits ahead of `origin/<base>`.
5. **Closing keywords.** A commit ahead of the base whose message would close this
   Issue (`Closes #n`, `fixes owner/repo#n`, the Issue URL, …) goes back to the
   Writer as a defect; the PR body is `Part of #<n>`.
6. **Accept** (read-only, `accept` skill, a fresh run each time) with the Issue, the
   Shape, the local diff against `origin/<base>` and the fix context, never the
   Writer's output. `defects` go to the Writer, then a fresh Acceptor; there is no
   round limit. `blocked` writes `deliver-blocked` and stops.
7. **PR.** After a pass it re-checks eligibility, pushes what is pending and opens the
   PR (`<Issue title> (#<n>)`), or reuses the branch's open one, and marks an earlier
   `deliver-blocked` comment resolved.

Fix context: `ci-failure` lists the failed required checks with URLs and, for a
GitHub Actions check run (app `github-actions`, whose check-run id is the job id),
the last 200 lines of the job log; other checks and statuses get their URL only.
`review` gives the review comment. `cd-failure` lists the failed CD runs of the
newest merged PR whose CD failed, with the log tails of their failed jobs
(`filter=latest`). Log text is redacted of the token.

### Pushes

Core pushes; the agent has no credentials. Core talks to GitHub only from its own
bare repository, created for the run outside the workspace (`mkdtemp` under the
system temp directory) without a template and removed when the run ends. It fetches
the base and the Issue branch from GitHub into that repository, and the workspace
fetches them from there. Before each push it fetches the branch from the workspace
into its repository (without the token) and pushes from there to the explicit
`https://github.com/<owner>/<repo>.git` URL. So the workspace's `.git/config`
(`url.*.insteadOf`, `pushInsteadOf`, `http.proxy`, `http.sslVerify`, hooks, …),
which the Writer can change, never applies to an authenticated command.

Each remote call (`ls-remote`, `fetch`, `push`) gets the header
`AUTHORIZATION: basic <x-access-token:token>` through `GIT_CONFIG_COUNT=1`,
`GIT_CONFIG_KEY_0=http.https://github.com/.extraheader` and `GIT_CONFIG_VALUE_0` in
that one child's environment, never in arguments or a config file. Commands in
Core's repository ignore the global and system config (`GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`) and run without hooks (`core.hooksPath=/dev/null`,
`--no-verify`), credential helpers, askpass programs or push signing, with only the
remote URL's protocol allowed (`GIT_ALLOW_PROTOCOL`). Git output is redacted of the
token and the header.

- **Lease.** Every push is `--force-with-lease=refs/heads/<branch>:<expected>`, where
  `<expected>` is the last head Core pushed, or the head fetched before the first
  push; empty (the branch must not exist) while it was never pushed. A rejected
  lease is `STAGE_PUSH_REJECTED` and is never retried as an overwrite; so is any
  other rejection, with a named cause for a missing workflows permission.
- **Nothing ahead.** A head without commits ahead of `origin/<base>` is never
  pushed, so a Writer that returns without commits leaves no remote branch.
- **Order.** Pushes run one at a time; requests during a push collapse into one
  follow-up push of the then current head. Right before each push Core re-reads the
  snapshot; when the Issue is no longer eligible for this reason and branch (paused,
  closed, …) it stops pushing, writes nothing more and exits 0.
- **Branch without an open PR** (no reason, `cd-failure`): while the Writer runs,
  `fs.watch` on the directory of the branch's loose ref (`git rev-parse --git-path
refs/heads/<dir>`) triggers a push whenever `refs/heads/<branch>` changed. The
  watch is re-armed after an error or when the directory was replaced (Linux
  watches the inode). With the reftable ref backend there is no loose ref, so the
  run logs that progress is saved by the final push only. Core pushes once more when
  the Writer returns, also when it is blocked or its run failed.
- **Branch with an open PR** (`ci-failure`, `review`): Core pushes only after Accept
  passes.

### Next action

With `NIBFIN_NEXT_FILE` set, the stage writes `{ "stage": …, "reason": … }` there for
#673 and #674: `{ "stage": "review", "reason": null }` when the snapshot after the PR
derives `review`, and both `null` when the run ends ineligible, blocked, Pending, or
waiting for CI events.

Results:

- Writer: `{ outcome: "done" }` or `{ outcome: "blocked", reason }`.
- Acceptor: `{ outcome: "pass" }`, `{ outcome: "defects", defects }` or
  `{ outcome: "blocked", reason }`.

## Review stage

`runReviewStage(context, client, deps?)` acts on the derived stage:

| Derived stage                       | Action                                    |
| ----------------------------------- | ----------------------------------------- |
| `review`                            | Review the pinned head; send problems     |
|                                     | back or merge (below)                     |
| `awaiting-cd`                       | Log the reason; next action none          |
| `cd-failed`                         | Next `{ "deliver", "cd-failure" }`        |
| `done`                              | Closing comment, `delivered`, close, wake |
| Closed, `delivered` and the actor's | Wake only (a redo after a crash)          |
| `delivered` comment                 |                                           |
| Anything else                       | Log the stage; next action none           |

### Review

1. **Pin.** The head `H` of the open PR is pinned. If the actor's marked `review`
   comment on the PR already records `H` (`Reviewed head: H`), the run asks for the
   `review` fix again without reviewing.
2. **Checkout.** Core fetches `H` (by SHA) and the base into its own bare repository
   outside the workspace, with the token in that one child's environment as for
   Deliver's pushes, brings both into the workspace and checks `H` out detached.
3. **Reviewer** (read-only, `shape` skill, role `PR review`, a fresh run) gets the
   current Issue, the approved Shape, where to read the product authority (the base
   branch's version, since the PR may change it), the PR diff against the merge base
   with `origin/<base>`, and the required checks and results for `H`. Nothing else;
   never the token. Its `reviewedHead` must be `H`, else `STAGE_RESULT_INVALID`.
4. **Re-read.** When the Issue is no longer at `review` on the same PR at `H`, the run
   stops without writing.
5. **Verdict.** `problems` writes the marked `review` comment on the PR
   (`Reviewed head: H`, then the problems as written) and asks for the `review` fix.
   `blocked` writes the marked `review-blocked` comment on the Issue and stops with
   `STAGE_BLOCKED`. `clean` goes to the merge. A clean result never writes a `review`
   comment.

### Merge

GitHub enforces the repository's own rules; Core imposes nothing the repository does
not configure.

1. Re-reads the snapshot: the Issue must still derive `review` on the same PR at `H`
   (so `pause`, closing and new pushes stop the merge).
2. Reads the PR: it must be open at `H`. `mergeable: null` or `mergeable_state:
unknown` stops with no next action (GitHub is still computing).
   `behind` or `dirty` writes the `review` comment "Rebase onto `<base>` and resolve
   conflicts: …" for `H` and asks for the `review` fix. `blocked` writes
   `review-blocked` naming the readable unmet ruleset requirements (approvals against
   the current count, code owner review, last push approval, resolved threads), or
   saying that classic protection is not readable.
3. Chooses the first of rebase, squash and merge commit that the repository settings
   and every applying ruleset `pull_request` rule allow (no merge commit under
   `required_linear_history`). No method, or an unknown setting, is `review-blocked`.
4. Merges with `sha: H`. `head-changed` (409, or a 405 saying the head was modified)
   stops with no next action. A 405 saying the base moved, the PR is not mergeable,
   out of date or conflicting goes back to Deliver as a rebase. A rejection naming the
   workflows permission is `review-blocked` naming it; any other 405 is
   `review-blocked` with GitHub's message, any other 4xx `GITHUB_WRITE_REJECTED`. An
   unknown outcome re-reads the PR once and otherwise stays Pending
   (`GITHUB_WRITE_UNCONFIRMED`); it is never retried blindly.
5. After the merge the next action is none: CD events continue the Issue.

### Closing

At `done` the stage writes the marked `delivered` comment on the Issue, built only
from GitHub data:

- every pull request of the Issue's branches, with its merge commit;
- for each merged PR, the base's current required checks and their results on its
  head;
- the CD runs of each merge, with conclusions and URLs;
- counts: CD-fix PRs (`-cd-<k>` branches), CI-fix rounds (distinct commits of the
  PRs, as GitHub lists them now, with a failed required check; heads removed by a
  force push are not counted) and review rounds (the versions of each PR's marked
  `review` comment from `userContentEdits`, 0 without one).

Then it re-reads the snapshot and closes only when the Issue still derives `done`
with the same CD run ids and conclusions; otherwise (a late run, `pause`, …) it stops
with no next action and the next run rewrites the comment. `closeDelivered` adds
`delivered` and closes the Issue as completed.

### Wake

The stage reads the Issues this Issue blocks (any repository). Each one whose
snapshot derives `shape` or a delivery stage goes into `wake`; every other one is
logged with its reason (`blocked by <remaining blockers>`, `no-assignee`, `paused`,
`closed`, or unreadable with the read error) and is never woken.

### Next action

`{ "stage": "deliver" | "review" | null, "reason": …, "wake"?: [{ "repo":
"<owner>/<repo>", "issue": <n> }] }`: `{ "deliver", "review" }` after problems or a
rebase request, `{ "deliver", "cd-failure" }` at `cd-failed`, `wake` after the close
(also on the redo), and `null` otherwise, including every failure.

Result: `{ outcome: "clean" | "problems" | "blocked", reviewedHead, problems?,
reason? }`; `problems` is a non-empty list of non-empty strings, `reason` a non-empty
string.

Tests use a fake GitHub API, fake agent runs and a fake configuration; only `git`
runs for real, in repositories under the ignored `.test-tmp/`, with a local bare
repository as the remote.
