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
| `--reason`               | Deliver only: `ci-failure`, `review`, `cd-failure` or       |
|                          | `conflict`                                                  |
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
| `NIBFIN_TOOL_CACHE`      | The cache for `.nibfin.json` tools, outside the workspace;  |
|                          | the agent's run gets `PLAYWRIGHT_BROWSERS_PATH` set to its  |
|                          | `ms-playwright` directory (#716)                            |
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
stages and malformed options print the usage and exit 1. `STAGE_WRITER_ACTIVE` prints
its code and message, writes nothing and exits 0. Any other failure prints its code
and message, sets `pending` (see Pending) or reports that it could not, and exits 1,
so a non-zero exit always means a person must act.

## Pending

`requestPerson(client, issue, error, runUrl)` asks a person to act: it upserts the
marked `pending` Issue comment (the code and message, the run URL, the note "this
looks temporary (network, GitHub or a single agent run); removing the label retries
it" for `GITHUB_READ_FAILED`, `GITHUB_WRITE_UNCONFIRMED`, `STAGE_GIT_FAILED`,
`TOOL_INSTALL_FAILED`, `AGENT_RUN_FAILED` and `STAGE_RESULT_INVALID`, for
`AGENT_USAGE_LIMIT` the note that the provider's usage limit was reached, when it
resets (or that the CLI did not report it) and to remove `pending` after that time,
and "Remove the `pending` label to continue") and adds `pending`, confirmed by the
read-back labels. When GitHub rejects that comment (`GITHUB_WRITE_REJECTED`, e.g. a
message listing thousands of paths), it writes it once more as the same body with only
the fenced message block replaced by "The full message is in the run log.", then adds
`pending` as usual; no size limit applies. The full message always goes to the Job log.
`nibfin run` and `nibfin route` call it on every failure once the Issue is known,
whatever the code, except `STAGE_WRITER_ACTIVE` (a wait: another Writer runs and its
own post-stage route continues the Issue; `nibfin run` exits 0 for it). The no-progress
stop (`STAGE_NO_PROGRESS`, see `src/route`) takes the same path. The stage-specific
comments stay as they are.
While `pending` is present the Issue derives `ineligible (pending)` and no stage is
dispatched; the repair stage (below) runs in the route Job, and removing `pending`
resumes from GitHub state. `requestPerson(..., stage)` and `askPerson(..., stage)`
add the header line ``- Stage: `repair` `` after `- Run:` when the repair stage
itself failed; without `stage` the body is unchanged.

## Repair stage

**Parsed by gh-nibfin.** The record and decision formats and the reader rule below are
a contract (`repair-record.ts`); change them only together with gh-nibfin.

The deterministic part of the repair stage (#777, Proposal R4.40–R4.52). It runs
inside `nibfin route --issue` (no agent, R5.70–R5.71) when the Issue derives
`ineligible (pending)` (so never for a closed, unscoped or paused Issue) and nothing
else is routed. The repair agent, applying a chosen option and the `labeled:pending`
wake are separate work; until that wake exists, any other routed wake of the Issue
reaches the stage.

### Reading the `pending` comment

`readPendingCause(body)` reads only Core's own lines of Nibfin's marked `pending`
comment: the header before the first ` ```text ` line and the trailer after
the last ` ``` ` line (the whole body without a fence). It gives `code` (the
first ``- Code: `X` ``; `none` is no code), `run` (the `- Run:` URL),
`temporary` (the trailer has the temporary sentence, `temporarySentence`, which the
wake failure of `nibfin-events.yml` writes word for word), `reset` (``it resets at
`<reset>` `` in the usage-limit note) and `fromRepair` (``- Stage: `repair` ``).
Text inside the fenced failure message never counts.

### What decides (`readRepairNeed`, `runRepair`)

`readRepairNeed` reads Nibfin's marked `pending` comment (its id from the Issue
record, then `GET …/issues/comments/{id}` for `body` and `updated_at`), the latest
`unlabeled` event for `pending`, and Nibfin's marked `repair` comment. The `pending`
comment is **current** when its `updated_at` is later than that event (or there is
none). Then:

- the current comment has ``- Stage: `repair` `` (the stage failed for this stop,
  R4.50) → nothing;
- the record applies (see Reader rule) and is `repairing` → **resume**; applies with
  any other status → nothing;
- otherwise → **new**.

A new stop is decided in this order:

1. no current comment, or no code → `not classified`, advice;
2. the code is in the record's `handled` list → the category it had the first time,
   advice: the second stop for that code (R4.47);
3. `AGENT_USAGE_LIMIT` → when the reset is ISO 8601 UTC (`YYYY-MM-DDThh:mm:ss[.s]Z`)
   and reset + 1 minute is at most `jobLimitMinutes` (330) after the Job's process
   started: `wait`, category `external temporary problem (provider usage limit)`;
   otherwise advice with the reset as reported, or that none was reported (R4.43,
   R4.46). Codex's free-text resets are not exact times and get advice;
4. the temporary sentence → `retry`, category `external temporary problem` (R4.42);
5. anything else → `not classified`, advice: read the latest Nibfin comment, fix
   what it names, then remove `pending`.

Writes: W1 upserts the record. `advice` ends there (`pending` stays). `retry` then
removes `pending` (W2, confirmed by the read-back labels, else
`GITHUB_WRITE_UNCONFIRMED`). `wait` sleeps until reset + 1 minute, drops the read
cache, and continues to W2 only while the Issue still derives `ineligible (pending)`
and `readRepairNeed` still says resume for the same `pending` digest; a person
removing `pending`, `pause`, closing, or a new stop ends it without a write. Resume
skips W1 and goes to the step its action names (a wait sleeps for the time left).
After W2 the route reads the Issue again and dispatches what it calls for once.
Every write is idempotent (R4.35): a crash after W1 resumes, a crash after W2 is an
Issue without `pending`. The wait holds the route Job and the Issue's concurrency
group; it is not a timer for dispatch (R1.15). `jobLimitMinutes` is GitHub's
360-minute job limit less a margin.

A failure inside `runRepair` goes through `askPerson(..., "repair")`: the `pending`
comment gets ``- Stage: `repair` ``, `pending` stays, and the stage does not start
again for that stop (R4.50).

### Repair record

Nibfin's marked comment `<!-- nibfin:repair -->` (one per Issue, updated in place).
Its next line is the state line:

```text
<!-- nibfin:repair-state for=<digest> status=<status> action=<action> handled=<CODES>[ reset=<ISO>] -->
```

- `for`: `pendingDigest(body)`, the first 16 hex characters of the SHA-256 of the
  exact `pending` comment body (UTF-8, as the API's `body`, marker line included)
  the record covers. Without a current comment it is the digest of `""`.
- `status`: `repairing`, `needs-person`, or `waiting-for-choice` (reserved for the
  repair agent's options; this stage never writes it).
- `action`: `retry`, `wait` (with `reset`) or `advice`.
- `handled`: comma-separated codes already handled automatically on this Issue,
  carried over from the previous record (possibly empty).

No value contains `--`. Then the visible lines (R4.49): `- Category:`, `- Reason:`
(one line), `- Evidence:` (the code, a link to the `pending` comment and its run),
`- Done:` and `- Advice:`. It never quotes the failure message.
`formatRepairRecord(state, text)` writes it and `parseRepairRecord(body)` reads the
state; a missing or unparseable state line, or `wait` without `reset`, is no record.

### Reader rule

`repairStatus({ hasPendingLabel, pendingComment, lastUnlabeledPendingAt, record })`
is what the Dashboard shows for a `pending` Issue (R9.52):

1. no `pending` label → `null`;
2. the `pending` comment is current only if it exists and its `updated_at` is later
   than the latest `unlabeled` event for `pending` (or there is none);
3. the record applies only if the comment is current and `for` equals the digest of
   its body;
4. the record applies → its `status`; otherwise `needs-person`.

Inputs: Nibfin's marked `pending` comment's `body` and `updated_at`, the latest
`unlabeled` event for the label `pending` from `GET …/issues/{n}/events`, and
Nibfin's marked `repair` comment (both comments by Nibfin's account only). A record
not tied to the current `pending` comment means `needs-person`, never `repairing`;
only `repairing` is left out of R9.1's count of Issues that need a person.

### Decision comment

`formatDecision(n)` is `<!-- nibfin:decision option=n -->` (n ≥ 1), what the
Dashboard writes for option n (R4.51). `parseDecision(body)` gives n when that marker
is the first line, or when the trimmed body is only a number; anything else is no
decision. Checking the author is a Collaborator and applying the option belong to the
Shape stage (separate Issue). Removing `pending` without a decision is one more run
(R4.52): the route continues as usual, and the removal makes that `pending` comment
stale, so it is not repaired later.

## Harness

- `prepareStageJob(context, client, deps, skills)` runs right before a stage's first
  agent run, while the workspace still holds the base checkout. It compares
  `MemAvailable` of `/proc/meminfo` with `NIBFIN_MEMORY_REQUIRED` (below it:
  `STAGE_HOST_MEMORY_LOW`), reads `.nibfin.json` (a `ConfigError` rejects the Job with
  its code and cause), resolves the text of each skill the stage's roles follow
  (`resolveRoleSkill`) and installs its tools once per Job with `prepareTools`. A
  branch or PR head checked out later never supplies a role's instructions.
- `runStageAgent(job, role, sections)` takes the role's skill text the Job resolved (a
  skill it did not resolve is `STAGE_INPUT_INVALID`), composes the prompt
  (`composePrompt`: the skill, "Your role is …", the titled input sections and the
  role's result format) and runs `runAgent`
  with the tools as `pathEntries`. Each call is a separate agent run, with the CLI's
  auto memory off, so roles share nothing except what the prompt and GitHub carry.
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

## Scope stage

`runScopeStage(context, client, deps?)` (`nibfin run --stage scope ...`) runs for an
open `request` Issue without `scope` (Proposal R3.2–R3.11, R4.8; #734, #735, #736). Both
roles are read-only and get every GitHub fact from the stage, since they hold no
credential (`scope-sources.ts`, `src/github` "Request sources"):

1. Reads the snapshot. When `deriveStage` is not `scope`, it logs the actual stage and
   ends with no next action, before any agent or write.
2. `prepareStageJob` resolves the `shape` and `scope` skills (built-in plus
   `.nibfin.json` `extend`/`override`) from the request repository's base checkout.
3. Reads the request's text and Assignees, its own Issues (`readOriginIssues`) and the
   request repository's inventory with its visibility, then runs the Investigation
   (`scope-investigation`, skill `shape`, "Feasibility of a request"): `feasible` (with
   the `repositories` the work touches), `already-covered` (with `covering`, an Issue
   URL or null), `not-feasible` or `needs-person`. No Validator checks it (R3.11).
4. Only when feasible: reads the inventory of every named repository, checks whether
   each Assignee can be assigned in each of them (a 404 is "not assignable", not
   retried), and runs the Plan (`scope-plan`, skill `scope`, `## Requests`). It returns
   `PLAN_READY` with `deduplication`, `report` and `issues` (new `{key, repository,
title, body, blockedBy}` or reused `{key, reuse, blockedBy}`), or `PLAN_BLOCKED` /
   `AUTHORITY_UPDATE_REQUIRED` with `reason`. The parser rejects an empty list,
   missing or duplicated keys, a repository without an inventory, an empty title or
   body, a body without the line `Origin: <request URL>`, a `reuse` that is not one of
   the request's own Issues (or is reused twice), and a `blockedBy` entry that is
   neither a key nor an Issue URL, a self-edge or a cycle (`STAGE_RESULT_INVALID`).
5. Re-reads the snapshot and the request text: not at `scope` any more (`pause`,
   `pending`, closed, `scope`, no Assignee) ends without writing (R4.12, R4.13); a
   changed title or body starts again at step 3, without a limit.
6. Acts, writing only the marked `scope-request` comment (updated in place on a redo,
   R3.42), the `pending` label and the close:
   - already covered: the comment with the reason and the covering Issue, a re-check
     of step 5, then `closeIssueAs(..., "not_planned")` (R3.8);
   - not feasible, needs a person, `PLAN_BLOCKED`, `AUTHORITY_UPDATE_REQUIRED` or
     `PLAN_READY` with unverified deduplication: the comment says only a person can
     decide, with the verdict, the reason (or the report), the request's own Issues
     with their state and that removing `pending` restarts the feasibility check; then
     `pending` (read back, else `GITHUB_WRITE_UNCONFIRMED`). The Job exits 0, so the
     generic `pending` comment is not added (R3.9, R3.10, R4.3);
   - a verified `PLAN_READY`: `deps.publish(scope, plan)` gets the `RequestPlan`
     (request URL, Investigation reason, report, Issues) in memory, never from Issue
     text (R3.7), with the request's Assignees from step 5 and a `recheck` that
     repeats step 5 on fresh reads. Publication follows below.
7. Publication (`publishRequestPlan`, `scope-publish.ts`; #736, R3.3–R3.6, R3.42)
   runs no agent: every read and write uses Core's client (R3.48, R3.49). It follows
   the scope skill's `## Publish` and `## Requests` rules:
   1. Refresh, read-only, before any write. The request's own Issues are read again
      (`readOriginIssues`): one the plan does not reuse, or a reuse that is no longer
      among them (discarded since the Plan), is `REPLAN_REQUIRED`. So is a reused
      Issue that already has `scope` or is closed and that the plan would give a
      Blocked by edge it does not have. Each new Issue's repository inventory is read
      once: closed Issues discarded as not planned or duplicate are ignored; one open
      Issue with the exact title and body, not one of the request's own, is adopted as
      that entry (its cross-reference may lag behind its creation, the same-title
      second net); any other exact-title match is `REPLAN_REQUIRED`. Then
      `PUBLICATION_BLOCKED`: a request without Assignees, an Assignee that cannot be
      assigned in the repository of an open new or reused Issue, or a URL blocker
      outside the repositories of the request, the new and the reused Issues (the
      Plan saw only those). Read failures here are thrown (generic `pending`, nothing
      written).
   2. Creates each remaining new Issue in plan order with title and body only (no
      labels or Assignees, so it is not eligible for Shape) and reads back its title,
      exact body and open state (`createIssue`, `src/github` "Writes").
   3. Adds every native Blocked by edge (`addBlockedBy`); both directions read back.
   4. `recheck`: no longer at `scope` (`pause`, `pending`, closed, …) stops; an
      edited request starts the next round at step 3, without a limit.
   5. Only now, for each open new, reused or adopted Issue: the request's Assignees
      (`addAssignees`, read back), then `scope` (read back). Adding `scope` fires
      that Issue's own `labeled` route for Shape. Closed reused Issues are listed but
      never written; reused bodies are never changed.
   6. `recheck` again, then the `scope-request` comment lists every created, reused
      or adopted Issue by key and URL, and `closeIssueAs(..., "completed")`. Exit 0.

   Any other end asks a person on the request with the `scope-request` comment and
   `pending` (R3.9, R3.10, R4.3, R4.5). The comment has the verdict, the reason, the
   Issues published so far by key and URL and the request's own Issues:
   - `REPLAN_REQUIRED` or `PUBLICATION_BLOCKED` from the refresh: nothing else is
     written; the Job exits 0.
   - a write that fails or cannot be confirmed (from step 2 on): the verdict is
     `PARTIAL_PUBLICATION` when a write took or may have taken effect, otherwise
     `PUBLICATION_BLOCKED`. The Job log gets `nibfin: <code>: <message>` (R1.14); the
     comment also carries the generic `pending` comment's content (`pendingBody`:
     code, run URL, message, usage-limit and temporary notes) and is written once more
     with a pointer to the run log when GitHub rejects it (`upsertPersonComment`).
     After `pending` the Job exits 1, so the CLI adds no second comment and does not
     route after the stage. When that comment or label cannot be written, the original
     failure is thrown and the CLI's generic `pending` applies.

   Every write is repeat-safe, so a redo converges: removing `pending`, or the next
   routed event after a crash, runs the stage from the Investigation, whose Plan
   reuses the Issues already created through their cross-references (or the
   same-title adoption), and publication writes only what is missing. An Issue that
   has `scope` already had all its edges.

Role notes bind every posted `reason` (and the report) to the request repository's
visibility and each new Issue to its target's; `internal` counts as private. Agent,
result and GitHub failures are thrown with their codes and end in the generic
`pending` (`src/cli/run.ts`), except a failed publication write, which step 7 handles.
After a Scope run Core dispatches only its wakes, never the request's own route (see
`src/route`); the per-Issue concurrency group keeps two runs on one request apart.

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
   `cd-failed` (work on `nextFixBranch`), or `deliver` on a fix branch (a redo);
   `conflict` → `conflict` (the open PR conflicts with its base). Otherwise it logs
   the stage and exits 0.
2. **Writer check.** It lists the in-progress workflow runs of `NIBFIN_RUN_REPO`
   (every workflow and page) other than `NIBFIN_RUN_ID`. Another run named
   `Nibfin · <owner>/<repo>#<n> · deliver` (run name or workflow name) is
   `STAGE_WRITER_ACTIVE`: Pending, nothing written. GitHub offers no query for a
   concurrency holder.
3. **Branch.** The base is the workspace's checked-out branch. Before anything else
   on it, Core builds the protected set from that base checkout (see
   [Protected paths](#protected-paths)). Core fetches the base and the
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
6. **Accept** (read-only, `accept` skill, a fresh run each time) runs only after the
   [protected-path check](#protected-paths) passes. It gets the Issue, the
   Shape, the local diff against `origin/<base>` and the fix context, never the
   Writer's output. `defects` go to the Writer, then a fresh Acceptor; there is no
   round limit. `blocked` writes `deliver-blocked` and stops.
7. **Base refresh.** After a pass Core fetches `origin/<base>` from GitHub again into
   its repository and the workspace (the Writer has no credentials to fetch). When
   the head no longer contains it (`merge-base --is-ancestor`), the base moved
   during the run: nothing is published, and the Writer gets one defect naming the
   new base head, asking it to rebase onto `refs/remotes/origin/<base>`, resolve
   conflicts keeping the base's work and rerun the affected checks, with the new
   base commits (below). A fresh Acceptor follows; there is no round limit.
8. **PR.** After a pass on a head that contains the base it re-checks eligibility,
   pushes what is pending and opens the PR (`<Issue title> (#<n>)`), or reuses the
   branch's open one, and marks an earlier `deliver-blocked` comment resolved. It
   then reads the snapshot fresh until GitHub computed the open PR's `mergeable`
   (at most 5 reads, 3 s apart; still unknown, it logs that and the CI rules apply).

Fix context: `ci-failure` lists the failed required checks with URLs and, for a
GitHub Actions check run (app `github-actions`, whose check-run id is the job id),
the last 200 lines of the job log; other checks and statuses get their URL only.
`review` gives the review comment. `cd-failure` at `cd-failed` lists the failed runs
of the stage's own `runs`, with their merged PR and merge commit: the Issue's own
merge, the previous Issue's fix on a newer base head (`failedOn`), or the Issue's
failed runs on paths that fix did not re-run (#772). On a fix-branch redo it lists the
failed CD runs of the newest merged PR whose CD failed. Each run comes with the log
tails of its failed jobs (`filter=latest`). `conflict` gives the PR, that it conflicts with the base and what
to do (as for a moved base), and the new base commits. Log text is redacted of the
token.

New base commits: the commits of `origin/<base>` the head lacks (`%h %s`, newest
first, at most 50 and a count of the rest), each with the pull requests GitHub
associates with it (`GET …/commits/{sha}/pulls`) and the Issues each links in its
description (`Part of #<n>`, closing keywords) with their titles and URLs. A failed
read is `GITHUB_READ_FAILED`.

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
- **Branch with an open PR** (`ci-failure`, `review`, `conflict`): Core pushes only
  after Accept passes.
- **Protected paths.** Before each push, after the "nothing ahead" check, Core checks
  the head for protected paths (below). A head that fails is not pushed and fails
  like a rejected push: no later push happens in the run, and `flush` reports it.

### Protected paths

Proposal §3 forbids the agent to change its own execution policy. Core enforces it
for every head it pushes or hands to an Acceptor. GitHub's own workflow-file
protection does not apply, because the token has the `workflow` scope.

- **The set.** `protectedPaths` builds it once per run from the base checkout,
  before the Issue branch is checked out. Its config is the base checkout's
  `.nibfin.json`, the one the run's agents read their role skills from. It
  contains:
  - the directories `.github/workflows/`, `.nibfin/` and `.rulesync/`;
  - the files `.nibfin.json`, `CODEOWNERS`, `.github/CODEOWNERS` and
    `docs/CODEOWNERS` (where GitHub reads CODEOWNERS);
  - every `skills.<role>.path` in that config, wherever it lies. Core's own
    `skills/` directory is product source and not protected.
- **Symlinks.** Each named path is resolved one part at a time in the base
  checkout, as the OS does. Every symlink on the way is protected, and so is the
  real path it resolves to inside the workspace, with the kind of the named entry
  (`.rulesync → config/rules` protects `config/rules/` as a directory). A link
  that leaves the workspace is protected, but its target is not. A missing part
  ends the walk.
- **Matching.** A path matches an entry when it is the entry, lies below a
  directory entry, or is a parent of the entry. Git lists a symlink or a file that
  replaces a directory under its own path, so adding, removing or retargeting a
  parent (`docs → evil`) of a protected path matches. Matching is case-sensitive.
- **Comparison.** In Core's repository, Core compares the head with the current
  tree of `refs/remotes/origin/<base>` (`git diff --name-only --no-renames`,
  two-dot). Any protected difference in content, mode, type or existence stops
  the run. That includes one the head only carries because it is behind the base.
  A merge-base diff tells which paths the branch changed itself.
- **Where.** The check runs before each push, and before each Acceptor after the
  workspace branch is fetched into Core's repository (also on a branch with an open
  PR, which is not pushed before Accept). Before an Acceptor, the working tree
  must also match that head on every protected path (`workingTreeChanges`). Core
  reads the head's protected entries from its own repository (`git ls-tree`) and
  compares them with the files and links on disk by blob hash. Each entry must be
  reached through real directories. No other file may sit on or below a protected
  path, or in place of a parent of one. The workspace's index and Git config take
  no part, so an ignored file, or an edit hidden by `--skip-worktree`,
  `--assume-unchanged` or an fsmonitor hook, also stops the run. No diff or status
  shows these, but rulesync and the Acceptor would read them. The executable bit
  is not compared.
- **Failure.** `STAGE_PROTECTED_PATH` lists the paths in two groups. Paths changed
  on the branch belong to a separately authorized maintenance route and must be
  removed from the branch. Paths only behind the base mean the branch must be
  updated from the base (rebased onto `origin/<base>`). The error takes the
  ordinary failure path: `pending` and the marked `pending` comment with the code
  and message. It is not a temporary code. Pushes of earlier clean heads stand. A
  branch pushed before this check existed is refused the same way on its next run.

### Next action

With `NIBFIN_NEXT_FILE` set, the stage writes `{ "stage": …, "reason": …,
"progressed": … }` there for #673 and #674 (a push counts as progress):
`{ "stage": "review", "reason": null }` when the snapshot after the PR
derives `review`; `{ "stage": "deliver", "reason": "conflict" }` when it derives
`conflict`; `{ "stage": "shape", "reason": null }` after a Writer
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
| `awaiting-cd`                       | Log the reason (and the Issue it waits    |
|                                     | on); next action none                     |
| `cd-failed`                         | Next `{ "deliver", "cd-failure" }`        |
| `conflict`                          | Next `{ "deliver", "conflict" }`          |
| `done`                              | Closing comment, `delivered`, close, wake |
| Closed, `delivered` and the actor's | Wake only (a redo after a crash)          |
| `delivered` comment                 |                                           |
| Anything else                       | Log the stage; next action none           |

### Finish stage

`runFinishStage(context, client, deps?)` (`nibfin run --stage finish --repo
<owner>/<repo> --issue <n>`, #755) runs the review stage's steps that need no agent:
the merge of a head whose passing review an `approval-wait` comment records, the
review fix from a writer's request for changes on that head, `done` and the
wake-only redo. `readFinishContext(args, env)` accepts no `--provider`, `--model` or
`--reason` and reads only `NIBFIN_GITHUB_TOKEN`, `NIBFIN_RUN_REPO`, `NIBFIN_RUN_ID`
and `NIBFIN_NEXT_FILE`, so the Job needs no login volume, workspace or tool cache and
runs on a GitHub-hosted runner when the execution repository is public. A head that
still needs the reviewer is never reviewed here: the run writes next
`{ "stage": "review", "reason": null }` and the route dispatches the review stage.

### Review

1. **Pin.** With a pending `shape-wrong` report the run neither reviews nor merges:
   next `{ "deliver", null }`, whose start removes `shaped`. Otherwise the head `H`
   of the open PR is pinned, and the PR is read once (`GET /pulls/{n}`), which starts
   GitHub's mergeability computation early so the merge after the review usually
   finds it done (#674). If the actor's marked `review` comment on the PR
   already records `H` (`Reviewed head: H`) and the current Shape version
   (`Reviewed Shape: <v>`, read here), the run asks for the `review` fix again
   without reviewing; a comment without a current `Reviewed Shape` line is stale and
   the head is reviewed again. Otherwise, when the actor's marked `approval-wait`
   comment on the PR records `H` and the current Shape version (a passing review,
   see Merge step 2), the head is not reviewed again: a writer's `CHANGES_REQUESTED`
   review on `H` (the newest) becomes the marked `review` comment for `H` and that
   Shape version (the review's author in backticks without `@`, its URL, its text and
   its inline comments as `path:line`, URL and body) and asks for the `review` fix;
   anything else goes straight to the merge, which re-checks everything. A wait
   comment for another head or Shape version is stale.
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
   comment; a merge that waits for approvals records it in the `approval-wait`
   comment.

### Merge

GitHub enforces the repository's own rules; Core imposes nothing the repository does
not configure.

1. Re-reads the snapshot: the Issue must still derive `review` on the same PR at `H`
   (so `pause`, closing and new pushes stop the merge). A pending `shape-wrong`
   report stops it with next `{ "deliver", null }`; nothing is merged or written.
2. Reads the PR: it must be open at `H`. `mergeable: null` or `mergeable_state:
unknown` stops with no next action (GitHub is still computing).
   `dirty` (a real conflict) writes the `review` comment "Rebase onto `<base>` and
   resolve conflicts: …" for `H` and the reviewed Shape version, and asks for the
   `review` fix. `behind` alone (no conflict) goes on to the merge; a repository
   that requires up-to-date branches then answers 405 (step 4). `blocked` waits for
   approvals (#725) when a ruleset `pull_request` rule of the base applies and either
   the approvals of writers (reviewers whose collaborator permission is `admin` or
   `write`; a 404 is no access) are below the largest required count, or a writer's
   latest review requests changes on any head (GitHub then needs that writer's
   approval). It upserts the marked `approval-wait` comment on the PR
   (`Reviewed head: H`, `Reviewed Shape: <v>`, that the Shape review
   passed, the requirement and the writers' approvals, each writer whose requested
   changes stand, the requested reviewers and teams; logins in backticks without
   `@`) and ends with next action none; no `pending`. A submitted review wakes the
   Issue (#726). Any other `blocked` writes `review-blocked` naming the readable
   unmet ruleset requirements (approvals against the current count, code owner
   review, last push approval, resolved threads), or saying that classic protection
   is not readable. Unreadable rules, reviews or permissions fail
   (`GITHUB_READ_FAILED`).
3. Chooses the first of rebase, squash and merge commit that the repository settings
   and every applying ruleset `pull_request` rule allow (no merge commit under
   `required_linear_history`). No method, or an unknown setting, is `review-blocked`.
4. Right before each attempt it reads the base head (`GET …/git/ref/heads/<base>`,
   fresh); a failed read leads to `pending` with nothing merged. Merges with
   `sha: H` and the method chosen once. A failed attempt (`head-changed`
   409, `not-mergeable` 405, any other rejection, an unknown outcome whose re-read
   does not show the merge) is re-sent up to 3 times (#748, Proposal R4.37–R4.38).
   Before each re-send it waits (`retryDelay`: a rate limit the time GitHub states,
   otherwise 1, 4, 9 s), logs `Merging <url> again (retry <k> of 3): <cause>;
waiting <s> s` (`<cause>` is the kind only: `HTTP 405`, `HTTP 409`, another
   status, a rate-limit kind or `no response`, never GitHub's message), then repeats steps 1 and 2's re-check: the Issue must still derive
   `review` on the same PR at `H` (`pause`, closing, an Issue edit, a new push or a
   merge that landed meanwhile stops with no next action), no pending `shape-wrong`
   report (otherwise next `{ "deliver", null }`), and the PR open at `H`. A real
   conflict goes to Deliver at once, with no more attempts: `dirty` writes the
   rebase `review` comment, and `mergeable: false` makes the stage `conflict`, which
   the route sends to Deliver. Anything else (`behind`, `blocked`, still computing,
   `clean`) is re-sent; GitHub decides. When the third retry fails too, it logs
   `Merging <url>: <cause>; not retrying after 3 retries`, and the last attempt's
   outcome is then routed once: `head-changed` (409, or a 405 saying the head was modified) stops with no
   next action. A rejection naming the workflows permission is `review-blocked`
   naming it. Any other 405 re-reads the PR: a head that moved or a PR no longer
   open stops with no next action, `mergeable: false` or `dirty` goes back to
   Deliver as a rebase, `behind` (the repository requires up-to-date branches) is
   `review-blocked` explaining that setting, a mergeability still being computed is
   `review-blocked` saying so, and any other state is `review-blocked` with GitHub's
   message. Any other error (`GITHUB_WRITE_REJECTED`, `GITHUB_WRITE_UNCONFIRMED`) is
   thrown and leads to `pending`.
5. After the merge the next action is none: CD events continue the Issue. When
   GitHub answers with a merge commit equal to the base head read right before the
   attempt, the base did not move (a same-content PR merged first, #771): no push,
   so no CD event, follows. The run logs it and goes on at once with a fresh
   snapshot (`continueMerged`): `awaiting-cd` waits (the CD completion wakes the
   Issue through route by SHA), `cd-failed` asks for `{ "deliver", "cd-failure" }`,
   `done` closes the Issue (below), and any other stage (`pause`, a manual close)
   stops with no next action. The review stage's own `awaiting-cd`, `cd-failed` and
   `done` cases use the same rule (`settleMerged`).

### Closing

At `done` the stage writes the marked `delivered` comment on the Issue, built only
from GitHub data:

- every pull request of the Issue's branches, with its merge commit;
- for each merged PR, the base's current required checks and their results on its
  head;
- the CD runs of each merge, with conclusions and URLs, and when the Issue's red merge
  passed on a newer base head (`done.passedOn`, #772), a line "CD passed on newer
  `<base>` `<sha>`" with that head's runs;
- counts: CD-fix PRs (`-cd-<k>` branches), CI-fix rounds (distinct commits with a
  failed required check among each PR's current commits and the commits of every
  head it had right before a force push, such as a rebase; a replaced head GitHub
  no longer has is logged and not counted) and review rounds (the versions of each
  PR's marked `review` comment from `userContentEdits`, 0 without one).

Then it re-reads the snapshot and closes only when the Issue still derives `done`
with the same CD run ids and conclusions (those of `passedOn` included); otherwise (a late run, `pause`, …) it stops
with no next action and the next run rewrites the comment. `closeDelivered` adds
`delivered` and closes the Issue as completed.

### A red `main` (#772)

`awaiting-cd` has three more reasons for a red merge `M` on a base that was already
red (see `src/github/README.md`): `previous-cd-pending` (the push before M still runs
CD), `previous-cd-red` (that push is red and its open Issue, named by `waitingOn`, has
not merged a fix) and `previous-fix-cd-pending` (that Issue's fix has no complete CD on
a newer head yet). Only the Issue whose merge made `main` red gets `cd-failed`; the
others wait without `pending` or a comment, and the route wakes them (`cdWaiters`,
`src/route/README.md`). A waiting Issue whose `main` passes for its merge finishes as
`done`; one whose predecessor's fix is red, or skipped a workflow that failed on its
merge, gets `cd-failed` and fixes from the latest base.

### Wake

The stage reads the Issues this Issue blocks (any repository). Each one whose
snapshot derives `scope`, `shape` or a delivery stage goes into `wake`; every other one is
logged with its reason (`blocked by <remaining blockers>`, `no-assignee`, `paused`,
`closed`, or unreadable with the read error) and is never woken. Reading a
downstream snapshot needs the same reads as the Issue's own (see Job context); a
downstream repository the token does not cover is logged as unreadable.

### Next action

`{ "stage": "shape" | "deliver" | "review" | null, "reason": …, "wake"?: [{ "repo":
"<owner>/<repo>", "issue": <n> }] }`: `{ "deliver", "review" }` after problems or a
rebase request (also instead of reusing a review comment whose `Reviewed Shape` is
not current: the head is reviewed again first), `{ "deliver", null }` at `review`
with a pending `shape-wrong` report (instead of reviewing or merging), `{
"deliver", "review" }` for a writer's request for changes on a head whose
`approval-wait` comment is current,
`{ "deliver", "cd-failure" }` at `cd-failed`, `{ "deliver", "conflict" }` at
`conflict`, `wake` after the close (also on the redo), and `null` otherwise,
including a wait for approvals and every failure. `"progressed": true` also when the re-read before writing
or merging finds another stage, PR or head than the one pinned.

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
  the comment recreated; nothing is stored locally and every check reads it from
  GitHub (within a Job, once between writes, agent runs and pushes; #689).
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
`conflict` → `{ "deliver", "conflict" }`;
`review` → `{ "review", null }`; `cd-failed` → `{ "deliver", "cd-failure" }`; `done`
→ `{ "review", null }` (closure); `awaiting-cd` and anything else → `null` (CD
events follow). A Shape run at a delivery stage outside this flow re-emits the same
delivery next action at most, which the delivery stages' own eligibility and Writer
guard make idempotent.

Tests use a fake GitHub API, fake agent runs and a fake configuration; only `git`
runs for real, in repositories under the ignored `.test-tmp/`, with a local bare
repository as the remote.
