---
title: Trusted delivery, from Issue to merge
description: Nibfin brings independently validated delivery to GitHub Issues.
template: splash
hero:
  title: Trusted delivery, from Issue to merge
  tagline: >
    Nibfin takes a bounded GitHub Issue through independent validation,
    implementation, and protected merge.
  actions:
    - text: Getting Started
      link: getting-started/
      icon: right-arrow
    - text: Installation guidance
      link: installation/
      variant: secondary
---

Nibfin helps people deliver changes through GitHub Issues,
with independent checks before changes reach the default branch.

## Explore the documentation

<div class="nf-doc-grid not-content">
  <a href="getting-started/">
    <strong>Getting Started</strong>
    <span>Choose an onboarding path for your Public Repository.</span>
  </a>
  <a href="lifecycle/">
    <strong>Protected lifecycle</strong>
    <span>Follow Issue labels, independent review, and verified closure.</span>
  </a>
  <a href="architecture/">
    <strong>Architecture and authority</strong>
    <span>See what GitHub, Core, Action, and the CLI each own.</span>
  </a>
  <a href="runners/">
    <strong>Runners</strong>
    <span>Understand registration, member routing, and host readiness.</span>
  </a>
  <a href="project-environment/">
    <strong>Project environment</strong>
    <span>Declare tools, HTTPS destinations, and role Skills for each Job.</span>
  </a>
  <a href="security/">
    <strong>Security and recovery</strong>
    <span>Understand credential boundaries and when work can safely resume.</span>
  </a>
</div>

## From Issue to verified closure

<div class="nf-delivery-grid">

### Shape the work

An independent validator checks the contract for an authorized Issue.

### Deliver and verify

A Writer implements the change. An independent Acceptor checks the Candidate.

### Review and merge

Applicable CI and final review cover the PR head before protected integration.

</div>

[Walk through the delivery stages](lifecycle/#from-scope-to-closure).

## Availability vocabulary

<!-- claim:availability -->
Unverified: formal release and fresh-install support for Core, Action, and CLI.
The public repositories are available for candidate source review.
<!-- /claim -->

Check [component status](installation/#component-status), read the
[CLI guide](cli/), or see [what each verification milestone proves](limitations/).
