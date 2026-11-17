# Managed Controller credentials (Linux candidate)

The administrator command is `nibfin-core managed-credentials` followed by
`intake`, `replace`, `status`, or `disconnect`. This is an installed, root-only
Core entry. It is not available through the Runner relay or workflow inputs.
CLI-1 owns selecting the installing user's github.com login. Core does not
inspect gh stores, editor environments, or unrelated session homes.

For intake and replacement, CLI-1 supplies a private owner-only FIFO as stdin.
The UTF-8 JSON envelope has exactly these fields:

- `schemaVersion`: `1`.
- `githubToken`: the selected github.com token, at most 16,300 characters.
- `codex`: the compatible ChatGPT subscription `auth.json` object, with
  `auth_mode: "chatgpt"` and `tokens.access_token`, `tokens.refresh_token`, and
  `tokens.id_token`. Optional `tokens.account_id` and `last_refresh` are retained.

The complete envelope is limited to 65,536 bytes and ten seconds of input.
Do not put this envelope in arguments, environment variables, a repository,
command output, installation PRs, Actions, Runner, Agent, or Hook inputs.
Unsupported active Codex authentication requires the dedicated Controller login
path; Core returns `MANAGED_CODEX_DEDICATED_LOGIN_REQUIRED`. The caller must
not substitute credentials from an unrelated session.

The installed host configuration supplies the member and repository identities.
For first adoption, the fixed administrator command
`nibfin-prepare-managed-onboarding.mjs --consent-dedicated-engine` accepts a
bounded nonsecret installation record on stdin. It verifies the installed
source, prepares the dedicated Engine and managed resources, and records the
binding in the root-owned `/etc/nibfin/credential-intake.json` file. Manual
profiles may still supply the same binding as `credentialIntake`. The binding
has:

- `schemaVersion: 1` and the intended numeric `memberId`.
- `installation`, containing the fixed `/opt/nibfin/core` directory and its
  approved existing source `pin`, in the usual host installation representation.
- `repositories`, an array of two `{ repository, repositoryId }` objects for the
  execution and target repositories (they may identify the same repository).

These are administrator-adopted installation facts, not pipe input or a new
repository permission ledger. After host adoption, Core derives the identities
from the current host's execution, target, and adopted peer configurations.
Core verifies the installed source before consuming input. First intake reuses
existing managed account/directory setup. It does not register Runners or start
services. Source preparation and local installation remain privileged host tasks.

Managed paths are fixed under `/var/lib/nibfin/controller`: `state`,
`credentials/github-token`, and `codex/auth.json`. Directories are canonical,
Controller-owned mode 0700; credentials are single-link, Controller-owned mode
0600 files. Core verifies GitHub `/user`, repository numeric identities, and
native administrator permission for each required repository before publication.
The token retains its actual provider permissions; private storage does not
attenuate them. Original gh and Codex stores remain untouched.

The private `credentials/managed.json` records lifecycle state and owned file
identities, not token values or repository authorizations. Intake refuses manual
files. Replacement requires active managed state and the same bound member.
File publication is exclusive for intake, checked against owned inodes for
replacement, atomic per file, and synchronized with its parent directory.
An interrupted multi-file publication remains `installing`, blocking admission.
Temporary publication files are removed on errors. Unexpected file identities
are conflicts; Core does not overwrite or delete them.

Managed admissions register private consumer leases while holding the lifecycle
mutex, then run concurrently using the existing Issue fences and journals.
Replacement requires all consumers and effects to be settled. Disconnect first
sets `disconnecting`, stopping new work, and removes credentials only after
leases, stage/recovery fences, and pending journal effects are settled.
An unknown process or effect remains Pending; no automatic kill or blind retry
is performed. A crash-retained mutex or consumer lease also remains Pending and
requires trusted host recovery that proves termination. Existing bounded
commit/review reconciliation remains available while disconnecting or access is
unauthorized; it does not authorize new remote effects. Status exposes only safe
metadata and distinguishes provider unavailability (Pending) from unauthorized
access (Denied), while reporting the installed lifecycle phase separately.

GitHub CLI logout alone does **not** revoke an imported token. Disconnect removes
Controller-managed files only. It does not revoke unrelated provider grants or
silently switch accounts. Reconnection uses fresh same-member intake after a
completed disconnect. This Candidate's local tests use fake credentials and
private temporary directories; live provider and clean-host installation support
remain unverified until the existing installation/release acceptance process.

The legacy automatic host rollout adapter uses gh environment authentication for
manual installations. It refuses managed credentials before reading them, under
the same credential mutex. An installed copy must match the verified Core copy
and its service must be inactive before intake. Managed credentials do not enable
that legacy automatic-rollout adapter; privileged Core operations use managed
admission instead. This change installs or reconfigures no service. Updating and
quiescing an existing legacy service belongs to the authorized host installation
process, not the credential pipe or the Runner.
