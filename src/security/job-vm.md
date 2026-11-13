# Job VM development backend

The optional backend runs Writer commands in a disposable Firecracker VM.
Core, GitHub credentials, model login, and MCP configuration remain outside
the guest. Independent Accept and offline hooks use the existing backend.

The guest runs a separate Docker daemon. The
controller accepts only administrator-owned Firecracker, kernel, and base disk
paths. Set `jobVm.executable`, `jobVm.kernel`, `jobVm.rootDisk` and
`jobVm.memoryMiB` in the controller configuration when installing a validated
guest. The host administrator can build the disk from the adopted Agent image
with `python3 scripts/build-job-vm.py --image IMAGE --socket SOCKET --disk PATH`.

The base disk needs a Linux userspace, Python 3, iproute2, the Agent tools,
and Docker Engine with its runtime and Buildx. Install `job-vm-init.sh` as
executable `/sbin/init` and `job-vm-executor.py` as
`/opt/nibfin/job-vm-executor.py`. The kernel must support KVM guests, virtio
block and vsock, cgroup v2, and Docker namespaces. The controller identity
needs access to `/dev/kvm`. Firecracker provides its own vsock transport.

The guest has no external network interface. Its local proxy forwards allowed
HTTPS package and project domains through Core's existing egress checks.
When an Issue selects project tools, Core copies the tool directory from the
selected Agent image into the guest. Core leaves
the host Agent and Hook image selection on the existing path.
