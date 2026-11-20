import { readFile, readlink, readdir, realpath, lstat } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative } from 'node:path';

export const withinPackage = (path, candidate) => path === candidate ||
  path.startsWith(candidate === '/' ? '/' : candidate + '/');
export const unescapeKernelPath = value => value.replace(/\\([0-7]{3})/g,
  (_, digits) => String.fromCharCode(parseInt(digits, 8)));
const clean = value => unescapeKernelPath(value.replace(/ \(deleted\)$/, ''));

function mounts(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.split(' '), separator = fields.indexOf('-');
    if (separator < 6 || !fields[separator + 2])
      throw new Error('PACKAGE_MOUNT_VISIBILITY_INCOMPLETE');
    const [root, target, source] =
      [fields[3], fields[4], fields[separator + 2]].map(clean);
    if (!root.startsWith('/') || !target.startsWith('/'))
      throw new Error('PACKAGE_MOUNT_VISIBILITY_INCOMPLETE');
    return { root, target, source, device: fields[2] };
  });
}

export function packageMountOrigin(text, candidate) {
  const base = mounts(text).filter(mount => withinPackage(candidate, mount.target))
    .sort((a, b) => b.target.length - a.target.length)[0];
  if (!base) throw new Error('PACKAGE_MOUNT_VISIBILITY_INCOMPLETE');
  return { ...base, location: resolve(base.root, relative(base.target, candidate)) };
}

export function packageMountUse(text, candidate, origin) {
  for (const mount of mounts(text)) {
    const { root, target, source } = mount;
    if ([root, target, source].some(path => withinPackage(path, candidate)) ||
      (target !== '/' && withinPackage(candidate, target) &&
        !(origin && target === origin.target && root === origin.root &&
          mount.device === origin.device))) return true;
    // A bind alias can use a different path in another mount namespace. Match
    // its filesystem/root against the candidate's containing host filesystem.
    if (origin && mount.device === origin.device &&
      (withinPackage(root, origin.location) ||
        (withinPackage(origin.location, root) &&
          (root !== origin.root || target !== origin.target)))) return true;
  }
  return false;
}

function processIdentity(text) {
  const end = text.lastIndexOf(')');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 20 || !/^\d+$/.test(fields[19]))
    throw new Error('PACKAGE_PROCESS_IDENTITY_UNKNOWN');
  return { state: fields[0], start: fields[19],
    kernel: Boolean(Number(fields[6]) & 0x200000) };
}

// No environment reads or command-line diagnostics. Tests inject the proc filesystem,
// including process disappearance versus permission failures and PID reuse.
export async function observePackageUse(candidate, {
  proc = '/proc', read = path => readFile(path, 'utf8'),
  link = readlink, list = readdir, canonical = realpath, inspect = lstat,
} = {}) {
  const retained = reason => ({ used: true, reason });
  const gone = async base => {
    try { await inspect(base); return false; }
    catch (error) { return error.code === 'ENOENT'; }
  };
  try {
    const hostMounts = await read(join(proc, 'self/mountinfo'));
    const origin = packageMountOrigin(hostMounts, candidate);
    if (packageMountUse(hostMounts, candidate, origin))
      return retained('PACKAGE_MOUNT_REFERENCE');
    const pids = (await list(proc)).filter(name => /^\d+$/.test(name));
    if (!pids.length) return retained('PACKAGE_PROCESS_VISIBILITY_INCOMPLETE');
    for (const pid of pids) {
      const base = join(proc, pid), statPath = join(base, 'stat');
      let before;
      try { before = processIdentity(await read(statPath)); }
      catch (error) {
        if (error.code === 'ENOENT' && await gone(base)) continue;
        return retained('PACKAGE_PROCESS_IDENTITY_UNKNOWN');
      }
      if (before.kernel || before.state === 'Z') continue;
      let use = false, failure = false;
      try {
        const root = clean(await link(join(base, 'root')));
        const cwd = clean(await link(join(base, 'cwd')));
        const exe = clean(await link(join(base, 'exe')));
        const namespace = await link(join(base, 'ns/mnt'));
        if (!namespace.startsWith('mnt:[')) throw new Error('unknown namespace');
        const referenced = path => {
          path = clean(path);
          return withinPackage(path, candidate) ||
            (root !== '/' && isAbsolute(path) &&
              withinPackage(resolve(root, '.' + path), candidate));
        };
        use = [root, cwd, exe].some(referenced);
        const args = (await read(join(base, 'cmdline'))).split('\0').filter(Boolean);
        // Relative script names resolve against cwd. Assignment-style arguments
        // also cover native --script=/path and loader options without logging them.
        for (const arg of args) {
          for (const value of [arg, ...arg.split('=')]) {
            const path = isAbsolute(value) ? value : resolve(cwd, value);
            if (referenced(path)) use = true;
            try {
              const target = await canonical(isAbsolute(value) ?
                join(base, 'root', value) : join(base, 'cwd', value));
              if (referenced(target)) use = true;
            } catch (error) {
              // Non-path arguments can exceed the kernel's pathname capacity.
              if (!['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(error.code))
                throw error;
            }
          }
        }
        for (const fd of await list(join(base, 'fd'))) {
          const descriptor = join(base, 'fd', fd);
          let target;
          try { target = await link(descriptor); }
          catch (error) {
            if (error.code === 'ENOENT' && await gone(descriptor)) continue;
            throw error;
          }
          if (target.startsWith('mnt:[') && target !== namespace)
            throw new Error('unobserved pinned mount namespace');
          if (referenced(target)) use = true;
        }
        for (const line of (await read(join(base, 'maps'))).split('\n')) {
          const match = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line);
          if (match && referenced(match[1])) use = true;
        }
        const mounts = await read(join(base, 'mountinfo'));
        if (await link(join(base, 'ns/mnt')) !== namespace)
          throw new Error('mount namespace changed');
        if (packageMountUse(mounts, candidate, origin)) use = true;
        // Namespace-relative mount paths must also be checked through its root.
        if (root !== '/' && packageMountUse(mounts,
          candidate.startsWith(root + '/') ? candidate.slice(root.length) : candidate))
          use = true;
      } catch { failure = true; }
      let after;
      try { after = processIdentity(await read(statPath)); }
      catch (error) {
        // A missing stat alone is not proof that the process has exited.
        if (error.code === 'ENOENT' && await gone(base)) continue;
        return retained('PACKAGE_PROCESS_IDENTITY_UNKNOWN');
      }
      if (before.start !== after.start)
        return retained('PACKAGE_PROCESS_IDENTITY_CHANGED');
      if (failure) return retained('PACKAGE_PROCESS_VISIBILITY_INCOMPLETE');
      if (use) return retained('PACKAGE_PROCESS_OR_MOUNT_REFERENCE');
    }
    return { used: false };
  } catch { return retained('PACKAGE_KERNEL_VISIBILITY_INCOMPLETE'); }
}
