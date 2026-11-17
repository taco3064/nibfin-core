# Bounded Claude component

`claude-plan.mjs`, `claude-result.mjs` and `claude-agent.mjs` implement the
component adapter. `createClaudePrivateRunner` supplies the model launcher.
Installing Claude as the selected provider is a separate integration step.

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

### Private model package

`src/security/claude-model.Dockerfile` uses the pinned upstream binary for the
native platform and includes the fixed stdio bridge. The host supplies a
separate model-only bridge and gateway running `claude-model-proxy.mjs` with
the shared HTTPS transport. The gateway permits `api.anthropic.com` and
requires the same isolated-network readback as the work gateway.

The administrator intake entry accepts an API key over a private pipe on an
adopted host. The model launcher sends it over container stdin, sets it for
the official Claude process and checks that model output contains no key.
The packaged stdio bridge rejects a child environment containing that key.
Provider selection and real-account verification remain separate.

### Work bridge and Linux worker package

AGENT-7 now supplies `bin/claude-work-tools.mjs` and
`src/claude-work-bridge.mjs`. Install the executable as
`/opt/nibfin/claude/bin/work-tools`, preserving the adjacent `../src` module
layout from the maintained Core package. Mark the executable executable.
`claudeWorkServer()` remains the sole authority for its invocation and endpoint;
no environment variable or command argument selects a transport. The bridge
forwards newline-delimited stdio MCP with backpressure and finite frame bounds.
The model launcher must still verify that its credential is stripped from this
child; this package does not enable installed Claude support.

`src/security/claude-work.Dockerfile` packages the credential-free worker with
the required Python 3.13.7 runtime. Its `PROJECT_IMAGE` build argument is Core's
maintained project tool image, never a repository/model-selected image. Package
inputs include the worker, protocol, filesystem and limits files.

The trusted composing runner constructs `ClaudeWorkWorker` from
`src/claude-work-launcher.mjs` with the verified rootful remapped backend,
Docker configuration, and admission `{executionId, stage, peer, work, main,
input, session}`. Each source/session directory must have a controller-owned
0700 parent; paths must be disjoint and contain no initial symlinks or hardlinks.
The session must be fresh. `peer` is the approved model UID/GID in the host's
remapped namespace. It must differ from the worker's remapped UID/GID 1000;
for example, the isolated model may use namespace UID/GID 1001. The model gets
only its matching channel directory at `/session/work-channel`, mounted read-only.
No project, admission, credential or Controller mount belongs in that container.
The worker authenticates actual Linux `SO_PEERCRED`, not MCP-supplied identity.
A connection belongs solely to its immutable admission and private socket.

The runner also supplies an `egress` descriptor `{network, gatewayId, image,
directory}`. It owns that execution's private isolated Docker bridge named
`nibfin-work-<UUID>` and its package-only gateway. Before worker creation, the
network must contain only the indicated gateway. `directory` contains unchanged
`egress-proxy.mjs` and `claude-package-proxy.mjs`, mounted read-only at
`/proxy/<filename>` in the gateway. The gateway uses entrypoint `node`, command
`/proxy/claude-package-proxy.mjs`, a read-only root, dropped capabilities and
no-new-privileges; its environment must match its credential-free image.
The existing proxy enforces HTTPS, public upstream addresses and matching TLS
SNI for the shared package download allowlist only. No provider authentication
or user MCP policy is attached. Worker inspection refuses extra networks,
mounts, privileges, devices or environment entries. Project commands receive a
clean environment and the verified package proxy, with no Docker socket.

The MCP tool names are `read`, `check` and (Deliver only) `write`, exposed by
Claude under the existing `mcp__work__*` names. `read` takes `surface` (`work`,
`main`, `input`), relative file `path`, and optional literal `search` text;
search returns matching numbered lines. `write` takes relative `path` and UTF-8
`content` and affects only `/work`. Parent directories must already exist.
Paths reject traversal, symbolic links, hardlinks, special files and `.git`.
`check` takes project shell `command` text, executed in `/work` inside the
worker. Only Deliver receives a writable `/work`; `/main` and `/input` always
remain kernel-enforced read-only mounts. Other roles can use private `/tmp`.
Shell text never selects the trusted worker executable, mounts or Docker API.

`claude-work-limits.json` is authoritative for request/response, file/command
output, runtime and worker lifetime limits. Malformed and unauthorized requests
return fixed bounded errors. Timeout, command output exhaustion, socket EOF
and cancellation retire the worker process; Core must still reconcile its
container. Concurrent requests during a running check interrupt that worker.
The MCP client should serialize work calls.

Use `withClaudeWorkWorker(worker, async handoff => ..., {signal})` around the
model runner, including model errors, cancellation and normal completion.
The model runner independently proves model termination using its existing
contract. The wrapper settles the worker and refuses to return successfully
without confirmed worker termination. `settle()` force-removes the uniquely
named container and independently reads back its absence; CLI exit and cleanup
requests alone are insufficient. Unknown settlement retains admission resources
and `requireSettlement()` throws `WRITER_TERMINATION_UNKNOWN`. Retain the Writer
and session fence in that case. After confirmed settlement the launcher removes
its admission file and channel directory. The composing runner then performs
normal remapped-workspace reclamation and Candidate capture, and retires its
own gateway/network only after all consumers have terminated.

Local tests cover actual Python filesystem operations, native Unix peer
credentials, bounded framing and subprocess limits. Docker, model and host
isolation scenarios use explicit executor doubles. Building and probing the
packaged worker on the managed remapped Docker host, and full Claude composition,
remain unverified by these local component tests.
