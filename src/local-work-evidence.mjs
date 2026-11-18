import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { digest, isDigest, isId, requireThat } from './identity.mjs';
import { evidenceBinding, stages } from './stages.mjs';
import { observeInvocation } from './local-work-activity.mjs';
import { observationEntries, readObservationFile } from './local-work-files.mjs';
import { limits, reason } from './local-work-values.mjs';

// All paths derive from fixed adoption and independently read native Issues.
// This reader deliberately does not construct journals, stores or RoleSessions.
export function localEvidence(host, {
  read = readObservationFile, entries = observationEntries,
  activity = observeInvocation,
} = {}) {
  let reads = 0;
  const deadline = Date.now() + limits.milliseconds;
  const snapshots = new Map();
  const readJSON = async path => {
    requireThat(++reads <= limits.entries && Date.now() < deadline,
      'OBSERVATION_LIMIT');
    const file = await read(path, host.uid);
    snapshots.set(path, file.bytes);
    return { value: JSON.parse(file.bytes), sourceTime: file.sourceTime };
  };
  const journal = async path => {
    const file = await readJSON(path);
    const { payload, hash } = file.value;
    requireThat(payload?.schemaVersion === 1 && digest(payload) === hash &&
      (payload.pending === null || isDigest(payload.pending)) &&
      Array.isArray(payload.completed) && payload.completed.every(isDigest) &&
      (payload.pauseDecisions === undefined || Array.isArray(payload.pauseDecisions)) &&
      (payload.wakeReceipts === undefined ||
        Array.isArray(payload.wakeReceipts) &&
        payload.wakeReceipts.every(receipt => isId(receipt?.runId) &&
          payload.completed.includes(receipt.decisionId))) &&
      (payload.wakeRunId === undefined ||
        isId(payload.wakeRunId) && isDigest(payload.pending)), 'UNTRUSTED_EVIDENCE');
    const receipts = payload.wakeReceipts ?? [];
    return { dispatchRunIds: receipts.map(receipt => receipt.runId),
      dispatchUnknown: payload.completed.some(id =>
        !receipts.some(receipt => receipt.decisionId === id)),
      decisions: payload.pauseDecisions ?? [], pending: payload.pending !== null,
      dispatchRunId: isId(payload.wakeRunId) ? payload.wakeRunId : null,
      sourceTime: file.sourceTime };
  };
  return {
    async issue(issue) {
      const root = join(host.stateRoot, `issue-${issue.repositoryId}-${issue.number}`);
      const result = { contexts: [], errors: [], journal: null, wake: null };
      for (const [key, path] of [
        ['journal', join(root, 'receipts',
          digest({ issueId: issue.id, repositoryId: issue.repositoryId }),
          'receipts.json')],
        ['wake', join(host.stateRoot, 'wake',
          digest({ issueId: issue.id, repositoryId: issue.repositoryId }),
          'receipts.json')],
      ]) {
        try { result[key] = await journal(path); }
        catch (error) { result.errors.push(reason(error)); }
      }
      try {
        const agentRoot = join(root, 'agent');
        const names = await entries(agentRoot, host.uid);
        const executions = names.filter(value => /^execution-[a-f0-9-]{36}$/.test(value));
        for (const name of executions) {
          const input = join(agentRoot, name, 'input');
          try {
            const file = await readJSON(join(input, 'context.json'));
            const context = file.value;
            const bound = context.approval?.record?.issue;
            if (bound?.id !== issue.id || bound.repositoryId !== issue.repositoryId ||
                bound.repository !== issue.repository || bound.number !== issue.number)
              continue;
            const execution = context.execution;
            requireThat(name === `execution-${execution?.id}` &&
              execution.actorId === host.subjectId &&
              context.runner?.memberId === host.subjectId,
            'UNTRUSTED_EVIDENCE');
            result.contexts.push({ context, input, sourceTime: file.sourceTime });
          } catch (error) { result.errors.push(reason(error)); }
        }
      } catch (error) { result.errors.push(reason(error)); }
      return result;
    },
    async phase(candidate) {
      const { context, input } = candidate;
      const file = await readJSON(join(input, 'invocation.json'));
      const stage = file.value.plan?.contract?.stage;
      const execution = context.execution;
      requireThat(['shape', 'validate-shape', 'deliver', 'accept', 'review-pr']
        .includes(stage) && stages[stage].role === execution.role,
      'UNTRUSTED_EVIDENCE');
      const binding = { ...evidenceBinding(context), memberId: execution.actorId,
        role: execution.role, executionId: execution.id, sessionId: execution.sessionId };
      const lockPath = join(host.stateRoot,
        `issue-${context.approval.record.issue.repositoryId}-` +
          context.approval.record.issue.number,
        'agent', `session-${digest(binding)}`, 'active.lock');
      const lock = (await readJSON(lockPath)).value;
      requireThat(lock.executionId === execution.id &&
        lock.bindingHash === digest(binding),
        'UNTRUSTED_EVIDENCE');
      // A result already written, or a completed receipt for this execution,
      // cannot establish that the role is still running.
      requireThat(!Object.values(context.receipts ?? {}).some(receipt =>
        receipt.execution?.id === execution.id), 'UNVERIFIED_BINDING');
      try {
        await lstat(join(input, '..', 'output', 'result.json'));
        requireThat(false, 'UNVERIFIED_BINDING');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const live = await activity(input);
      requireThat(live, 'UNVERIFIED_BINDING');
      return { stage, confirm: live.confirm };
    },
    async confirm() {
      for (const [path, bytes] of snapshots) {
        requireThat(Date.now() < deadline, 'OBSERVATION_LIMIT');
        requireThat((await read(path, host.uid)).bytes === bytes,
          'OBSERVATION_CHANGED');
      }
    },
  };
}
