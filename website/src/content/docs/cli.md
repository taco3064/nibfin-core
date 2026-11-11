---
title: CLI usage
description: Read-only source inspection and CLI availability.
---

## Onboarding CLI

The [CLI component](https://github.com/taco3064/gh-nibfin) owns repository onboarding
and Runner/environment operations. Its public help and source are Unverified in
this environment. Exact initialization, registration, removal and upgrade syntax
is unavailable here; no flags or install command are inferred from repository
names, requirements or Core help.

## Candidate source inspection

<!-- claim:core-help -->
Unverified release status; candidate-only example. In the inspected Core source
checkout, this read-only command prints help without onboarding mutations:

```sh
node bin/nibfin-core.mjs help
```

Source: Core commit `6840bdb38ca3f063b2d2b6c39684c6fdaff05873`,
`bin/nibfin-core.mjs`, the `help` branch. This is Core administrative help,
not the onboarding CLI and not a released installation instruction.
[Inspect this source](https://github.com/taco3064/nibfin-core/blob/6840bdb38ca3f063b2d2b6c39684c6fdaff05873/bin/nibfin-core.mjs).
<!-- /claim -->

The help branch exposes packaging, source installation and verification among
administrative entries. Their presence does not establish a published artifact,
compatibility or an installed host. Do not run administrative operations as a
substitute for an approved onboarding path.

## Availability and next steps

<!-- claim:dashboard -->
Planned: Dashboard is optional future work here, not an available installation
step or a prerequisite for delivery. Team-member quick registration is also
Planned; it must not be confused with initial Admin-only registration.
<!-- /claim -->

Read [installation](../installation/) before selecting component sources and
[Runners](../runners/) before managing registration. The
[source checklist](https://github.com/taco3064/nibfin-core/tree/main/website/evidence)
links inspected source and records unavailable observations. A synthetic validator
fixture establishes no real publication or support.
