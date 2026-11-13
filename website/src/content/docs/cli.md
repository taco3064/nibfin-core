---
title: CLI usage
description: Commands for repository setup, Runner management, and the local Dashboard.
---

`gh` is GitHub CLI. The Nibfin extension adds the `nibfin` command group.
The examples below use the public **candidate CLI**. Formal release and
fresh-user installation remain Unverified. Follow the
[candidate build guide][candidate] to install from reviewed source.

Replace `OWNER/REPO` with the public repository you want to work on, such as
`octocat/hello-world`. Use your existing GitHub CLI login.

## Get help

```sh
gh nibfin help
```

| I want to… | Go to |
| --- | --- |
| Check this machine before using a Runner | [Check prerequisites](#check-prerequisites) |
| Set up a public repository | [Preview and propose setup](#preview-and-propose-setup) |
| View or manage repository Runners | [Manage Runners](#manage-runners) |
| See the Issue dependency graph | [Local Dashboard](#local-dashboard) |
| Update the managed workflow files | [Preview an upgrade](#preview-an-upgrade) |

## Check prerequisites

```sh
gh nibfin preflight --repo OWNER/REPO
```

This read-only check reports host tools, login presence, Docker observations,
and repository permissions. It also reports whether protected execution can
be verified. See [preflight details][preflight].

## Preview and propose setup

Preview the changes first.

```sh
gh nibfin init --repo OWNER/REPO
```

With repository and workflow write permissions, add `--apply` to create the
installation PR and add any missing workflow labels. Review and merge the PR
through the repository's normal process.

```sh
gh nibfin init --repo OWNER/REPO --apply
```

To include initial Runner registration, add both `--runner-directory` and
`--runner-name`. A repository administrator reruns the apply command after the
installation PR merges. See [Runner readiness](../runners/#after-registration)
before attempting a delivery.

## Manage Runners

```sh
gh nibfin runner list --repo OWNER/REPO
```

Repository administrators can use the `runner` subcommands below. Omit
`--apply` to preview changes.

| Subcommand | What it does |
| --- | --- |
| `create` | Downloads and verifies the official GitHub Runner package. |
| `register` | Registers a prepared Runner with the repository. |
| `list` | Lists repository Runners. |
| `unregister` | Removes registration and reconciles local Runner configuration. |
| `remove` | Removes the remote registration and keeps local Runner files. |

See the [Runner command guide][runner] for exact flags and the
[team-member quick registration guide][quick] for the separate `init --quick`
handoff. Its steps are `request`, `issue`, `register`, `confirm`, and `reconcile`.
Use `inspect` and `cancel` for recovery.

## Local Dashboard

<!-- claim:dashboard -->
Unverified formal release and installed operation. Candidate CLI source
implements a local Dashboard with a GitHub Issue dependency graph and
permission-checked Pause and Resume requests.
<!-- /claim -->

```sh
gh nibfin dashboard --repo OWNER/REPO
```

The Dashboard uses your current GitHub CLI identity and opens in a browser.
It shows the request result and the observed GitHub label. Core's effective
decision is displayed as Unknown. Press Ctrl+C in the terminal to stop it.
See [pause and resume](../lifecycle/#pause-and-resume) and the [Dashboard guide][dashboard].

## Preview an upgrade

```sh
gh nibfin upgrade --repo OWNER/REPO
```

Upgrade requires compatible official release metadata and assets. Once those
are available, `--apply` can open a PR for the managed workflow changes.
See the [upgrade guide][upgrade] for options and recovery.

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
[Inspect this source][core-help].
<!-- /claim -->

[candidate]: https://github.com/taco3064/gh-nibfin#build-and-use-the-candidate
[preflight]: https://github.com/taco3064/gh-nibfin#read-only-environment-inspection
[runner]: https://github.com/taco3064/gh-nibfin#manual-repository-runner-management
[quick]: https://github.com/taco3064/gh-nibfin/blob/main/docs/quick-registration.md
[dashboard]: https://github.com/taco3064/gh-nibfin/blob/main/docs/dashboard.md
[upgrade]: https://github.com/taco3064/gh-nibfin/blob/main/docs/upgrade.md
[core-help]:
  https://github.com/taco3064/nibfin-core/blob/6840bdb38ca3f063b2d2b6c39684c6fdaff05873/bin/nibfin-core.mjs
