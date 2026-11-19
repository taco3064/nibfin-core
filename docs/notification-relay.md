# Installed outgoing notification relay

This page describes the retained historical artifact route. Native Issue forwarding
and caller refresh do not require this configuration or its receipts; see
[the native caller-refresh contract](managed-issue-wake.md). Removing historical
notification resources is a separate migration responsibility.

The Controller polls adopted public GitHub repositories and forwards bounded
Issue notification artifacts to its installed shared workflow. Notifications
locate work; they grant no execution permission. The receiving shared job still
checks live Issue authority, Job/Runner/OIDC admission, Pause and fanout. A
`consumed` relay receipt proves a dispatch run was read back, not that a Runner
was available or that any stage completed.

This interface is for CLI-2 and administrator-operated managed retirement. It
requires an installed verified Core at `/opt/nibfin/core`, the existing trusted
`/etc/nibfin/host.json` and peer adoptions, and the private Controller token named
by that host adoption. No credential is accepted in arguments, notifications or
relay configuration. CLI-1 supplies credentials and host adoption during actual
initialization. These commands neither provision credentials nor adopt a new
repository. Linux with systemd, `/usr/bin/flock`, and the installed pinned Linux
x64 Node runtime is the implementation target; real installation/provider and
release verification remain subsequent Proposal §11.3 work.

Create root-owned `/etc/nibfin/notification-relay.json` with no group/other write
access. Its complete version-1 schema is:

```json
{
  "schemaVersion": 1,
  "origins": [
    {
      "repository": "owner/project",
      "repositoryId": 123,
      "ref": "main",
      "workflow": {
        "id": 456,
        "path": ".github/workflows/nibfin-issue.yml",
        "commit": "<adopted 40-character source commit>",
        "blob": "<adopted 40-character workflow Git blob>"
      }
    }
  ]
}
```

There must be 1–10 distinct origin repository IDs. Unknown fields are rejected.
The ref is the adopted default branch. Workflow identity, path, source commit
and blob must match each repository's existing `eventRunner` adoption. Its
reusable Issue workflow must name the installed Core source. The origin caller
must be the exact maintained `issue-managed` recipe; legacy callers remain
supported by the existing wake path. Installing this relay does not change
callers or rewrite host adoption. The destination comes exclusively from the
installed shared Runner adoption and the existing native-policy destination
guard. It cannot be selected by an artifact or a relay configuration field.

Run these fixed commands as the local host administrator, using the installed
pinned Node executable followed by `/opt/nibfin/core/bin/nibfin-notification-relay.mjs`:

| Command | Result and effect |
| --- | --- |
| `prepare` | Verifies installed source, host/config/peer bindings, public identities, current workflow continuity and credential-bound Controller identity. Prepares exact service/timer resources and root-private relay state; never enables or starts them. New installations start locally paused. |
| `inspect` | Returns resource preparation status, current service state, authenticated GitHub readiness and bounded recovery receipts separately. Unavailable GitHub readiness is `unverified`; local recovery remains inspectable. |
| `pause` | Acquires the same kernel gate used by dispatch, then durably sets local pause. `paused` means no new POST can start until resume. |
| `resume` | Clears only local pause under that gate. It preserves all pending and consumed origin receipts and requires fresh eligibility for every new POST. |
| `poll` | One bounded polling/reconciliation pass, also used by the timer. No listener or Runner slot is used. |

Successful preparation reports `servicesStarted: false`, `github.status:
verified`, and actual `control` and `service` observations. `prepared` does not
mean active or enabled. Repeated preparation preserves pause and all valid
receipts; conflicting or untrusted unit files are rejected and never replaced.
An existing directory with missing/corrupt control is indeterminate and cannot
be silently initialized. `inspect` distinguishes `missing`, `prepared`,
`conflicting`, and `untrusted` unit resources. If systemd cannot be queried,
`service.status` is `unknown`, never an inferred success.

An administrator can activate prepared resources with the normal systemd
`daemon-reload` and `enable --now nibfin-notification-relay.timer` operations and
explicitly run `resume`. These operations are outside preparation. The
service runs as root to use the trusted host interfaces and existing private
Controller credential, with read-only system access and a single writable state
directory, `/var/lib/nibfin/notification-relay`. Agent workspaces and Runner
processes must have no access to this directory or the Controller token.

A concurrent poll or control command returns `pending / RELAY_BUSY`. That is
not an effective pause: retry the fixed pause command until it reports `paused`.
The gate spans admission, durable intent, POST and immediate readback. A
completed pause cannot race a newly starting POST. Invalid or missing control
prevents new dispatch. Already recorded effects may still reconcile while
paused. Local pause is a service retirement control, not a substitute for the
Issue's authoritative GitHub `pause` label.

## Bounds and recovery

The timer runs about one minute after the previous pass, without a delivery
SLA. Discovery examines a 24-hour recent window and at most three 50-run pages
per adopted workflow. Conditional reads only optimize discovery; admission is
always fresh. Each reader permits 240 API requests, each with a 15-second
request/body deadline and a 1 MiB JSON response limit. Artifact listings require complete pagination within three pages. Artifact ZIPs
are at most 64 KiB, with at most three HTTPS storage hops, exactly one expected
JSON member, and at most 4,096 decompressed bytes. Authorization goes only to
`api.github.com`, never artifact storage. Redirect targets are restricted to
Azure Blob HTTPS hosts. Archives are parsed in memory with CRC, digest and
strict member/size validation; they are never extracted to disk.

Only authenticated successful attempt 1 is consumed. The relay reads the
original attempt endpoint even when the latest run is a rerun. The original's
repository/workflow/ref/source, artifact owner, attempt-qualified name, creation
interval, digest and payload run/attempt fields must agree. A later rerun
cannot replace a failed, absent, expired or consumed original. A fresh complete
artifact listing of a successful completed original can establish deletion;
authenticated explicit `expired` metadata can establish expiry. These produce
terminal `skipped / RELAY_ORIGINAL_EXPIRED`. Incomplete listings, access denial,
rate limits and timeouts produce no expiry record. Recovery outside the bounded
window is not promised. Recovery before retention expires can consume an
otherwise eligible original.

Rate-limit/reset and retry-after observations defer subsequent polls for at
least a minute and at most a day. Incomplete, paused and denied discoveries do
not retain conditional-cache markers that could hide a future retry. Diagnostics
contain fixed codes, stable public identities and recorded run IDs, never raw
provider errors, credentials or signed storage URLs.

Each separate origin receipt is keyed by repository ID, run ID and attempt in
root-private state. Immutable destination/source, Controller actor, target Issue
and exact wake inputs are synced before the POST. Returned run IDs are synced
before exact readback. `consumed` suppresses repeats across restarts.
`pending / RELAY_EFFECT_UNKNOWN` never permits another POST for that origin,
even after timeout, absent ID, restart or revocation. Receipts are separate from
the existing Issue-stage journal and are not a second task queue.

When no ID was returned, the origin stays pending. The native run listing and
Issue-specific title do not expose the origin run/attempt or dispatched inputs.
Even a single matching run cannot distinguish two notifications for the same
Issue, so this interface cannot safely adopt a run from listing evidence.
Zero matches, one match, two matches and incomplete observations all preserve
the unknown effect without a second POST, including after restart or while
paused. No origin-specific authoritative recovery evidence is currently
available through this interface. A returned dispatch ID remains recoverable:
exact readback verifies native ID, actor, installed workflow, source, ref,
destination and target Issue title. No token or storage URL is persisted in
receipts.

Recovery examines at most 50 pending receipts per pass, independently of
artifact retention. Each state file is limited to 16 KiB; the journal admits at
most 4,096 origins and fails closed at capacity rather than forgetting consumed
origins and risking duplicates. Inspection returns at most that many bounded
receipt summaries. An administrator must preserve receipts needed for dedup or
unknown effects during maintenance; removing state does not authorize replay.
Kernel locks release on process termination, including abrupt termination;
pending intent remains durable and still requires reconciliation. Resume does
not erase unknown effects. No manual JSON edits or guessed run IDs are a
recovery interface.

## Continue work after a host rollout

After installing a Core package, the existing rollout timer scans the currently
adopted repositories for open Scope Issues assigned to the adopted member.
It rechecks the Issue, owner pause and native prerequisites using the same
eligibility rules as Issue wake events, then triggers the current shared
workflow with `stage=continue`. GitHub owns queueing, assignment and workflow
concurrency. Core's normal admission and continuation own stage execution.

The completion scan reads current host adoption rather than the previous
relay workflow source bindings. It also runs after a self-update when the
old updater has already removed its deployment plan. A completion receipt at
`/etc/nibfin/rollout-resume.json` records successful native dispatch IDs for
the installed package. Later timer invocations reuse those results after a
partial failure and retry the remaining scan. Missing bookkeeping starts a
fresh scan. An Issue read failure leaves other eligible Issues independent.

An operator relay pause defers the remaining scan. Existing Issue pauses and
unmet native dependencies remain effective. Deployment completion and pending
continuation observations are tracked independently so a failed Issue read
does not leave the deployment unfinished.

If GitHub accepts a dispatch but its response is lost, a later scan can submit
another normal continuation for that unfinished Issue. The shared workflow's
native concurrency applies to both invocations, and Core reuses confirmed
stage effects. Successful dispatch establishes that GitHub received the job;
the job's own result establishes progress or completion of the Issue.
