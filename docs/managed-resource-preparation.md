# Managed Linux resource preparation

After installing the verified Core package and preparing its dedicated Engine,
run the fixed administrator executable on the native Linux AMD64 or ARM64 host:

```sh
sudo /opt/nibfin/core/bin/nibfin-prepare-shared-host.mjs \
  --consent-resource-preparation
```

The consent flag is the only input. Core verifies the installed package and
existing Engine ownership, builds both maintained images without requiring a
cache, loads its packaged AppArmor policy, checks enforcement and both namespace
maps for each slot, and creates `nibfin-managed-egress`. Docker's default bridge
is not the egress resource. The schema-v1 root-owned profile is published at
`/etc/nibfin/shared-host-profile.json` only after those checks pass. Credentials
and Runner registrations are neither inputs nor outputs of preparation.

`consumerContract.managedResourcePreparation` describes the executable and its
finite interface. A `prepared` result identifies inspected image IDs and the
profile path, with `adoption: false` and `servicesReady: false`. `denied` rejects
configuration; `pending` requires reconciliation of unresolved effects. Exit codes
are 0, 1 and 2 respectively. Diagnostics never include credential or exception text.

The separate journal is `/var/lib/nibfin-resource-prepare`. Retry verifies owned
resources and refuses foreign resources, profile conflicts, changed package inputs,
image drift or uncertain probes. Do not delete recovery files to force retry.
Uncertain effects retain the public admission guard
`/etc/nibfin/resource-preparation.pending`; credential consumers cannot admit work
until preparation completes. Admissions hold shared kernel leases on the stable
root-owned `/opt/nibfin` directory from the guard check through the entire operation,
including manual-profile and initial-adoption paths. Preparation takes an exclusive
lease before initialization or mutation. Concurrent admissions remain supported;
a conflicting lease returns `pending` with `RESOURCE_PREPARATION_PENDING` and can
be retried after the active operation settles. A failed preparation retains its
admission guard even after releasing the lease. Core never overwrites an existing
manual profile.

Agent acquisition uses digest-pinned base images, an authenticated immutable
Debian snapshot and an npm integrity lock including native Codex dependencies.
The Hook recipe derives from the inspected Agent ID and removes the model CLI;
Hook execution remains offline under the existing sandbox contract. Building
requires access to the pinned base registries, Debian snapshot and npm registry.
Acquisition builds use fixed host networking with verified recipes and no private
inputs, so they also work without a default Docker bridge. Runtime Agents still
use registration-bound controlled egress and Hooks remain offline. No image
import, manual Docker setup or policy editing is required.

The generated profile keeps the maintained model default from
`src/managed-model.mjs`, fixed private credential references and distinct slot
policy directories. Supply credentials privately through the existing credential
flow and adopt separately using two real offline registrations. Adoption retains
provider/model authentication, registration-bound gateways and relay verification.
Preparation does not start services or certify a supported clean-install E2E.

For a live repeatability smoke on an authorized disposable host:

```sh
sudo node /opt/nibfin/core/src/managed-resource-smoke.mjs \
  --consent-resource-preparation
```

This runs real preparation twice without credentials or registrations. Offline
fixture tests do not establish kernel, acquisition or host deployment success.

Native image inputs are resolved before managed resource effects. The public
Agent recipe remains authoritative for the reviewed Node and Go source indexes;
Core requires unique Linux amd64 and arm64 child manifests in each pinned index.
It pulls the selected immutable children on the verified dedicated daemon,
checks their native platform, and renders only those references into the managed
Agent recipe. No tag fallback, emulation, caller-supplied recipe or alternate
version is used. Missing/malformed indexes, missing children and unavailable or
wrong-platform inputs produce bounded `RESOURCE_INPUT_*` diagnostics.

The resolved source references, child references, target platform, recipes and
versions participate in recovery input identity. Existing amd64 image names stay
unchanged; arm64 names have an `-arm64` suffix. Old or different input journals
remain conflicts requiring reconciliation, rather than authorizing image reuse
or automatic replacement. Builds with uncertain effects retain Pending.

Before profile publication, each isolated slot probe also executes the pinned
bootstrap Node, npm, Go and companion formatter. Agent probes execute native
Codex; offline Hook probes never require the removed model CLI. These checks run
on reuse as well as initial preparation and remain under the existing offline,
unprivileged container limits and trusted cleanup/termination checks. Native
executable failures return `RESOURCE_NATIVE_EXECUTABLE_UNAVAILABLE`.

The maintained browser profile supplies Chromium runtime libraries and fonts;
preparation checks their native dependencies and font availability, reporting
`RESOURCE_BROWSER_INPUT_UNAVAILABLE` if absent. It does not install a browser
binary for projects that do not request one. Project browser packages and their
pinned binaries remain native package/lockfile inputs, rather than additional
`.nibfin.json` tools. Actual Chromium launch and browser tests belong to that
project's selected package profile; a library probe alone does not certify a
browser version or clean-install browser availability on either architecture.
Native Ubuntu 24.04 amd64/arm64 acquisition, kernel enforcement, browser execution
and clean-install support claims still require their actual environment results.

## Online storage reclamation permission

Managed preparation installs and reads back a root-owned sudoers policy allowing
only `nibfin-controller` to run `/opt/nibfin/core/bin/nibfin-reclaim` as root,
with no arguments. The existing Runner-to-Controller relay grant is unchanged;
Runners and Agents receive no direct root reclamation permission.

Normal package promotion invokes the verified promoted package's installer before
recording update completion. An interrupted publication can retry the same update:
an identical owned policy is reused, while a foreign or conflicting policy is
refused. Package replacement alone does not establish permission installation.

The helper verifies installed runtime/source ownership, ignores caller input and
uses fixed native executables with a sanitized environment. Targets derive from
the maintained Controller storage and dedicated Engine data roots. Canonical
paths, their owners, mount identity, block device identity and writable supported
filesystems must be established before discard; filesystems are deduplicated.
Controller private storage remains Controller-owned. Ambiguous mounts, bind
mounts, unsupported filesystems and unsafe paths are refused.

See [cleanup reclamation](storage-reclamation.md) for lifecycle behavior and the
limits of reported results. Actual privileged installation and discard require
their own host/platform verification; controlled tests do not establish them.

