import { requireLegacyReplacementsSettled } from './legacy-wake-state.mjs';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, isSha, requireThat } from './identity.mjs';
import { OperationJournal, readWakeOrigins, requireWakeEffectsSettled }
  from './operation-journal.mjs';
import { observeWake, observeWakeAttempt, WakeDispatcher } from './wakeup.mjs';
import { adoptedWake } from './issue-wake.mjs';
import { hostWakeAdoption } from './host-issue-wake.mjs';
import { recoverStaleOrigin, recoverReplacementWake } from './rollout-recovery.mjs';
import { readRelayState, writeRelayState, RelayJournal } from './relay-state.mjs';
import { sharedRepository, sharedRunner, sharedDispatchWorkflow }
  from './shared-runner.mjs';
import { readCallerSource } from './caller-source.mjs';
import { wakeRecipe } from './caller-recipes.mjs';
import { GitHubReader } from './github-read.mjs';
import { bindRolloutPool, settleRolloutWork } from './rollout-pool.mjs';
import { withRolloutGates, rolloutHasRelay } from './rollout-gates.mjs';
import { requireNoRetirement, requirePoolOpen } from './retirement-admission.mjs';
import { relayStateRoot } from './relay-host.mjs';
import { boundedHostFile, hostFile, coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { lifecycleState, readPrivate } from './managed-credential-files.mjs';

// One bounded, rotating pass. The caller serializes admission and dispatch.
// Ports below are the same journal/dispatcher interfaces as ordinary wakes.
export async function recoverLegacyWakeOrigins({
  root, coreCommit, ports, uid = process.getuid(),
}) {
  const origins = await readWakeOrigins(root, uid);
  const cursor = await readRelayState(root, 'legacy-poll.json', uid);
  const position = Number.isSafeInteger(cursor?.position) ? cursor.position : 0;
  const results = [], count = Math.min(origins.length, 50);
  for (let offset = 0; offset < count; offset++) {
    const receipt = origins[(position + offset) % origins.length];
    const initial = receipt.initial;
    if (!initial || !isSha(initial.coreCommit)) {
      results.push({ status: 'pending', code: 'LEGACY_WAKE_ORIGIN_EVIDENCE_MISSING' });
      continue;
    }
    if (initial.coreCommit === coreCommit) continue;
    const record = { status: 'consumed', runId: receipt.runId,
      origin: { repositoryId: initial.issue.repositoryId,
        runId: receipt.runId, attempt: 1, decisionId: receipt.decisionId },
      intent: { source: { coreCommit: initial.coreCommit } } };
    try {
      results.push(await recoverStaleOrigin(record, coreCommit,
        await ports(receipt, record)));
    } catch (error) {
      results.push({ status: 'pending', code: /^[A-Z][A-Z0-9_]{0,79}$/.test(
        error.code ?? '') ? error.code : 'LEGACY_WAKE_RECOVERY_UNKNOWN' });
    }
  }
  await writeRelayState(root, 'legacy-poll.json', {
    position: origins.length ? (position + count) % origins.length : 0,
  }, uid);
  return results;
}

// Fixed installed timer entry. A manual token stays inside the trusted process;
// imported managed credentials continue to require their existing admission.
export async function recoverInstalledLegacyWakes() {
  requireThat(process.getuid() === 0 && coreRoot === '/opt/nibfin/core',
    'ROLLOUT_REQUIRES_HOST_ADMINISTRATOR');
  const read = async path => {
    await rootOwnedPath(path);
    return JSON.parse(await boundedHostFile(path, 262144));
  };
  const host = await read(hostFile), pin = host.installation.pin;
  await verifyInstalledSource(coreRoot, pin);
  const root = join(host.stateRoot, 'wake'), uid = host.uid;
  // A pool with no legacy wake history has nothing to recover.
  if (!(await readWakeOrigins(root, uid)).length)
    return { status: 'observed', results: [] };
  return withRolloutGates(host, async () => {
    await requireNoRetirement({ rollout: true });
    requireThat(!await lifecycleState(host), 'LEGACY_MANAGED_CREDENTIAL_REFUSED');
    const token = (await readPrivate(host.tokenFile, host, 16384)).trim();
    const reader = new GitHubReader(token);
    const binding = await bindRolloutPool(host);
    const inspect = async () => {
      requireThat(digest(await read(hostFile)) === digest(host), 'HOST_ADOPTION_CHANGED');
      await verifyInstalledSource(coreRoot, pin);
      requireThat(!await lifecycleState(host), 'LEGACY_MANAGED_CREDENTIAL_REFUSED');
      requireThat((await readPrivate(host.tokenFile, host, 16384)).trim() === token,
        'ROLLOUT_CREDENTIAL_CHANGED');
      for (const item of binding.adoptions)
        requireThat(digest(await read(item.path)) === digest(JSON.parse(item.bytes)),
          'HOST_ADOPTION_CHANGED');
    };
    const results = await recoverLegacyWakeOrigins({ root, coreCommit: pin.commit, uid,
      ports: async ({ initial }, record) => {
        const name = 'legacy-' + digest(record.origin) + '.json';
        const directory = join(root, 'legacy-' + digest(record.origin));
        const original = new OperationJournal(root, initial.issue, { uid });
        const journal = () => new OperationJournal(directory, initial.issue, { uid });
        let config, shared;
        const admit = async () => {
          await requirePoolOpen();
          await requireNoRetirement();
          await inspect();
          if (await rolloutHasRelay())
            requireThat(!(await new RelayJournal(relayStateRoot).control()).paused,
              'RELAY_PAUSED');
          const selected = await sharedRepository(host, initial.issue.repositoryId, read);
          config = adoptedWake(hostWakeAdoption(selected, selected.repository),
            initial.issue);
          shared = initial.workflow.repository !== undefined;
          const pause = await original.pauseEvidence();
          requireThat(!pause.pending, 'EXTERNAL_EFFECT_UNKNOWN');
          config.pauseDecisions = pause.decisions;
          const ancestry = await reader.get('/repos/taco3064/nibfin-core/compare/' +
            `${initial.coreCommit}...${pin.commit}`);
          requireThat(ancestry.status === 'ahead' &&
            ancestry.merge_base_commit?.sha === initial.coreCommit,
          'ROLLOUT_ORIGINAL_SOURCE_UNRELATED');
          if (!shared) await readCallerSource(reader, initial.issue.repository,
            initial.workflow, initial.workflow.commit,
            wakeRecipe(initial.coreCommit, initial.workflow, initial.route.userId));
          await observeWake(reader, { ...config, shared });
        };
        return {
          reconcile: async () => {
            const result = await new WakeDispatcher({ token, journal: original,
              observe: async () => { throw new Error('Readback only'); } })
              .reconcile(initial);
            requireThat(result.status === 'scheduled' && result.runId === record.runId,
              'LEGACY_WAKE_EFFECT_UNKNOWN');
          },
          attempt: () => observeWakeAttempt(reader, initial, record.runId),
          read: () => readRelayState(root, name, uid),
          write: (unused, value) => writeRelayState(root, name, value, uid),
          admit,
          settle: async () => {
            await requireWakeEffectsSettled(root, uid);
            await requireLegacyReplacementsSettled(root, name, uid);
            await original.assertIdle();
            await settleRolloutWork(host, reader, binding, {
              relayGateHeld: true, legacyReplacement: name,
            });
          },
          recover: () => recoverReplacementWake({ directory,
            issue: initial.issue, uid, token }),
          dispatch: async () => {
            const created = await mkdir(directory, { mode: 0o700 }).then(
              () => true, error => { if (error.code !== 'EEXIST') throw error; });
            if (created) {
              const file = await open(directory, constants.O_RDONLY |
                constants.O_DIRECTORY | constants.O_NOFOLLOW);
              try { await file.chown(uid, -1); } finally { await file.close(); }
            }
            let first;
            return new WakeDispatcher({ token, journal: journal(),
              observe: async current => {
                await admit();
                const observed = await observeWake(current, { ...config, shared });
                const workflow = shared ? await sharedDispatchWorkflow(current,
                  sharedRunner(host, initial.issue).runner) : observed.workflow;
                const value = { ...observed, workflow,
                  recovery: { origin: record.origin, runId: record.runId } };
                requireThat(!first || digest(first.workflow) === digest(workflow),
                  'ROLLOUT_REPLACEMENT_SOURCE_CHANGED');
                if (!first) {
                  first = { workflow };
                }
                return value;
              } }).dispatch();
          },
        };
      } });
    return { status: 'observed', results };
  });
}

export { requireLegacyReplacementsSettled } from './legacy-wake-state.mjs';
