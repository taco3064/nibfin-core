# Managed Linux resource preparation

After installing the verified Core package and preparing its dedicated Engine,
run the fixed administrator executable on the supported Linux x64 host:

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
