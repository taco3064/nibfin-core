import { mkdir, lstat, realpath, chmod } from 'node:fs/promises';
import * as filesystem from 'node:fs';
import { join } from 'node:path';
import { projectToolRoot } from './project-tool-paths.mjs';
import { requireThat } from './identity.mjs';

async function prepareDirectory(path) {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path, { bigint: true });
  requireThat(stat.isDirectory() && await realpath(path) === path,
    'UNSAFE_TOOL_OUTPUT_PATH');
  // The workspace's existing private parent limits access to this execution.
  // Match its remapped-agent sharing, without changing pre-existing source.
  if (created) await chmod(path, 0o777);
  return { created, identity: { path, dev: String(stat.dev), ino: String(stat.ino) } };
}

// This same fixed implementation runs on the host and in the cleanup container.
// Settlement already established that the owning tool process can no longer
// mutate this tree. Re-observe source identities before following any pathname.
function retireOutput(fs, parent, root) {
  const unchanged = (expected, optional = false) => {
    let current;
    try { current = fs.lstatSync(expected.path, { bigint: true }); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return false;
      throw error;
    }
    if (!current.isDirectory() || fs.realpathSync(expected.path) !== expected.path ||
      String(current.dev) !== expected.dev || String(current.ino) !== expected.ino)
      throw Object.assign(new Error('TOOL_OUTPUT_CHANGED'), {
        code: 'TOOL_OUTPUT_CHANGED',
      });
    return true;
  };
  unchanged(parent);
  if (unchanged(root, true)) fs.rmSync(root.path, { recursive: true, force: true });
}

// The execution's newly created output is owned by Core. An existing source
// path is never claimed merely because it has the configured cache name.
export async function prepareToolOutput(work, executionId) {
  const container = projectToolRoot(true, executionId);
  const path = join(work, container.slice('/work/'.length));
  const parent = await prepareDirectory(join(work, '.nibfin-cache'));
  const root = await prepareDirectory(path), owned = root.created;
  const parentInContainer = { ...parent.identity, path: '/work/.nibfin-cache' };
  const rootInContainer = { ...root.identity, path: container };
  return {
    owned,
    // Execute only after the owning tool container is independently absent.
    cleanupScript: owned
      ? `(${retireOutput})(require('node:fs'),` +
        `${JSON.stringify(parentInContainer)},` +
        `${JSON.stringify(rootInContainer)});\n` : '',
    dispose: async () => {
      if (owned) retireOutput(filesystem, parent.identity, root.identity);
    },
  };
}
