---
title: Security and recovery
description: Public input, credential separation and safe single-Writer recovery.
---

## Public input and protected execution

Public Issue text, forks and workflow input are untrusted. They can describe
work but cannot authorize privileged execution. A self-hosted Runner is not a
sandbox. Agents and Hooks require verified isolation and must remain separated
from host credentials and protected operations. Arbitrary Issue or fork code
must never run with those credentials.

Core must check current authorization, Runner identity and applicable isolation
before execution, and fail closed when required facts cannot be established.
Independent Shape validation, Candidate Acceptance and final review provide
separate technical checks; they do not turn untrusted input into authority.
See the [lifecycle](../lifecycle/) for their order.

Public documentation describes these boundaries without exposing secrets,
protected Runner configuration, private source, operational logs or unpublished
protocol details. These requirements are not a claim that a live security
exercise has been performed. Publication must preserve the same separation for
untrusted fork input; the website cannot grant access to protected operations.

## Recovery and single-Writer operation

Only one Writer may operate on the work at a time. GitHub concurrency controls
Jobs, but a cancelled GitHub Run alone does not prove host processes stopped.
Pending is a safety outcome for unresolved execution or effects; it need not mean
GitHub still has a pending Job.

For example, a lost host with an unknown external write remains **Pending**.
Do not start a second Writer while the original may still run or its effects
remain unknown. An apparently idle replacement Runner does not resolve either
uncertainty.

Safe retry requires verified termination of the original execution, reconciled
external effects and current permission. Only then may another eligible Runner
restart the unfinished stage. Reassignment also requires reconciliation of the
previous queued or running Job before lawful reevaluation.

Uncommitted files, working directories and Agent sessions are not transferred
across failed hosts. Recovery restarts the unfinished stage from maintained
sources and verified evidence; it does not promise migration of lost local work.
