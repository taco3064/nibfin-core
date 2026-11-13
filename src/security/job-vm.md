# Job VM development backend

The optional backend runs Writer commands in a disposable Firecracker VM.
Core, GitHub credentials, model login, and MCP configuration remain outside
the guest. Independent Accept and offline hooks use the existing backend.

The draft supports an offline guest with a separate Docker daemon. The
controller accepts only administrator-owned Firecracker, kernel, and base disk
paths. Set `jobVm.executable`, `jobVm.kernel`, `jobVm.rootDisk` and
`jobVm.memoryMiB` in the controller configuration when installing a validated
guest. Keep the VM disabled while preparing the installation.

The base disk needs a Linux userspace, Python 3, the maintained Agent tools,
and Docker Engine with its runtime and Buildx. Install `job-vm-init.sh` as
executable `/sbin/init` and `job-vm-executor.py` as
`/opt/nibfin/job-vm-executor.py`. The kernel must support KVM guests, virtio
block and vsock, cgroup v2, and Docker namespaces. The controller identity
needs access to `/dev/kvm` and `/dev/vhost-vsock`.

The guest currently has no external network interface. Production adoption
still needs project tool image transfer and restricted package/registry access
where the project requires them.
