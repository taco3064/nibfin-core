import { join } from 'node:path';
import { rootOwnedPath } from './host-paths.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { requireThat } from './identity.mjs';

export async function verifySharedSlotIdentity(directory, expected, repository, {
  inspect = rootOwnedPath, allowRemoved = false,
} = {}) {
  const registration = join(directory, '.runner');
  let local;
  try {
    await inspect(registration);
    const bytes = await boundedHostFile(registration, 65536);
    local = JSON.parse(bytes.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (allowRemoved && error.code === 'ENOENT') return null;
    throw error;
  }
  requireThat(local.agentId === expected.id && local.agentName === expected.name &&
    local.gitHubUrl === `https://github.com/${repository}` &&
    local.workFolder === '_work', 'SHARED_RUNNER_REGISTRATION_MISMATCH');
  return local;
}
