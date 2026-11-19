# Managed pool retirement

The fixed installed Core CLI command `retire-shared-host` takes no arguments.
Only a local root administrator in the verified `/opt/nibfin/core` installation
can initiate or advance it. It does not remove GitHub registrations or choose a
replacement provider. Those GitHub operations remain with gh-nibfin AGENT-5.

The command returns bounded JSON with `retirementId`, `phase`, `code`, and
`removal`. `pending` is an incomplete retirement, including when registration
removal by AGENT-5 is the next permitted action. Repeating the command reconciles
the same operation. No token, model authentication, or exception text is returned.

1. Core records the exact adoption, provider, repository/member identity, both
   registration IDs and their managed service-slot directory identities.
2. Under the Controller admission gate, Core writes a root-owned drain marker.
   For an adopted artifact consumer it also durably pauses the notification relay.
   When all adopted consumers have freshly verified native Issue callers, drain
   does not require notification configuration, service, timer or journal state.
   New Controller admissions and pre-Worker admission refuse the draining pool.
   Continuation checks the drain boundary before beginning another stage.
3. Existing admitted work settles. Core checks admission and credential leases,
   all adopted repositories' native Jobs, journals, Writer/session fences,
   containers and both service cgroups. For artifact consumers, the relay gate requires
   paused control and no pending dispatch receipts, including lost-response
   effects without a native run ID. Relay recovery retains and reconciles these
   receipts; retirement never clears or reposts them. Busy, unavailable or unknown observations
   retain Pending evidence. A retained consumer or Writer lock is not removed
   based on process age, Runner status, cancellation or registration absence.
4. Core can stop an idle service only after workload settlement and inspection
   of its exact shell, RunnerService and Listener supervisor chain. A Worker,
   additional process, changed PID, unsupported layout or ambiguous service
   prevents stopping. Both services must then be inactive with settled cgroups.
5. Only a current response with `removal.permitted: true` permits AGENT-5's
   separate removal of the matched IDs in `removal.runners` from the specified
   repository. The persisted phase alone is insufficient. Core performs no
   authenticated GitHub removal or automatic removal retry.
6. Core independently observes both registrations absent using the adopted
   Controller identity. It disables only the two matched service instances,
   quarantines and deletes their exact slot directories, removes bounded
   provider credential/home copies, and retires the matched gateway containers
   and private networks. Each effect has durable intent and independent
   readback. Unknown outcomes stay Pending; known incomplete effects have
   explicitly bounded retry semantics. The reusable systemd template remains.
7. `retired` records completed retirement, independent of replacement availability.
   The administrator can prepare a replacement using `adopt-shared-host` with
   fresh IDs and a new provider binding. The drain marker remains in place.
   Ordinary updates and stale IDs cannot rebind the provider.

Runtime records are `/etc/nibfin/managed-retirement.json` and the root-owned
`/etc/nibfin/managed-pool-drain.json`. Retirement serializes with adoption and
rollout through their existing guard. Its separate kernel gate permits recovery
of a tagged retirement guard after process death; an unresolved adoption or
rollout guard is preserved. A later retirement archives the previous completed
record as `retirement-history-<retirementId>.json` in the same directory.

The verified Core contract advertises `managedPoolReplacement`. After preparing
the primary adoption, re-adopt the historical peers with `adopt-shared-peer`
and start the two new listeners. While the drain marker exists, the listeners
can be observed online,
but both Worker execution and new relay dispatches remain closed.

The fixed, argument-free `activate-shared-replacement` operation is local
administrator only. It verifies both new registrations, absence of the old IDs,
the local services, installed source, private credential identity and all
historical repository and caller bindings. Notification artifacts and relay
service or timer readiness are not activation prerequisites. Then Core durably
records the release and removes the drain marker. A verification failure leaves admission closed. If publication is
interrupted before the marker is removed, retrying activation revalidates the
replacement before completing the release.

After verified release and drain-marker removal, Core releases the replacement
mutation lock and requests continuation of eligible unfinished Issues. The single
JSON response keeps `status: active`, `retirementId` and the pool fields, and adds
`continuation` with its separate `dispatched`, `paused` or `pending` outcome.
A pending continuation does not roll back activation or repeat replacement.

Retrying activation observes an already verified release and absent drain marker,
keeps the active result and invokes completion outside the mutation lock. The
argument-free installed `complete-installed-lifecycle` command also discovers the
released pool without a prior local receipt. It uses current adoption and the
same completion operation as successful deployment. Fresh Runner IDs start a new
lifecycle even with the same installed package. Private observational progress
lives beneath the adopted Controller state root in `lifecycle-continuation/`.
Prepared replacements, missing activation verification and unresolved drains stay
closed. No timer or notification control record initiates or recovers completion.
See [continuation recovery](notification-relay.md#continue-work-after-a-host-rollout).

Retirement preserves repositories, PRs, Issues, delivery evidence, original user
login stores, shared credentials, unrelated services and shared uplink networks.
It never revokes account credentials. Legacy/unadopted removal is unchanged.
Unsupported service supervisor or gateway layouts remain explicitly Pending.

## Retire obsolete notification resources

The contract advertises `notificationRelayRetirement`. Its fixed command,
`retire-notification-relay`, takes no arguments and requires the verified installed
administrator context. CLI can call it after its native credential and caller
setup. It does not provide or infer credential installation: a maintained native
caller proves the selected route, not the value of an unreadable GitHub secret.

Core verifies every actual adopted repository's live native Issue and Action
caller against the maintained recipes and adopted identities. An additional old
configuration origin must be an identically identified archived/disabled repository;
a live unadopted consumer prevents deletion. Missing obsolete configuration does
not prevent native activation, retirement or lifecycle completion. Corrupt obsolete
configuration prevents cleanup of shared resources whose consumers cannot be proved;
it does not become an unrelated lifecycle prerequisite.

Cleanup stops and disables the owned notification timer before stopping its worker.
Only exact root-owned installed unit resources and their verified configuration are
removed, after independent systemd readback confirms termination. Drop-ins, foreign
units and changed adoption are preserved. Command response loss re-enters the same
operation: confirmed stopped units and absent files are reused rather than written
again. No new timer, scheduler, queue or durable cleanup lock is introduced.

`retired` exits zero; `pending` exits two with a safe code and partial removal list.
Trust/admission refusal exits one. The optional old journal is pruned only after
worker termination using its existing gate. Confirmed terminal adopted-origin
receipts and obsolete poll caches can be removed. Owner pause, unknown effects,
malformed records, unrelated origins and replacement recovery evidence remain.
Their retained names are reported separately. None is required to activate a native
pool or complete its normal continuation. This command neither resumes Owner pause
nor removes active Issue/Writer state, registrations or shared credentials.

Controlled tests use two disposable slots, fake native services/registrations
and gateways, the real relay control interface and admission kernel gate. They
include process death after an effect. They establish maintained behavior, not
live provider switching, host installation certification or authenticated
GitHub removal. Native host/provider integration remains Unverified here.
