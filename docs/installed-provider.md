# Installed Agent provider contracts

The administrator-owned host adoption is the provider authority. New shared pools
persist `providerBinding` in `/etc/nibfin/host.json`; peers copy that entire record.
It contains no credentials. `original` records the provider, original verified Core
installation pin, execution repository, member and both verified native Runner
IDs/names. `modelProfile`, `credentialKind` and `components` are replaceable
same-provider configuration. Components reference the verified Core source pin,
Agent image and code-owned adapter, runner, tool-channel and host-profile contracts.
Existing package/source and actual host isolation checks remain mandatory.

`provider-binding.mjs` owns identity and compatibility validation. The finite
identities are `codex` and `claude`. This release composes only Codex; Claude is
unavailable even if an administrator supplies all component names. A future
implementation must provide its compatible role adapter, model runner, credential
boundary, fixed work-tool channel and isolated host profile before enabling package
selection. No module path, command, registry or repository-defined implementation
can satisfy compatibility. Controlled tests are not live Claude or host certification.

Adoption obtains the provider from the trusted installation profile (`provider`,
defaulting to Codex for existing Codex installers), verifies the source, profile and
both native registrations, then stores the binding. Inspection, service startup,
Core adoption loading, slot selection, peer enrollment and rollout validate it.
The launcher selects `installedProviderExecutor` before preparing project tools.
Project configuration, Issue text, Workflow input, labels and environment cannot
select an implementation. Unknown identities, requested mismatches, incomplete
components, mismatched slot images and peer overrides fail before execution.
There is no cross-provider retry or fallback.

A missing binding is recognized as legacy Codex only with the supported host
schema/kind, valid installed Core pin, Codex model syntax, private-auth reference,
compatible isolated profile/image references and native pool identities. Absence
alone never enables execution. Actual source, credentials, native Job/Runner and
isolation verification still follow; structural compatibility is not proof of any
of those facts. Legacy peers must match the primary installation, model (when
present) and isolation profile. Explicit pools require exact binding copies.

Rollout preserves an explicit `original` record and rejects its replacement or
removal. The existing automatic rollout updates only the replaceable component
source reference along with the verified installation. Compatible model, image
and credential renewal retain provider identity and pool association. Recognized
legacy pools can continue through same-provider updates without inventing an
original record; when explicitly adopting a binding during an update, retain the
pre-update original record. Switching provider requires retirement and rebuilding
the pool. AGENT-4 implements retirement separately; these checks do not retire it.

## Component boundaries for downstream implementations

- **Role adapter (AGENT-2):** receives the trusted stage, Skill/context and model
  profile. `privatePlanContract` supplies the role/Skill, fresh-session rule and
  capabilities. `codexPlan` implements this in the existing private invocation.
  Only Deliver writes `/work`; Shaper, Validator, Acceptor and PR review read it.
  Scratch/check execution does not grant publishing, host control or credentials.
- **Model runner and credentials (AGENT-3):** consume the private plan and separate
  private authentication reference. Provider arguments, authentication and session
  state stay outside workspace tool inputs and public role results. Existing
  `CodexRoleAgent`, `RoleSessions` and `CodexSandbox` enforce fresh independent
  sessions, credential scanning, actual isolation and Candidate/result evidence.
  `codexStageExecutor` remains source compatible for existing installed callers.
- **Fixed work-tool channel (AGENT-7):** consumes only bounded role capabilities
  and workspace operations. It must enforce those bounds without forwarding
  model credentials, arbitrary trusted-host commands, Docker/host control or
  caller-selected executables. Codex currently uses the fixed isolated tool policy
  in `codexPlan` and the existing sandbox; this contract does not implement a
  separate Claude tool executor or permit a generic plugin.
- **Termination:** the runner returns `completed` or safely `interrupted`, bound
  to `executionId` and a confirmed `terminationHash`. Completion also binds policy,
  isolation and probe evidence. `requireModelTermination` rejects missing,
  mismatched or unconfirmed termination before workspace application. Safely
  interrupted work follows existing interruption handling. Unconfirmed termination
  throws and retains the existing session/Writer fences and Pending recovery;
  it never authorizes workspace acceptance, cleanup or subsequent execution.

No readiness assertion here replaces native package verification, single Writer,
Hooks, independent Acceptance, PR CI or Final Review. Claude adapter, credentials,
isolation, work tools, retirement and real deployment remain separately scoped.
