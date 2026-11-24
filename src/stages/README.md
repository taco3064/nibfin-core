# `src/stages`

Implements the delivery stages that move an Issue from Shape to a merged pull request.
Owned by #671, #672 and #673. #671 adds the Shape stage and the harness the other
stages reuse; #672 adds the Deliver stage; #673 adds the review stage, which reviews,
merges, follows CD and closes the Issue. #674 runs the stages from workflows (see
`src/route`), gives each Deliver Job the run name
`Nibfin · <owner>/<repo>#<n> · deliver`, and adds `pending`, `progressed` and the
memory check. #686 returns an Issue to the Shape stage when
the Deliver Writer finds the approved Shape wrong (see Shape reported wrong).

## Job context

`nibfin run --stage <stage> --repo <owner>/<repo> --issue <n> --provider <p>
[--model <model>] [--reason <reason>]` runs one stage for one Issue. The caller
(#674) supplies the rest of the context in the environment. `readJobContext(args,
env)` reads and checks it; a missing or invalid field is `STAGE_INPUT_INVALID` naming
the field, never its value.

| Input                    | Meaning                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `--repo`                 | The repository, `<owner>/<repo>`                            |
| `--issue`                | The Issue number                                            |
| `--provider`             | `codex` or `claude`, from the Pool or runner configuration  |
| `--model`                | Optional agent model                                        |
| `--reason`               | Deliver only: `ci-failure`, `review` or `cd-failure`        |
| `NIBFIN_GITHUB_TOKEN`    | Issues and Pull requests write, the reads in `src/github`;  |
|                          | Deliver: Contents write (plus the workflows permission when |
|                          | a change touches `.github/workflows/`) and Actions read on  |
|                          | the execution repository; review: Pull requests and         |
|                          | Contents write (plus the workflows permission when the PR   |
|                          | changes `.github/workflows/`), Actions read, and on the     |
|                          | repositories of downstream Issues every read of the         |
|                          | snapshot: Metadata, Contents, Issues, Pull requests,        |
|                          | Checks, Commit statuses and Actions read (a downstream it   |
|                          | cannot read is never woken); dispatching on the execution   |
|                          | repository (#674)                                           |
| `NIBFIN_AGENT_HOME`      | The agent CLI's config home on the login volume (absolute)  |
| `NIBFIN_WORKSPACE`       | A checkout of the base branch by name, without persisted    |
|                          | credentials                                                 |
| `NIBFIN_TOOL_CACHE`      | The cache for `.nibfin.json` tools, outside the workspace   |
| `NIBFIN_RUN_REPO`        | The execution repository (`GITHUB_REPOSITORY`): Deliver's   |
|                          | Writer check, the run URL of `pending`, and where Core      |
|                          | dispatches what runs next                                   |
| `NIBFIN_RUN_ID`          | This Job's workflow run id (`GITHUB_RUN_ID`)                |
| `NIBFIN_NEXT_FILE`       | Optional: where the stage writes its next action (absolute, |
|                          | outside the workspace); read by the same `nibfin run` after |
|                          | the stage                                                   |
| `NIBFIN_MEMORY_REQUIRED` | Optional: memory the host must have available before the    |
|                          | first agent run (`3g`, Podman units), the container's       |
|                          | `--memory`; unset means no check                            |

The actor (the account the token writes as, for marked comments and the commit
identity) is read once with `GET /user`. The provider never comes from a workflow or
dispatch input. The token is the gh login token of the Nibfin account (Owner
decision A, scopes `repo` and `workflow`): its writes start workflow runs like the
user's, so events only wake an Issue and Core decides the stage. It is used only for
the GitHub client and Core's own Git remote calls, reaches the container only as
`--env NIBFIN_GITHUB_TOKEN`, and is never printed or passed to an agent, whose
environment, arguments and prompt are the allowlist in `src/agent`. The agent runs as
the same uid in the same container and could read Core's process environment;
decision A accepts this as equal to a local agent running `gh auth token`. Unknown
stages and malformed options print the usage and exit 1. Any other failure prints its
code and message, sets `pending` (see Pending) and exits 1.

## Pending

`requestPerson(client, issue, error, runUrl)` asks a person to act: it upserts the
marked `pending` Issue comment (the code and message, the run URL, the note "this
looks temporary (network, GitHub or a single agent run); removing the label retries
it" for `GITHUB_READ_FAILED`, `GITHUB_WRITE_UNCONFIRMED`, `STAGE_GIT_FAILED`,
`TOOL_INSTALL_FAILED`, `AGENT_RUN_FAILED` and `STAGE_RESULT_INVALID`, and "Remove the
`pending` label to continue") and adds `pending`, confirmed by the read-back labels.
When GitHub rejects that comment (`GITHUB_WRITE_REJECTED`, e.g. a message listing
thousands of paths), it writes it once more as the same body with only the fenced
message block replaced by "The full message is in the run log.", then adds `pending`
as usual; no size limit applies. The full message always goes to the Job log.
`nibfin run` and `nibfin route` call it on every failure once the Issue is known,
whatever the code, except `STAGE_WRITER_ACTIVE` (a wait: another Writer runs and its
own post-stage route continues the Issue). The no-progress stop (`STAGE_NO_PROGRESS`,
see `src/route`) takes the same path. The stage-specific comments stay as they are.
While `pending` is present the Issue derives `ineligible (pending)` and nothing runs;
removing it resumes from GitHub state.

## Harness

- `prepareStageJob(context, client, deps)` runs right before a stage's first agent
  run. It compares `MemAvailable` of `/proc/meminfo` with `NIBFIN_MEMORY_REQUIRED`
  (below it: `STAGE_HOST_MEMORY_LOW`), reads `.nibfin.json` (a `ConfigError` rejects
  the Job with its code and cause) and installs its tools once per Job with
  `prepareTools`.
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
- **Progress.** Every exit of every stage that writes a next action also writes
  `progressed` (#674): `true` when the run wrote to GitHub (any request of its client
  other than a GET or a GraphQL query: comment, label, PR, merge, close), pushed, or
  re-read a PR head or stage other than the one it started with; `false` otherwise
  (ineligible start, nothing to do, wake-only redo, mergeability unknown, an unchanged
  comment that was not rewritten). Core uses it after the stage (see `src/route`).
- **Results.** `parseAgentResult(finalMessage, outcomes)` reads the last fenced block
  whose opening line is exactly ` ```nibfin-result ` and closing line exactly
  ` ``` `. It must hold a JSON object with an `outcome` from `outcomes`; anything else
  is `STAGE_RESULT_INVALID` with the agent's final message. Each stage checks the
  other fields of its roles' results.

## Shape stage

`runShapeStage(context, client, deps?)`:

1. Reads the snapshot. When `deriveStage` is not `shape`, it logs the actual stage
   and exits 0 without running a role, so a run after publication does nothing (at
   a delivery stage it may still name a next action, see Shape reported wrong).
2. Reads the sources: the Issue's title, body and URL, and for each Blocked by Issue
   its URL, title, body and marked `shape` comment. An upstream Issue in another
   repository is flagged: its source is not in the workspace, so the Author reports a
   gap instead of guessing.
3. With a pending `shape-wrong` report the existing Shape is not validated: the
   Author rewrites it ("Rewrite the Shape: the previous one was found wrong") from
   the "Previous Shape" and "Why the previous Shape is wrong". Otherwise, with an
   existing marked `shape` comment (and no `shaped`) the Validator checks it first;
   else the Shape Author proposes one.
4. The Shape Validator runs separately with only the sources and the proposed Shape,
   plus the reason while a `shape-wrong` report is active (then it also checks that
   the Shape resolves it). In a revision round it also gets the previous proposed
   Shape and the previous Validator findings, so it can compare the versions; the
   first round is unchanged. It never sees the Author's reasoning.
   `changes-required` sends its findings and the previous Shape (and an active
   reason) to the Author for a revision and a fresh validation, without a round
   limit; each round is logged.
5. Before publishing, the stage reads the snapshot and the sources again. If the
   Issue is no longer at the Shape stage (paused, closed, …) it stops without
   publishing. If the Issue's title or body changed, a fresh validation runs against
   the new text.
6. It writes the marked `shape` comment (an unchanged body is not rewritten) and
   confirms it with one read of its body and Shape version: when the body changed,
   the version must have changed too. It then rewrites an active `shape-wrong`
   report as resolved, adds `shaped`, checks the read-back labels and marks an
   earlier `shape-blocked` comment resolved. A failed read-back is
   `GITHUB_WRITE_UNCONFIRMED`.
7. **Next action.** After a rewrite (this run resolved a `shape-wrong` report) it
   re-reads the snapshot and writes `shapeNextAction` of the derived stage; every
   other exit, including a first Shape and every failure, writes none.

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

1. **Eligibility.** First, at any delivery stage (any or no reason) with a pending
   `shape-wrong` report, no Writer runs: it removes `shaped`, confirms it and asks
   for the Shape stage (a redo after a crash between the report and the label).
   Then the snapshot must fit the reason: none → `deliver`; `ci-failure` →
   `ci-failed`; `review` → `review` with the actor's marked `review` comment on the
   PR whose `Reviewed head: <sha>` line equals the PR head and whose
   `Reviewed Shape: <v>` line equals the current Shape version; `cd-failure` →
   `cd-failed` (work on `nextFixBranch`), or `deliver` on a fix branch (a redo).
   Otherwise it logs the stage and exits 0.
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
   and commits ahead of `origin/<base>`. `shape-wrong` (the Shape conflicts with the
   current Issue or product authority) gets the same final push as `blocked`
   (none with an open PR), then a re-check: when the Issue is still eligible it
   writes the marked `shape-wrong` report for the Shape version the Writer was given,
   removes `shaped`, confirms it and asks for the Shape stage; otherwise it stops
   without writing. No Acceptor runs.
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

With `NIBFIN_NEXT_FILE` set, the stage writes `{ "stage": …, "reason": …,
"progressed": … }` there for #673 and #674 (a push counts as progress):
`{ "stage": "review", "reason": null }` when the snapshot after the PR
derives `review`; `{ "stage": "shape", "reason": null }` after a Writer
`shape-wrong`, on the redo that removes `shaped` for a pending report (any reason),
and on an ineligible start at `shape` with an unresolved `shape-wrong` report (a
redo after a crash before the next action); `{ "stage": "review", "reason": null }`
when the run ends ineligible (at start or at any re-check, including the one after
`shape-wrong`) at `review` with a review comment for the current head whose
`Reviewed Shape` is missing or not current (no CI event follows); and both `null`
when the run ends ineligible otherwise, blocked, Pending, or waiting for CI events.

Results:

- Writer: `{ outcome: "done" }`, `{ outcome: "shape-wrong", reason }` or
  `{ outcome: "blocked", reason }`; `reason` is a non-empty string.
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

1. **Pin.** With a pending `shape-wrong` report the run neither reviews nor merges:
   next `{ "deliver", null }`, whose start removes `shaped`. Otherwise the head `H`
   of the open PR is pinned, and the PR is read once (`GET /pulls/{n}`), which starts
   GitHub's mergeability computation early so the merge after the review usually
   finds it done (#674). If the actor's marked `review` comment on the PR
   already records `H` (`Reviewed head: H`) and the current Shape version
   (`Reviewed Shape: <v>`, read here), the run asks for the `review` fix again
   without reviewing; a comment without a current `Reviewed Shape` line is stale and
   the head is reviewed again.
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
   (`Reviewed head: H`, `Reviewed Shape: <v>` with the version read together with
   the Shape text the reviewer got, then the problems as written) and asks for the
   `review` fix. Its body changes whenever the version does.
   `blocked` writes the marked `review-blocked` comment on the Issue and stops with
   `STAGE_BLOCKED`. `clean` goes to the merge. A clean result never writes a `review`
   comment.

### Merge

GitHub enforces the repository's own rules; Core imposes nothing the repository does
not configure.

1. Re-reads the snapshot: the Issue must still derive `review` on the same PR at `H`
   (so `pause`, closing and new pushes stop the merge). A pending `shape-wrong`
   report stops it with next `{ "deliver", null }`; nothing is merged or written.
2. Reads the PR: it must be open at `H`. `mergeable: null` or `mergeable_state:
unknown` stops with no next action (GitHub is still computing).
   `behind` or `dirty` writes the `review` comment "Rebase onto `<base>` and resolve
   conflicts: …" for `H` and the reviewed Shape version, and asks for the `review`
   fix. `blocked` writes
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
- counts: CD-fix PRs (`-cd-<k>` branches), CI-fix rounds (distinct commits with a
  failed required check among each PR's current commits and the commits of every
  head it had right before a force push, such as a rebase; a replaced head GitHub
  no longer has is logged and not counted) and review rounds (the versions of each
  PR's marked `review` comment from `userContentEdits`, 0 without one).

Then it re-reads the snapshot and closes only when the Issue still derives `done`
with the same CD run ids and conclusions; otherwise (a late run, `pause`, …) it stops
with no next action and the next run rewrites the comment. `closeDelivered` adds
`delivered` and closes the Issue as completed.

### Wake

The stage reads the Issues this Issue blocks (any repository). Each one whose
snapshot derives `shape` or a delivery stage goes into `wake`; every other one is
logged with its reason (`blocked by <remaining blockers>`, `no-assignee`, `paused`,
`closed`, or unreadable with the read error) and is never woken. Reading a
downstream snapshot needs the same reads as the Issue's own (see Job context); a
downstream repository the token does not cover is logged as unreadable.

### Next action

`{ "stage": "shape" | "deliver" | "review" | null, "reason": …, "wake"?: [{ "repo":
"<owner>/<repo>", "issue": <n> }] }`: `{ "deliver", "review" }` after problems or a
rebase request (also instead of reusing a review comment whose `Reviewed Shape` is
not current: the head is reviewed again first), `{ "deliver", null }` at `review`
with a pending `shape-wrong` report (instead of reviewing or merging),
`{ "deliver", "cd-failure" }` at `cd-failed`, `wake` after the close (also on the
redo), and `null` otherwise, including every failure. `"progressed": true` also when
the re-read before writing or merging finds another stage, PR or head than the one
pinned.

Result: `{ outcome: "clean" | "problems" | "blocked", reviewedHead, problems?,
reason? }`; `problems` is a non-empty list of non-empty strings, `reason` a non-empty
string.

## Shape reported wrong

When the Deliver Writer finds the approved Shape in conflict with the current Issue
or the product authority, the Issue goes back to the Shape stage with the reason
(#686). Branches, commits and PRs stay; pushed work is the next Deliver run's
starting point. Merged work is not revisited: after a rewrite, `awaiting-cd` and
`done` continue as usual, and a CD fix fixes the cited CD failure under the current
Shape.

- **Shape version** `<shape comment id>.<versions>`, where the versions are the
  comment's `userContentEdits` count read in the same GraphQL query as the Shape
  text (`readCurrentShape`). It changes exactly when the Shape body is rewritten or
  the comment recreated; nothing is stored locally and every check re-reads it.
  That the count grows only on body edits and is current right after a write is an
  assumption shared with the review-round count of #673 (GraphQL documents
  `userContentEdits` only as "a list of edits"); the Shape stage's write check
  guards it.
- **Report.** The marked `shape-wrong` Issue comment: `The approved Shape is wrong
(Writer).`, `Shape version: <v>` (the version the Writer was given), then the
  reason. It is _pending_ while unresolved and for the current version,
  _unresolved_ until it starts with `Resolved:`, and _active_ while unresolved or
  resolved by the current version (`Rewritten as Shape version: <v>`). A missing or
  malformed version line, or no Shape comment, makes it neither pending nor active
  (logged). On publication an active report is (re)written as `Resolved: a
rewritten Shape was approved and written.`, `Rewritten as Shape version: <new v>`,
  then the original lines; this happens before `shaped` is added, so a rewrite
  with unchanged text never leaves a pending report next to `shaped`.
- **Prompts.** After a rewrite the Writer and the Acceptor get the same inputs as
  always (the current Issue and the current Shape); the Writer's reason never
  reaches the Acceptor.
- **Reviews.** A `review` comment counts (Deliver `review` eligibility, review-stage
  reuse) only when it records both the current head and the current Shape version.
  Comments written before #686 have no `Reviewed Shape` line, so each in-flight PR
  is reviewed once more.

The next actions of this flow, all stages together:

- Deliver: `{ "shape", null }` after a Writer `shape-wrong` (report written,
  `shaped` removed), on a start at a delivery stage with a pending report (redo),
  and on an ineligible start at `shape` with an unresolved report; `null` when the
  Writer returns `shape-wrong` but the re-check finds the Issue ineligible (or
  `{ "review", null }` for a stale review, as above).
- Shape: `shapeNextAction` after a rewrite, and at a delivery stage with a report
  resolved by the current version (redo); `{ "deliver", null }` at a delivery stage
  with a pending report; `null` on any other exit (a first Shape, failures).
- Review: `{ "deliver", null }` at `review` with a pending report.

`shapeNextAction` maps the stage derived after `shaped` is back: `deliver` on the
delivery branch → `{ "deliver", null }`; `deliver` on a CD fix branch →
`{ "deliver", "cd-failure" }`; `ci-failed` → `{ "deliver", "ci-failure" }`;
`review` → `{ "review", null }`; `cd-failed` → `{ "deliver", "cd-failure" }`; `done`
→ `{ "review", null }` (closure); `awaiting-cd` and anything else → `null` (CD
events follow). A Shape run at a delivery stage outside this flow re-emits the same
delivery next action at most, which the delivery stages' own eligibility and Writer
guard make idempotent.

Tests use a fake GitHub API, fake agent runs and a fake configuration; only `git`
runs for real, in repositories under the ignored `.test-tmp/`, with a local bare
repository as the remote.
