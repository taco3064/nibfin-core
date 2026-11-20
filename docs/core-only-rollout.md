# Core-only rollout

`nibfin-core rollout-core-only CD_RUN_ID ARTIFACT_ID` submits a serving-pool
maintenance request to the adopted GitHub execution repository and reads back the
native result on retry. The maintenance Job uses the verified management package
outside the Core directory being replaced. For explicit offline recovery, stop
both Runner services and wait for their process groups to exit before running
`rollout-core`. Core-only mode preserves Runner service state and registration.

Before admission closes, Core-only mode compares the candidate against the actual
installed pool runtime, service template, Worker dispatcher and adopted host
configuration. Provider, credentials, registration, layout, Node or service changes
return `unsupported` with `CORE_ONLY_MAINTENANCE_REQUIRED` and concrete reasons.
They require a separate maintenance operation. A candidate's changed bootstrap
Runner release table alone does not invalidate an existing verified installation.

The pool Node is read from its own fully verified installed package contract, not
from the management process version. During source replacement, the existing
transaction's verified backup can provide these facts as data. Core never imports
or executes code from the backup. Missing Runner identity metadata is reconstructed
only during apply preparation, using the existing installer producer and the
verified installed source's known official executable facts. Preview stays read
only; unknown or modified executables cannot be enrolled through their own digest.

Each write rechecks compatibility and existing business settlement. All pool
consumers, other credential consumers, Writer sessions and unresolved effects must
settle. Listener state remains exactly as observed before the operation, including
a listener that was already stopped. Existing apply readback reuses confirmed
source/configuration writes after interruption or a lost response.

After release, the management process observes the actual installed pool Node and
uses it to invoke the new Core's normal lifecycle completion. A failed observation
returns pending and follows normal retry; it does not reinstall a confirmed target.
Owner pause continues to suppress dispatch through that normal lifecycle route.

## Native maintenance consumer contract

Core exposes a narrow internal entry through its installed maintenance bridge.
The maintenance workflow and pre-Worker route use GitHub's current run and Runner
identity to authenticate the operation.

Core's own deployment uses `.github/workflows/core-maintenance.yml` and the
`core-maintenance` Job. An adopted execution repository can use the maintained
upgrade execution workflow with the Core activation inputs. Both use the native
`workflow_dispatch` event. The fixed privileged bridge verifies the signed
`nibfin:core-maintenance` invocation and selects the installed package entry.

Private stdin contains exactly:

```json
{
  "token": "GitHub signed OIDC token",
  "runId": 123,
  "attempt": 1,
  "jobId": 456,
  "runnerId": 42,
  "target": { "runId": 789, "artifactId": 321 }
}
```

The invoker UID comes from the actual fixed sudo wrapper's `SUDO_UID`. Request
data cannot choose an executable, repository, workflow, mode or UID. Admission
checks the GitHub signature and native repository, protected source, run attempt,
workflow, job, Check Run and assigned adopted Runner. The Check Run ID comes from
the job's native `check_run_url`; it need not equal the REST Job ID. The workflow's
source commit is independent of the target CD commit, and its native actor can
differ from the adopted host Owner.

Initial authorization borrows and releases its normal credential/resource scope
before starting the coordinator. The JWT is never persisted. Minimal invocation
provenance is stored in the existing Root-owned rollout plan. Every Node phase
reads that fixed plan, freshly observes native state and mints its own private
process-local scope. Only that exact maintenance Job and its assigned Runner's
busy status can be excluded from settlement. There is no pool-lease exception.
An ordinary object, request flag, path or environment value cannot create a scope.

The separate fixed pre-Worker bridge can use `observeCoreMaintenanceWorker` with
an actual Root manager context, original Listener frame and actual invoker UID.
The native Job is found across all pages for the exact run attempt; the Check
Run's `external_id` must equal the Listener's Job GUID. That observation returns
no promotion scope. A closed pool additionally requires the existing Root-owned
Core-only plan, complete matching closure and adopted pool identity. This permits
only the fixed maintenance Worker to start. Exact target proof remains with the
later signed Root operation before writes; pre-Worker admission does not claim
that an unobserved frame input or operation target was already verified.

GitHub's concurrency group orders serving-pool maintenance Jobs in the adopted
execution repository. The fixed bridge keeps its verified management package
available for the life of the process. After installation, it reads the selected
manager and installed pool runtime again before completing the lifecycle. A
failed observation leaves installation complete and continuation pending so that
retry can reuse the confirmed installation.

Another authenticated Job may resume the same target after fresh admission. It
does not bypass another target's closure, retirement or Owner pause. Ordinary
Issue jobs keep their existing admission and stopped/destructive safeguards.
