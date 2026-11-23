# `src/agent`

Runs a role through an agent CLI and loads the repository's `.nibfin.json` settings.
Owned by #668 (CLI runner) and #669 (`.nibfin.json`).

## CLI runner

`runAgent({ provider, workspace, prompt, home, model? })` runs Codex or Claude Code
headless in `workspace` and returns `{ exitCode, finalMessage }`.

- **Login.** `home` is the CLI's config home on the login volume, passed as
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Only the CLI reads its login there; Nibfin never
  opens credential files.
- **Environment.** The CLI, its login-status command and rulesync get only `PATH`,
  `HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, the proxy variables (`HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY` and their lowercase forms) and the config-home variable.
  Stage credentials such as `GITHUB_TOKEN` and `GH_TOKEN` never reach them.
- **Agent config.** When the workspace has `.rulesync/`, `rulesync --json generate`
  writes the provider's rules, MCP and skill files first. The written paths go to the
  repository's `info/exclude`, so they are never committed.
- **Trust.** Codex saves project trust itself through `--trust`. For Claude Code,
  `enableAllProjectMcpServers: true` is merged into `<home>/settings.json`, keeping
  every other key; the file is replaced atomically and left alone when already set.
- **Prompt and output.** The prompt goes on stdin. The CLI's stdout and stderr are
  forwarded to the Job log unchanged.
- **Final message.** Claude Code: the `result` message of `--output-format stream-json`.
  Codex: the `-o` file, kept at `git rev-parse --git-path nibfin-last-message` and
  removed after the run.
- **Failures** throw `AgentError` and keep the CLI's exit code:
  - `AGENT_LOGIN_REQUIRED` with the re-login command `gh nibfin login --provider <p>`,
    when the stream reports a rejected login, or `claude auth status` /
    `codex login status` exits 1.
  - `AGENT_RUN_FAILED` for any other non-zero exit, or a run without a final message.
  - `AGENT_CONFIG_GENERATION_FAILED` with rulesync's exit code and output.
  - `AGENT_CONFIG_INVALID` when `settings.json` is not a JSON object.

Headless commands:

- `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions
--model <model>` (default model `opus`)
- `codex exec --json --trust --dangerously-bypass-approvals-and-sandbox -o <file>
[-m <model>] -`

Bypass mode needs a non-root user in the container (#666). Executables are injectable
through `executables`; tests use fake CLIs written as small Node scripts under the
ignored `.test-tmp/` directory.
