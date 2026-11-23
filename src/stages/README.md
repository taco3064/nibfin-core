# `src/stages`

Implements the delivery stages that move an Issue from Shape to a merged pull request.
Owned by #671, #672 and #673. #671 adds the Shape stage and the harness the other
stages reuse.

## Job context

`nibfin run --stage <stage> --repo <owner>/<repo> --issue <n> --provider <p>
[--model <model>]` runs one stage for one Issue. The caller (#674) supplies the rest
of the context in the environment. `readJobContext(args, env)` reads and checks it; a
missing or invalid field is `STAGE_INPUT_INVALID` naming the field, never its value.

| Input                 | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `--repo`              | The repository, `<owner>/<repo>`                               |
| `--issue`             | The Issue number                                               |
| `--provider`          | `codex` or `claude`, from the Pool or runner configuration     |
| `--model`             | Optional agent model                                           |
| `NIBFIN_GITHUB_TOKEN` | Issues and Pull requests write, plus the reads in `src/github` |
| `NIBFIN_ACTOR_ID`     | The numeric id of the account the token writes as              |
| `NIBFIN_ACTOR_LOGIN`  | That account's login                                           |
| `NIBFIN_AGENT_HOME`   | The agent CLI's config home on the login volume (absolute)     |
| `NIBFIN_WORKSPACE`    | A checkout of the base branch by name, without persisted creds |
| `NIBFIN_TOOL_CACHE`   | The cache for `.nibfin.json` tools, outside the workspace      |

The provider never comes from a workflow or dispatch input. The token is never an
admin or dispatch credential; it is used only for the GitHub client and never printed
or passed to an agent, whose environment is the allowlist in `src/agent`. Unknown
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
- **Read-only roles** must find the workspace clean (`git status --porcelain
--untracked-files=all` empty) and leave it clean at the same `HEAD`; otherwise
  `STAGE_WORKSPACE_MODIFIED`.
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

Tests use a fake GitHub API, fake agent runs and a fake configuration; only `git`
runs for real, in repositories under the ignored `.test-tmp/`.
