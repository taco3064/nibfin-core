---
title: Trusted delivery, from Issue to merge
description: Nibfin brings independently validated delivery to GitHub Issues.
template: splash
hero:
  title: Trusted delivery, from Issue to merge
  tagline: Turn a bounded GitHub Issue into a checked, independently accepted change.
  actions:
    - text: Getting Started
      link: getting-started/
      icon: right-arrow
    - text: Installation guidance
      link: installation/
      variant: secondary
---

Nibfin helps people deliver changes through GitHub Issues, independent shaping
and acceptance, and protected review and merge. Core owns delivery rules, Action
is the thin workflow entry, and CLI owns onboarding and Runner operations.

## A clear boundary. Evidence at every step.

<div class="nf-delivery-grid">

### Shape the work

Start with an authorized Issue and explicit dependencies. A published,
independently validated Shape defines the implementation contract.

### Deliver and verify

A Writer implements the bounded change and runs applicable checks. Independent
Accept evaluates the captured Candidate and its evidence.

### Review and merge

Required CI and final review apply to the actual PR head. Protected merge and
verified Closure complete the path; a label or a green local build is not delivery.

</div>

Read the [protected lifecycle](lifecycle/#from-scope-to-closure) for the full path.

## Built for Public Repositories

Choose a Public Repository owned by a personal account or an Organization.
Installation permissions, repository Runner administration and member execution
rights are separate. Review the prerequisites before choosing a candidate or host.

[Getting Started](getting-started/) explains both onboarding paths and their limits.

## Explore the documentation

<div class="nf-delivery-grid">

### Start with the foundations

- [Architecture and authority](architecture/): Core, Action and CLI responsibilities.
- [Security and recovery](security/): isolation, permissions and safe retry.
- [Limitations and status](limitations/): source evidence and live observations.

### Prepare your environment

- [Installation](installation/#component-status): component availability and evidence.
- [CLI usage](cli/): maintained command guidance.
- [Runners](runners/): repository-level onboarding and readiness.

### Read with confidence

- [Protected lifecycle](lifecycle/): from Scope to verified Closure.
- [Getting Started](getting-started/): prerequisites for your repository.
- [Theme reading sample](theme/): shared reading components in Light and Dark.

</div>

## Availability vocabulary

**Released/Installed** distinguishes a verified formal release from an installed
candidate for an exact version and configuration. Neither implies the other.
**Planned** means authorized future work. **Unverified** means observations are
insufficient. **Unsupported** requires evidence of an unsupported interface or
configuration. Missing network evidence means Unverified, never Unsupported.
CI success, lifecycle labels and production support are separate observations.

<!-- claim:availability -->
Unverified: formal Core, Action and CLI releases, assets and fresh-user installation
have not been independently read back for this guide. Installation commands are
unavailable here. This is not a claim that releases do not exist.
<!-- /claim -->

The checked-in [source checklist](https://github.com/taco3064/nibfin-core/tree/main/website/evidence)
records observation limits. These pages are a public projection, not another
product policy store. Local website checks do not establish live Pages publication
or product onboarding E2E.

