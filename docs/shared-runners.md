# Shared local Runners

An adopted execution repository can accept development Jobs for other adopted
repositories through `.github/workflows/shared-runner.yml`. Register both local
Runner services with the execution repository and add the `nibfin-shared`
label to each registration.
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
repository. For a user-managed execution repository, set the administrator
managed Actions variable `NIBFIN_SHARED_RUNNER_DESTINATION` in each participating
repository to JSON with `repository` (the canonical full name) and
`repositoryId` (the GitHub numeric ID). The hosted Wake resolves that identity
and the current default branch before dispatch. The Wake token needs dispatch
access to the execution repository and belongs in the Actions secret store.
Existing official deployments without a destination retain their current Core
route. Leave the pool variable unset when using a local registration.

For a manual run, select the shared workflow in the execution repository and enter the target
repository ID, Issue number and optional stage. Omitting the stage runs
`continue`. Core checks the live Issue in the target repository and authenticates
the GitHub Job in the execution repository. The two Runners retain distinct
gateway networks and work directories when they run Jobs for the same target.

For local recovery of a shared Job, use the host configuration of the slot
that ran the Job and set `NIBFIN_TARGET_REPOSITORY_ID` to the original target.
