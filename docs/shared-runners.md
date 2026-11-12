# Shared local Runners

The Nibfin Core repository can accept development Jobs for other adopted
repositories through `shared-runner.yml`. Register both local Runner services
with that repository and add the `nibfin-shared` label to each registration.
GitHub assigns each Job to an available Runner. Issue events and pull request
CI still belong to the repository that owns the Issue.

Each service needs its own administrator-owned host configuration and isolation
profile. Add `sharedRunner.runner` and `sharedRunner.caller` using the native
registration and workflow identities for that service and the shared workflow.
Set `sharedRunner.repositories` to the adopted repository IDs and add the
other repositories' host files to `wakePeerFiles`. All adopted configurations
must use the same controller identity, state directory and Core installation.

After the shared workflow and host configuration are live, set the
`NIBFIN_SHARED_RUNNER_POOL` Actions variable to `true` in each participating
repository. The existing Wake token must be able to dispatch the shared
workflow in Core. Keep the token in the Actions secret store. Leave the
variable unset while the repository still uses a local registration.

For a manual run, select the shared workflow in Core and enter the target
repository ID, Issue number and optional stage. Omitting the stage runs
`continue`. Core checks the live Issue in the target repository and authenticates
the GitHub Job in the execution repository. The two Runners retain distinct
gateway networks and work directories when they run Jobs for the same target.
