# Event-driven Core maintenance

Successful Core CD completion selects its own unexpired activation artifact.
`.github/workflows/core-maintenance.yml` uses a hosted selector and official
`workflow_dispatch` to submit one `core-maintenance` Job to the existing shared
Runner pool. The hosted selector does not run installation code on the host.
The installed pre-Worker verifies the actual workflow, run, attempt, Job GUID
and assigned adopted Runner before starting the official Worker. The privileged
operation separately verifies signed GitHub OIDC and the selected native target.

Normal init and upgrade prepare the fixed external management entry from a
normally verified complete Core package. They use the existing GitHub CLI login
and supported administrator installation; no manual credential copying, third
Runner, timer, polling service or external watcher is needed. An old Core without
the new commands uses the same normal verified bootstrap, before attempting the
new maintenance Job. Bootstrap changes Nibfin management programs and metadata,
not official Runner binaries, registration, live Core or adopted bindings.

The installed public contract exposes `eventDrivenCoreMaintenance`. Its fixed
bridge, client and pre-Worker dispatcher reside under
`/usr/local/libexec/nibfin/core-rollout`, outside the replaceable `manager` and
`/opt/nibfin/core` trees. Requests cannot choose a root program, source directory,
service list or another installation. Runner accounts may request only read-only
pre-Worker admission or authenticated Core-only maintenance. Changing a request
kind cannot grant a Runner the normal administrator route.

## Explicit administration and retry

### A stopped legacy installation

Bootstrap readiness does not mean that live Core was upgraded or that its
listeners can start. Some legacy startup checks require the dispatcher packaged
with their own live source. Bootstrap installs the new fixed dispatcher first;
starting an old listener at that intermediate point can therefore fail with
`SHARED_RUNNER_WORKER_ADMISSION_REQUIRED`, before any official Listener or Job
starts. A queued maintenance Job cannot repair a listener that cannot start.

Keep the two original stopped services stopped through this transition:

1. Use normal init/upgrade to verify the selected Core package and prepare the
   fixed external management entry with the selected GitHub CLI login. Do not
   assume the old live Core already has the new management commands below.
2. From outside both Runner services, use the prepared administrator bridge for
   the selected successful native CD run and activation artifact. For the
   stopped-pool administrator operation, the request is:

   ```sh
   printf '%s\n' '{"kind":"administrator","coreOnly":false,"target":{
     "runId":123,"artifactId":456}}' |
     sudo /usr/local/libexec/nibfin/core-rollout/bridge.py
   ```

   Replace the example IDs with the actual selected native objects. This uses
   the existing administrator lifecycle; it does not bypass target eligibility,
   source integrity, settlement, consumer branch protection or admission.
3. Read back completed live installation and management entries. Bootstrap's
   `installed` receipt alone is insufficient: it intentionally leaves live Core
   and adopted bindings unchanged. An observation failure or pending apply uses
   the same operation's normal retry, reusing confirmed effects.
4. After source and entry readback, resume only the original services whose
   startup is authorized. Originally stopped services remain stopped until that
   separate resumption. Installation completion and paused/pending continuation
   are distinct outcomes.

This is separate from Core-only maintenance on an already serving pool. Do not
start an intermediate legacy listener merely to consume its queued upgrade,
patch the immutable old startup check, put the old dispatcher back, create a
third Runner, or restore a timer or polling repair service. If an explicit
target is refused, diagnose the reported cause; these steps do not authorize
forcing a divergent or otherwise ineligible source. An Owner-authorized reinstall
after a deliberate main rollback is a separate local administration decision.

The regression fixture preserves the historical slot guard from
[Core f44a2f2](https://github.com/taco3064/nibfin-core/blob/f44a2f2776ecc375b707e21e1664eb6b1a6a85ba/src/security/shared-runner-start-check.mjs)
and exercises it with controlled host observations alongside the current guard
and filesystem transaction seam. It covers the intermediate refusal, source
promotion before readiness, retained registration/runtime observations and
interrupted apply. It does not execute service restoration. The administrator's
existing pool restore branch separately uses the captured original service
states and only starts services that were running and stopped by that operation.
Portable controlled coverage is not evidence of a real host installation,
actual service startup, signed maintenance Job or public CLI ordering defect.

### An already modern installation

From an already verified modern installed Core, a normal root administrator can
prepare or repair the same management installation:

```sh
node /opt/nibfin/core/bin/nibfin-core.mjs install-core-rollout-manager
```

Select one successful native Core CD run and that run's `nibfin-activate-*`
artifact ID. Preserve those native identities on retry:

```sh
node /opt/nibfin/core/bin/nibfin-core.mjs rollout-core-only RUN_ID ARTIFACT_ID
```

The stopped-pool administrator operation remains separate:

```sh
node /opt/nibfin/core/bin/nibfin-core.mjs rollout-core RUN_ID ARTIFACT_ID
```

It must run outside both Runner services. Neither a serving maintenance Job nor
a job-completed hook may stop its own listeners. Core-only compatibility is
determined from actual runtime, dispatchers, service layout and registrations;
an incompatible change returns its specific unsupported result instead of
pretending that a caller flag made it safe.

The fixed bridge remains reachable when live Core is temporarily absent during
a recorded apply. A normal administrator can request the same target directly:

```sh
printf '%s\n' '{"kind":"administrator","coreOnly":true,"target":{
  "runId":123,"artifactId":456}}' |
  sudo /usr/local/libexec/nibfin/core-rollout/bridge.py
```

Replace the example IDs with the actual selected native objects. No input chooses
a filesystem path or executable. `inspect` requests read actual capability and
entry state; `prepare` repairs only that already verified management installation.
These normal administrator operations are refused to Runner invokers.

To retry automatic CD, use GitHub's **Re-run jobs** on the original authorized CD
run. This preserves its original event and source. The existing manual draft-only
CD inputs keep their draft policy; a manual or docs-only result without an
activation artifact is unavailable for maintenance and dispatches no host Job.
An existing successful activation may also be retried through the maintenance
workflow's two native ID inputs. No recurring discovery or recursive workflow
chain is involved.

## Interruption, source lifetime and completion

The stable bridge takes the existing `/etc/nibfin` directory gate before loading
management code. Read-only pre-Worker admission holds a shared source lease;
manager publication and installation use the existing exclusive operation.
Inherited descriptor handoff refers to the same open description and actual
directory inode. It is serialization, not execution authorization. A competing
operation reports pending through its normal retry path; no elapsed-time cutoff
or additional execution lock is used.

Source verification is independent of the live transaction. Actual adopted LIVE
readback works without an old response or unrelated planning receipt. A valid
recorded apply may identify its verified backup or staged source when LIVE is
absent. Corrupt source, foreign files and contradictory transaction data are not
treated as successful absence. Confirmed provider writes, consumer merges and
installation effects are reused; successful reads finding unfinished work enter
the same operation again.

After installation, the old management child exits before its management code
can be replaced. The normal installer publishes the current verified management
package and stable entries. A verified predecessor is retained only while needed
to reconcile owned entry publication, then removed after readback. Missing pin
or runtime publication metadata is repaired against the actual complete package.
Unknown files remain available for an Owner decision.

After successful source and entry readback, the bridge converts the existing
gate to shared mode, freshly observes the current installation and invokes the
fixed new Core's `complete-installed-lifecycle`. The shared lease admits newly
dispatched pre-Workers while excluding another source writer. A failed conversion
or observation preserves `installation: complete` and a pending continuation.
Retrying this outcome does not repeat promotion, registration or replacement.
Owner pauses and originally stopped services retain their existing meanings.

The retired rollout units and their recognized installed script are cleaned up
after native entry readback. Cleanup preserves plans, closures, credentials,
Owner pauses, active unknown processes and unrelated files. An unused retained
script is cleanup information, not proof that a legacy credential consumer is
running. Credential admission checks the actual fixed unit and timer state.
