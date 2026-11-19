# Installed official Runner identity

Managed slots keep the official Listener and rename the official Worker to
`bin/Runner.Worker.official`. The existing dispatcher and Worker admission remain
in place. Node and Core package verification still use the Core package contract.

GitHub documents both automatic updates and externally maintained runners using
`--disableupdate` in its [self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#runner-software-updates-on-self-hosted-runners).
These managed slots retain external maintenance because their Worker is a
dispatcher. This change does not implement refresh, change registration, replace
that dispatcher, or claim compatibility with every future Runner protocol.

## Installer interface

`src/installed-runner-identity.mjs` exports:

- `officialRunnerArtifact(release, arch)`: select exactly one canonical Linux
  artifact from authenticated `actions/runner` release metadata. Require the
  official archive URL and its API-provided SHA-256 digest. No Core Runner version
  allowlist participates in this selection.
- `deriveOfficialRunnerIdentity(archive, release, arch, local)`: verify the
  root-owned archive digest, extract the two executable members to memory, check
  ELF architecture, and derive their digests. `local` is native `.runner` data.
  Fetch release metadata through the trusted installer's authenticated official
  endpoint; caller-controlled JSON or a local digest alone is not provenance.
- `installedRunnerIdentity(value, local, target)`: validate the record shape,
  official artifact identity, architecture, and native registration binding.
- `verifyRunnerIdentityFiles(directory, identity, target)`: verify ownership,
  architecture, and actual installed Listener/original Worker digests.

Bootstrap archive verification and installed-fact derivation both use
`src/shared-archive-members.mjs` for trusted tar inspection, member selection and
one-member-at-a-time extraction. Their provenance and executable verification
remain with each consumer. `sharedArchiveMember` remains re-exported from
`shared-artifacts.mjs` for existing callers.

`src/installed-runner-state.mjs` exports:

- `publishInstalledRunnerIdentity(directory, identity, target)`: recheck native
  registration and installed executable bytes, then atomically publish and sync
  `.nibfin-runner-identity.json` as root-owned, non-writable metadata. Call this
  only from the trusted installer after deriving facts from its verified package.
- `readInstalledRunnerIdentity(directory, local, target)`: inspect metadata and
  verify the installed files against it. Startup and pre-Node Worker validation
  read the same slot record. No network access or registration change is needed.
- `ensureInstalledRunnerIdentity(directory, local, target)`: bootstrap install
  completion and migration. Reuse a confirmed valid record without rewriting it.
  Reconstruct missing/stale metadata only when installed bytes independently
  match the trusted bootstrap package. Unknown bytes are refused.

The schema contains `schemaVersion: 1`, canonical `arch`, `release`, the official
`artifact` (`name`, `url`, `sha256`), native `registration` (`id`, `name`, `url`),
and `listenerSha256` / `workerSha256`. Executable hashes are archive-derived
integrity facts, not manually maintained workflow prerequisites.

## Recovery and compatibility

Fresh bootstrap installation publishes facts before admitting the staged slot.
Existing legitimate bootstrap slots can start without metadata using the known
bootstrap package bytes; the next installer invocation automatically publishes
their record. Ownership alone never enrolls an unknown executable.

A later Runner refresh must derive facts from its selected verified official
archive and publish them after installing the matching bytes. It need not edit
`shared-platform.json`. Keep registration, private credentials, external
maintenance mode, dispatcher, and admission protections unchanged.

The installed administrator's `refresh-runner-runtime` operation now consumes
these facts for preview, refresh and interrupted-operation recovery. See
[official Runner software maintenance](runner-runtime-refresh.md) for the external
invocation boundary, service-state preservation and continuation results.

If metadata from a newer install is lost or stale, re-enter that install with its
verified archive and republish the facts. The bootstrap compatibility path cannot
attest arbitrary newer bytes. Observation errors retain their original error and
use the caller's normal retry path. No timer, global lock, fixed release gate,
or manual hash update is added.

## Verification

`test/installed-runner-identity.test.mjs` runs architecture, provenance selection,
registration binding, changed-byte refusal, unavailable observation, and legacy
fallback tests with controlled ports on all supported development hosts. Its Linux
root case creates a repository-local real archive and checks actual publication,
confirmed-state reuse, both readers, simulated bootstrap migration, stale-record
recovery, and refusal to enroll unknown bytes. The fixture is synthetic ELF data,
not an executed official Listener or a live registration. Core Node selection is
mocked only in the Python Worker probe; its maintained bootstrap tests remain
separate. Windows skips that root case explicitly.
