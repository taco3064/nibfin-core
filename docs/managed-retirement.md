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
   It durably pauses the notification relay through its control interface.
   New Controller admissions and pre-Worker admission refuse the draining pool.
   Continuation checks the drain boundary before beginning another stage.
3. Existing admitted work settles. Core checks admission and credential leases,
   all adopted repositories' native Jobs, journals, Writer/session fences,
   containers and both service cgroups. Under the relay gate it also requires
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
7. `retired` is the durable release point. Replacement availability is irrelevant
   to completion. The drain marker remains until a separately verified adoption
   publishes fresh IDs and its new provider binding. The existing
   `adopt-shared-host` administrator operation can perform this explicit rebuild;
   ordinary updates and stale IDs cannot rebind the provider.

Runtime records are `/etc/nibfin/managed-retirement.json` and the root-owned
`/etc/nibfin/managed-pool-drain.json`. Retirement serializes with adoption and
rollout through their existing guard. Its separate kernel gate permits recovery
of a tagged retirement guard after process death; an unresolved adoption or
rollout guard is preserved. A later retirement archives the previous completed
record as `retirement-history-<retirementId>.json` in the same directory.

The completed record preserves bounded peer adoption identities. A replacement
starts with its own primary adoption; historical peers require fresh native and
source revalidation through `adopt-shared-peer`. Historical views cannot execute
against the new pool. A failed replacement leaves retirement completed and
admission closed. Relay resume remains a separate administrator decision.

Retirement preserves repositories, PRs, Issues, delivery evidence, original user
login stores, shared credentials, unrelated services and shared uplink networks.
It never revokes account credentials. Legacy/unadopted removal is unchanged.
Unsupported service supervisor or gateway layouts remain explicitly Pending.

Controlled tests use two disposable slots, fake native services/registrations
and gateways, the real relay control interface and admission kernel gate. They
include process death after an effect. They establish maintained behavior, not
live provider switching, host installation certification or authenticated
GitHub removal. Native host/provider integration remains Unverified here.
