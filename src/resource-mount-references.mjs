import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { requireThat } from './identity.mjs';

const self = '/proc/self/mountinfo';
const contains = (parent, path) => path === parent ||
  path.startsWith(parent === '/' ? '/' : parent + '/');
const decode = value => value.replace(/\\([0-7]{3})/g,
  (_, octal) => String.fromCharCode(parseInt(octal, 8)));

function parse(text) {
  const rows = text.trim().split('\n').map(line => {
    const fields = line.split(' '), separator = fields.indexOf('-');
    const [id, , device, root, target] = fields;
    requireThat(separator >= 6 && fields.length > separator + 3 &&
      /^\d+:\d+$/.test(device) && root && target.startsWith('/'),
    'RETIREMENT_MOUNT_OBSERVATION_UNKNOWN');
    return { id, device, root: decode(root), target: decode(target),
      source: decode(fields[separator + 2]) };
  });
  return rows;
}

function candidateCoordinates(path, mounts) {
  // Anonymous namespace handles use roots such as net:[4026531992]. Their
  // targets still count as mounts, but these roots are not path coordinates.
  const ancestors = mounts.filter(mount => mount.root.startsWith('/') &&
    contains(mount.target, path));
  const deepest = ancestors.reduce((length, mount) =>
    Math.max(length, mount.target.length), 0);
  // Consider every mount at the deepest mountpoint. An overmount can hide a
  // lower mount whose source remains visible to a process in another namespace.
  const anchors = ancestors.filter(mount => mount.target.length === deepest);
  requireThat(anchors.length > 0, 'RETIREMENT_MOUNT_OBSERVATION_UNKNOWN');
  return anchors.map(anchor => ({ anchor,
    root: posix.join(anchor.root, posix.relative(anchor.target, path)) }));
}

export function requireNoMountReferences(path, text, hostText = text) {
  const observed = parse(text);
  const host = hostText === text ? observed : parse(hostText);
  const coordinates = candidateCoordinates(path, host);
  requireThat(!observed.some(mount => {
    if (contains(path, mount.target) || contains(path, mount.source)) return true;
    return coordinates.some(({ anchor, root }) => {
      if (anchor.device !== mount.device || anchor.id === mount.id ||
        !mount.root.startsWith('/')) return false;
      // Mount roots are relative to the backing filesystem. Comparing them in
      // those coordinates works even when a process has no host mountpoint.
      if (contains(root, mount.root)) return true;
      // A whole-filesystem alias does not identify an individual package.
      if (mount.root === '/' || !contains(mount.root, root)) return false;
      // Private namespaces can clone the existing mount at the same location.
      // A mount at a different path exposes the candidate through an alias.
      const candidateView = posix.join(mount.target,
        posix.relative(mount.root, root));
      return candidateView !== path;
    });
  }), 'RETIREMENT_RESOURCE_MOUNTED');
}

export async function assertNoSlotMounts(path, file = self) {
  const observed = await readFile(file, 'utf8');
  const host = file === self ? observed : await readFile(self, 'utf8');
  requireNoMountReferences(path, observed, host);
}
