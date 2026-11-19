# Local work observation (version 1)

`nibfin-core observe-local-work` returns a bounded JSON observation for the signed-in
GitHub user. `observeLocalWork(token)` is the corresponding public JavaScript export.
It accepts only the user's credential. There are no member, host, module, repository,
state-root or Controller-credential arguments. This interface does not grant admission,
change enrollment, schedule work, reconcile pause, or recover unresolved executions.
The existing installation and two-slot enrollment contracts are unchanged.

Pass exactly `{"token":"…"}` through a private pipe to stdin, then close stdin. Never
put the token in command arguments, shell history, a URL or an environment variable.
For example, a consumer can keep its existing `gh` authentication and pipe its output
through a JSON encoder, without copying the credential to disk:

```sh
gh auth token | node --input-type=module -e '
  let token = "";
  for await (const bytes of process.stdin) token += bytes;
  process.stdout.write(JSON.stringify({token: token.trim()}));
' | nibfin-core observe-local-work
```

Use the installed, trusted Core binary. This is a local interface; do not expose its
stdin or stdout through an unauthenticated HTTP service. CLI owns assignee filtering
and presentation. Neither an assignment nor a member label is queue/admission evidence.

## Response

A successful read has `schemaVersion: 1`, `status: "observed"`, an authenticated
`subject` (`id`, `login`), an `interval` (`startedAt`, `finishedAt`), `completeness`
(`complete` or `partial`), `runners`, `work`, and bounded `errors` codes. Authentication
or a mismatched installed member returns only a sanitized denial (`schemaVersion`,
`status: "denied"`, `code`), with no subject or host data. The CLI exits 1 on denial.
Malformed input also exits 1 with sanitized JSON on stderr. Partial reads exit 0;
consumers must inspect completeness and each observation's uncertainty.

A complete empty `runners` collection differs from unavailable discovery. Missing,
unsupported, inaccessible or changing installed adoption produces partial results and
an explicit error, never a complete empty success. A host not yet installed cannot
prove that the user has no Runners elsewhere. Version 1 recognizes the current
single-host Linux adoption format. Older binaries without this command are unsupported;
consumers must preserve that distinction instead of treating command failure as empty.

Runner entries contain:

- `hostId`: an opaque local Controller identity (`local-controller-<uid>`), scoped to
  this machine. It is neither a filesystem path nor a globally unique host identifier.
- `adoption`: provenance and freshness for the trusted local registration record.
- `registration`: registration repository name and stable repository ID, Runner ID,
  and adopted Runner name. Identity is the repository ID plus Runner ID, never a name
  suffix. Shared registrations appear once with merged, validated `routes`.
- `online` and `busy`: separate native observations; absence is `null`, not false.
- `state`: `idle`, `busy`, `offline` or `unknown`. Idle requires confirmed native
  online/not-busy and complete, consistent job discovery. Busy without a verified job
  retains unknown association. Offline is independent of any historical work.
- `association`: a verified native job identity or an explicit unknown observation.

Work entries contain a qualified `issue` (repository name/ID, number, stable Issue ID,
`qualified` name) or `null`, a `native` job identity or `null`, and `phase` and `activity`
observations. Qualified Issues also carry `issueObservation` provenance. Native
identity contains execution repository name/ID, run ID, attempt,
job ID, validated GitHub job `url`, and ISO `startedAt` or `null`. A live job on a
verified local registration remains visible with an unknown Issue when uncorrelated.
Other workflow jobs are excluded unless a qualified subject-bound dispatch proves
their queued association; excluded jobs do not suppress ordinary waiting.
Multiple jobs can have separate work entries for
one Issue. Open `scope` Issues are discovered across adopted routes without assignee
filtering; this is not a complete inventory of unadopted or closed historical Issues.

For qualified Issues, `pause`, `dependencies`, `executionBlocker` and `waiting` are
separate observations. Dependencies report the number of incomplete native upstreams;
a completed upstream follows Core's existing closed/delivered qualification. Edges
outside adopted routes remain unknown. Pause uses native events and existing trusted
qualification receipts through `interpretPause`. A qualified current command establishes
the requested state even when earlier local receipts are missing. It does not qualify
unknown historical actors. Later unqualified changes still need qualification or repair;
label absence alone does not prove Resume. New receipts use stable native event IDs,
with legacy hash receipts supported. Confirmed pause does not imply admitted work stopped.
An existing pending journal effect reports `EXTERNAL_EFFECT_UNKNOWN`; this endpoint
does not diagnose an Agent or claim that every possible runtime failure is observable.

`activity` distinguishes `executing` and `queued` native jobs, confirmed `dispatched`
run identities retained by the pending wake journal or completed wake receipts matched
with a current validated run, and unknown admission.
Successful wake completion retains a minimal run/decision receipt in the existing
journal. It proves association only when the same run is currently discovered through
validated native workflow reads. A current run without jobs establishes dispatch,
not queueing or execution; its job identity and phase remain unknown. A historical
receipt alone never implies queueing.
Older journals with completed operations but no run receipts cannot establish absence
of admission: their waiting state remains unknown. No privileged access or journal
mutation occurs during observation. Dispatch is not
admission, and an unresolved dispatch journal remains a separate execution blocker.
`waiting: "no-admission-observed"` means complete applicable native discovery and
available journals show no admission or pending effect, with clear pause and no native
dependency blocker. It is an observation, not a scheduling decision. Unknown or
inaccessible inputs cannot establish this ordinary waiting state.

Every field observation has `value`, allowlisted `source`, `observedAt`, `sourceTime`
(or `null`), `freshness`, and `code`. Freshness is `fresh` only for a valid source time
within the preceding **30 seconds**, `stale` for older or future timestamps, and
`unknown` when no source timestamp exists. In particular, native registration responses
have no source timestamp: their successful interval read does not invent one. Native
job/activity uses the run update time or job start time when available; dependencies
use the oldest available upstream update time only when every upstream has one. Empty
dependency lists and derived ordinary waiting have no source timestamp. Phase and
retained dispatch/journal evidence use their trusted file modification times. Consumers should
refresh observations rather than caching freshness indefinitely. The response is not
an atomic GitHub snapshot; material inputs and discovery pages are read again before
returning. Changed evidence invalidates assertions while retaining safe identifiers.

## Phase evidence and local trust

Only root-owned fixed `/etc/nibfin/host.json` and its validated peer filenames provide
adoption sources. The authenticated `/user` ID must match the installed member and
each route. Registration collections adapt primary/additional records and independently
validated peer views, then deduplicate. They have no two-entry projection limit. Native
labels alone cannot add registrations. Discovery does not relax provider or admission
validation, and does not load credentials referenced by adoption files.

Local evidence is read under the **installed Controller UID**, subject to ordinary
filesystem access controls. Each ancestor is checked for ownership, writes by other
users and symlinks. Root-owned sticky ancestors are allowed for private directories;
files must have the expected owner, one link, a safe mode and bounded size. Reads use
`O_NOFOLLOW`, check identity/timestamps again, and never create directories or locks.
Permission denial is partial access, not a reason to use sudo, the Docker socket or a
privileged relay. Raw contexts, receipts, journals, locks, process data, credential paths,
logs and signed download URLs are never returned.

A current native job must agree with registration, repository, workflow, run, attempt,
source, actor, Runner name and Runner ID. Trusted execution contexts can then qualify
Issue identity. Phase additionally requires a uniquely correlated invocation contract,
matching active session binding, no completed result for that invocation, and a live
kernel process/mount observation linking `/input/bootstrap.mjs` to that exact trusted
input directory. Process identity and mounts are rechecked before returning. A retained
lock or old context alone, job title, initial continuation fence, last receipt or next
planned stage cannot supply phase. Multiple live proofs, superseded executions and
non-Agent stages without such proof remain `PHASE_UNKNOWN`. Restricted `/proc` access,
namespace layouts that do not expose the input mount, and an exhausted process scan
also leave phase unknown. No daemon control or signal is used to obtain phase evidence.

## Bounds and errors

Input is at most 17 KiB, with a token at most 16 KiB, a five-second stdin deadline,
and no extra keys. Observation uses a 20-second request budget and at most 160 native
GET attempts, including confirmation. Responses are bounded to 2 MiB per GET and output
to 1 MiB. Pagination is at most three 100-item pages per list, and each route admits at
most 64 open Issues. Adoption reads are 256 KiB each, at most ten peer files; evidence
files are at most 1 MiB, with at most 256 local evidence reads, directory entries or
process candidates per scan. Directory walks are fixed-depth. Confirmation repeats
bounded reads. Slow or inaccessible filesystem operations remain subject to host OS
behavior; there is no privilege bypass or background observation service.

Budget exhaustion, access/rate limits, malformed native data, unavailable sources and
changing intervals report bounded codes such as `OBSERVATION_LIMIT`,
`ACCESS_OR_RATE_LIMIT`, `ACCESS_DENIED`, `UNAVAILABLE`, `UNVERIFIED_BINDING`,
`OBSERVATION_CHANGED`, `WORK_STATE_PARTIAL`, `WORK_UNKNOWN` and `PHASE_UNKNOWN`.
Partial failures preserve independently verified fields; an unconfirmed interval
replaces state assertions with explicit unknowns. Output-size exhaustion returns a
partial bounded envelope with `OBSERVATION_LIMIT`; its empty arrays are not discovery
proof. Errors never include provider bodies, exception text, host objects or tokens.

## Verification ownership

Development regression fixtures exercise injected native reads and disposable local
evidence, including simulated invocation activity. They do not establish live installed
host or GitHub access. Core CI owns changed-source verification, packaging and applicable
integration suites through `npm run verify` and its workflow components. Independent
Accept chooses Candidate verification; rollout owns installed-host activation. Those
later results remain Unverified until their owning stages run.

Selected-attempt blocker reports and explicit read-only diagnosis are additive
interfaces. See [Blocker reports and local diagnosis](blocker-diagnosis.md) for
the private request format, authorization, capacity and uncertainty contract.
Observation itself never starts a diagnostic Agent.
