"""Construct the guest runtime archive without extracting image-controlled paths."""
import sys
sys.dont_write_bytecode = True

import copy
import io
from pathlib import PurePosixPath
import tarfile


class InvalidPayload(ValueError):
    pass


def reject():
    raise InvalidPayload('JOB_VM_PAYLOAD_UNSAFE')


def name_of(value):
    # A directory's trailing slash is conventional, but aliases are ambiguous.
    value = value[:-1] if value.endswith('/') else value
    if not value or value.startswith('/') or '\\' in value or '\x00' in value:
        reject()
    if any(part in ('', '.', '..') for part in value.split('/')):
        reject()
    if value != 'project' and not value.startswith('project/'):
        reject()
    return value


def link_parts(link):
    if not link or link.startswith('/') or '\\' in link or '\x00' in link:
        reject()
    return link.split('/')


def validate(entries):
    members = {}
    for entry in entries:
        name = name_of(entry.name)
        allowed = (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE,
                   tarfile.SYMTYPE, tarfile.LNKTYPE)
        if name in members or entry.type not in allowed:
            reject()
        members[name] = entry
    for name, entry in members.items():
        parent = PurePosixPath(name).parent
        while str(parent) != '.':
            ancestor = members.get(str(parent))
            if ancestor is not None and not ancestor.isdir():
                reject()
            parent = parent.parent
        if entry.issym():
            link_parts(entry.linkname)
        elif entry.islnk():
            name_of(entry.linkname)

    def walk(parts, stack, visiting):
        for index, part in enumerate(parts):
            if part in ('', '.'):
                continue
            if part == '..':
                if len(stack) <= 1:
                    reject()
                stack.pop()
                continue
            stack.append(part)
            if stack[0] != 'project':
                reject()
            prefix = '/'.join(stack)
            entry = members.get(prefix)
            if entry is None:
                continue
            if entry.isfile() and index < len(parts) - 1:
                reject()
            if not (entry.issym() or entry.islnk()):
                continue
            if prefix in visiting:
                reject()
            if entry.issym():
                target = link_parts(entry.linkname)
                base = stack[:-1]
            else:
                target = name_of(entry.linkname).split('/')
                base = []
            stack = walk(target, base, visiting | {prefix})
            if entry.islnk():
                leaf = members.get('/'.join(stack))
                if leaf is None or not leaf.isfile() or index < len(parts) - 1:
                    reject()
        return stack

    targets = {}
    for name, entry in members.items():
        resolved = '/'.join(walk(name.split('/'), [], set()))
        if entry.islnk():
            targets[name] = resolved
    for name, target in targets.items():
        members[name].linkname = target
    return members


def build(executor, project, destination):
    with tarfile.open(destination, 'w', format=tarfile.PAX_FORMAT) as output:
        runtime = tarfile.TarInfo('job-vm-executor.py')
        runtime.mode = 0o755
        runtime.size = len(executor)
        output.addfile(runtime, io.BytesIO(executor))
        if project is None:
            return
        with tarfile.open(project, 'r:*') as source:
            entries = validate(source.getmembers())
            ordered = sorted(entries.items(), key=lambda item: item[1].islnk())
            for name, original in ordered:
                entry = copy.copy(original)
                entry.name = name
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ''
                entry.mode &= 0o777
                entry.pax_headers = {}
                if entry.islnk():
                    entry.linkname = name_of(entry.linkname)
                data = source.extractfile(original) if entry.isfile() else None
                try:
                    output.addfile(entry, data)
                finally:
                    if data is not None:
                        data.close()


def main():
    from pathlib import Path
    executor, project, destination = sys.argv[1:]
    build(Path(executor).read_bytes(), None if project == '-' else project,
          destination)


if __name__ == '__main__':
    try:
        main()
    except OSError as error:
        import json
        print(json.dumps({'code': 'JOB_VM_PAYLOAD_IO_FAILED', 'errno': error.errno}))
        sys.exit(1)
    except (ValueError, RecursionError, tarfile.TarError):
        import json
        print(json.dumps({'code': 'JOB_VM_PAYLOAD_UNSAFE'}))
        sys.exit(1)
