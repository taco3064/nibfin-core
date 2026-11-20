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
native discard reuse, failed or unknown observations, and successful or failed
invocation. A successful zero-byte result is
preserved. A lost helper response leaves invocation status unknown (`null`),
rather than asserting that no invocation happened. Raw command output, paths and
credentials are not included in these diagnostics. An unavailable legacy/manual installation has no escalation fallback.

The fixed installed root helper accepts no target or configuration input. It
selects eligible writable ext4 block-backed filesystems from managed storage
roots and trusted Linux mount information. Other filesystem semantics remain
unsupported. It observes backing-device discard capability through sysfs. A
confirmed effective ext4 `discard` path is reused without invoking `fstrim`;
configured discard without a usable backing path does not prove reclamation.
Failed capability reads remain unknown and do not trigger trimming. It never
requests all mounted filesystems. Unsafe ownership, noncanonical paths, ambiguous
mounts and device identity mismatches remain unknown. Read-only storage and
bind/subvolume mounts are unsupported. A successful request applies
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

The ext4 [mount option contract](https://www.kernel.org/doc/html/latest/admin-guide/ext4.html)
defines discard on block freeing. The [fstrim manual](https://man7.org/linux/man-pages/man8/fstrim.8.html)
describes online discard and potential bytes, rather than measured host recovery.
Permission preparation is optional at managed preparation and installed lifecycle
completion; its failure is reported without blocking installation or continuation.
