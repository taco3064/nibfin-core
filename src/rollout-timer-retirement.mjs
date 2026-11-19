import { requireThat } from './identity.mjs';

// These are recognition data for retirement, never installable unit templates.
export const legacyRolloutUnits = new Map([
  ['nibfin-rollout.timer', Buffer.from('[Unit]\n' +
    'Description=Check for verified Nibfin Core rollouts\n\n' +
    '[Timer]\nOnBootSec=1min\nOnUnitInactiveSec=1min\n\n' +
    '[Install]\nWantedBy=timers.target\n')],
  ['nibfin-rollout.service', Buffer.from('[Unit]\n' +
    'Description=Apply a verified Nibfin Core rollout\n' +
    'After=network-online.target\nWants=network-online.target\n\n' +
    '[Service]\nType=oneshot\n' +
    'ExecStart=/usr/bin/python3 /usr/local/libexec/nibfin/host-auto-rollout.py\n' +
    'TimeoutStartSec=10min\nUMask=0022\n')],
]);

export async function retireRolloutTimer(ports) {
  const removed = [];
  let stopped = false;
  try {
    await ports.ready();
    await ports.resources();
    for (const name of legacyRolloutUnits.keys()) {
      if (await ports.stopped(name)) continue;
      await ports.safeToStop(name);
      try { await ports.stop(name); }
      catch { /* A lost response is reconciled against actual systemd state. */ }
      requireThat(await ports.stopped(name), 'CORE_ROLLOUT_UNIT_STOP_UNCONFIRMED');
      stopped = true;
    }
    await ports.resources();
    for (const name of legacyRolloutUnits.keys())
      requireThat(await ports.stopped(name), 'CORE_ROLLOUT_UNIT_STOP_UNCONFIRMED');
    for (const path of await ports.removable()) {
      await ports.resources();
      await ports.remove(path);
      removed.push(path);
    }
    if (stopped || removed.length) await ports.reload();
    return { status: 'retired', removed, retained: await ports.retained() };
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]*$/.test(error?.code ?? '') ? error.code :
      'CORE_ROLLOUT_RESOURCE_RETIREMENT_PENDING';
    return { status: 'pending', code, removed };
  }
}
