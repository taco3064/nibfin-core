---
title: Runner registration and removal
description: Separate official registration from trusted host adoption.
---

## Rights and prerequisites

Both personal-owned and Organization-owned Public Repositories use the
repository-level path. Installation write permission does not imply Runner
administration permission. Ask an authorized administrator to check current
repository and organization policy before adding or removing a Runner.
Do not paste registration tokens, removal tokens or member credentials into
Issues, documentation, logs or Agent workspaces.

## Registration paths

<!-- claim:manual -->
Unverified platform-specific onboarding. Follow GitHub's current instructions
for your repository and platform.
<!-- /claim -->

**Manual official registration:** open the target repository's Settings, then
Actions and Runners. An authorized administrator uses GitHub's current New
self-hosted runner instructions for the selected platform. Obtain downloads and
short-lived registration instructions directly from GitHub; review the target
repository and member routing. Keep generated credential-bearing commands private.
See GitHub's
[adding self-hosted runners guide](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners).
No static download version or credential-bearing command is reproduced here.

<!-- claim:registration -->
Unverified release and fresh installation. The candidate CLI supports optional
Admin-authorized registration after the installation PR merges.
See the [candidate onboarding guide](https://github.com/taco3064/gh-nibfin#build-and-use-the-candidate).
<!-- /claim -->

The candidate also includes [team-member quick registration](https://github.com/taco3064/gh-nibfin/blob/main/docs/quick-registration.md).
A repository administrator authorizes the short-lived handoff and verifies
the registration. The member uses their own login. Administrative credentials
stay with the administrator. Formal release and installed operation remain
Unverified.

## After registration

Registration success does not prove trusted Core host adoption, isolation, Agent
readiness, valid work authorization or successful delivery. Runner routing labels
are not security identities. Verify the actual member/repository/Job binding and
approved host configuration before privileged work. Untrusted public content
must remain isolated from administrative credentials and member Agent logins.

Unverified: organization policy and OS/Agent combinations need separate testing.
No private directory layout, WSL installation or universal platform support is
prescribed by this guide.

## Shared Runners

An adopted shared Runner can execute a Job for a different target repository.
GitHub routes the Job, while Core checks the actual Job and member identity.
Each Job uses its target repository's
[project environment](../project-environment/) and isolation boundaries.

## Unregister and remove

Use the target repository's Settings, Actions, Runners to select the correct Runner
and follow GitHub's current removal instructions with an authorized administrator.
See [removing self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/removing-self-hosted-runners).
Candidate CLI management is documented in the
[Runner command guide](https://github.com/taco3064/gh-nibfin#manual-repository-runner-management).
Keep generated removal tokens private.

Before retiring a host, check active Jobs, processes, services and dependencies.
Stop authorized work safely and confirm termination and external effects before
removing files or registrations. Remote cancellation alone does not prove all
host processes stopped. Preserve user data, current logins and necessary recovery
evidence. Runner service management is outside this guide.

Return to [Getting Started](../getting-started/) or [CLI usage](../cli/).
