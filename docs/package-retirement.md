# Deployment package retirement

Installed lifecycle completion retires disposable Core deployment copies before
remote Issue continuation. The fixed administrator bridge also invokes cleanup
after its management child
exits, before management refresh. Refresh uncertainty cannot suppress cleanup.
Direct administrator completion and ordinary retries run the same policy when
the rollout plan is already gone. The legacy coordinator delegates to that policy.
A paused or pending continuation does not skip
local cleanup. No timer extension or remote ancestry query drives retirement.

Only `core-staged-<target>` and `core-before-<target>` directories in the adopted
installation parent are candidates. A backup suffix identifies the deployment
that created it; it need not equal the backup's own source commit. Names alone do
not authorize removal. Classification checks canonical root-owned paths, safe
permissions, the original Core manifest, repository attribution and the hashes
and modes of surviving payload. Symlinks, additional files, changed content and
foreign or unclassified paths remain untouched.

The shared policy protects installed source, adopted primary and peer references,
active rollout targets and backups, both current and next apply resource bindings,
and unresolved replacement recovery references. Apply completion alone does not
end recovery: the retained rollout intent still protects its exact packages until
verified service restoration and pool release permit the coordinator to remove
that intent. An old historical source pin or successful deployment receipt is not
a permanent reason to retain every backup.

Stopped and loaded service definitions, effective executable paths and service
working/root directories are observed without stopping services. Effective
properties exclude overridden commands and comments; unresolved executable
selectors defer cleanup. Management and
bootstrap recovery selections use the maintained adopted-source resolver rather
than retaining every package with a matching historical pin.

Linux observation covers executable and script paths, process roots and working
directories, descriptors, mapped files and process mount namespaces. Mount roots
are matched through the containing filesystem to detect bind aliases; escaped
kernel paths and directory boundaries are parsed explicitly. Failed visibility,
PID reuse or an unobserved pinned mount namespace retains the candidate. Process
exit is distinguished from permission or read failure. No process environments,
private arguments or raw exception messages appear in cleanup reports.

Retirement reuses resource preparation, coordinator, retirement and pool admission
kernel gates. It creates no cleanup database or adoption marker. Busy gates,
active resource leases and unresolved existing guards defer cleanup without changing
continuation or deployment exit semantics. No services are stopped for cleanup.
Classification, bindings and kernel use are observed again immediately before
removal and before discarding the original manifest. Each ordinary retry repeats
these checks. Payload is removed before the original manifest, so an interrupted
payload deletion remains classifiable. Before unlinking the manifest, retirement
persists its validated repository, source commit, path and directory identity in a
directory-local Linux extended attribute and syncs the directory. This narrowly
scoped finalization evidence survives interruption between manifest unlink and
`rmdir`, then disappears with the directory. Retry accepts it only for that same
empty directory after repeating binding and use observations. It never authorizes
unexpected payload or a replacement directory. Missing evidence remains
unclassified; a name cannot reconstruct ownership. If extended attributes cannot
be persisted, the manifest remains and cleanup reports
`PACKAGE_FINALIZATION_UNAVAILABLE` without changing continuation status.
A lost response after completed removal is reconciled from observed absence.

The completion result includes an additive `cleanup` object. `retired` contains
confirmed absent paths, `retained` contains candidate paths and safe reason codes,
and `deferred` explains a boundary that prevented observation. These fields do not
change the existing `dispatched`, `paused`, `pending` or denied conventions. The
legacy coordinator reports the same policy result as `packageRetirement`. Neither report claims live installation certification.

Implementation responsibilities are split across `package-candidates.mjs`
(classification and filesystem removal), `package-finalization.mjs`
(directory-local finalization evidence), `package-bindings.mjs` (adoption and
recovery references), `package-use.mjs` (Linux observation),
`package-services.mjs` (service configuration), and
`package-retirement.mjs` (policy and installed admission). Maintained regression
fixtures exercise these interfaces without systemd, GitHub or host mutation.
CI owns full affected checks and packaging; later installation verification owns
actual deployed-host behavior.
