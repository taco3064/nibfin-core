# `src/github`

Reads and writes the GitHub state that Nibfin works from: Issues, comments, labels,
pull requests and checks. Owned by #667.

All progress is derived from GitHub; nothing is kept locally. Reads give either a full
answer or a `GitHubError`, and every write is safe to repeat after an interruption.

## Client

`createClient(token, actor)` returns an `@octokit/rest` instance carrying `actor`
(`{ id, login }`), the account Nibfin writes as. `connectClient(token)` reads that
actor once with `GET /user` (`readActor`) and returns the client (#674): Nibfin's
token is a user's gh login token, for which `GET /user` works (it does not for
installation tokens or `GITHUB_TOKEN`). The token is used only here; Octokit redacts
it from request errors. No retry plugin or timeout is added.
The other modules take `Pick<Octokit, "request" | "paginate">`.

## Errors

`GitHubError { code, operation, cause }`. The message names only the operation and the
HTTP status; `cause` keeps the original error, so rate limits (403/429 with their
response headers) stay identifiable.

- `GITHUB_READ_FAILED`: any failed read, including a failed page of a list. A list is
  never returned partially. Only the 404s that mean "absent" are not failures: a branch
  ref probe and a missing base branch.
- `GITHUB_WRITE_UNCONFIRMED`: the write got no response or a 5xx, and a re-read did not
  show its effect. The outcome is Pending; repeat the operation later.
- `GITHUB_WRITE_REJECTED`: any other 4xx, except the cases under Writes that mean
  success.

## Snapshot and stage

`readIssueSnapshot(client, repo, n, deps?)` reads, all pages each:

- The Issue: state, `state_reason`, labels and Assignees (in GitHub's order).
- Its native Blocked by Issues, from any repository, with `state` and labels. The count
  must match the Issue's `issue_dependencies_summary`; a shorter list (for example
  Issues the credential cannot see) fails instead of looking unblocked.
- Its branches: `nibfin/issue-<n>` and the CD-failure fix branches
  `nibfin/issue-<n>-cd-<k>`, probed by pull requests (`state=all`) and exact ref until a
  `k` has neither. The highest existing `k` is the current branch; the next `k` is
  `nextFixBranch`. `issueOfBranch(branch)` maps either branch name back to `n`.
- Each pull request, newest first, with its CI when open and its CD when merged.

`deps` can replace the readers the snapshot is built from.

CI is the base branch's required checks: rulesets (`GET …/rules/branches/{branch}`) plus
classic protection as `GET …/branches/{branch}` shows it, matched by context and app
(`null` = any source). A result is the newest matching check run, else, for an
any-source check, the newest commit status of that context (statuses carry no app id).
Check runs of Nibfin's own workflow runs (name prefix `Nibfin ·`, matched through their
check suite) never count.

CD is the push runs of the merge commit on the base branch, newest per workflow `path`,
without Nibfin's own workflows. Nibfin's own push run for that commit is the signal that
the set is complete.

`deriveStage(snapshot)` checks, in order: `ineligible` (`closed`, `no-scope`, `paused`,
`pending` (#674: Nibfin needs a person; removing the label resumes), `blocked` by an
Issue that is not Closed + `delivered`, `no-assignee`), then `shape` without
`shaped`, then `deliveryOutcome(snapshot)` on the current branch:

| Current branch                         | Stage                                     |
| -------------------------------------- | ----------------------------------------- |
| No PR, or only closed-unmerged PRs     | `deliver`                                 |
| Open PR, no required checks            | `review`                                  |
| Open PR, a required check failed       | `ci-failed` (wins over pending)           |
| Open PR, a required check not done     | `awaiting-ci`                             |
| Open PR, all required checks succeeded | `review`                                  |
| Merged, no Nibfin push run yet         | `awaiting-cd` (`nibfin-push-run-missing`) |
| Merged, a CD run failed                | `cd-failed` (wins over pending)           |
| Merged, a CD run not done              | `awaiting-cd` (`cd-runs-pending`)         |
| Merged, all CD runs succeeded or none  | `done`                                    |

An open PR is used before a merged one. `cd-failed` names `nextFixBranch`; once that
branch exists it is the current branch, and its PR follows the same rules.

Results: `success`, `neutral`, `skipped` succeed; `failure`, `cancelled`, `timed_out`,
`startup_failure`, `stale` and status `error`/`failure` fail; anything else, including
`action_required` and a missing conclusion, is pending. The CI stages return the
required checks and their results for the merge admission (#673). A result from a
check run also carries `checkRunId` and the app's `appSlug` (`null` when GitHub names
none); for a GitHub Actions check run (`github-actions`) the id is the job id (#672).

`readRunJobs(client, repo, runId)` lists the jobs of a workflow run's latest attempt
(`filter=latest`), and `readJobLog(client, repo, jobId)` reads one job's log; GitHub
answers with a redirect to the log, which Octokit's fetch follows, and a 404 is
`undefined` (#672).

The snapshot carries no Issue text. `readIssueText(client, issue)` reads an Issue's
current `{ title, body }` (an empty description is `""`), from any repository the
credential covers (#671).

`readBlocking(client, issue)` lists the Issues an Issue blocks, across repositories,
checked against its summary the same way (#673).

## Writes

- `ensurePullRequest(client, repo, { branch, base, title, body })`: the branch's open
  pull request, created when there is none. A 422 "already exists" re-reads and reuses.
- `findMarkedComment(client, target, key)` and
  `upsertMarkedComment(client, target, key, body)`: comments starting with
  `<!-- nibfin:<key> -->` written by the actor (by `user.id`). The oldest is updated in
  place, others are never deleted, and an unchanged body is not written. Returns the
  comment as re-read.
- `setLabels(client, issue, { add, remove })`: writes only missing additions and present
  removals. A removal 404 re-reads; an absent label is success.
- `closeDelivered(client, issue)`: adds `delivered`, then closes with
  `state_reason: completed`. An open Issue with `delivered` still derives `done`, so a
  repeated call finishes the close.
- `mergePullRequest(client, repo, { number, sha, method })` (#673):
  `PUT …/pulls/{n}/merge` with `sha` and `merge_method`, so GitHub merges only at that
  head and enforces the repository's own rules. Results: `merged` (with the merge
  commit), `head-changed` (409) or `not-mergeable` (405, with GitHub's message). Any
  other 4xx (403, 422, …) is `GITHUB_WRITE_REJECTED`; `responseMessage(error.cause)`
  gives GitHub's message. An unknown outcome re-reads the pull request: merged at
  `sha` confirms the merge, anything else is `GITHUB_WRITE_UNCONFIRMED`, never a
  retry.
- `deleteBranch(client, repo, name)` (#700): `DELETE …/git/refs/heads/<name>`. GitHub
  documents no answer for a missing ref, so an unknown outcome or any 4xx re-reads
  `GET …/git/ref/heads/<name>` (`branchExists`): a 404 there is success, otherwise
  `GITHUB_WRITE_UNCONFIRMED` or `GITHUB_WRITE_REJECTED`. Deleting a branch closes its
  open pull request.

After an unknown outcome each write re-reads GitHub: a confirmed effect is reused,
otherwise it fails with `GITHUB_WRITE_UNCONFIRMED`.

## Workflow runs (#674)

- `nibfinRunTitle(repo, n, stage)`: `Nibfin · <owner>/<repo>#<n> · <stage>`, the run
  name of an Issue's route and stage runs.
- `readNotStartedRuns(client, repo)`: the runs with status `requested`, `waiting`,
  `pending` or `queued`, one list request (all pages) per status, with their
  `display_title`.
- `dispatchWorkflow(client, repo, workflow, inputs)`: dispatches `workflow` on the
  repository's default branch (`readDefaultBranch`) with `return_run_details` and
  returns the run URL when GitHub reports it. No response or a 5xx is
  `GITHUB_WRITE_UNCONFIRMED` (a dispatch cannot be confirmed by a re-read), any
  other failure `GITHUB_WRITE_REJECTED`.

## Merge admission (#673)

- `readPullRequest(client, repo, n)`: the pull request with `mergeable` (`null` while
  GitHub computes it) and `mergeable_state` (`clean`, `blocked`, `behind`, `dirty`,
  `unstable`, `unknown`, …).
- `readMergeSettings(client, repo)`: `allow_rebase_merge`, `allow_squash_merge` and
  `allow_merge_commit` of `GET /repos/{owner}/{repo}`; a field GitHub leaves out is
  `undefined`.
- `readMergeRules(client, repo, branch)`: the rules that apply to the base branch
  (`GET …/rules/branches/{branch}`): every `pull_request` rule (required approvals,
  code owner review, last push approval, thread resolution, `allowed_merge_methods`)
  and whether `required_linear_history` applies.
- `allowedMergeMethods(settings, rules)`: the methods, in the order rebase, squash,
  merge commit, that the settings and every `pull_request` rule allow; no merge
  commit under linear history. `undefined` when a setting is unknown.
- `readApprovalCount(client, repo, n)`: reviewers whose latest deciding review
  approves (plain comments do not decide).
- `readPullRequestCommits(client, repo, n)`: the SHAs of the pull request's current
  commits (heads removed by a force push are not listed).
- `readForcePushedHeads(client, repo, n)`: the head right before each force push,
  from GraphQL `HeadRefForcePushedEvent.beforeCommit`, all pages.
- `readCommitsAhead(client, repo, base, head)`: the commits of `head` that `base`
  lacks (`GET …/compare/{base}...{head}`, at most the 250 GitHub returns);
  `undefined` when GitHub no longer has `head` (404).
- `readCommentVersions(client, repo, commentId)`: the comment's versions from GraphQL
  `userContentEdits`, which is empty for a comment never edited (1 version) and once
  edited lists every edit plus the original (`totalCount` versions).
- `readCommentWithVersions(client, repo, commentId)`: the comment's `body` and its
  versions (as above) from one GraphQL query on the comment node, so the body read
  is the one the versions count (the Shape version of #686).

Classic branch protection details (required approvals, allowed methods) need
Administration, so they are not read; GitHub still enforces them on the merge.

## Permissions

Metadata, Actions, Checks and Commit statuses read; Issues and Pull requests write.
No Administration. The Deliver stage (#672) also pushes with the same token, so it
needs Contents write, plus the workflows permission when a change touches
`.github/workflows/`, and Actions read on the execution repository (`NIBFIN_RUN_REPO`)
for the Writer check. The review stage (#673) merges, which needs Contents write and
Pull requests write, plus the workflows permission when the pull request changes
`.github/workflows/`. The GitHub client itself only reads Contents. Dispatching a
workflow needs Actions write (classic: `repo`); Nibfin's own token is a gh login
token with `repo` and `workflow` (#674). Reading Issues in
other repositories needs a credential that covers them (#674); without it the read
fails with `GITHUB_READ_FAILED`.

## Interfaces with other Issues

- #674 installs Nibfin's push workflow (`nibfin-issue.yml`, `Nibfin · Issue events`).
  It must run on every push to the base branch (no `branches`/`paths` filter that
  excludes it) and its name must start with `Nibfin ·`; otherwise merged work stays
  `awaiting-cd` (`nibfin-push-run-missing`).
- #673 reads the snapshot again right before closing, so a run that appears late is
  still waited for. A merge commit message containing `[skip ci]` suppresses all push
  runs, Nibfin's included.

Tests use a fake GitHub API behind a real Octokit (`fake-github.test.ts`), so
pagination, errors and request encoding are Octokit's own.
