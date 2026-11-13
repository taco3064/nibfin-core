#!/usr/bin/env python3
"""Build a credential-free Job VM disk from the installed Agent image."""

import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def install_file(root, source, target=None):
    source = Path(source)
    target = root / (target or str(source)).lstrip("/")
    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    if not parent.resolve().is_relative_to(root):
        raise ValueError(f"Guest path escapes the root: {parent}")
    if target.is_symlink():
        target.unlink()
    shutil.copy2(source, target)


def install_program(root, executable, target=None):
    install_file(root, executable, target)
    # These binaries come from the trusted Linux host installation. The
    # standard interpreter is copied separately because ldd lists it without =>.
    output = subprocess.run(("ldd", executable), text=True, capture_output=True)
    for line in output.stdout.splitlines():
        words = line.split()
        if len(words) > 2 and words[1] == "=>" and words[2].startswith("/"):
            install_file(root, words[2])
        elif len(words) > 1 and words[1] == "=>" and words[2] == "not":
            raise ValueError(f"Unavailable guest library: {words[0]}")


def export_agent(docker, image, root):
    # Docker creates a stopped container only. No environment, host mount, or
    # controller credential enters the exported filesystem.
    result = run(*docker, "create", "--pull=never", "--network", "none",
                 "--entrypoint", "/bin/false", image, capture_output=True, text=True)
    container = result.stdout.strip()
    try:
        with subprocess.Popen((*docker, "export", container),
                              stdout=subprocess.PIPE) as exported:
            try:
                run("tar", "-xf", "-", "-C", root, stdin=exported.stdout)
            finally:
                exported.stdout.close()
            if exported.wait():
                raise RuntimeError("Agent image export failed")
    finally:
        run(*docker, "rm", container, stdout=subprocess.DEVNULL)


def install_guest(root, source):
    install_file(root, "/lib64/ld-linux-x86-64.so.2")
    for name in ("python3", "docker", "dockerd", "containerd",
                 "containerd-shim-runc-v2", "runc", "ip"):
        program = shutil.which(name, path="/usr/sbin:/usr/bin")
        if program is None:
            raise ValueError(f"Required guest executable unavailable: {name}")
        install_program(root, program)
    python = Path("/usr/bin/python3").resolve()
    install_file(root, python)
    library = run(str(python), "-c",
                  "import sysconfig; print(sysconfig.get_path('stdlib'))",
                  capture_output=True, text=True).stdout.strip()
    library_target = root / library.lstrip("/")
    if not library_target.parent.resolve().is_relative_to(root):
        raise ValueError("Guest Python library path escapes the root")
    shutil.copytree(library, library_target, dirs_exist_ok=True, symlinks=True)
    install_file(root, "/usr/libexec/docker/docker-init", "/usr/local/bin/docker-init")
    install_file(root, "/usr/libexec/docker/cli-plugins/docker-buildx")
    install_file(root, source / "job-vm-executor.py", "/opt/nibfin/job-vm-executor.py")
    install_file(root, source / "job-vm-init.sh", "/sbin/init")
    (root / "sbin/init").chmod(0o755)
    run("chroot", root, "/usr/bin/python3", "-c", "import json, socket, selectors")
    run("chroot", root, "/usr/local/bin/codex", "--version")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Installed Agent image")
    parser.add_argument("--socket", required=True, help="Trusted host Docker socket")
    parser.add_argument("--disk", type=Path, required=True, help="New ext4 disk path")
    parser.add_argument("--size-mib", type=int, default=3072)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / "src/security"
    docker = ("/usr/bin/docker", "--host", "unix://" + args.socket)
    directory = args.disk.absolute().parent.resolve(strict=True)
    output = directory / args.disk.name
    if output.exists() or output.is_symlink() or args.size_mib < 128:
        parser.error("Choose a new disk path and at least 128 MiB")
    with tempfile.TemporaryDirectory(prefix="nibfin-vm-build-", dir=directory) as tmp:
        root = Path(tmp) / "root"
        root.mkdir()
        export_agent(docker, args.image, root)
        install_guest(root, source)
        disk = Path(tmp) / "guest.ext4"
        with disk.open("xb") as stream:
            stream.truncate(args.size_mib * 1024 * 1024)
        run("mkfs.ext4", "-q", "-F", "-d", root, disk)
        disk.chmod(0o644)
        output.hardlink_to(disk)


if __name__ == "__main__":
    main()
