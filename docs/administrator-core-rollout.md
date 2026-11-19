# Explicit administrator Core rollout

This is a one-target, out-of-pool administrator operation. It does not discover
new releases or replace the native CD event caller. It must run from a root
administrator session outside the two Runner services. A Runner job or its
completion hook must never invoke an operation which stops that same pool.

First use the normally verified installed Core to prepare its management package:

```sh
node /opt/nibfin/core/bin/nibfin-core.mjs install-core-rollout-manager
```

This installs the complete verified code closure under
`/usr/local/libexec/nibfin/core-rollout/manager`. Ownership, ancestors and package
contents are checked. Its code location is distinct from the live installation
at `/opt/nibfin/core`. Update this management package only after the previous
rollout has completed; an outstanding rollout plan prevents replacement.

Select one successful native Core CD run and that run's unexpired
`nibfin-activate-*` artifact ID. The administrator interface accepts their native
numeric IDs, not a command, executable path, service list or caller assertion:

```sh
node /opt/nibfin/core/bin/nibfin-core.mjs rollout-core RUN_ID ARTIFACT_ID
```

The fixed management entry remains available if an interrupted package rename
has temporarily removed the live Core entry. Retry the same target with:

```sh
python3 /usr/local/libexec/nibfin/core-rollout/manager/scripts/core-rollout-admin.py \
  RUN_ID ARTIFACT_ID
```

The caller validates the exact native run, artifact, activation and source
package. Target discovery is separate from the shared one-target coordinator.
Consumer proposals, current provider binding, source integrity and installation
readback retain their existing checks. Confirmed merges and package/configuration
writes are reused. A successful observation with no completed result resumes the
unfinished operation. A failed provider observation returns a normal retry result.

The operation uses the existing rollout closure and stopped-listener transaction.
It records actual running states before closing admission, restores only listeners
it stopped, and leaves originally stopped services and the Owner pause control
untouched. It never equates an enabled service with permission to start it.
The manager's code remains fixed throughout both package renames and every
configuration write; retained package paths are inspected as data, not selected
as executable recovery code.

After source, configuration, service-state readback and closure release succeed,
a separate process invokes the **new** installed Core's
`complete-installed-lifecycle`. The output distinguishes `installation: complete`
from continuation `dispatched`, `paused` or `pending`. Retrying a pending
continuation observes the installed result and does not repeat installation.
This also works when both the old rollout plan and completion receipt are absent.
The fixed administrator observer reads the current host adoption and full source
package, current native registrations and service states without creating a
closure or stopping/restoring anything. The verified native target and all four
consumer readbacks must agree before continuation. Management code can be older
than the installed package: its source pin identifies executable code, while
current host adoption plus actual package verification identifies installed state.
An unrelated active closure is preserved and reported for normal retry.
This observation remains valid while another Issue holds ordinary work or
credential leases or a native Runner is busy. It verifies installation facts;
promotion and release separately retain all drain, idle and settlement checks.
Existing credential admission creates and releases its real managed lease; it
does not bypass managed credentials through the legacy manual-token reader.

The management package contains no timer, scheduler, polling service or new
execution lock. It shares the existing administrator configuration-directory
serialization and the existing apply transaction. Core-only promotion without
stopping listeners and native-event wiring are separate follow-up capabilities.
