import { join } from 'node:path';
import { repoPath } from './github-read.mjs';
import { issueStatePath } from './host-fence.mjs';
import { recoveryFile, inspectRecoveryFile } from './recovery-lock.mjs';
import { digest, isId, requireThat } from './identity.mjs';

// Select the historical slot from the exact private fence and native Job.
// The requesting continuation's slot and authentication remain separate.
export async function selectRecoverySlot(current, loadSlot) {
  let context = current;
  const subject = current.adopted.isolation.issue;
  const root = issueStatePath(current.host.stateRoot, subject);
  for (const directory of [root, current.host.stateRoot]) {
    const path = join(directory, 'stage.lock');
    const snapshot = await recoveryFile(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!snapshot) continue;
    const fence = JSON.parse(snapshot.bytes), prior = fence.binding?.execution;
    requireThat(fence.binding?.issueId === subject.id && isId(prior?.jobId),
      'INVALID_RECOVERY_FENCE');
    const job = await current.reader.get(repoPath(current.adopted.runner.repository) +
      '/actions/jobs/' + prior.jobId);
    requireThat(job.id === prior.jobId, 'RECOVERY_EXECUTION_MISMATCH');
    if (job.runner_id !== current.adopted.runner.runnerId) {
      const additional = current.host.sharedRunner?.additionalRunner;
      // loadHostAdoption selects the main slot when runnerUid is the main UID.
      const uid = additional?.id === job.runner_id ? additional.uid
        : current.host.runnerUid;
      requireThat(isId(uid), 'RECOVERY_EXECUTION_MISMATCH');
      context = await loadSlot(uid);
    }
    requireThat(context.adopted.runner.runnerId === job.runner_id &&
      context.host.stateRoot === current.host.stateRoot &&
      digest(context.adopted.isolation.issue) === digest(subject),
    'RECOVERY_EXECUTION_MISMATCH');
    await inspectRecoveryFile(path, snapshot);
    return { context, expectedFence: { path, snapshot } };
  }
  return { context };
}
