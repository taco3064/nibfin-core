import { assertNoCredentialConsumers } from './managed-credentials.mjs';
import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, requireThat } from './identity.mjs';
import { reconcileRelayAttempt, observeRelayOrigin, observeRelayAttempt }
  from './relay-observe.mjs';
import { repoPath } from './github-read.mjs';
import { adoptedWake, resolveSharedIssueWake } from './issue-wake.mjs';
import { hostWakeAdoption } from './host-issue-wake.mjs';
import { sharedRepository, sharedDispatchWorkflow } from './shared-runner.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { observeWake, WakeDispatcher } from './wakeup.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { readRelayState, writeRelayState, withRelayGate } from './relay-state.mjs';
import { requirePoolOpen } from './retirement-admission.mjs';
import { managedSettlement } from './managed-credential-settlement.mjs';
import { requirePoolConsumersSettled } from './retirement-admission.mjs';
import { inspectRetirementSessions } from './retirement-copies.mjs';
import { idleContainers } from './host-containers.mjs';
import { sharedSlotIsolation } from './shared-runner.mjs';
import { assertRetirementJobs } from './retirement-observe.mjs';

// Known origin only. Queue absence and title matches never establish safety.
// The caller holds the relay dispatch gate. All writes use the existing effect
// journal; the original relay intent is neither edited nor retried.
export async function recoverStaleOrigin(record, coreCommit, ports) {
  if (record.status !== 'consumed' || !record.runId ||
    record.intent?.source.coreCommit === coreCommit) return { status: 'unchanged' };
  await ports.reconcile(record);
  const run = await ports.attempt(record);
  requireThat(run.id === record.runId && run.run_attempt === 1,
    'ROLLOUT_ORIGIN_CHANGED');
  if (run.status !== 'completed') return { status: 'pending',
    code: 'ROLLOUT_ORIGIN_STILL_ACTIVE' };
  if (run.conclusion === 'success') return { status: 'unchanged' };
  requireThat(['failure', 'cancelled', 'skipped'].includes(run.conclusion),
    'ROLLOUT_ORIGIN_OUTCOME_UNKNOWN');
  const previous = await ports.read(record);
  if (previous?.status === 'scheduled') return previous;
  requireThat(!previous || previous.coreCommit === coreCommit &&
    previous.originRunId === record.runId, 'ROLLOUT_REPLACEMENT_SOURCE_CHANGED');
  if (previous) {
    const result = await ports.recover(record);
    if (result.status === 'scheduled') await ports.write(record, {
      ...previous, status: 'scheduled', replacementRunId: result.runId });
    if (result.status !== 'unstarted') return result;
  }
  await ports.admit(record);
  await ports.settle(record);
  // Association is durable before dispatch, separately from the immutable origin.
  if (!previous) await ports.write(record, { status: 'pending', coreCommit,
    origin: record.origin, originRunId: record.runId });
  const result = await ports.dispatch(record);
  if (result.status === 'scheduled') await ports.write(record, {
    status: 'scheduled', coreCommit, origin: record.origin,
    originRunId: record.runId, replacementRunId: result.runId });
  return result;
}

// Both installed adapters use the authoritative journal, not a sidecar
// observation or the pending association, to distinguish unstarted dispatch.
export async function recoverReplacementWake({ directory, issue, uid, token }) {
  try { await lstat(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'unstarted' };
    throw error;
  }
  const journal = new OperationJournal(directory, issue, { uid });
  const state = await journal.wakeRecoveryState();
  if (state.status !== 'observed') return state;
  return new WakeDispatcher({ token, journal,
    observe: async () => { throw new Error('Readback only'); } })
    .reconcile(state.initial);
}

export async function recoverRolloutOrigins(context) {
  const { host, reader, token, journal, configuration, inspect } = context;
  const results = [];
  // Bounded independent recovery. Existing pending POSTs are reconciled by poll
  // first; any remaining unknown prevents new replacement effects.
  const records = (await journal.records()).sort((a, b) =>
    digest(a.origin).localeCompare(digest(b.origin)));
  const cursor = await readRelayState(journal.root, 'replacement-poll.json');
  const position = Number.isSafeInteger(cursor?.position) ? cursor.position : 0;
  const count = Math.min(records.length, 50);
  for (let offset = 0; offset < count; offset++) {
    const record = records[(position + offset) % records.length];
    if (record.status !== 'consumed' ||
      record.intent.source.coreCommit === configuration.coreCommit) continue;
    const result = await withRelayGate(journal.root, async () => {
      const name = 'replacement-' + digest(record.origin) + '.json';
      const read = async path => {
        await rootOwnedPath(path);
        return JSON.parse(await boundedHostFile(path, 262144));
      };
      const directory = join(journal.root, 'replacement-' + digest(record.origin));
      const replacementJournal = () =>
        new OperationJournal(directory, record.intent.issue);
      let selected, adoption, event, invocation, config;
      const admit = async () => {
        await requirePoolOpen();
        requireThat(!(await journal.control()).paused, 'RELAY_PAUSED');
        await inspect();
        const origin = configuration.origins.find(item =>
          item.repositoryId === record.origin.repositoryId);
        requireThat(origin, 'RELAY_ORIGIN_REVOKED');
        await observeRelayOrigin(reader, origin, configuration.coreCommit);
        await observeRelayAttempt(reader, origin, record.origin.runId,
          configuration.coreCommit, { historical: true });
        selected = await sharedRepository(host, origin.repositoryId, read);
        adoption = hostWakeAdoption(selected, selected.repository);
        event = JSON.parse(record.intent.inputs.wake_event).event;
        invocation = { repository: origin.repository,
          coreCommit: configuration.coreCommit,
          eventName: 'issues', runId: record.origin.runId, attempt: 1, forwarded: true,
          shared: true, managed: true };
        await resolveSharedIssueWake(reader, event, invocation);
        config = adoptedWake(adoption, record.intent.issue);
        const pause = await new OperationJournal(join(host.stateRoot, 'wake'),
          record.intent.issue).pauseEvidence();
        requireThat(!pause.pending, 'EXTERNAL_EFFECT_UNKNOWN');
        config.pauseDecisions = pause.decisions;
        await observeWake(reader, { ...config, shared: true });
      };
      return recoverStaleOrigin(record, configuration.coreCommit, {
        reconcile: item => reconcileRelayAttempt(reader, item.intent, item.runId),
        attempt: item => reader.get(repoPath(item.intent.destination.repository) +
          `/actions/runs/${item.runId}/attempts/1`),
        read: () => readRelayState(journal.root, name),
        write: (unused, value) => writeRelayState(journal.root, name, value),
        recover: () => recoverReplacementWake({ directory,
          issue: record.intent.issue, token }),
        admit,
        settle: async () => {
          requireThat((await journal.records()).every(item => item.status !== 'pending'),
            'RELAY_EFFECT_UNKNOWN');
          await journal.requireReplacementEffectsSettled({ except: name });
          await requirePoolConsumersSettled(host);
          await assertNoCredentialConsumers(host);
          await managedSettlement(host);
          await inspectRetirementSessions(host);
          for (const uid of [host.runnerUid, host.sharedRunner.additionalRunner.uid])
            await idleContainers(sharedSlotIsolation(host, uid));
          await assertRetirementJobs(reader, configuration.origins,
            { runners: [host.sharedRunner.runner, host.sharedRunner.additionalRunner]
              .map(r => ({ id: r.runnerId ?? r.id, name: r.runnerName ?? r.name })) });
        },
        dispatch: async () => {
          await mkdir(directory, { mode: 0o700 }).catch(error => {
            if (error.code !== 'EEXIST') throw error;
          });
          let initial;
          return new WakeDispatcher({ token, journal: replacementJournal(),
          observe: async current => {
            await admit();
            const observed = await observeWake(current, { ...config, shared: true });
            const workflow = await sharedDispatchWorkflow(current, configuration.runner);
            const value = { ...observed, workflow,
              recovery: { origin: record.origin, runId: record.runId } };
            requireThat(!initial || digest(initial.workflow) === digest(value.workflow),
              'ROLLOUT_REPLACEMENT_SOURCE_CHANGED');
            // WakeDispatcher persists the observation in its operation journal.
            if (!initial) initial = { workflow };
            return value;
          } }).dispatch();
        },
      });
    });
    results.push(result);
  }
  const saved = await withRelayGate(journal.root, async () => {
    await writeRelayState(journal.root, 'replacement-poll.json', {
      position: records.length ? (position + count) % records.length : 0,
    });
    return { status: 'observed' };
  });
  if (saved.status === 'pending') results.push(saved);
  return results;
}
