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
   For an adopted artifact route it also pauses notification dispatch. Native
   routes do not load obsolete notification configuration or control files.
   New Controller admissions and pre-Worker admission refuse the draining pool.
   Continuation checks the drain boundary before beginning another stage.
3. Existing admitted work settles. Core checks admission and credential leases,
   all adopted repositories' native Jobs, journals, Writer/session fences,
   containers and both service cgroups. Artifact routes additionally require
   paused relay control. Native routes inspect existing dispatch evidence only
   for effects affecting this pool or its repositories; absent obsolete state
   is allowed. Unrelated records do not block native retirement. Lost-response
   effects affecting the pool remain protected even without a native run ID.
   Retirement never clears or reposts them. Busy, unavailable or unknown observations
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
the primary adoption, re-adopt the historical peers with `adopt-shared-peer`,
start the two new listeners, and verify current route configuration. Native
callers need no notification relay. Artifact callers retain their existing relay
readiness requirement. While the drain marker exists, the listeners can be
observed online,
but both Worker execution and new relay dispatches remain closed.

The fixed, argument-free `activate-shared-replacement` operation is local
administrator only. It verifies both new registrations, absence of the old IDs,
the local services, private credential identity, all historical repository and
caller bindings, installed source, current caller continuity and destination workflow. Native readiness also
observes `NIBFIN_SHARED_RUNNER_POOL=true`, the effective destination variable
(including the official fallback), and `NIBFIN_WAKE_TOKEN` secret metadata. These
observations establish configuration, not live dispatch success. Only artifact
routes require relay configuration and timer readiness. Core then durably records
the release and removes the drain marker. A verification failure leaves admission closed. If publication is
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

Controlled tests use two disposable slots, fake native services/registrations
and gateways, the real relay control interface and admission kernel gate. They
include process death after an effect. They establish maintained behavior, not
live provider switching, host installation certification or authenticated
GitHub removal. Native host/provider integration remains Unverified here.

## Native migration and notification cleanup

The public `managedNotificationLifecycle` capability advertises route-aware
activation/retirement, `refresh-native-issue-caller` and `cleanup-notifications`.
CLI owns credential setup and installation orchestration. After publishing the
exact native caller and preparing its effective configuration, CLI can invoke
`refresh-native-issue-caller OWNER/REPO REPOSITORY_ID` as the installed administrator.
Core observes the current caller, destination and configured secret metadata,
then uses the existing admission/adoption locks and atomic readback to update
its binding. Failure preserves adoption and existing notification resources.
The compatibility `refresh-managed-issue-caller` still refreshes either recipe.
Neither command loads the old relay, so a missing or broken relay does not block
native preparation.

After native activation, run the fixed argument-free `cleanup-notifications`.
See [notification cleanup and recovery](notification-relay.md#native-migration-cleanup)
for its bounded results and resource-specific retention. Cleanup is independent
of activation: retained shared resources or unresolved cleanup do not become a
native activation or deployment gate. Core's existing rollout continuation
interface and engine remain separate.
