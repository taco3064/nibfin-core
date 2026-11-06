import { join } from 'node:path';
import { requireThat } from './identity.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { restrictMcpToReadOnly } from './mcp-catalog.mjs';
import { guardedMcpDiscovery } from './mcp-discovery.mjs';
import { resolveUserMcp, bindMcpProfile } from './mcp-resolve.mjs';
import { verifyMcpPath, readPrivateMcpJson } from './mcp-files.mjs';
import { readMcpDelegation } from './mcp-delegation.mjs';
export { readNativeMcpConfiguration } from './mcp-native.mjs';

// Both sources come exclusively from administrator-owned host adoption.
// Neither an Issue nor a role can select paths, executables or authentication.
export async function loadUserMcp(source, {
  environment = process.env, nativeRead, run,
  validateExecutable = rootOwnedPath,
  restrict = restrictMcpToReadOnly, discoveryRoot, memberId,
} = {}) {
  if (source === undefined) return null;
  requireThat(process.platform === 'linux', 'UNSUPPORTED_USER_MCP_SOURCE_HOST');
  let profile;
  if (source?.kind === 'delegated-http-v1') {
    requireThat(Object.keys(source).sort().join(',') === 'file,kind',
      'INVALID_USER_MCP_SOURCE');
    profile = await readMcpDelegation(source.file, memberId);
  } else {
    requireThat(source && Object.keys(source).sort().join(',') ===
      'codex,home,uid' && Number.isSafeInteger(source.uid) && source.uid > 0,
    'INVALID_USER_MCP_SOURCE');
    await validateExecutable(source.codex);
    await verifyMcpPath(source.home, { uid: source.uid, directory: true });
    await verifyMcpPath(join(source.home, 'config.toml'), { uid: source.uid });
    let credentials = {};
    try {
      credentials = await readPrivateMcpJson(join(source.home, '.credentials.json'),
        { uid: source.uid });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    profile = await resolveUserMcp(source, {
      environment, credentials, nativeRead, run,
      validateSystemFile: validateExecutable,
    });
  }
  await restrict(profile, guardedMcpDiscovery(discoveryRoot));
  return bindMcpProfile(profile);
}
