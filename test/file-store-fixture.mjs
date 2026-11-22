import { engineFileStore } from '../src/engine-files.mjs';

// In-memory root-owned filesystem behind the engine file store.
export function fileDouble(umask = 0) {
  const nodes = new Map();
  const failure = code => Object.assign(Error(code), { code });
  const get = path => {
    if (!nodes.has(path)) throw failure('ENOENT');
    return nodes.get(path);
  };
  const make = (kind, mode) => ({ kind, mode, uid: 0, gid: 0, nlink: 1, bytes: '' });
  nodes.set('/owned', make('directory', 0o700));
  const fs = {
    nodes,
    async lstat(path) {
      const node = get(path);
      return { ...node, isFile: () => node.kind === 'file',
        isDirectory: () => node.kind === 'directory' };
    },
    async rootOwnedPath(path) {
      const node = get(path);
      if (node.kind === 'link' || node.uid !== 0 || (node.mode & 0o022) !== 0)
        throw failure('UNTRUSTED_ADOPTION_PATH');
    },
    async mkdir(path, { mode }) {
      if (nodes.has(path)) throw failure('EEXIST');
      nodes.set(path, make('directory', mode & ~umask));
    },
    async open(path, flags, mode) {
      if (flags === 'wx') {
        if (nodes.has(path)) throw failure('EEXIST');
        nodes.set(path, make('file', mode));
      }
      const node = get(path);
      return {
        async chown(uid, gid) { node.uid = uid; node.gid = gid; },
        async chmod(value) { node.mode = value; },
        async writeFile(bytes) { node.bytes = bytes; },
        async sync() {}, async close() {},
      };
    },
    async link(from, to) {
      if (nodes.has(to)) throw failure('EEXIST');
      const node = get(from);
      node.nlink++;
      nodes.set(to, node);
    },
    async unlink(path) { get(path).nlink--; nodes.delete(path); },
    async rename(from, to) { nodes.set(to, get(from)); nodes.delete(from); },
    async readdir(path) {
      return [...nodes.keys()].filter(name => name.startsWith(`${path}/`))
        .map(name => name.slice(path.length + 1)).filter(name => !name.includes('/'));
    },
    async boundedHostFile(path) { return get(path).bytes; },
    async syncRecoveryDirectory() {},
  };
  return { nodes, store: engineFileStore(fs) };
}
