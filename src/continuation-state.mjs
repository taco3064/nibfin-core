import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { isDeepStrictEqual } from 'node:util';
import { requireThat, isId } from './identity.mjs';
import { replacementPool } from './retirement-rebind.mjs';
import { readPrivateState, writePrivateState, withPrivateStateGate } from
  './private-observation-state.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { safeGitHubReadCause } from './github-read-cause.mjs';

function confirmedDispatch(item) {
  return isId(item?.repositoryId) && isId(item.number) &&
    typeof item.id === 'string' && isId(item.runId);
}

// Observational progress only. GitHub and normal Core admission own execution.
export function continuationLifecycle(host, origins, retirement, drain) {
  requireThat(drain === null, 'MANAGED_POOL_RETIRING');
  const pool = replacementPool(host);
  requireThat(host.installation && isId(pool.memberId) &&
    isId(pool.repositoryId) && pool.runners.every(item => isId(item.id)) &&
    pool.runners[0].id !== pool.runners[1].id, 'INVALID_CONTINUATION_POOL');
  if (retirement) requireThat(retirement.phase === 'retired' &&
    retirement.replacement?.phase === 'released' &&
    retirement.replacement.activationVerified === true &&
    isDeepStrictEqual(pool, retirement.replacement.pool),
  'MANAGED_POOL_RETIREMENT_UNRESOLVED');
  return { installation: host.installation, pool,
    repositories: origins.map(({ repository, repositoryId }) =>
      ({ repository, repositoryId })).sort((a, b) => a.repositoryId - b.repositoryId),
    retirementId: retirement?.id ?? null };
}

export class ContinuationState {
  constructor(root) { this.root = root; }
  async optional(name) {
    try { return await readPrivateState(this.root, name); }
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  }
  async receipts() {
    return (await readdir(this.root)).filter(name =>
      /^continuation-\d+-\d+\.json$/.test(name));
  }
  async read(lifecycle) {
    const record = await this.optional('continuation.json') ?? (lifecycle ? {
      schemaVersion: 1, lifecycle, status: 'pending',
    } : null);
    if (!record) return null;
    const completed = [];
    for (const name of await this.receipts()) {
      const receipt = await this.optional(name);
      if (receipt?.schemaVersion === 1 && confirmedDispatch(receipt.dispatched) &&
        name === `continuation-${receipt.dispatched.repositoryId}-` +
          `${receipt.dispatched.number}.json` &&
        isDeepStrictEqual(receipt.lifecycle, record.lifecycle))
        completed.push(receipt.dispatched);
    }
    // A missing receipt re-enters discovery; surviving confirmed effects remain
    // reusable even when the scan header was lost.
    return { ...record, completed,
      status: record.confirmedCount === completed.length ? record.status : 'pending' };
  }
  async write({ completed, ...record }) {
    await writePrivateState(this.root, 'continuation.json', { ...record,
      confirmedCount: completed?.length ?? 0 });
    // New lifecycle progress replaces stale observations, never notification intent.
    if (completed?.length === 0) {
      for (const name of await this.receipts()) {
        const receipt = await this.optional(name);
        if (!confirmedDispatch(receipt?.dispatched) ||
          !isDeepStrictEqual(receipt?.lifecycle, record.lifecycle))
          await unlink(join(this.root, name));
      }
      await syncRecoveryDirectory(this.root);
    }
  }
  async dispatched(lifecycle, dispatched) {
    requireThat(confirmedDispatch(dispatched),
      'INVALID_CONTINUATION_DISPATCH');
    // Each receipt uses the existing private-state bound independently, so an
    // ordinary growing Issue list cannot overflow a single progress document.
    await writePrivateState(this.root,
      `continuation-${dispatched.repositoryId}-${dispatched.number}.json`,
      { schemaVersion: 1, lifecycle, dispatched });
  }
  async use(action) {
    await mkdir(this.root, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(this.root);
    await syncRecoveryDirectory(this.root);
    return withPrivateStateGate(this.root, action, { name: 'continuation.lock' });
  }
}

export async function resumeLifecycle({ lifecycle, state, inspect, resume,
  control = async () => ({ paused: false }),
  onDispatched = async () => {} }) {
  return state.use(async () => {
    await inspect();
    if ((await control()).paused) return { status: 'paused', results: [] };
    const previous = await state.read(lifecycle);
    const compatible = previous?.schemaVersion === 1 &&
      isDeepStrictEqual(previous.lifecycle, lifecycle) &&
      Array.isArray(previous.completed) && previous.completed.every(confirmedDispatch);
    const record = compatible ? previous : {
      schemaVersion: 1, lifecycle, completed: [], status: 'pending',
    };
    // Persist each confirmed response before proceeding to another Issue.
    record.status = 'pending';
    await state.write(record);
    try {
      const result = await resume({ completed: record.completed,
        onDispatched: async dispatched => {
          await state.dispatched(lifecycle, dispatched);
          record.completed.push(dispatched);
          await state.write(record);
          await onDispatched(dispatched);
        } });
      record.status = result.status;
      await state.write(record);
      return result;
    } catch (error) {
      // Confirmed responses survive an observation failure later in the scan.
      record.status = 'pending';
      try { await state.write(record); }
      catch (saveError) {
        if (!safeGitHubReadCause(error)) throw saveError;
      }
      throw error;
    }
  });
}

// Admission gates can report pending before the scan callback is entered.
export function continuationOutcome(result) {
  requireThat(['dispatched', 'paused', 'pending'].includes(result?.status),
    'INVALID_CONTINUATION_OUTCOME');
  return { ...result, results: result.results ?? [] };
}
