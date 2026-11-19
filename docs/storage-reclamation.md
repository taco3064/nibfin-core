# Online reclamation after managed cleanup

Core requests online filesystem discard after successful retirement of disposable
role sources, confirmed private Agent homes (including recovered sessions), and
settled delivered workspaces. Existing termination, credential scans, candidate
preservation, closure and recovery checks still decide whether files can be
removed. The role completion path combines source and home retirement into one
request. Recovery receipts and active or unpublished work remain protected.

Reclamation is best effort. Cleanup diagnostics contain structured status,
platform, whether invocation was attempted, and any observed byte count. Results
distinguish unsupported storage/platform, unavailable tools or privilege,
successful invocation and failed invocation. A successful zero-byte result is
preserved. Raw command output, paths and credentials are not included in these
diagnostics. An unavailable legacy/manual installation has no escalation fallback.

The fixed installed root helper accepts no target or configuration input. It
selects eligible writable ext4, XFS or Btrfs block-backed filesystems from managed
storage roots and trusted Linux mount information. It never requests all mounted
filesystems. Unsafe ownership, noncanonical paths, read-only storage, ambiguous
devices or bind/subvolume mounts are unsupported. A successful request applies
to the selected filesystem, which may also contain other host data.

Native Linux and WSL guest operations are identified separately. `fstrim` byte
counts describe eligible filesystem extents; they do not prove physical bytes
returned to Windows. Core does not modify VHD settings, compact offline storage,
stop WSL or stop the Runner pool for reclamation.

A missing response or failed discard does not undo deletion or delivery. The
normal cleanup/recovery retry can request discard again after observing retained
state; there is no separate reclamation journal, timer or completion gate.
Installed updates reconcile the fixed permission through the same installer used
by [managed preparation](managed-resource-preparation.md).
