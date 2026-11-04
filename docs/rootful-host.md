# Controlled rootful Docker host

`linux-rootful-docker-v1` is an explicitly adopted Linux container backend.
Windows can remain the user's primary OS. This backend does not establish
Docker Desktop or macOS support, and does not change delivery authorization.
The existing rootless backend remains available with its original preflights.

## Privilege boundary

Use separate non-root Linux identities for the GitHub Runner and controller.
The root-owned adoption file sets `uid` to the controller and `runnerUid` to
the Runner. Both must be positive, distinct and below 65536. Every Issue on
this host uses the rootful profile. State, journals and authentication files
remain private to the controller; they must not be readable by the Runner.

The dedicated daemon socket is fixed at `/run/nibfin-engine/docker.sock`.
Its root-owned canonical parent must not be group/world writable. The socket
must be root-owned mode 0660, with only the controller in its access group.
The Runner must have neither socket access nor membership in any Docker group.
Host admission reads the Runner's account groups and actual running process
groups, including stale supplementary memberships. It refuses named ACLs on
the dedicated socket and parent. Install the standard `acl` package providing
root-owned `/usr/bin/getfacl`; unreadable membership/ACL evidence fails closed.
Before initial adoption, stop and reconcile old Runner processes and establish
a clean service start with no Docker membership. A process snapshot cannot
repair previous privilege exposure or atomically stop a privileged forking
process. The root-owned Runner service grants no Docker access or general sudo.
Its only allowed identity transition is the exact launcher described below.
Runner-level `NoNewPrivileges=yes` would block that setuid sudo transition;
do not claim it is active. All container no-new-privileges controls remain required.
Socket access is effectively host-root authority: user namespace remapping
restricts containers, not the daemon's authority. Do not share this daemon
with unrelated workloads or grant its group to workflow processes.

An administrator installs verified Core at `/opt/nibfin/core`, including the
executable `bin/nibfin-controller`, and the exact Node version from
`.node-version` at `/opt/nibfin/tools/node-v<VERSION>-linux-x64/bin/node`.
Code, runtime, launcher and their ancestors must be administrator-owned and
not writable by either execution identity. The only sudo permission is the
fixed launcher, with **no arguments**, as the controller identity. For example,
substitute the actual fixed account names in this administrator-owned rule:

```sudoers
nibfin-runner ALL=(nibfin-controller) NOPASSWD: /opt/nibfin/core/bin/nibfin-controller ""
```

Validate the rule with `visudo -cf` before enabling it. Do not authorize a
shell, Node, `env`, Docker, arbitrary arguments or environment preservation.
The launcher clears inherited environment, selects the installed runtime and
passes only the sudo-provided invoker UID to its fixed JavaScript entry.

The existing CLI relays a bounded stage request or raw Issue-event bytes on
stdin. It cannot select privileged files, modules, commands, sockets or policy.
Only seven native Actions identity/context fields cross the boundary. These
remain untrusted claims until existing native job, source, approval and OIDC
checks pass. The controller reuses the existing stage/wake entry and fence.
There is no additional listener, scheduler or alternative authorization path.
Pre-job hooks are not a substitute for this OS identity separation.

## Container capabilities

The administrator adopts `isolation.namespace` with exact `uidStart`,
`gidStart` and `size: 65536`. Both starts must be at least 65536 and match
the dedicated daemon's non-overlapping subordinate allocation. Container IDs
0 through 65535 map only into these ranges; host root, Runner and controller
UIDs are excluded. The preflight reads actual kernel UID/GID maps inside a
credential-free container. Docker metadata alone is insufficient.

Both adapters use `/usr/bin/docker` and the fixed dedicated socket. Retain
systemd cgroup v2 limits, builtin seccomp, enforced AppArmor, dropped
capabilities, no-new-privileges, restricted mounts and the existing network
policy. Rootful Hooks also prove the actual AppArmor label and maps before
mounting their workspace. Hook containers remain offline. Only bounded
remapped-root cleanup may reclaim the known work directory after verified
container absence; uncertain cleanup stops Pending.

The shipped AppArmor policy denies fresh procfs mounts. This prevents Codex's
nested sandbox from overlaying the masked `/proc`. It retains the original
inner denial probe and its positive execution control. Never omit a failing
probe, replace actual enforcement with Docker inspect fields, or disable
AppArmor to admit a host.

## Observed evidence and remaining work

On 2026-11-04, an Owner-authorized WSL Linux host used a separate remapped
Docker 29.9.1 daemon, Node 24.22.1 and Codex 0.138.0. As controller UID 999,
actual Hooks passed the offline positive case and rejected exit 17. The
unchanged Codex denial probe passed, including execution control exit 37.
The production adapter passed its sandbox probe, refused synthetic missing
login and cleaned its containers. The Runner identity was denied socket
access. These observations used public source and synthetic authentication.
They do not prove an authenticated role, native Runner/OIDC or complete E2E.

The public image recipe is `src/security/agent.Dockerfile`. Adopt the actual
immutable image ID observed on the target daemon; a tag is not an image pin.
It includes Git for the existing applicable Hooks. Never import private user
images or login material into a build context.

Before adoption, independently review the installed source and privilege rule,
verify private credential access and real Runner invocation, and test failure
and cancellation across sudo. A canceled or timed-out relay is not evidence
that the privileged child or external write stopped. Preserve the durable
fence and Pending journal until processes, containers and native effects are
reconciled. Do not retry blindly or delete a lock based on job/PID age.

References: [Docker socket authority](https://docs.docker.com/engine/install/linux-postinstall/),
[user namespace remapping](https://docs.docker.com/engine/security/userns-remap/).
