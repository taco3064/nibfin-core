# Host OS and verified execution environments

Core has one authorization and delivery contract. Primary OS, Runner OS and
container OS are separate facts. Windows/macOS users need not replace their
daily OS or obtain a physical Linux computer. Implemented is not live-verified.

## Coupling audit

| Component | Security contract versus implementation |
| --- | --- |
| `host-launcher.mjs` | Trusted adoption and native OIDC/job binding are required; root-owned `/etc` and installed paths implement the current Linux backend. |
| `operation-journal.mjs` | Durable intent, exclusion and unknown-write Pending are required; UID/mode, no-follow opens, directory sync and replacement are current Linux mechanisms. |
| `host-fence.mjs` | Single Writer and reconciliation before release are required; canonical private directories and exclusive files currently use POSIX semantics. |
| `codex-sandbox.mjs` | Existing Linux backend: rootless daemon, fixed UID/socket, resource limits, isolated proxy, upstream seccomp/AppArmor, actual denial probes and cleanup. |
| `sandbox.mjs` | Existing Hooks backend: same rootless daemon, fixed mounts, dropped privileges, no network and verified cleanup. |
| `codex-agent.mjs` | Independent roles, restricted subscription access and verified outputs are invariant; UID/private-file and mount handling remain backend-specific. |
| `runner-binding.mjs` | Reads actual native OS and checks an adopted OS pin when present. Native identity does not establish backend safety. |
| `native-stage.mjs` | Shared authorization, handlers and writes; journal/store remain POSIX implementations. |
| `stages.mjs` | Shared Scope/Shape, Candidate, Accept, CI and merge rules; environment eligibility delegates to `execution-profiles.mjs`. |
| `stage.yml` | Explicit Linux routing for this fixed launcher; no Candidate checkout or native container job. |
| Other host code | `workspace`, `evidence-store`, `role-sessions` and `agent-mounts` use POSIX ownership/modes; `process` uses Linux process-group termination. Windows ACL/macOS equivalents are unverified. |

The finite installed profile list lives in `execution-profiles.mjs`.
`codex-environment.mjs` composes fixed Agent/Hook adapters and refuses different
Docker endpoints. Issues, workflow inputs and Agents cannot register profiles or
select adapter modules. Profile names alone prove no isolation. All existing
Linux preflights and mandatory probes still run unchanged.

## Actual support status

| Configuration | Evidence and remaining limit |
| --- | --- |
| Linux Runner + rootless Docker + required AppArmor | Existing implementation retained; remote isolation probes are linked in `migration-status.md`. Authenticated protected Dispatch and complete delivery remain unverified. |
| Windows + Docker Desktop Linux containers | Candidate only. On 2026-11-04, local assessment found no Docker CLI, Desktop in standard machine/per-user locations, Docker service or process. No Desktop container test was possible. |
| macOS + Docker Desktop Linux containers | Candidate only; neither a backend nor an actual macOS host was tested. |
| Local WSL Linux | Rootless Docker available, kernel AppArmor disabled. Does not satisfy the existing Agent backend. No security control was disabled for compatibility. |
| Windows Codex subscription CLI | Agent role functionality is separate from container isolation, native admission and protected delivery. |

Desktop's Linux VM does not prove rootless equivalence, host ACL isolation,
mount-path translation, private subscription access, restricted egress,
termination or single Writer exclusion. Each needs actual positive/negative
evidence. No Desktop profile, automatic fallback or user-controlled adapter is
implemented. GitHub native container jobs/actions/services require Linux runners;
a future host-side Desktop path is not a `jobs.container` shortcut.

Official references: [GitHub Runner requirements](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[Docker Desktop WSL](https://docs.docker.com/desktop/features/wsl/),
[Windows Docker permissions](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/).

## Remaining Core #1 work

C14 now includes hosted Issue-event/Dispatch wiring and bounded stage
continuation under the existing host fence. Actual Runner/OIDC, independent
authenticated Agent stages and complete external execution remain unverified. A legal test Issue and approval are required; manual #1 cannot substitute.
C17 still needs sufficient runtime evidence, reviewed source, authorized formal
publication and publisher/source/asset read-back. Phase 0 needs one safe route,
not an all-OS matrix or three-repository self-delivery E2E.
