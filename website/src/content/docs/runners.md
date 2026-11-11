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
Unverified: the current GitHub UI/download instructions have not been read back
for this guide. Use the official links below for current platform-specific
commands; no static command or download version is certified here.
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
Unverified source interface: current product requirements describe implemented
optional Admin-authorized initial registration after the installation PR merges.
The CLI source/help needed to reproduce its exact interface is unavailable here;
this capability is not described as unimplemented or as a verified released step.
<!-- /claim -->

**Later team-member quick registration is Planned.** It is distinct from the
initial Admin-only path and requires separately authorized short-lived handoff
and member binding. Do not give a team member an administrator's credentials.

## After registration

Registration success does not prove trusted Core host adoption, isolation, Agent
readiness, valid work authorization or successful delivery. Runner routing labels
are not security identities. Verify the actual member/repository/Job binding and
approved host configuration before privileged work. Untrusted public content
must remain isolated from administrative credentials and member Agent logins.

Unverified: organization policy and OS/Agent combinations need separate testing.
No private directory layout, WSL installation or universal platform support is
prescribed by this guide.

## Unregister and remove

Use the target repository's Settings, Actions, Runners to select the correct Runner
and follow GitHub's current removal instructions with an authorized administrator.
See [removing self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/removing-self-hosted-runners).
CLI removal syntax is Unverified/unavailable here. Do not invent a command or
publish GitHub's generated removal token.

Before retiring a host, check active Jobs, processes, services and dependencies.
Stop authorized work safely and confirm termination and external effects before
removing files or registrations. Remote cancellation alone does not prove all
host processes stopped. Preserve user data, current logins and necessary recovery
evidence. Runner service management is outside this guide.

Return to [Getting Started](../getting-started/) or [CLI usage](../cli/).
