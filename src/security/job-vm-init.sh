#!/bin/sh
set -eu

export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /run /tmp /sys/fs/cgroup
mount -t devpts devpts /dev/pts
mount -t cgroup2 none /sys/fs/cgroup

# The daemon runs entirely in the VM. No Docker socket or host directory is
# attached to the guest. This entry point supports offline Docker workloads.
dockerd -H unix:///run/docker.sock \
    --iptables=false --ip6tables=false --userland-proxy=false \
    --bridge=none --ip-forward=false --storage-driver=vfs &
daemon=$!
for attempt in $(seq 1 30); do
    if docker -H unix:///run/docker.sock info >/dev/null 2>&1; then
        exec /usr/bin/python3 /opt/nibfin/job-vm-executor.py
    fi
    kill -0 "$daemon" || exit 1
    sleep 1
done
exit 1
