# `src/stages`

Implements the delivery stages that move an Issue from Shape to a merged pull request.
Owned by #671, #672 and #673. #671 adds the Shape stage and the harness the other
stages reuse; #672 adds the Deliver stage. #674 gives each Deliver Job the run name
`Nibfin · <owner>/<repo>#<n> · deliver`, and #673 writes the marked `review` comment
with a `Reviewed head: <sha>` line.

## Job context

`nibfin run --stage <stage> --repo <owner>/<repo> --issue <n> --provider <p>
[--model <model>] [--reason <reason>]` runs one stage for one Issue. The caller
(#674) supplies the rest of the context in the environment. `readJobContext(args,
env)` reads and checks it; a missing or invalid field is `STAGE_INPUT_INVALID` naming
the field, never its value.

| Input                 | Meaning                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `--repo`              | The repository, `<owner>/<repo>`                                  |
| `--issue`             | The Issue number                                                  |
| `--provider`          | `codex` or `claude`, from the Pool or runner configuration        |
| `--model`             | Optional agent model                                              |
| `--reason`            | Deliver only: `ci-failure`, `review` or `cd-failure`              |
| `NIBFIN_GITHUB_TOKEN` | Issues and Pull requests write, the reads in `src/github`, and    |
|                       | for Deliver: Contents write (plus the workflows permission when a |
|                       | change touches `.github/workflows/`) and Actions read on the      |
|                       | execution repository                                              |
| `NIBFIN_ACTOR_ID`     | The numeric id of the account the token writes as                 |
| `NIBFIN_ACTOR_LOGIN`  | That account's login                                              |
| `NIBFIN_AGENT_HOME`   | The agent CLI's config home on the login volume (absolute)        |
| `NIBFIN_WORKSPACE`    | A checkout of the base branch by name, without persisted creds    |
| `NIBFIN_TOOL_CACHE`   | The cache for `.nibfin.json` tools, outside the workspace         |
| `NIBFIN_RUN_REPO`     | Deliver: the execution repository (`GITHUB_REPOSITORY`)           |
| `NIBFIN_RUN_ID`       | Deliver: this Job's workflow run id (`GITHUB_RUN_ID`)             |
| `NIBFIN_NEXT_FILE`    | Optional: where the stage writes its next action (absolute,       |
|                       | outside the workspace)                                            |

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

Tests use a fake GitHub API, fake agent runs and a fake configuration; only `git`
runs for real, in repositories under the ignored `.test-tmp/`, with a local bare
repository as the remote.
