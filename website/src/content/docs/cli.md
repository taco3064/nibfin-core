---
title: CLI usage
description: Read-only source inspection and CLI availability.
---

## Onboarding CLI

The [CLI component](https://github.com/taco3064/gh-nibfin) handles repository
onboarding, environment inspection, Runner management and upgrades. The public
candidate source documents these interfaces. Formal release and fresh-user
installation remain Unverified.

| Task | Candidate source guide |
| --- | --- |
| Preview or propose an installation PR | [Candidate onboarding](https://github.com/taco3064/gh-nibfin#build-and-use-the-candidate) |
| Inspect host prerequisites | [Read-only preflight](https://github.com/taco3064/gh-nibfin#read-only-environment-inspection) |
| Register or retire a Runner | [Runner management](../runners/) |
| Preview or propose an upgrade | [Upgrade workflow](https://github.com/taco3064/gh-nibfin/blob/main/docs/upgrade.md) |

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

## Local Dashboard

<!-- claim:dashboard -->
Unverified formal release and installed operation. Candidate CLI source
implements a local Dashboard with a GitHub Issue dependency graph and
permission-checked Pause and Resume requests.
<!-- /claim -->

The Dashboard is optional. It uses the current GitHub CLI identity and
displays the request result and the observed GitHub label. Core's effective
decision remains Unknown in the Dashboard. See
[pause and resume](../lifecycle/#pause-and-resume) and the
[Dashboard source guide](https://github.com/taco3064/gh-nibfin/blob/main/docs/dashboard.md).

Read [installation](../installation/) before selecting component sources and
[Runners](../runners/) before managing registration. The
[source checklist](https://github.com/taco3064/nibfin-core/tree/main/website/evidence)
links inspected source and records verification limits.
