# `src/github`

Reads and writes the GitHub state that Nibfin works from: Issues, comments, labels,
pull requests and checks. Owned by #667.

All progress is derived from GitHub; nothing is kept locally. Reads give either a full
answer or a `GitHubError`, and every write is safe to repeat after an interruption.

## Client

`createClient(token, actor, options?, log?)` returns an `@octokit/rest` instance with
the official `@octokit/plugin-throttling`, carrying
`actor` (`{ id, login }`), the account Nibfin writes as. `connectClient(token,
options?, log?)` reads that actor once with `GET /user` (`readActor`) through the same
instance and returns the client (#674): Nibfin's token is a user's gh login token, for
which `GET /user` works (it does not for installation tokens or `GITHUB_TOKEN`). The
token is used only here; Octokit sends it as the `authorization` header and redacts it
from request errors. No timeout is added. The other modules take
`Pick<Octokit, "request" | "paginate">`.

Retries (#748, Proposal R4.37–R4.39): every GitHub API call is retried on any error up
to 3 times (`maxRetries`) after its first attempt, whatever the error is: no
response, a 5xx, any 4xx, a rate limit, a GraphQL `errors` answer or a merge
refusal. Every retry counts toward the same 3. Only after the third retry fails does
the caller get today's failure (`GITHUB_READ_FAILED`, `GITHUB_WRITE_UNCONFIRMED`,
`GITHUB_WRITE_REJECTED`, a merge's `not-mergeable`), so `pending` handling is
unchanged.

- Reads (GET, HEAD, GraphQL queries) are retried by one `hook.wrap("request")` loop
  inside the read cache, so identical reads still share one answer. A GraphQL answer
  with `errors` counts as a failure; after the last retry it is returned as it is and
  its caller fails as before.
- An answer that arrived but fails Nibfin's check that it is complete (a missing
  node, a count that does not match, a missing connection or `data`, a missing
  Issue) is retried at call level (#768): its check throws `incompleteRead`, a
  `GITHUB_READ_FAILED` caused by an `IncompleteAnswer`, and `retryIncomplete(client,
operation, run)` reruns the whole read up to 3 times. Each retry is logged as
  `GitHub <operation> (retry <k> of 3): incomplete answer; waiting <s> s`, waits
  `k²` seconds and drops the kept reads (`freshReads`), so the next attempt reaches
  GitHub rather than the read cache. After the third retry it logs the give-up line
  and throws the last error, whose message ends `(incomplete answer)`. The reads that
  do so: `readIssueRecord` (with its follow-up queries), `readBlockingRecord`,
  `readOriginIssues`, `readRepositoryInventory`, `readCommentVersions`,
  `readCommentWithVersions` and `readForcePushedHeads`. Other errors pass through at
  once (the request hook already retried them), as do definite answers such as "is a
  pull request", so retries never multiply; an error a nested `retryIncomplete` gave
  up on is not retried again.
- A 404 that the caller reads as "absent" is an answer and is not retried: the read
  passes `request: absentProbe` (`{ absent404: true }`, which Octokit does not
  send). The five `readOptional` reads do: `branchExists`, the base branch of
  `readRequiredChecks`, `hasWritePermission`, `readCommitsAhead` and `readJobLog`.
  Any other failure of these reads is retried.
- Writes are retried by `write()` (see Writes), merges by `mergeReviewed`
  (`src/stages`).
- `retryDelay(error, k)` is the wait before retry `k`: a secondary rate limit
  (GitHub's message names it) waits `retry-after`, or 60 s without it; a primary
  rate limit (REST 403/429 with `x-ratelimit-remaining: 0`, or a GraphQL
  `RATE_LIMITED` error in a 200 answer) waits until `x-ratelimit-reset` + 1 s, or
  60 s without it; anything else waits `k²` seconds (1, 4, 9). Every wait happens
  inside the running call; no timer, cron or later wake.
- Each retry writes `<what> (retry <k> of 3): <cause>; waiting <s> s` to `log` (the
  Job log), where `<what>` is `GitHub <METHOD> <path>` and `<cause>` is `HTTP
<status>`, `no response`, `GraphQL error` or `primary`/`secondary rate limit` (at call
  level `<what>` is `GitHub <operation>` and `<cause>` is `incomplete answer`).
  Giving up writes `<what>: <cause>; not retrying after 3 retries`. The line carries
  the URL path only, never the query string, the body, a header or GitHub's message.
- The throttling plugin no longer retries by itself (both handlers return false); it
  spaces writes and GraphQL queries at least 1 s apart, as GitHub recommends, and
  reports a GraphQL rate limit as an error.

Caller `throttle` options are merged; the handlers stay Nibfin's. `wait` replaces the
wait before a retry (tests make it instant). The client's `log` and `wait` are kept
with its read cache (`retrySettingsOf`), so `write()` and the merge loop reach them
through any client built over it; a client without them logs nothing and waits for
real.

### Per-Job read cache

Every client keeps the answers of its reads (each GET page and each GraphQL query,
keyed by method, full URL, the `absent404` option and body) for the rest of the Job, so a Job reads each piece
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
HTTP status; `cause` keeps the original error (the last attempt's). A rate limit that outlasted its retries
is named: `(HTTP 403, rate limited (secondary))`, or `(GraphQL, rate limited
(primary))` for a GraphQL one. `rateLimitOf(cause)` gives `primary`, `secondary` or
`undefined`; the `pending` comment marks a rate limit temporary whatever its code.

- `GITHUB_READ_FAILED`: any failed read, including a failed page of a list. A list is
  never returned partially, and fails only after its retries. Only the 404s that mean
  "absent" are not failures (and are not retried): a branch ref probe, a missing base
  branch, not a collaborator, a compare head GitHub no longer has and a missing job
  log.
- `GITHUB_WRITE_UNCONFIRMED`: the write's last attempt got no response or a 5xx, and
  a re-read did not show its effect. The outcome is Pending; repeat the operation
  later.
- `GITHUB_WRITE_REJECTED`: the last attempt got any other 4xx, except the cases under
  Writes that mean success.

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

A pull request number fails with `GITHUB_READ_FAILED` at once. A missing Issue (a
just-created one can read as missing until GraphQL catches up) or a list longer than
GitHub's page (labels, Assignees, more than 100 pull requests of one branch) is an
incomplete answer: the whole read is retried up to 3 times (`retryIncomplete`, above)
before it fails with `GITHUB_READ_FAILED`. GraphQL has its own rate-limit budget,
separate from REST. `queryGraphql(client, operation, query, variables)` turns GraphQL
`errors` into `GITHUB_READ_FAILED` and a missing `data` into an incomplete answer.

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

- When the current branch's merged pull request has a failed CD run, `baseCd`: the
  base branch around that red merge (`readBaseCd`, below; `null` otherwise, so a
  green `main` adds no reads).

`deps` can replace the CI, CD, pull request and base readers (`readCi`, `readCdRuns`,
`readPullRequest`, `readBaseCd`). CI and CD stay
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
the set is complete. `readCdRuns` also keeps that run's `workflow_id` as
`nibfinWorkflowId` (the run at `.github/workflows/nibfin-issue.yml` when several Nibfin
workflows ran on the push, else the lowest id).

### The base branch around a red merge (#772)

Nibfin's push workflow runs once on every push to the base branch (Proposal R3.35), and
merges are rebase merges, so its push runs list the push heads of `main`, each newer
head containing the older ones. `readBaseHeads(client, repo, base, workflowId)` reads
one page (100) of `GET …/actions/workflows/{workflow_id}/runs?event=push&branch=<base>`
(only that workflow, so other workflows take no slot), keeps push runs of the base, and
sorts them by run id, newest first, one SHA per run. The listing has no documented
order; sorting by id is the same assumption `readCdRuns` makes for "newest".

`readBaseCd(client, repo, base, ownCd, n)` (null without `ownCd.nibfinWorkflowId`)
returns `heads`; when the Issue's merge `M` is on the page: `newest`, the CD of the
newest head when it is not `M`; `previous`, the CD of the head just older than `M`;
and only when `previous` has a failed run, `previousIssue`: the Issue of that push
(`issueOfCommit`: the first Issue of `GET /commits/{sha}/pulls`, the pull
request that introduced the push; `issuesOfCommit` adds every Issue merged to it, the
rule `routeEvent` uses, #771) with its open state, and unless it is
Issue `n` itself, its newest merge (`newestMergeOf`, by pull request number across its
branches) when that is not the red push: `fix` with its pull request, whether it is a
head on the page newer than `M`, and its CD. The fix is read whether the Issue is open
or closed. A merge older than the page gets nothing around it.

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
| Merged, a CD run failed                | `cd-failed` (wins over pending), unless    |
|                                        | the red-merge rule below says otherwise    |
| Merged, a CD run not done              | `awaiting-cd` (`cd-runs-pending`)          |
| Merged, all CD runs succeeded or none  | `done`                                     |

A red merge `M` (#772) is fixed only by the Issue whose merge made the base red. A
newer head _passes for M_ when Nibfin's run is present, none of its CD runs is pending
or failed, and every workflow `path` that failed on M has a successful run on it (a
`paths:`-filtered workflow that did not run again does not pass). In order:

1. `newest` passes for M → `done` with `passedOn` (that head's CD).
2. No `previous` (or no `baseCd`), `previous` green, `previous` red of no Issue, or of
   this Issue → `cd-failed` with M's runs.
3. `previous` still pending → `awaiting-cd` (`previous-cd-pending`).
4. `previous` red and its Issue merged nothing since: open → `awaiting-cd`
   (`previous-cd-red`, `waitingOn` that Issue); closed → `cd-failed` with M's runs.
5. That Issue's newer merge `F`, open or closed: not a newer head on the page, or no
   Nibfin run yet → `awaiting-cd` (`previous-fix-cd-pending`); a failed run →
   `cd-failed` with F's runs and `failedOn` (F and its pull request); still pending →
   `previous-fix-cd-pending`; passes for M → `done` with `passedOn` F; green but missing a
   path that failed on M → `cd-failed` with M's failed runs on those paths.

The result depends only on what GitHub holds, not on when the previous Issue closes.

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

`readLastUnlabeled(client, issue, label)` gives the latest `created_at` of an
`unlabeled` event for `label` among all the Issue's events
(`GET …/issues/{n}/events`, every page of 100), or `null`; and
`readIssueComment(client, repo, id)` reads one Issue comment by REST with its
`updated_at`. The repair stage uses both (#777, `src/stages`).

The snapshot carries no Issue text. `readIssueText(client, issue)` gives an Issue's
current `{ title, body }` (an empty description is `""`) from its record, from any
repository the credential covers (#671).

`readBlocking(client, issue)` lists the Issues an Issue blocks, across repositories,
from one GraphQL query (`IssueBlocking`), checked against
`issueDependenciesSummary.totalBlocking` the same way (#673).

## Writes

Every write goes through `write(client, operation, run, { confirm, recover })`
(`write.ts`), which retries it on any error up to 3 times:

1. A 4xx that `recover` shows as the intended state is success, with no retry: the
   422 "already exists" of `ensurePullRequest`, the removal 404 of `setLabels`, and
   any 4xx of `deleteBranch` that re-reads as absent.
2. Otherwise, while retries are left, the call waits `retryDelay`, logs the retry,
   then re-reads GitHub (`confirm`) right before the re-send. If the write already
   took effect (also during the wait), the confirmed result is used and nothing is
   sent again, so no comment, label, close, branch delete or merge happens twice.
   A failing pre-read ends the write without a re-send, with the code below.
3. After the third retry an unknown outcome is re-read once more (R1.13) and is
   `GITHUB_WRITE_UNCONFIRMED`; anything else is `GITHUB_WRITE_REJECTED`.

A 5xx can come back while GitHub still completes the first write; if it lands only
after the pre-read, a new marked comment can appear twice. Nibfin reads the oldest
copy and never deletes the others, so the effect is cosmetic. `writeOnce` is one
attempt with the same `confirm`/`recover` handling and no retry.

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
- `closeIssueAs(client, issue, reason)`: closes with `state_reason` `completed` or
  `not_planned` (the Scope stage's already-covered request, #735). A closed Issue is
  not written again; the close is confirmed by reading the state back.
- `mergePullRequest(client, repo, { number, sha, method })` (#673):
  `PUT …/pulls/{n}/merge` with `sha` and `merge_method`, so GitHub merges only at that
  head and enforces the repository's own rules. Results: `merged` (with the merge
  commit), `head-changed` (409) or `not-mergeable` (405, with GitHub's message). Any
  other 4xx (403, 422, …) is `GITHUB_WRITE_REJECTED`; `responseMessage(error.cause)`
  gives GitHub's message. An unknown outcome re-reads the pull request: merged at
  `sha` confirms the merge, anything else is `GITHUB_WRITE_UNCONFIRMED`. It makes
  one attempt (`writeOnce`): a re-sent merge must first re-check the Issue's stage,
  so `mergeReviewed` (`src/stages`) retries it.
- `deleteBranch(client, repo, name)` (#700): `DELETE …/git/refs/heads/<name>`. GitHub
  documents no answer for a missing ref, so an unknown outcome or any 4xx re-reads
  `GET …/git/ref/heads/<name>` (`branchExists`): a 404 there is success, otherwise
  `GITHUB_WRITE_UNCONFIRMED` or `GITHUB_WRITE_REJECTED`. Deleting a branch closes its
  open pull request.

The Scope stage publishes a request's plan with these (`issue-writes.ts`, #736):

- `readIssueId(client, issue)`: `GET …/issues/{n}`, the Issue's handle (address,
  GitHub's URL and REST `id`, which a dependency's `issue_id` names). A pull request
  is `GITHUB_READ_FAILED`.
- `createIssue(client, repo, { title, body })`: `POST …/issues` with title and body
  only, so the Issue has no labels or Assignees yet. An unknown outcome is checked with
  `findCreatedIssue(client, repo, title, body)`: the first page (100) of
  `GET …/issues?state=all&creator=<actor>&sort=created&direction=desc`, skipping pull
  requests, for the Issue with exactly that title and body. It lists the repository,
  never search. If the listing lags behind a create that took effect, the re-send can
  create a second Issue; the Scope stage's next run then finds an Issue with the
  request's origin line that its plan does not list (`REPLAN_REQUIRED`).
- `addBlockedBy(client, blocked, blocker)`: `POST …/issues/{n}/dependencies/blocked_by`
  with the blocker's `issue_id`. An edge already in the Blocked by list is not written
  again; a 4xx is recovered by reading the edge back. Afterwards both directions must
  read back (the blocked Issue's Blocked by and the blocker's blocking, compared by
  URL without case), else `GITHUB_WRITE_UNCONFIRMED`.
- `addAssignees(client, issue, logins)`: `POST …/issues/{n}/assignees` with only the
  logins that are not yet Assignees (compared without case); others stay. GitHub
  silently ignores an Assignee it cannot add, so every login must read back, else
  `GITHUB_WRITE_UNCONFIRMED`.

`dispatchWorkflow` (Workflow runs) goes through `write()` with a `confirm` that never
confirms: a dispatch has no run to re-read, and a repeated wake is harmless (R4.35),
so it is re-sent on any error without a pre-read.

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
  returns the run URL when GitHub reports it. Any failure is re-sent up to 3 times
  without a pre-read (see Writes); then no response or a 5xx is
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
- `readPullRequestsMergedAt(client, repo, sha)`: the merged pull requests whose
  `merge_commit_sha` is `sha`, including those GitHub does not associate with it (a
  merge that left the base where it was, #771). It reads the commit's committer date
  (`GET …/git/commits/{sha}`), then the closed pull requests most recently updated
  first, up to the first page that reaches one updated before that date.
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

## Request sources (#735)

The Scope stage's agents hold no GitHub credential, so the stage reads every GitHub
fact they judge (`request-sources.ts`). Each list is read in full through
`queryGraphql`, so the read retries apply; a missing node, connection or nested list
that does not match its count is an incomplete answer, retried by `retryIncomplete`
and then `GITHUB_READ_FAILED`.

- `readOriginIssues(client, request)`: the request's own Issues (Proposal R3.4). It
  pages through the request's `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT])`,
  keeps sources that are Issues (not pull requests) with a line that, trimmed, is
  exactly `Origin: <request URL>` (`hasOriginLine`), drops those closed as
  `not_planned` or `duplicate`, and keeps each URL once. Each has repository, number,
  URL, title, body, state, state reason, labels and Assignee logins.
- `readRepositoryInventory(client, repo)`: the repository's `visibility` (`public`,
  `private` or `internal`; a missing or unknown value fails and is never guessed),
  its open Issues with text, labels, Assignees and Blocked by (checked against
  `issueDependenciesSummary.totalBlockedBy`), its closed Issues with title, state
  reason and labels, and its open pull requests with head branch, 100 per page.
- `checkAssignable(client, repo, login)`: `GET …/assignees/{login}` sent with
  `absentProbe`. 204 is `true`; 404 is `false`, an answer that is not retried
  (R4.39); any other failure is retried and then `GITHUB_READ_FAILED`.

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
