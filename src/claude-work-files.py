"""Descriptor-relative workspace operations; never follows links."""
import os
import json
from pathlib import Path
import stat

LIMIT = json.loads(Path(__file__).with_name(
    "claude-work-limits.json").read_text())["contentBytes"]
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC


def parts(path):
    result = path.split("/")
    if (path.startswith("/") or any(p in ("", ".", "..") for p in result)
            or len(result) > 64 or any(p == ".git" for p in result)):
        raise ValueError("UNSAFE_PATH")
    return result


def parent(root, path):
    names = parts(path)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        for name in names[:-1]:
            next_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW,
                              dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd, names[-1]
    except BaseException:
        os.close(fd)
        raise


def regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("UNSAFE_FILE")


def read(root, path, search=None):
    directory, name = parent(root, path)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=directory)
        with os.fdopen(fd, "rb") as source:
            regular(source.fileno())
            data = source.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError("FILE_LIMIT")
        text = data.decode("utf-8")
        if search is None:
            return text
        return "\n".join(f"{i}: {line}" for i, line in enumerate(
            text.splitlines(), 1) if search in line)[:LIMIT]
    finally:
        os.close(directory)


def write(root, path, content):
    data = content.encode("utf-8")
    if len(data) > LIMIT:
        raise ValueError("FILE_LIMIT")
    directory, name = parent(root, path)
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_NONBLOCK | NOFOLLOW,
                     0o644, dir_fd=directory)
        with os.fdopen(fd, "wb") as output:
            regular(output.fileno())
            os.ftruncate(output.fileno(), 0)
            output.write(data)
        return "written"
    finally:
        os.close(directory)
