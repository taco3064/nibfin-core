# Deployment package retirement

Core reconsiders obsolete `core-staged-<commit>` and `core-before-<target>`
packages during installed lifecycle completion and after the administrator's
management child exits. Cleanup runs before continuation admission and dispatch,
so paused work and pending remote operations do not prevent local cleanup.
A failed management refresh keeps installation complete and cleanup independent.
The legacy staged cleanup delegates to this same implementation.

A name, age or Git ancestry does not authorize removal. Core checks canonical
root-owned paths, protected ancestors, the complete package manifest and every
attributed file. A rollback package's source comes from its contents, not the
target in its name. Foreign, changed, injected, symlinked and unsupported entries
remain in place. Core does not stop services or delete recovery state to make a
package removable.

Current primary and peer adoption, active apply packages, and the executable
selection used by management and bootstrap protect required deployment source.
The existing adopted-source selector remains authoritative, including its
healthy-live behavior. Current management publication pins use that selector;
historical manager recovery copies remain self-contained recognition data owned
by management publication, rather than a reason to keep all deployment copies.
Relevant unreadable facts defer retirement. An unrelated valid planning record
protects its own packages and does not veto other obsolete packages.

Immediately before deletion, Core rechecks package identity and current local
references, process executable/root/cwd, mapped files, open descriptors, mounts in
observed process namespaces, and effective installed/loaded service properties.
For bind mounts, Core compares roots on the backing filesystem, including when
that filesystem is mounted below the host root or the bind appears in another
namespace. Service arguments use the effective working directory under the
service root and include relative script and option paths. Effective properties
are checked on configured units and concrete template instances, including
inactive services. Failed observations preserve affected material.

Removal runs under the existing exclusive configuration-directory kernel gate.
An inherited shared gate is deferred, never upgraded by cleanup. The fixed bridge
owns its existing promotion boundary and runs cleanup after the child exits,
before downgrading for continuation. Executing package source remains protected.
No additional lock, timer, work queue or recovery-source registry is introduced.

After complete verification, Core durably records a per-package deletion intent
beside the package as `.retiring-core-<kind>-<commit>.json`. This contains its
existing manifest attribution and directory device/inode and creation time, not credentials or a
new executable selection. It is necessary to distinguish an interrupted removal
from arbitrary damaged source and to reconcile the final manifest/directory
removal gap. Retries verify each remaining entry against that attribution;
missing entries are accepted only with that intent. Files are removed individually,
then empty directories, then the manifest and package directory, and finally the
intent. Core checks each entry's identity before removal and repeats the reference
and content checks before removing the manifest. Unexpected replacements and
injected entries are retained. Lost responses are read back against actual absence;
confirmed removal is never repeated on a replacement. Normal lifecycle retries
resume unfinished cleanup.

Typed results carry sanitized `cleanup` records with a package name, `removed`
or `retained` status, and a stable reason code. Sweep-wide unavailable observations
have no package field. Raw paths, commands, service configuration and exception
text do not enter these records. Cleanup uncertainty does not change installation
or continuation outcomes. Full native installation, CI and deployment verification
remain with their owning stages.
