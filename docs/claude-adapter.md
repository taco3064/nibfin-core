# Bounded Claude component

`claude-plan.mjs`, `claude-result.mjs` and `claude-agent.mjs` implement the
component adapter only. Installed provider composition still rejects Claude.
No live authentication, host isolation or complete Claude support is claimed.

The trusted caller supplies the stage, protected effective Skill, context and
model profile. Component configuration pins the official unmodified
`@anthropic-ai/claude-code` CLI version at `/opt/nibfin/claude/bin/claude`.
The adapter never installs or substitutes that executable. The trusted runner
must verify the configured installation before launching it without a shell.
Issue and repository text remain stdin data; they cannot select flags or tools.

The private plan requires a fresh clean `/session` and config directory, no
repository mounts in the model container, bare JSON print output, disabled
built-in tools, disabled native Skills and hooks, no persistent sessions and
only the fixed `work` MCP endpoint. Workspace paths in the Core prompt describe
resources accessible through work tools, not model-container mounts.

The component channel identifier is `claude-scoped-work-v1`. Its exact tools
are `mcp__work__read`, `mcp__work__check`, and, for Deliver only,
`mcp__work__write`. The separately owned work channel must expose exactly that
set and enforce Core role capabilities, including scratch/check limits. It
must not accept arbitrary executables, host control or private model settings.
An unavailable compatible channel is a prerequisite failure. The model adapter
declares the stdio server; AGENT-7 implements it.

### Stdio handoff

- The trusted model launcher packages the fixed AGENT-7 bridge at the command
  returned by `claudeWorkServer()`. The Core-owned Claude configuration names
  it as `work` and supplies empty arguments and environment overrides. The
  launcher verifies the compatible CLI actually strips the model credential
  from this child and starts Claude with a scrubbed environment.
- The bridge forwards MCP over the private Unix socket at `claudeWorkSocket`.
  The launcher exposes only that socket's per-execution directory to the
  model and its matching tool worker. The worker verifies the approved
  remapped peer identity on that private socket and associates the connection
  with the trusted execution. Project files, other executions, model keys and
  controller sockets are outside that handoff.
- The worker calls `bindClaudeWorkChannel(stage, executionId)` with its
  trusted admission values, then checks the authenticated connection's
  execution identity and the named operation before dispatch. MCP request
  data never assigns either the execution identity or stage. The worker
  owns bounded request schemas, workspace checks and process termination.
  The model launcher does not report completion until both sides settle.

The injected runner implements `claude-private-runner-v1`:

- `execute({plan, executionId, session})` verifies installation and isolation,
  enforces the plan's stdin/stdout/stderr byte bounds and timeout during process
  execution, and returns collected output plus independent termination evidence.
  It owns private authentication and never forwards it to work tools.
- `requestCleanup(executionId)` requests process cleanup on every execution exit,
  including executor exceptions. Its completion alone is not termination proof.
- `assertOutputSafe(executionId, stdout, stderr)` scans against private credentials
  and session/configuration data, returning exactly `true` only on safe output.
  Public diagnostics contain fixed error codes, never raw provider errors.
- `retire(executionId)` retires disposable private resources only after the
  adapter has validated termination and output safety. Invalid results retain
  the session fence conservatively for trusted recovery.

Execution results follow `requireModelTermination`: `completed` binds execution,
policy, isolation, probe and termination evidence; `interrupted` still requires
confirmed termination. Timeout, CLI exit and cleanup requests cannot create those
facts. The runner reports `timedOut`, `outputLimitExceeded`, `exitCode`, `stdout`
and `stderr` separately. Unknown termination retains the existing RoleSessions
fence. Raw runner exceptions are suppressed because they may contain secrets.

Only a single official successful result envelope with `structured_output` can
produce validated Core role data. Duplicate JSON members, concatenated results,
provider errors and invalid closed-schema data fail. Official transport metadata
is discarded. Core alone applies workspace changes, captures the Candidate and
constructs authoritative receipts; this component performs none of those steps.

Local executor doubles exercise this interface. Actual runner enforcement,
authentication, credentials, mounts, network, process cleanup and live integration
remain AGENT-3/AGENT-7 responsibilities and require their own integration evidence.
