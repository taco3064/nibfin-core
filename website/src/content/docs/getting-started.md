---
title: Getting Started
description: Choose an onboarding path and understand prerequisites.
---

## Prerequisites

Choose a Public Repository owned by a personal account or an Organization.
Identify a person authorized to install workflows and propose repository changes,
a repository administrator for Runner management, and the executing member.
Repository write access alone does not grant Runner Admin rights.

Review the target repository's branch protections, required checks and applicable
review requirements. Preserve independent technical validation even for a single
human owner. Do not execute untrusted public Issue or fork code on a host with
member logins or administrative credentials.

:::note[Host compatibility]
<!-- claim:platform -->
Unverified: no universal OS, Agent or isolation-backend compatibility is established
by this guide. Each host and Agent configuration needs actual isolation and
credential-boundary verification. Running a container alone is insufficient.
<!-- /claim -->
:::

## Personal repository

1. Confirm the repository is public and that you have installation permissions.
2. Review [component availability](../installation/#component-status). Obtain
   verified source identities before choosing an installation candidate.
3. Review the installation PR and its real checks before protected merge.
   PR creation is not installation completion.
4. Have a repository administrator follow [Runner onboarding](../runners/).
5. Confirm trusted host adoption, member authorization, isolation and Agent
   readiness before attempting an authorized delivery.

## Organization repository

Use the same repository-level model for an Organization-owned Public Repository.
Ask an authorized administrator to check workflow permissions, branch rules and
repository Runner policy. Installation write rights and Runner management rights
remain separate.

<!-- claim:organization -->
Unverified: organization installation and policy combinations have not been tested
for this guide. Organization-level Runner management and Runner Groups are outside
this onboarding path; use repository-level Runners only.
<!-- /claim -->

## First delivery expectations

A registered Runner is not a trusted adopted host or proof of completed delivery.
An authorized Issue proceeds through Shape, Deliver, independent Accept, applicable
CI, final review and protected merge. Labels alone do not grant execution rights.
A successful local build does not demonstrate this product flow.

After host adoption, [project configuration](../project-environment/) can
declare the tools, network access, and Skills that your Jobs need.

Continue with [installation](../installation/) and [CLI usage](../cli/).
