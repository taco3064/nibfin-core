# Blocker reports and explicit local diagnosis

Core retains attributed Agent explanations separately from native termination and
admission observations. Reports bind the repository name and ID, Issue number and
ID, stage, authenticated member, known execution/session and native Job identity.
An admission report uses its known admission ID and leaves absent Agent execution
fields null. Immutable reports survive replacement of current stage receipts.
Old installations without retained reports return unavailable evidence.

A report's classification describes its producer's assessment. An Agent explanation
has `confidence: attributed` and never becomes an independent confirmation.
`executionAuthority` is always false. A bare exit 137 has unknown cause. Docker's
matching `OOMKilled` observation establishes only the exact container observation,
not guest or host OOM. Missing telemetry remains explicit. Core does not collect
kernel logs or acquire additional host permissions.

## Consumer interface

`consumerContract.localDiagnosis` advertises `request-local-diagnosis`, schema 1.
The public library export is `requestLocalDiagnosis(request)`. The command accepts
no arguments and reads one private JSON stdin object within five seconds, bounded
at 18 KiB. Do not put a token on the command line or in a URL.

```json
{
  "token": "PRIVATE_CURRENT_GITHUB_TOKEN",
  "repository": "OWNER/REPO",
  "issueNumber": 447,
  "attempt": {
    "id": "CORE_EXECUTION_OR_ADMISSION_UUID",
    "stage": "deliver"
  },
  "diagnose": false
}
```

The attempt selector comes from a retained report's `binding.admissionId` and
`binding.stage`. No filesystem path, evidence locator, provider, model or executable
is accepted. `diagnose: false` reads reports and retained diagnostic status only.
`diagnose: true` explicitly requests a fresh diagnosis, or reads an existing result
for the same selected evidence. Ordinary `observe-local-work` remains read-only
and never starts diagnosis. Its existing input and fields remain compatible; work
entries add a bounded `diagnosis` summary with retained reports and diagnostic
history, or an explicit unavailable status.

Completed history entries preserve the same bounded report as the immediate
diagnosis response: `confirmed` contains Core observation codes, `sourceReports`
contains opaque references to the selected source reports, and `sourceTimes`
contains their corresponding observation timestamps (null when unknown).
`observedAt` is the diagnosis report time, distinct from those source timestamps.
The entries also retain the selected Issue and attempt, diagnostic `invocationId`
and `evidenceId`. The explanation and hypotheses remain attributed to the diagnosis
Agent; retaining Core observations does not grant execution authority.

The request independently authenticates `/user`, discovers installed routes and
verifies the repository and selected Issue afresh, including its current Assignee.
It supports closed historical Issues without querying active runs or open scoped
Issues. Known native identities are checked against the corresponding run and Job.
A changing read interval denies diagnosis. Reading a historical report does not
establish that it is the current delivery attempt: `current` is false, and
`newerAttempts` lists later retained observations for the same stage.

Responses use `reported`, `denied`, `no-capacity`, `insufficient-evidence` or
`unresolved-effect`. They contain safe codes instead of exception bodies. Public
references are the report's opaque reference or qualified native GitHub URLs
validated against its bound repositories and native attempt. Unqualified Agent
locators, arbitrary URLs, signed download URLs and paths are not returned. Private
Agent prose is retained, while public prose uses a restricted bounded projection;
unsafe prose is null. Private logs and credential locations are not API output.

## Dedicated invocation and capacity

Diagnosis does not call delivery stages, create RoleSessions, fabricate GitHub
Jobs or issue delivery receipts. The current process must already have the adopted
Controller UID, private state access, verified installed Codex composition and
working adopted sandbox. Other callers receive a capacity/access result. There is
no privileged relay, service, new Runner registration or workflow dispatch.

A fresh invocation sees only bounded sanitized report projections. Its work/main
mounts are empty and denied, its tool network is disabled, and no MCP or delivery
publisher is supplied. An external Codex tool environment disables local fallback
and rejects every execution/mutation method in code, including shell commands,
builds and CI requests. Only protocol initialization is acknowledged. The model
can reason about the supplied bundle; it cannot run a tool to collect new data.
The invocation has a two minute execution deadline, bounded input/output and a
fresh private session. Installed provider/isolation availability is a separate
runtime observation, not implied by the controlled fixture tests.

An exclusive Controller-owned record keys the authenticated subject, selected
attempt and evidence identity. A second global record limits local diagnostic
concurrency to one. Identical concurrent requests do not start another model.
Unknown termination retains both records and necessary mounts. Neither expiry,
missing processes nor a disappeared Runner permits a duplicate invocation. Proven
termination retires diagnostic mounts; completion retains the bounded report and
provenance. Diagnosis never clears delivery fences, locks or Pending effects.

Use the corresponding authoritative CI/CD result to explain workflow failures.
Diagnosis cannot rerun CI or replace its result with a local build. Independent
Acceptance, PR-head CI, native isolation checks and installed provider availability
remain owned by their respective stages.

Pre-Agent Proposal and global-instruction read failures are retained after native
Job, caller and Issue approval verification, before acquiring an execution fence.
Their report binds the admission attempt and native Job, with no Agent execution
or session identity. Proposal credential, sharing, retrieval and incomplete-data
failures use fixed codes; global-instruction reads use
`GLOBAL_INSTRUCTIONS_UNAVAILABLE`. Exception bodies and private paths are omitted.
These reports use the same historical attempt reader and explicit diagnosis
request as other native reports. Retention cannot release an existing fence or
settle delivery work. If private report storage is unavailable, the denial marks
`reportStatus: unavailable` rather than claiming evidence was retained.
