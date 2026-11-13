---
title: Limitations and verification status
description: What source evidence proves and what still needs release or host evidence.
---

## Three distinct delivery milestones

**Manual Bootstrap** creates and verifies pinned, publicly obtainable candidate
Core, Action and CLI sources and installs them under authorization. It is not
itself normal self-delivery.

**External product E2E** exercises the protected product lifecycle in an external
public repository using those fixed installed candidates. An authorized switch
and read-back of the real entries, permissions and installed sources are required
before normal self-development. A public release or Marketplace listing is not
a prerequisite for that switch.

**Real self-delivery** requires each of Core, Action and CLI to deliver its own
actual work through the protected lifecycle. One repository's successful work
does not establish all three. Source code, passing local tests and pinned
references alone prove none of these live milestones.

## Reading status claims

- **Source implemented / locally tested** describes maintained code and the
  behavior actually exercised by specified tests.
- **Released and installed** requires authoritative release and installation
  read-back, including the source actually installed. A version string or
  screenshot is insufficient.
- **Self-delivery verified** requires real lifecycle evidence for the named
  repository and work, including applicable CI, review, Merge and Closure.
- **Planned** means future product work; **Unverified** means the required direct
  evidence is unavailable. **Unsupported** means outside the supported boundary.

This documentation does not establish a public release, clean installation,
complete external E2E or full three-repository self-delivery. Those claims remain
Unverified here without current authoritative evidence. Current source can
implement a rule without proving its deployed operation.

## Availability and platform boundaries

The [local Dashboard](../cli/#local-dashboard) and optional member quick
registration are implemented in candidate CLI source. Formal release and
installed operation remain **Unverified**. Initial repository Runner registration
is a separate administrator-authorized path. See [Runner registration](../runners/).

Core's delivery contract is host OS neutral, but that does not establish every
OS, Agent or isolation backend as supported. Untested OS/Agent combinations and
unavailable cross-platform evidence remain **Unverified**. Launching a container
alone does not prove equivalent credential isolation, process containment or
safe cancellation. No all-platform support claim follows from these pages.

Private repositories, a separate central scheduler, automatic cross-Assignee
fallback, and migration of uncommitted work or sessions across failed hosts are
**Unsupported** product paths. Organization-owned public repositories use the
same model with repository-level Runners; a separate organization Runner
management product is outside scope.

## Website verification

Browser checks verify the tested site output. GitHub Pages deployment read-back
establishes which site is live. Product onboarding and protected execution
require their own evidence. See the [website boundary](../architecture/#website-boundary).
