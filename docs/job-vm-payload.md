# Per-Job VM runtime payload

The Writer composition captures `src/security/job-vm-executor.py` immediately
following verification of its adopted Core package. Each invocation receives a
private copy of those bytes. VM preparation builds a runtime archive even when
the project has no selected tools. Later installed-source changes do not select
another executor for that already composed Job.

The optional selected image supplies only an archived `project/` subtree. Docker
copies it as a tar stream without extracting image-controlled paths on the host.
The payload producer validates that stream, then constructs a new archive with
the fixed executor and allowed project entries. It rejects duplicate paths,
non-directory ancestors, special files, absolute and traversal paths, escaping
links and link cycles. Safe relative links remain available to project tools.
Hard links resolve to regular project files and follow those files in the output.

The existing launcher exposes the archive as a read-only block. Supported guest
init extracts it into the private root disk before starting its fixed executor
path. No shared base-disk update is involved. Existing VM retirement owns the
archive and private disk; the producer removes intermediate executor and project
archive copies after assembly.

This payload path alone does not establish installed VM readiness or post-merge
upgrade continuation. The Writer still validates actual prepare replies before
model execution. Native VM startup, installed upgrade completion and deployment
remain separate observations; controlled archive tests do not establish them.
