import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { privateHostDirectory } from './host-fence.mjs';
import { digest, requireThat } from './identity.mjs';
import { discoverReadOnlyMcpTools } from './mcp-catalog.mjs';

// One exclusive intent survives crashes and ambiguous transport/session cleanup.
// It contains no OAuth credentials. Session IDs remain controller-private.
export function guardedMcpDiscovery(root, discover = discoverReadOnlyMcpTools) {
  return async server => {
    requireThat(typeof root === 'string', 'USER_MCP_DISCOVERY_JOURNAL_REQUIRED');
    await privateHostDirectory(root);
    const path = join(root, 'mcp-discovery.json');
    const sync = async () => {
      const file = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await file.sync(); } finally { await file.close(); }
    };
    const record = { schemaVersion: 1, endpointHash: digest(server.url),
      state: 'intent', session: null };
    const write = async (target, value) => {
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
    };
    try { await write(path, record); }
    catch (error) {
      if (error.code === 'EEXIST')
        requireThat(false, 'USER_MCP_DISCOVERY_UNRESOLVED');
      throw error;
    }
    await sync();
    let retired = false;
    try {
      return await discover(server, undefined, {
        async observed(session) {
          const next = path + '.next';
          await write(next, { ...record, state: 'observed', session });
          await rename(next, path);
          await sync();
        },
        async retired() {
          await unlink(path);
          await sync();
          retired = true;
        },
      });
    } finally {
      // Never erase an unknown session/response or silently start another one.
      requireThat(retired, 'USER_MCP_DISCOVERY_UNRESOLVED');
    }
  };
}
