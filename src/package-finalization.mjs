import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireThat } from './identity.mjs';

const execute = promisify(execFile);
// Directory-local evidence survives the last manifest unlink and disappears
// atomically with rmdir. No sidecar, cleanup database or arbitrary-empty fallback.
const program = `
import errno, json, os, sys
operation, path, identity, value = sys.argv[1:]
fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    info = os.fstat(fd)
    if str(info.st_dev) + ':' + str(info.st_ino) != identity:
        raise RuntimeError('changed directory')
    name = 'user.nibfin.package-finalization'
    if operation == 'write':
        os.setxattr(fd, name, value.encode())
        os.fsync(fd)
    else:
        try:
            print(os.getxattr(fd, name).decode())
        except OSError as error:
            if error.errno != errno.ENODATA:
                raise
            print('null')
finally:
    os.close(fd)
`;

export async function packageFinalization(path, identity, value) {
  try {
    const { stdout } = await execute('python3', ['-B', '-c', program,
      value === undefined ? 'read' : 'write', path, identity,
      value === undefined ? '' : JSON.stringify(value)]);
    return value === undefined ? JSON.parse(stdout) : value;
  } catch { requireThat(false, 'PACKAGE_FINALIZATION_UNAVAILABLE'); }
}
