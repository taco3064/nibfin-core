import { constants } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { repoPath } from './github-read.mjs';
import { mcpJobBinding } from './mcp-job.mjs';
import { withManagedAdmission } from './managed-credential-admission.mjs';
import { coreRoot, loadHostAdoption, inspectHostAdoption } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { targetContextKey } from './controller-contract.mjs';
import { issueStatePath, privateHostDirectory } from './host-fence.mjs';
import { linuxBootId, isBootId } from './linux-boot.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { issueProgress } from './issue-progress.mjs';
import { OperationJournal } from './operation-journal.mjs';
import { idleContainers } from './host-containers.mjs';
import { proveDeliverProcesses } from './deliver-recovery-processes.mjs';
import { deliverExecutionEvidence, terminalDeliverJob }
  from './deliver-recovery-evidence.mjs';
import {
  exclusiveRecovery, recoveryFile, inspectRecoveryFile, syncRecoveryDirectory,
} from './recovery-lock.mjs';

// Local Controller only. No relay registration, Runner request or proof argument.
export async function recoverDeliverFence(issueNumber) {
  requireThat(process.getuid?.() > 0 && /^[1-9][0-9]*$/.test(issueNumber) &&
    isId(Number(issueNumber)), 'INVALID_RECOVERY_REQUEST');
  await rootOwnedPath(coreRoot);
  const installed = await import('/opt/nibfin/core/src/host-adoption.mjs');
  const adoption = coreRoot === '/opt/nibfin/core' ?
    { loadHostAdoption, inspectHostAdoption } : installed;
  const load = adoption.loadHostAdoption;
  return withManagedAdmission(async () => {
    const target = process.env[targetContextKey];
    let context = await load(issueNumber, target, undefined, true);
    // Shared slots have separate adopted isolation. Select only an explicitly
    // adopted slot using the native Job, never a caller-supplied Runner identity.
    const root = issueStatePath(context.host.stateRoot, context.adopted.isolation.issue);
    let snapshot;
    for (const directory of [root, context.host.stateRoot]) {
      snapshot = await recoveryFile(join(directory, 'stage.lock')).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (snapshot) break;
    }
    if (snapshot) {
      const prior = JSON.parse(snapshot.bytes).binding?.execution;
      requireThat(isId(prior?.jobId), 'INVALID_RECOVERY_FENCE');
      const job = await context.reader.get(repoPath(context.adopted.runner.repository) +
        '/actions/jobs/' + prior.jobId);
      if (job.runner_id !== context.adopted.runner.runnerId) {
        const additional = context.host.sharedRunner?.additionalRunner;
        requireThat(additional?.id === job.runner_id && isId(additional.uid),
          'RECOVERY_EXECUTION_MISMATCH');
        context = await load(issueNumber, target, additional.uid, true);
      }
    }
    return recoverAdoptedDeliverFence(context, {
      inspectAdoption: adoption.inspectHostAdoption,
    });
  }, { reconcile: true }).catch(pendingRecovery);
}

const prefix = 'settled-deliver-fence-';
const recordName = name => /^settled-deliver-fence-[a-f0-9]{64}\.json$/.test(name);
const completed = record => ({ status: 'completed', code: 'DELIVER_FENCE_RECOVERED',
  executionId: record.execution.id, recovery: record.id });

// Seams are private module dependencies, never selected by the public caller.
export async function recoverAdoptedDeliverFence(context, {
  observeBoot = linuxBootId, containers = idleContainers,
  processes = proveDeliverProcesses, approvalReader = readProtectedApproval,
  inspectAdoption = inspectHostAdoption, afterRecord = async () => {},
} = {}) {
  try {
    const { host, adopted } = context;
    const root = issueStatePath(host.stateRoot, adopted.isolation.issue);
    await privateHostDirectory(host.stateRoot);
    await privateHostDirectory(root);
    return await exclusiveRecovery(root, async () => {
      await inspectAdoption(context);
      const approval = structuredClone(
        await approvalReader(context.reader, adopted.approval));
      requireThat(digest(approval.record.issue) === digest(adopted.isolation.issue) &&
        approval.record.operations.includes('deliver') &&
        approval.record.roles.writer === host.memberId, 'RECOVERY_ISSUE_CHANGED');
      let path = join(root, 'stage.lock');
      const readFence = candidate => recoveryFile(candidate).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      let snapshot = await readFence(path);
      if (!snapshot) {
        // Older installations retained a host-root fence. The subject binding
        // below must still match; another Issue's legacy fence is never retired.
        path = join(host.stateRoot, 'stage.lock');
        snapshot = await readFence(path);
      }
      if (!snapshot) {
        // A completed disposition is evidence only: no admission or receipt is
        // minted. A later fence always takes precedence over these records.
        const names = (await readdir(root)).filter(recordName);
        requireThat(names.length > 0 && names.length <= 4096,
          'RECOVERY_FENCE_MISSING');
        const records = [];
        for (const name of names) {
          const record = JSON.parse((await recoveryFile(join(root, name),
            65536)).bytes);
          requireThat(record.id === name.slice(prefix.length, -5) &&
            record.issueId === adopted.isolation.issue.id &&
            record.disposition === 'settled' &&
            digest({ fence: record.fence, execution: record.execution }) === record.id,
          'RECOVERY_RECORD_CHANGED');
          records.push(record);
        }
        records.sort((a, b) => b.recordedAt - a.recordedAt);
        return completed(records[0]);
      }
      return reconcile(context, approval, root, path, snapshot,
        { observeBoot, containers, processes, approvalReader, inspectAdoption,
          afterRecord });
    });
  } catch (error) { return pendingRecovery(error); }
}

async function reconcile(context, approval, root, path, snapshot, observers) {
  const { host, hostBytes, adopted } = context;
  const subject = adopted.isolation.issue;
  requireThat(adopted.isolation.kind === 'linux-rootful-docker-v1',
    'RECOVERY_ISOLATION_UNSUPPORTED');
  const fence = JSON.parse(snapshot.bytes), prior = fence.binding?.execution;
  requireThat(fence.binding?.host === digest(hostBytes) &&
    fence.binding.issueId === subject.id && typeof fence.nonce === 'string' &&
    isId(fence.pid) && isId(prior?.runId) && isId(prior.jobId) &&
    isId(prior.attempt) && isBootId(fence.bootId), 'INVALID_RECOVERY_FENCE');
  const native = await terminalDeliverJob(context, fence, approval);
  const { store } = await issueProgress(root, approval);
  const evidence = await deliverExecutionEvidence(context, fence, native.run,
    approval, store);
  const journal = new OperationJournal(join(root, 'receipts'), subject);
  const observe = async () => {
    await privateHostDirectory(host.stateRoot);
    await privateHostDirectory(root);
    await observers.inspectAdoption(context);
    const fresh = await observers.approvalReader(context.reader, adopted.approval);
    requireThat(digest(fresh.record) === digest(approval.record),
      'RECOVERY_AUTHORITY_CHANGED');
    requireThat(await observers.observeBoot() === fence.bootId,
      'RECOVERY_BOOT_MISMATCH');
    const current = await terminalDeliverJob(context, fence, fresh);
    requireThat(current.hash === native.hash, 'RECOVERY_EXECUTION_CHANGED');
    await evidence.confirm();
    await proveMcpNotEntered(context, fence);
    const processHash = await observers.processes(fence,
      { installation: host.installation?.directory, subject,
        stateRoot: host.stateRoot });
    const containerHash = await observers.containers(adopted.isolation, subject);
    // No resetting locks, replaying writes or operation-specific reconciliation.
    // Such uncertainty must first settle through its owning recovery route.
    await journal.assertIdle();
    await inspectRecoveryFile(path, snapshot);
    return { native: current.hash, processes: processHash, containers: containerHash,
      journal: 'idle', evidence: evidence.hash, bootId: fence.bootId };
  };
  await observe();
  const observations = await observe();
  const id = digest({ fence: snapshot, execution: evidence.execution });
  const archive = join(root, `${prefix}${id}.json`);
  const record = { schemaVersion: 1, id, issueId: subject.id,
    fence: snapshot, execution: evidence.execution, observations,
    disposition: 'settled', recordedAt: Date.now() };
  let file;
  try {
    file = await open(archive, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (file) {
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
  }
  const saved = await recoveryFile(archive, 65536);
  const previous = JSON.parse(saved.bytes);
  requireThat(previous.id === id && previous.disposition === 'settled' &&
    previous.issueId === subject.id &&
    digest(previous.fence) === digest(snapshot) &&
    digest(previous.execution) === digest(evidence.execution), 'RECOVERY_RECORD_CHANGED');
  await syncRecoveryDirectory(root);
  await observers.afterRecord();
  // Repeat all consequential observations after durable recording. Even a
  // byte-identical replacement fence must not be retired by this recovery.
  await observe();
  await inspectRecoveryFile(archive, saved, 65536);
  await inspectRecoveryFile(path, snapshot);
  await unlink(path);
  await syncRecoveryDirectory(dirname(path));
  return completed(previous);
}

// The maintained MCP acquisition guard is durable before any native request and
// is never evicted. Its absence proves this exact Job did not acquire consumers.
// A retained claim needs external-host read-back unavailable on the current
// bridge; even terminal GitHub state cannot substitute for that observation.
async function proveMcpNotEntered({ host, adopted }, fence) {
  const directory = join(host.stateRoot, 'mcp-jobs');
  try { await privateHostDirectory(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const runner = { ...adopted.runner, ...fence.binding.execution };
  const claim = join(directory, digest(mcpJobBinding(runner)) + '.json');
  const snapshot = await recoveryFile(claim).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  requireThat(snapshot === null, 'RECOVERY_MCP_OBSERVATION_UNAVAILABLE');
}

function pendingRecovery(error) {
  const code = typeof error?.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code : 'RECOVERY_OBSERVATION_UNAVAILABLE';
  return { status: 'pending', code };
}
