import { coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { command } from './process.mjs';
import { assertRetirementCgroups, observeRetirementUnit }
  from './retirement-observe.mjs';
import {
  readSharedServiceSource, readSharedServiceUnit, unitDirectory,
  writeSharedServiceTemplate,
} from './shared-service-install.mjs';
import { verifyInstalledSource } from './source-package.mjs';

const readUnit = () => readSharedServiceUnit(unitDirectory, rootOwnedPath);

async function requirePreviousTemplate(actual, source) {
  requireThat(actual === await source(), 'SHARED_SERVICE_TEMPLATE_CONFLICT');
}

export async function inspectRolloutServiceTemplate(staged, currentPin) {
  const actual = await readUnit();
  if (actual === await readSharedServiceSource(staged)) return;
  await verifyInstalledSource(coreRoot, currentPin);
  await requirePreviousTemplate(actual, () => readSharedServiceSource(coreRoot));
}

// The stopped-pool restore operation has already verified the promoted source.
// The verified predecessor authorizes a replacement without a new local receipt.
export async function restoreRolloutServiceTemplate(plan, {
  read = readUnit,
  desired = () => readSharedServiceSource(coreRoot),
  previous = async () => {
    const backup = `/opt/nibfin/core-before-${plan.pin.commit}`;
    await verifyInstalledSource(backup, plan.apply.oldPin);
    return readSharedServiceSource(backup);
  },
  stopped = async () => {
    for (const slot of [1, 2]) await observeRetirementUnit(slot);
    await assertRetirementCgroups();
  },
  write = (next, prior) =>
    writeSharedServiceTemplate(unitDirectory, next, rootOwnedPath, prior),
  reload = async () => {
    const systemctl = '/usr/bin/systemctl';
    await rootOwnedPath(systemctl);
    await command(systemctl, ['daemon-reload'],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  },
} = {}) {
  const actual = await read();
  const expected = await desired();
  if (actual !== expected) {
    await requirePreviousTemplate(actual, previous);
    await stopped();
    await write(expected, actual);
  }
  // A previous attempt might have persisted the unit before daemon-reload.
  await reload();
  requireThat(await read() === expected, 'SHARED_SERVICE_TEMPLATE_CONFLICT');
}
