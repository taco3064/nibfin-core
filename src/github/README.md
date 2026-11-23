# `src/github`

Reads and writes the GitHub state that Nibfin works from: Issues, comments, labels,
pull requests and checks. Owned by #667.

All progress is derived from GitHub; nothing is kept locally. Reads give either a full
answer or a `GitHubError`, and every write is safe to repeat after an interruption.

## Client

`createClient(token, actor)` returns an `@octokit/rest` instance carrying `actor`
(`{ id, login }`), the account Nibfin writes as. The caller supplies the actor (#674):
`GET /user` does not work for installation tokens or `GITHUB_TOKEN`. The token is used
only here; Octokit redacts it from request errors. No retry plugin or timeout is added.
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
  `nextFixBranch`.
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
`blocked` by an Issue that is not Closed + `delivered`, `no-assignee`), then `shape`
without `shaped`, then `deliveryOutcome(snapshot)` on the current branch:

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
required checks and their results for the merge admission (#673).

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

After an unknown outcome each write re-reads GitHub: a confirmed effect is reused,
otherwise it fails with `GITHUB_WRITE_UNCONFIRMED`.

## Permissions

Contents, Metadata, Actions, Checks and Commit statuses read; Issues and Pull requests
write. No Administration. Reading Issues in other repositories needs a credential that
covers them (#674); without it the read fails with `GITHUB_READ_FAILED`.

## Interfaces with other Issues

- #674 installs Nibfin's push workflow. It must run on every push to the base branch (no
  `branches`/`paths` filter that excludes it) and its name must start with `Nibfin ·`;
  otherwise merged work stays `awaiting-cd` (`nibfin-push-run-missing`).
- #673 reads the snapshot again right before closing, so a run that appears late is
  still waited for. A merge commit message containing `[skip ci]` suppresses all push
  runs, Nibfin's included.

Tests use a fake GitHub API behind a real Octokit (`fake-github.test.ts`), so
pagination, errors and request encoding are Octokit's own.
