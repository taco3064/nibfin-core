import { join } from 'node:path';
import { boundedHostFile, coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { installedSharedRuntime } from './shared-platform.mjs';
import { relayUnits } from './relay-host.mjs';

// Installation and retirement compare the same fixed, owned unit templates.
// Only internal tests replace observations; no CLI input selects a resource.
export async function notificationUnitContents({ runtime = installedSharedRuntime,
  inspect = rootOwnedPath, read = boundedHostFile } = {}) {
  const { nodePath } = await runtime();
  const result = new Map();
  for (const name of relayUnits) {
    const path = join(coreRoot, 'src/security', name);
    await inspect(path);
    const template = await read(path, 16384);
    result.set(name, template.replaceAll('NODE_RUNTIME', nodePath));
  }
  return result;
}
