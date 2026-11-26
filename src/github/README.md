# `src/github`

Reads and writes the GitHub state that Nibfin works from: Issues, comments, labels,
pull requests and checks. Owned by #667.

All progress is derived from GitHub; nothing is kept locally. Reads give either a full
answer or a `GitHubError`, and every write is safe to repeat after an interruption.

## Client

`createClient(token, actor, options?, log?)` returns an `@octokit/rest` instance with
the official `@octokit/plugin-throttling` and `@octokit/plugin-retry`, carrying
`actor` (`{ id, login }`), the account Nibfin writes as. `connectClient(token,
options?, log?)` reads that actor once with `GET /user` (`readActor`) through the same
instance and returns the client (#674): Nibfin's token is a user's gh login token, for
which `GET /user` works (it does not for installation tokens or `GITHUB_TOKEN`). The
token is used only here; Octokit sends it as the `authorization` header and redacts it
from request errors. No timeout is added. The other modules take
`Pick<Octokit, "request" | "paginate">`.

Rate limits (#689), handled by the throttling plugin only:

- A primary rate limit (REST 403/429 with `x-ratelimit-remaining: 0`, or a GraphQL
  `RATE_LIMITED` error in a 200 answer) waits until `x-ratelimit-reset` + 1 s and
  retries, at most 2 times.
- A secondary rate limit (GitHub's message names it) waits `retry-after`, or the
  plugin's GitHub-documented 60 s fallback, and retries, at most 4 times.
- Each wait writes `GitHub <primary|secondary> rate limit on <METHOD> <path>: waiting
<s> s (retry <k> of <n>)` to `log` (the Job log); giving up writes `… not retrying
after <n> retries`. The line carries the URL path only, never the query string, the
  body or a header.
- A rate-limited write is retried too: GitHub rejected it, so it did not happen. The
  plugin also spaces writes and GraphQL queries at least 1 s apart, as GitHub
  recommends.

The retry plugin retries reads (GET, HEAD, GraphQL queries) on a 5xx or no response,
3 times with a growing delay. Writes are never re-sent (`retries: 0`): their unknown
outcome is re-read instead (see Writes). 429 is left to the throttling plugin.
Caller `throttle` and `retry` options are merged; the handlers stay Nibfin's.

### Per-Job read cache

Every client keeps the answers of its reads (each GET page and each GraphQL query,
keyed by method, full URL and body) for the rest of the Job, so a Job reads each piece
of GitHub data once. Identical reads share one answer, also while it is in flight;
every caller gets its own copy; failed answers are not kept. It is cleared:

- by any other request (a write), before it is sent and once it settled, so the
  confirm and read-back reads of a write go to GitHub;
- by `freshReads(client)`: at the start and end of every agent run (`runStageAgent`),
  after every push and before each pre-push eligibility re-check (Deliver), before the
  merge re-check (`mergeReviewed`), and before the post-stage route
  (`continueAfterStage`).

A client built over another (`trackProgress`) shares its cache through
`shareReadCache`. Nothing outlives the Job.

## Errors

`GitHubError { code, operation, cause }`. The message names only the operation and the
HTTP status; `cause` keeps the original error. A rate limit that outlasted its retries
is named: `(HTTP 403, rate limited (secondary))`, or `(GraphQL, rate limited
(primary))` for a GraphQL one. `rateLimitOf(cause)` gives `primary`, `secondary` or
`undefined`; the `pending` comment marks a rate limit temporary whatever its code.

- `GITHUB_READ_FAILED`: any failed read, including a failed page of a list. A list is
  never returned partially. Only the 404s that mean "absent" are not failures: a branch
  ref probe and a missing base branch.
- `GITHUB_WRITE_UNCONFIRMED`: the write got no response or a 5xx, and a re-read did not
  show its effect. The outcome is Pending; repeat the operation later.
- `GITHUB_WRITE_REJECTED`: any other 4xx, except the cases under Writes that mean
  success.

## Snapshot and stage

`readIssueRecord(client, issue)` (#689) reads with one GraphQL query (`IssueRecord`;
follow-up queries only past 100 comments or past the first fix branches):

- The Issue: state, state reason (REST's lowercase values), URL, title, body, labels
  and Assignees (in GitHub's order).
- Its native Blocked by Issues, from any repository, with state and labels. The count
  must match `issueDependenciesSummary.totalBlockedBy`; a shorter list or a missing
  node (for example Issues the credential cannot see) fails instead of looking
  unblocked.
- All its comments with author id, body, URL and `userContentEdits` count.
- The pull requests (head in this repository) and refs of its delivery and fix
  branches, below.

A pull request number, a missing Issue or a list longer than GitHub's page (labels,
Assignees, more than 100 pull requests of one branch) fails with
`GITHUB_READ_FAILED`. GraphQL has its own rate-limit budget, separate from REST.
`queryGraphql(client, operation, query, variables)` turns GraphQL `errors` or a
missing `data` into `GITHUB_READ_FAILED`.

`readIssueSnapshot(client, repo, n, deps?)` builds on the record:

- The Issue: state, `stateReason`, labels and Assignees.
- Its Blocked by Issues, as above.
- Its branches: `nibfin/issue-<n>` and the CD-failure fix branches
  `nibfin/issue-<n>-cd-<k>`, probed by pull requests (any state) and refs (`refs/heads/
nibfin/` matching `issue-<n>-cd-`), three fix branches per query, until a `k` has
  neither. The highest existing `k` is the current branch; the next `k` is
  `nextFixBranch`. `issueOfBranch(branch)` maps either branch name back to `n`.
- Each pull request, newest first, with its CI when open and its CD when merged. The
  open pull request of the current branch also carries GitHub's `mergeable`
  (`readPullRequest`; `null` while GitHub computes it, and for every other pull
  request, which is not read).

`deps` can replace the CI, CD and pull request readers (`readCi`, `readCdRuns`,
`readPullRequest`). CI and CD stay
REST: no single GraphQL query keeps their required-check semantics; within a Job they
are read once through the read cache.

CI is the base branch's required checks: rulesets (`GET …/rules/branches/{branch}`) plus
classic protection as `GET …/branches/{branch}` shows it, matched by context and app
(`null` = any source). A private repository whose plan has no rulesets answers the
rules endpoint with 403 "Upgrade to GitHub Pro or make this repository public"; that
reads as no rules, for the required checks and the merge rules alike. A result is the newest matching check run, else, for an
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

| Current branch                         | Stage                                      |
| -------------------------------------- | ------------------------------------------ |
| No PR, or only closed-unmerged PRs     | `deliver`                                  |
| Open PR, conflicts with the base       | `conflict` (`mergeable: false`, before CI) |
| Open PR, no required checks            | `review`                                   |
| Open PR, a required check failed       | `ci-failed` (wins over pending)            |
| Open PR, a required check not done     | `awaiting-ci`                              |
| Open PR, all required checks succeeded | `review`                                   |
| Merged, no Nibfin push run yet         | `awaiting-cd` (`nibfin-push-run-missing`)  |
| Merged, a CD run failed                | `cd-failed` (wins over pending)            |
| Merged, a CD run not done              | `awaiting-cd` (`cd-runs-pending`)          |
| Merged, all CD runs succeeded or none  | `done`                                     |

An open PR is used before a merged one. A conflicting PR gets no `pull_request` CI
from GitHub, so `conflict` is checked first; while `mergeable` is `null` the CI rules
apply. `cd-failed` names `nextFixBranch`; once that branch exists it is the current
branch, and its PR follows the same rules.

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

The snapshot carries no Issue text. `readIssueText(client, issue)` gives an Issue's
current `{ title, body }` (an empty description is `""`) from its record, from any
repository the credential covers (#671).

`readBlocking(client, issue)` lists the Issues an Issue blocks, across repositories,
from one GraphQL query (`IssueBlocking`), checked against
`issueDependenciesSummary.totalBlocking` the same way (#673).

## Writes

- `ensurePullRequest(client, repo, { branch, base, title, body })`: the branch's open
  pull request, created when there is none. A 422 "already exists" re-reads and reuses.
- `findMarkedComment(client, target, key, on?)` and
  `upsertMarkedComment(client, target, key, body, on?)`: comments starting with
  `<!-- nibfin:<key> -->` written by the actor (by user id). The oldest is updated in
  place, others are never deleted, and an unchanged body is not written. Returns the
  comment as re-read. An Issue's comments come from its record; with
  `on: "pull-request"` (the `review` comment) from the REST comment list.
  `readMarkedComment(client, issue, key)` gives the record's comment with its
  versions.
- `setLabels(client, issue, { add, remove })`: writes only missing additions and present
  removals, reading the labels from the Issue record. A removal 404 re-reads; an
  absent label is success.
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
- `readRunners(client, repo)` (#739): every self-hosted runner of the repository
  (`GET …/actions/runners`, all pages; needs admin access) as `{ online, labels }`:
  `online` when its `status` is `online` (case-insensitive; anything else is
  offline, and `busy` is not read), and its label names lowercased since runner
  labels are case-insensitive. `runnerLabel(id)` forms an Assignee's label
  `nibfin-<user id>`.
- `dispatchWorkflow(client, repo, workflow, inputs)`: dispatches `workflow` on the
  repository's default branch (`readDefaultBranch`) with `return_run_details` and
  returns the run URL when GitHub reports it. No response or a 5xx is
  `GITHUB_WRITE_UNCONFIRMED` (a dispatch cannot be confirmed by a re-read), any
  other failure `GITHUB_WRITE_REJECTED`.
- `readRepoOwnerId(client, repo)` (#721): the repository's `owner.id` (an
  organisation's id when it owns it), from the same `GET /repos/{owner}/{repo}`
  read as `readDefaultBranch`, so within a run it costs no extra request.

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
- `readLatestReviews(client, repo, n)`: each reviewer's latest submitted review
  (`id`, `login`, `state`, `commitId`, `url`, `body`), all pages, by review
  id; plain comments, `PENDING` reviews and reviews without a user do not count.
- `readApprovalCount(client, repo, n)`: reviewers whose latest deciding review
  approves (plain comments do not decide), from `readLatestReviews`.
- `readReviewComments(client, repo, n, reviewId)`: a review's inline comments
  (`path`, `line` or `null`, `body`, `url`), all pages.
- `readRequestedReviewers(client, repo, n)`: the logins and team slugs a pull
  request still requests a review from (`GET …/pulls/{n}/requested_reviewers`).
- `hasWritePermission(client, repo, login)`: whether the collaborator permission
  (`GET …/collaborators/{login}/permission`) is `admin` or `write`; a 404 is
  `false`, any other failure `GITHUB_READ_FAILED`.
- `readPullRequestCommits(client, repo, n)`: the SHAs of the pull request's current
  commits (heads removed by a force push are not listed).
- `readForcePushedHeads(client, repo, n)`: the head right before each force push,
  from GraphQL `HeadRefForcePushedEvent.beforeCommit`, all pages.
- `readCommitPullRequests(client, repo, sha)`: number, title, URL and description
  of the pull requests GitHub associates with a commit (`GET …/commits/{sha}/pulls`).
- `readIssueTitle(client, issue)`: an Issue's title and URL (`GET …/issues/{n}`).
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
