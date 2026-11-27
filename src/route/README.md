# `src/route`

Decides from GitHub state what runs next for an Issue, and dispatches it to the
execution repository (#674). GitHub events only wake an Issue; this module is the one
authority for "what runs next".

## Route

`routeIssue(client, repo, issue, log)` derives `{ stage, reason, assignee, assignees } | null`
from the snapshot, composing the stages' own rules:

1. derived `scope` (an open `request` without `scope`, #734) → `scope`; derived
   `shape` → `shape`;
2. a delivery stage with a pending `shape-wrong` report (`readPendingReport`) →
   `deliver` (its start removes `shaped`);
3. `review` whose PR has a current review comment (`currentReview(...)?.current ===
true`; a stale one falls to rule 4) → `deliver review`; `review` whose PR has a
   current `approval-wait` comment that still waits (`readApprovalWait(...)?.kind
=== "waiting"`: writers' approvals missing or a writer's older request for
   changes standing) → `null` until a submitted review wakes the Issue (#725,
   #726); approvals met or changes requested on the head → `finish` (#755);
4. any other delivery stage → `shapeNextAction(stage, issue)` (`done` → `finish`,
   `conflict` → `deliver conflict`, `awaiting-*` → `null`);
5. closed as delivered (`closedAsDelivered`) → `finish` (wake-only redo);
6. anything else (paused, `pending`, neither `scope` nor `request`, blocked, no
   Assignee) → `null`.

`assignees` holds all the Issue's Assignees (`{ id, login }`, GitHub's order); without
one the route is `null`. Several Assignees route like one: `dispatchStage` chooses
among them (#739), and all are asked for consent.
`readRoute` also says whether the Issue is open. The actor (for marked comments) is
the token's account, read once with `GET /user`.

The stages keep writing their next actions; only their `wake` lists are dispatched.
For every documented non-null next action, the route on the resulting state asks for
the same run, except two cases that end the same way: a Deliver `review` fix with no
new head, and a Shape rewrite with unchanged text and head (the route gives
`deliver review` where the stage wrote `review`). `route.test.ts` holds that table.

`routeEvent(client, repo, target)` maps an event to its Issues, without repeats:
`{ issue }` as is, `{ branch }` through `issueOfBranch`
(`nibfin/issue-<n>[-cd-<k>]`), and `{ sha }` through every open or merged pull
request of `GET /commits/{sha}/pulls` whose head is such a branch, then every merged
pull request whose `merge_commit_sha` is the commit (`readPullRequestsMergedAt`).
GitHub associates a commit only with the pull request that introduced it, so a
second pull request that merged to the same commit without moving the base is found
only the second way (#771): `GET …/git/commits/{sha}` gives the commit's committer
date, and `GET …/pulls?state=closed&sort=updated&direction=desc&per_page=100` is
read page by page up to the first page holding a pull request updated before that
date. Anything else belongs to no Issue.

## Dispatch

Core dispatches `nibfin-shared-runner.yml` of the execution repository
(`NIBFIN_RUN_REPO`) on its default branch with `return_run_details`, and logs the run
URL. A dispatch cannot be confirmed by a re-read: no response or a 5xx is
`GITHUB_WRITE_UNCONFIRMED`, any other failure `GITHUB_WRITE_REJECTED`.

- `dispatchRoute`: inputs `stage: route`, `repo`, `issue`. Never deduplicated, so no
  wake is lost.
- `dispatchStage`: inputs `stage`, `repo`, `issue`, `reason` (empty for none) and
  `assignee`, the chosen Assignee's user id. It first lists the execution
  repository's self-hosted runners (`readRunners`, all pages; the token needs admin
  there) and `chooseAssignee` goes through `route.assignees` in GitHub's order
  (#739): the first Assignee with an online runner labelled `runnerLabel(id)` =
  `nibfin-<user id>` (a busy runner is online); otherwise the first with any such
  runner (the Job queues until one is online). Labels compare case-insensitively and
  exactly (`nibfin-<id>-<provider>` and `nibfin-<id>0` do not match). The log names
  the chosen user id and whether its runner is online. Without any match the Issue is
  an ordinary assignment: nothing more is read and nothing is dispatched, labelled or
  commented; the log names the Issue, the Assignees' user ids and the label form,
  never runner names. A runner gaining the label later starts nothing by itself; the
  next Issue event routes it. Then it lists the execution repository's runs that have not started
  (`requested`, `waiting`, `pending`, `queued`; one request each) and skips when one
  other than this run is titled exactly `Nibfin · <owner>/<repo>#<n> · <stage>`: a
  waiting run keeps its runner label and reads GitHub when it starts, even if another
  Assignee would now be chosen. `in_progress` runs never cause a skip.
- Consent (#721, `askForConsent`): after those two checks and before dispatching,
  `dispatchStage` reads the execution repository's owner id (`readRepoOwnerId`).
  Every Assignee in `route.assignees` other than the owner who has no Nibfin comment
  `consent-<user id>` on the Issue (`findMarkedComment`; other authors never count)
  is unasked. With any unasked, it adds `pause` (confirmed by the read-back labels,
  else `GITHUB_WRITE_UNCONFIRMED`), then writes one marked `consent-<user id>`
  comment per unasked Assignee in GitHub's order, mentioning them, and dispatches
  nothing. Removing `pause` is the go-ahead; the comment says this is a consent step,
  not a security control. Each Assignee is asked once per Issue. The check comes after
  the waiting-run skip, so a queued run is never paused under itself; reassignment
  during a queued or running run is not detected, and the next dispatch follows the
  Assignees then.

## Commands

`nibfin route --repo <owner>/<repo> (--issue <n> | --sha <sha> | --branch <b>)`
reads `NIBFIN_GITHUB_TOKEN`, `NIBFIN_RUN_REPO` and optionally `NIBFIN_RUN_ID` from
the environment.

- `--issue`: dispatches the Issue's route result (deduplicated), or logs why nothing
  runs. When the Issue is closed (any reason or label, since a closed Issue derives
  `closed` first), it first deletes the Issue's branches whose ref exists
  (`deleteIssueBranches`: `nibfin/issue-<n>` and every probed
  `nibfin/issue-<n>-cd-<k>`, #700). A close wakes the route through the `closed`
  Issue event; a delete failure sets `pending` and nothing is dispatched in that run.
  A merged pull request keeps its branch while the Issue is open.
- `--sha` / `--branch`: dispatches one route run for each mapped Issue in turn, so
  every stage decision for an Issue happens inside that Issue's concurrency group. A
  failed dispatch sets `pending` on that Issue only; the other Issues are still
  dispatched and the command exits 1. Nothing for an unrelated commit or branch; a
  failed read while mapping fails the run before any Issue is known, without
  `pending`.

After `nibfin run` exits 0 (`continueAfterStage`), Core reads the stage's next-action
file and dispatches a route for each `wake` target first. Its reads go to GitHub
fresh (`freshReads`), never to answers the stage read earlier in the Job (#689).
Then, only while the Issue is open, it dispatches the Issue's route result. When the
stage wrote `progressed: false` and the route asks for the same stage and reason again,
it stops
with `STAGE_NO_PROGRESS` instead (marked temporary after a review run: GitHub may
still be computing mergeability). A closed Issue's own route is never dispatched
after a stage, so closing cannot loop. After a Scope run only its wakes are
dispatched, never the request's own route: a Scope run ends by closing the request or
adding `pending` (Proposal R3.6, R3.8, R3.9), and the Issues it publishes continue
through `wake` (#734). Without `NIBFIN_NEXT_FILE` nothing is
dispatched.

## Failures

Any failure of `nibfin run` or `nibfin route` once the Issue is known goes through
`requestPerson` (`src/stages/pending.ts`): the marked `pending` comment (the code and
message, the run URL from `NIBFIN_RUN_REPO`/`NIBFIN_RUN_ID`, the temporary note for
`GITHUB_READ_FAILED`, `GITHUB_WRITE_UNCONFIRMED`, `STAGE_GIT_FAILED`,
`TOOL_INSTALL_FAILED`, `AGENT_RUN_FAILED` and `STAGE_RESULT_INVALID`, the usage-limit
note with the reset time for `AGENT_USAGE_LIMIT`, and "remove the `pending` label to
continue") and the `pending` label, confirmed by the read-back
labels. `STAGE_WRITER_ACTIVE` is a wait, not a failure: another Writer runs and its
own post-stage route continues the Issue. `nibfin run` prints it and exits 0;
`nibfin route` never raises it. When the `pending` write fails too (GitHub
unreachable), the run's failure is the only record.

Tests use a fake GitHub API (`fake-runner.test.ts` adds the execution repository).
