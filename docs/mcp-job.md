# Native MCP within an Actions Job

Candidate status: verification incomplete. The maintained transport now separates
Windows control proof from delegated response data. Native execution and the
required process/ACL matrix have not passed in this isolated Linux environment.
This documentation does not claim production support or authorized installation.

The trusted host launcher authenticates the native repository, member, Runner,
Run, attempt and Job, the adopted Caller and current approval before preparation.
It records an exclusive, fsynced acquisition claim before contacting the native
owner. All stage executors receive one immutable prepared profile. No later stage
reads native settings, renews access or replaces the profile. Existing approval,
delegation, token and egress expiry checks still apply.

Initial admission supports the single-step Action chain at
`0716d30b0b05e7f626fefa3c566b5941096f6312`, through the existing exact Caller
recipe verification. Other Callers fail closed. A second entry for the same Job
is refused, including concurrent entry, failed preparation, interruption and
entry after normal retirement. A new authorized Job needs a fresh acquisition.
The former persistent delegated-file source is not a Job acquisition fallback.

## Separate trusted adoption

These sources do not install, configure or start a Runner, service or scheduled
task. A separately authorized existing Runner startup context under the enrolled
Windows owner must start the installed `src/mcp-job-startup.mjs` with the adopted
Node executable once for an eligible formal Job. This arms a finite handoff;
manual arming is only a probe. A production startup integration has to adopt and
verify this invocation separately. General WSL interop stays disabled. Runner,
Agent, Hook and Workflow inputs receive no native launch capability.

The Windows owner privately adopts `C:/ProgramData/Nibfin/mcp-job.json` with
`schemaVersion: 1`, its exact `sid`, `repositoryId`, `memberId`, `runnerId`,
`distribution`, enrolled settings `home`, private `authenticationHome`, and the
existing package `pin` (repository, commit and manifest hash). `node`, `codex`,
`supervisor` and `wsl` each contain `path` and `sha256`. The supervisor is an
immutable build of the shipped `mcp-windows-job.cs`, prepared through trusted
installation, with its binary identity and `sourceHash` separately adopted.
The existing `prepareWindowsMcpReader` API returns both hashes and a private
build directory. An authorized installer first verifies the source package,
builds there and adopts the retained immutable result; it must not release an
adopted helper while it is installed. This Candidate performs no installation.
The Job does not compile it. Installed program files are retained. Source hashes, SID,
private ACLs and link/junction checks are verified before delegated output.

The fixed Windows program is `C:/Windows/System32/wsl.exe`. Its fixed arguments
select the adopted distribution, root, `/usr/bin/perl` and the installed
`/opt/nibfin/core/src/mcp-job-relay.pl`. A second fixed invocation adds only
`--response` to upload into Linux-private staging. Linux requires Perl with its core
Socket, IO::Select, JSON::PP, Digest::SHA and Cwd modules; this is an explicit
transport prerequisite, not an automatic dependency installation. Unsupported
hosts fail closed. Neither public task data nor an environment override selects
these executables, paths or identities.

The Linux administrator adopts `/etc/nibfin/mcp-relay.json`: `controllerUid`,
`controllerGid`, `repositoryId`, `memberId`, `runnerId`, `perlHash`, `relayHash`
and `directory: "/run/nibfin-mcp"`. Its parent, installed source, interpreter
and endpoint directory are protected root-owned paths. The directory must let
the controller traverse it; the relay creates `job.sock` root-owned, group
`controllerGid`, mode 0660, without replacing any existing endpoint. Kernel
`SO_PEERCRED` must match the adopted controller UID and primary GID before any
request reaches Windows. Host `mcp` becomes
`{"kind":"native-job-v1","controllerGid":988}` using the actual adopted GID.
No socket, command or destination is supplied by the Workflow.

## Protocol, liveness and retirement

The controller sends one bounded newline-terminated request containing a fresh
nonce and complete authenticated Job binding. The relay validates identity and
framing before forwarding it on inherited streams. Only then does the Windows
bridge start the fixed producer inside the supervisor's Windows Job Object.
Suspended assignment and a restricted handle list precede execution. Native
configuration and lawful access use the existing reader and delegation rules;
refresh credentials, model login and original settings are never exported.

The credential-blind outer native supervisor starts the bridge suspended, assigns
it to a non-breakaway Job Object, then resumes it with only three private pipes.
That job contains the bridge, inner producer supervisor, native reader, helper
descendants and response-upload wsl process. Native producer proof remains a
separate requirement. Bridge stdout carries only a fixed completion marker.

Delegated response bytes travel from the bridge through a second fixed wsl
invocation to a root-only `response.sock`, never through the outer supervisor.
The Linux relay validates uploader kernel identity, nonce and full Job binding,
stages one bounded response privately, acknowledges staging, and observes the
uploader PID disappear. The Windows upload process exits before the bridge exits.
The outer supervisor then terminates the entire outer job, observes zero active
processes, and sends its own proof on the original relay stdin. The bridge never
inherits that control write handle. A response field cannot substitute for this
proof; the relay alone adds `nativeTerminated` after receiving the control proof.

Only with native control proof, uploader absence and one valid staged response
does the relay release delegated bytes. The controller validates nonce, complete
binding and both termination fields, closes its request side, and independently
observes relay PID absence before profile admission. EOF and cancellation are
separate from these observations. Closing the controller request direction closes
the native request pipe and requests outer Job Object termination. Job status and
approval polling request cancellation instead of imposing a preparation deadline.
Existing native protocol/output limits remain. Lost proof, uncertain termination,
a surviving consumer or failed output scan retains Pending and the host fence.

Restricted discovery runs once into the Job profile. Role output scans finish
before per-consumer private configuration and egress leases retire. The launcher
removes generated source copies only after all tracked consumers finish and its
normal host/container inspection succeeds. A failed preparation is never retried.
Original configuration, OAuth stores and installed verified helpers are retained.

Claims in `stateRoot/mcp-jobs` contain only Job bindings. Retiring `.copies` does
not remove claims. There is no stale-PID, elapsed-time or automatic deletion rule.
Administrative retention may be bounded only after independently establishing
that the native Job can no longer authenticate, its authorization is retired and
all unknown effects are reconciled. These claims are replay protection, not a
parallel delivery or recovery database.

Maintained fixtures are synthetic. Native Windows process/ACL tests and the
cross-system adopted startup route require their actual platforms; local unit
results do not establish logged-in native-to-Agent integration. MCP-LIVE, host
installation, exact-head package CI and independent Acceptance remain separate.

The bounded replay guard fails closed at capacity. Reconcile terminal Jobs
under the trusted host recovery procedure before retiring old guards.
