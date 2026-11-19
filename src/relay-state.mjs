import { mkdir, readdir } from 'node:fs/promises';
import { privateHostDirectory } from './host-fence.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { readPrivateState as readRelayState,
  writePrivateState as writeRelayState,
  withPrivateStateGate as withRelayGate } from './private-observation-state.mjs';
export { readRelayState, writeRelayState, withRelayGate };

export function relayOriginKey(origin) {
  requireThat(isId(origin?.repositoryId) && isId(origin.runId) && origin.attempt === 1,
    'INVALID_RELAY_ORIGIN');
  return `origin-${origin.repositoryId}-${origin.runId}-1.json`;
}

export class RelayJournal {
  constructor(root) { this.root = root; }
  async prepare() {
    await mkdir(this.root, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(this.root);
    await syncRecoveryDirectory(this.root);
  }
  async read(origin) {
    const record = await readRelayState(this.root, relayOriginKey(origin));
    if (record) requireThat(record.schemaVersion === 1 &&
      digest(record.origin) === digest(origin) &&
      ['pending', 'consumed', 'skipped'].includes(record.status) &&
      (record.runId === undefined || isId(record.runId)) &&
      (record.status === 'skipped' || record.intent?.origin &&
        digest(record.intent.origin) === digest(origin)), 'RELAY_JOURNAL_CORRUPT');
    return record;
  }
  async write(record) {
    const name = relayOriginKey(record.origin);
    const previous = await this.read(record.origin);
    requireThat(!previous || previous.status === 'pending' &&
      digest(previous.intent) === digest(record.intent) &&
      (!previous.runId || record.runId === previous.runId),
    'RELAY_IMMUTABLE_INTENT');
    await writeRelayState(this.root, name, { schemaVersion: 1, ...record });
  }
  async records() {
    const names = (await readdir(this.root)).filter(name =>
      /^origin-\d+-\d+-1\.json$/.test(name));
    requireThat(names.length <= 4096, 'RELAY_JOURNAL_CAPACITY');
    const result = [];
    for (const name of names) {
      const record = await readRelayState(this.root, name);
      requireThat(record && name === relayOriginKey(record.origin),
        'RELAY_JOURNAL_CORRUPT');
      result.push(await this.read(record.origin));
    }
    return result;
  }
  async control() {
    const value = await readRelayState(this.root, 'control.json');
    requireThat(value?.schemaVersion === 1 && typeof value.paused === 'boolean',
      'RELAY_CONTROL_UNKNOWN');
    return value;
  }
  async requireReplacementEffectsSettled({ except } = {}) {
    for (const name of await readdir(this.root)) {
      if (!/^replacement-[a-f0-9]{64}\.json$/.test(name) || name === except) continue;
      const record = await readRelayState(this.root, name);
      requireThat(record?.status === 'scheduled', 'ROLLOUT_REPLACEMENT_PENDING');
    }
  }
  // Caller must hold this journal's relay gate throughout check and effects.
  async requireEffectsSettledUnderGate() {
    await this.requireReplacementEffectsSettled();
    requireThat((await this.records()).every(record => record.status !== 'pending'),
      'RETIREMENT_RELAY_EFFECT_PENDING');
  }
  async requireEffectsSettled() {
    const result = await withRelayGate(this.root, async () => {
      await this.requireEffectsSettledUnderGate();
      return { settled: true };
    });
    requireThat(result?.settled === true, 'RETIREMENT_RELAY_BUSY');
  }
  async requireSettled() {
    const result = await withRelayGate(this.root, async () => {
      requireThat((await this.control()).paused, 'RETIREMENT_RELAY_NOT_PAUSED');
      // A lost dispatch response remains an external effect even if no active
      // Job or registration is visible. Recovery owns reconciliation; retirement
      // must neither clear the receipt nor repeat the POST.
      await this.requireEffectsSettledUnderGate();
      return { settled: true };
    });
    requireThat(result?.settled === true, 'RETIREMENT_RELAY_BUSY');
  }
  async setPaused(paused) {
    return withRelayGate(this.root, async () => {
      await this.control();
      await writeRelayState(this.root, 'control.json', { schemaVersion: 1, paused });
      return { status: paused ? 'paused' : 'resumed', stageAdmitted: false };
    });
  }
}
