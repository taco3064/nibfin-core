import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedHostFile, hostFile } from '../host-adoption.mjs';
import { rootOwnedPath } from '../host-paths.mjs';
import { controllerRoute } from '../controller-contract.mjs';
import { requireThat } from '../identity.mjs';

async function check() {
  const slot = process.argv[2];
  requireThat(slot === '1' || slot === '2', 'INVALID_SHARED_RUNNER_SLOT');
  await rootOwnedPath(hostFile);
  const host = JSON.parse(await boundedHostFile(hostFile, 256 * 1024));
  const second = host.sharedRunner?.additionalRunner;
  const primary = host.sharedRunner?.runner;
  requireThat(controllerRoute(host) && primary && second &&
    process.getuid() === (slot === '1' ? host.runnerUid : second.uid),
  'SHARED_RUNNER_ACCOUNT_MISMATCH');
  const directory = `/var/lib/nibfin/runners/slot-${slot}`;
  const registration = await boundedHostFile(join(directory, '.runner'), 65536, true);
  const local = JSON.parse(registration.replace(/^\uFEFF/, ''));
  const expected = slot === '1'
    ? { id: primary.runnerId, name: primary.runnerName } : second;
  requireThat(local.agentId === expected.id && local.agentName === expected.name &&
    local.gitHubUrl === `https://github.com/${primary.repository}`,
  'SHARED_RUNNER_REGISTRATION_MISMATCH');
  for (const path of [host.stateRoot, host.tokenFile, host.authFile,
    '/run/nibfin-engine/docker.sock']) {
    try { await access(path, constants.R_OK); }
    catch (err) {
      if (err.code === 'EACCES') continue;
      throw err;
    }
    requireThat(false, 'SHARED_RUNNER_CAN_READ_CONTROLLER_RESOURCE');
  }
}

check().catch(error => {
  const safe = ['INVALID_SHARED_RUNNER_SLOT', 'SHARED_RUNNER_ACCOUNT_MISMATCH',
    'SHARED_RUNNER_REGISTRATION_MISMATCH', 'SHARED_RUNNER_CAN_READ_CONTROLLER_RESOURCE'];
  process.stderr.write((safe.includes(error.code) ? error.code :
    'SHARED_RUNNER_START_CHECK_FAILED') + '\n');
  process.exitCode = 1;
});
