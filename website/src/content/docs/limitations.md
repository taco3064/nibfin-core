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

The Dashboard and future member quick enrollment are **Planned**. Existing
administrator-authorized initial repository Runner registration is a separate
capability: it requires repository Admin authority and does not establish trusted
Core host adoption. It must not be advertised as completed member quick
enrollment. Installation and CLI tutorials are maintained separately.

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

## Documentation is not deployment

The [website boundary](../architecture/#website-boundary) distinguishes the
selected hosting route from actual publication. Local build, navigation, search
and browser results cover only the tested site output. Protected publication
and authenticated read-back belong to DOC07; live-site verification belongs to
DOC08. Neither an API acknowledgement nor a screenshot proves a released site.
