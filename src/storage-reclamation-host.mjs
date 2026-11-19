import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { managedBase } from './managed-credential-files.mjs';
import { engine } from './engine-contract.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';
import { reclamationEnvironment as env } from './storage-reclamation.mjs';

const trim = '/usr/sbin/fstrim';
const roots = [managedBase, engine.data];
const supported = new Set(['ext4', 'xfs', 'btrfs']);
const decode = value => value.replace(/\\(040|011|012|134)/g,
  (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function reclamationMounts(bytes) {
  return bytes.trim().split('\n').filter(Boolean).map(line => {
    const [left, right, extra] = line.split(' - ');
    const fields = left.split(' '), tail = right?.split(' ');
    requireThat(!extra && fields.length >= 6 && tail?.length >= 3 &&
      /^\d+:\d+$/.test(fields[2]), 'RECLAMATION_MOUNT_INVALID');
    return { device: fields[2], root: decode(fields[3]),
      target: decode(fields[4]), options: fields[5].split(','),
      type: tail[0], source: decode(tail[1]), superOptions: tail[2].split(',') };
  });
}

function deviceId(value) {
  const dev = BigInt(value);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}`;
}

const native = {
  platform: () => process.platform,
  release: () => readFile('/proc/sys/kernel/osrelease', 'utf8'),
  mounts: () => readFile('/proc/self/mountinfo', 'utf8'),
  controller: async () => {
    await rootOwnedPath('/etc/passwd');
    const rows = (await readFile('/etc/passwd', 'utf8')).split('\n')
      .map(line => line.split(':')).filter(row => row[0] === engine.controller);
    requireThat(rows.length === 1 && /^[1-9][0-9]*$/.test(rows[0][2]),
      'RECLAMATION_CONTROLLER_INVALID');
    return Number(rows[0][2]);
  },
  diskGroup: async () => {
    await rootOwnedPath('/etc/group');
    const rows = (await readFile('/etc/group', 'utf8')).split('\n')
      .map(line => line.split(':')).filter(row => row[0] === 'disk');
    requireThat(rows.length <= 1 && (!rows.length || /^\d+$/.test(rows[0][2])),
      'RECLAMATION_DEVICE_GROUP_INVALID');
    return rows.length ? Number(rows[0][2]) : null;
  },
  lstat, realpath, rootOwnedPath,
  run: (path, args) => command(path, args, { env }),
};

async function validateRoot(path, uid, io) {
  requireThat(await io.realpath(path) === path, 'RECLAMATION_ROOT_INVALID');
  for (let current = path; ; current = dirname(current)) {
    const stat = await io.lstat(current);
    const owner = path === managedBase &&
      (current === managedBase || current.startsWith(managedBase + '/')) ? uid : 0;
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.uid === owner && (stat.mode & 0o022) === 0,
    'RECLAMATION_ROOT_INVALID');
    if (current === '/') break;
  }
  return io.lstat(path);
}

function selectMount(path, stat, mounts) {
  const matches = mounts.filter(row => path === row.target ||
    path.startsWith(row.target === '/' ? '/' : row.target + '/'));
  const length = Math.max(...matches.map(row => row.target.length));
  const nearest = matches.filter(row => row.target.length === length);
  requireThat(nearest.length === 1, 'RECLAMATION_MOUNT_AMBIGUOUS');
  const mount = nearest[0];
  requireThat(mount.device === deviceId(stat.dev) && mount.root === '/' &&
    supported.has(mount.type) && mount.options.includes('rw') &&
    !mount.options.includes('ro') && !mount.superOptions.includes('ro') &&
    mount.source.startsWith('/dev/') &&
    mounts.filter(row => row.device === mount.device).length === 1,
  'RECLAMATION_STORAGE_UNSUPPORTED');
  return mount;
}

// Private dependency seam exercises the same selection and execution as root.
export async function reclaimManagedStorage(io = native) {
  const result = { status: 'unsupported', platform: 'unsupported', attempted: false,
    filesystems: [] };
  if (io.platform() !== 'linux') return result;
  result.platform = /microsoft|wsl/i.test(await io.release()) ? 'wsl' : 'linux';
  let mounts, uid, diskGroup;
  try {
    uid = await io.controller();
    diskGroup = await io.diskGroup();
    mounts = reclamationMounts(await io.mounts());
  } catch { return result; }
  const selected = new Map();
  for (const path of roots) {
    try {
      const stat = await validateRoot(path, uid, io);
      const mount = selectMount(path, stat, mounts);
      await io.rootOwnedPath(mount.target);
      const target = await io.lstat(mount.target);
      requireThat(target.isDirectory() && deviceId(target.dev) === mount.device,
        'RECLAMATION_TARGET_INVALID');
      const source = await io.realpath(mount.source);
      requireThat(source.startsWith('/dev/'), 'RECLAMATION_DEVICE_INVALID');
      await io.rootOwnedPath(dirname(source));
      const block = await io.lstat(source);
      // Native block nodes commonly grant the system disk group read/write.
      // Their root-owned parent and metadata remain outside Controller control.
      requireThat(block.isBlockDevice() && block.uid === 0 &&
        (block.mode & 0o002) === 0 &&
        (!(block.mode & 0o020) || block.gid === 0 || block.gid === diskGroup) &&
        deviceId(block.rdev) === mount.device,
        'RECLAMATION_DEVICE_INVALID');
      selected.set(mount.device, mount);
    } catch {
      result.filesystems.push({ status: 'unsupported', attempted: false, bytes: null });
    }
  }
  for (const mount of selected.values()) {
    const row = { status: 'unavailable', attempted: false, bytes: null };
    result.filesystems.push(row);
    try {
      await io.rootOwnedPath(trim);
      row.attempted = true;
      const output = await io.run(trim, ['--verbose', '--', mount.target]);
      row.status = 'success';
      const count = /\((\d+) bytes\)/.exec(output.stdout.toString('utf8'));
      if (count && Number.isSafeInteger(Number(count[1]))) row.bytes = Number(count[1]);
    } catch { if (row.attempted) row.status = 'failure'; }
  }
  result.attempted = result.filesystems.some(row => row.attempted);
  result.status = ['failure', 'unavailable', 'unsupported', 'success'].find(status =>
    result.filesystems.some(row => row.status === status)) ?? 'unsupported';
  return result;
}
